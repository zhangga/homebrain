/**
 * The single choke point for all LLM traffic (plan R6: gateway breaking changes
 * are absorbed here). Wraps the ByteDance internal gateway, which speaks the
 * native Anthropic Messages API.
 *
 * Verified gateway facts (probed live against api.gameaigc.cn):
 *   - Auth is `x-api-key: <token>` plus `anthropic-version: 2023-06-01`.
 *   - Structured output is done with forced tool_use. IMPORTANT: the gateway
 *     REWRITES the tool name in the response (we send "extract", it returns
 *     e.g. "CompatExtract9f0a1b"), so we must locate the tool_use block by
 *     BLOCK TYPE, never by matching the name we sent.
 *   - There is no embeddings endpoint; the knowledge layer is retrieval-by-LLM.
 */
import { config, logger, type Logger } from "@homebrain/shared";
import { estimateCost } from "./pricing.ts";
import {
  BudgetExceededError,
  checkBudget,
  recordCall,
  type CallPurpose,
} from "./budget.ts";

const log: Logger = logger.child("llm");

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  model?: string;
  system?: string;
  messages?: Message[];
  /** shorthand for a single user message */
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
  purpose?: CallPurpose;
  space?: string;
  /** number of retryable attempts (network/5xx). default 3 */
  retries?: number;
}

export interface CompleteResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: AnthropicUsage;
  model?: string;
  error?: { message?: string; type?: string };
}

function buildMessages(opts: CompleteOptions): Message[] {
  if (opts.messages && opts.messages.length > 0) return opts.messages;
  if (opts.prompt !== undefined) return [{ role: "user", content: opts.prompt }];
  throw new Error("complete() requires either `messages` or `prompt`");
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

async function postMessages(
  body: Record<string, unknown>,
  retries: number,
): Promise<AnthropicResponse> {
  const cfg = config();
  const url = `${cfg.gatewayBaseUrl}/v1/messages`;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(500 * 2 ** (attempt - 1), 8000) + Math.random() * 250;
      log.warn("retrying gateway call", { attempt, backoffMs: Math.round(backoff) });
      await Bun.sleep(backoff);
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": cfg.gatewayToken,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as AnthropicResponse;
      if (!res.ok || json.error) {
        const msg = json.error?.message ?? `HTTP ${res.status}`;
        if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
          lastErr = new Error(`gateway ${res.status}: ${msg}`);
          continue;
        }
        throw new Error(`gateway error ${res.status}: ${msg}`);
      }
      return json;
    } catch (err) {
      lastErr = err;
      // fetch-level failure (network); retry if attempts remain
      if (attempt < retries) continue;
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function usageOf(json: AnthropicResponse): { input: number; output: number } {
  return {
    input: json.usage?.input_tokens ?? 0,
    output: json.usage?.output_tokens ?? 0,
  };
}

/** Free-form text completion. */
export async function complete(opts: CompleteOptions): Promise<CompleteResult> {
  const cfg = config();
  const model = opts.model ?? cfg.model;
  const purpose = opts.purpose ?? "other";

  const decision = checkBudget(purpose);
  if (!decision.allowed) throw new BudgetExceededError(decision);

  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 1024,
    messages: buildMessages(opts),
  };
  if (opts.system) body.system = opts.system;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  const started = Date.now();
  let ok = false;
  let input = 0;
  let output = 0;
  try {
    const json = await postMessages(body, opts.retries ?? 3);
    const u = usageOf(json);
    input = u.input;
    output = u.output;
    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    ok = true;
    const costUsd = estimateCost(model, input, output);
    return { text, model: json.model ?? model, inputTokens: input, outputTokens: output, costUsd };
  } finally {
    recordCall({
      t: new Date().toISOString(),
      model,
      purpose,
      inputTokens: input,
      outputTokens: output,
      costUsd: estimateCost(model, input, output),
      space: opts.space,
      ok,
      ms: Date.now() - started,
    });
  }
}

export interface JSONOptions<_T> extends CompleteOptions {
  /** JSON schema for the structured result (Anthropic input_schema shape) */
  schema: Record<string, unknown>;
  /** validate + narrow the raw parsed object; throw to reject */
  validate?: (raw: unknown) => _T;
}

/**
 * Structured completion via forced tool_use. Returns the tool input object.
 *
 * We register a single tool and force `tool_choice`, then read back the FIRST
 * block whose `type === "tool_use"` — deliberately ignoring `name`, because the
 * gateway rewrites it. `validate` (when given) narrows/checks the shape.
 */
export async function completeJSON<T = unknown>(opts: JSONOptions<T>): Promise<{
  value: T;
  result: CompleteResult;
}> {
  const cfg = config();
  const model = opts.model ?? cfg.model;
  const purpose = opts.purpose ?? "other";

  const decision = checkBudget(purpose);
  if (!decision.allowed) throw new BudgetExceededError(decision);

  const toolName = "extract";
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 2048,
    messages: buildMessages(opts),
    tools: [
      {
        name: toolName,
        description: "Return the requested structured data.",
        input_schema: opts.schema,
      },
    ],
    tool_choice: { type: "tool", name: toolName },
  };
  if (opts.system) body.system = opts.system;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  const started = Date.now();
  let ok = false;
  let input = 0;
  let output = 0;
  try {
    const json = await postMessages(body, opts.retries ?? 3);
    const u = usageOf(json);
    input = u.input;
    output = u.output;
    // Find the structured block by TYPE, not name (gateway mangles the name).
    const block = (json.content ?? []).find((b) => b.type === "tool_use");
    if (!block || block.input === undefined) {
      throw new Error("gateway returned no tool_use block for structured request");
    }
    const value = opts.validate ? opts.validate(block.input) : (block.input as T);
    ok = true;
    const costUsd = estimateCost(model, input, output);
    return {
      value,
      result: { text: "", model: json.model ?? model, inputTokens: input, outputTokens: output, costUsd },
    };
  } finally {
    recordCall({
      t: new Date().toISOString(),
      model,
      purpose,
      inputTokens: input,
      outputTokens: output,
      costUsd: estimateCost(model, input, output),
      space: opts.space,
      ok,
      ms: Date.now() - started,
    });
  }
}

/** Lightweight connectivity probe used by health checks. */
export async function ping(model?: string): Promise<boolean> {
  try {
    const r = await complete({
      model,
      prompt: "reply with the single word: pong",
      maxTokens: 8,
      purpose: "other",
      retries: 1,
    });
    return /pong/i.test(r.text);
  } catch (err) {
    log.error("gateway ping failed", { err: String(err) });
    return false;
  }
}

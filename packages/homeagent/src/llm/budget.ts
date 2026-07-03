import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LlmTextClient, LlmVisionClient } from "./types";

export interface LlmBudgetPricing {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  maxOutputTokensPerCall: number;
}

export interface BudgetedLlmClientOptions {
  client: LlmTextClient & Partial<LlmVisionClient>;
  logPath: string;
  dailyBudgetUsd?: number;
  pricing?: LlmBudgetPricing;
  now?: () => Date;
}

type LlmBudgetLogStatus = "completed" | "blocked" | "failed";

interface LlmBudgetLogEntry {
  ts: string;
  date: string;
  status: LlmBudgetLogStatus;
  inputTokens: number;
  outputTokens?: number;
  maxOutputTokens?: number;
  estimatedCostUsd?: number;
  requestedCostUsd?: number;
  dailySpentBeforeUsd?: number;
  dailyBudgetUsd?: number;
  error?: string;
}

export type BudgetedLlmClient = LlmTextClient & Partial<LlmVisionClient>;

export function createBudgetedLlmClient(opts: BudgetedLlmClientOptions): BudgetedLlmClient {
  validateBudgetOptions(opts);
  const now = opts.now ?? (() => new Date());

  const budgetedClient: BudgetedLlmClient = {
    async generateText(input) {
      return runBudgetedCall({
        opts,
        now,
        inputTokens: estimateTokens(input.system) + estimateTokens(input.user),
        call: () => opts.client.generateText(input),
      });
    },
  };

  if (opts.client.generateTextFromImage) {
    budgetedClient.generateTextFromImage = async (input) => {
      return runBudgetedCall({
        opts,
        now,
        inputTokens:
          estimateTokens(input.system) +
          estimateTokens(input.prompt) +
          estimateImageTokensFromBase64(input.image.dataBase64),
        call: () => opts.client.generateTextFromImage!(input),
      });
    };
  }

  return budgetedClient;
}

async function runBudgetedCall(input: {
  opts: BudgetedLlmClientOptions;
  now: () => Date;
  inputTokens: number;
  call: () => Promise<string>;
}): Promise<string> {
  const currentTime = input.now();
  const date = localDateKey(currentTime);
  const requestedCostUsd = input.opts.pricing
    ? estimateCostUsd(
        input.inputTokens,
        input.opts.pricing.maxOutputTokensPerCall,
        input.opts.pricing,
      )
    : undefined;

  if (
    input.opts.dailyBudgetUsd !== undefined &&
    input.opts.pricing &&
    requestedCostUsd !== undefined
  ) {
    const dailySpentBeforeUsd = await readDailySpentUsd(input.opts.logPath, date);
    if (dailySpentBeforeUsd + requestedCostUsd > input.opts.dailyBudgetUsd) {
      await appendBudgetLog(input.opts.logPath, {
        ts: currentTime.toISOString(),
        date,
        status: "blocked",
        inputTokens: input.inputTokens,
        maxOutputTokens: input.opts.pricing.maxOutputTokensPerCall,
        requestedCostUsd,
        dailySpentBeforeUsd,
        dailyBudgetUsd: input.opts.dailyBudgetUsd,
      });
      throw new Error(
        `LLM 每日预算已用尽：今日已估算 ${formatUsd(
          dailySpentBeforeUsd,
        )}，本次最多 ${formatUsd(requestedCostUsd)}，预算 ${formatUsd(
          input.opts.dailyBudgetUsd,
        )}`,
      );
    }
  }

  try {
    const output = await input.call();
    const outputTokens = estimateTokens(output);
    await appendBudgetLog(input.opts.logPath, {
      ts: currentTime.toISOString(),
      date,
      status: "completed",
      inputTokens: input.inputTokens,
      outputTokens,
      estimatedCostUsd: input.opts.pricing
        ? estimateCostUsd(input.inputTokens, outputTokens, input.opts.pricing)
        : undefined,
      dailyBudgetUsd: input.opts.dailyBudgetUsd,
    });
    return output;
  } catch (err) {
    await appendBudgetLog(input.opts.logPath, {
      ts: currentTime.toISOString(),
      date,
      status: "failed",
      inputTokens: input.inputTokens,
      requestedCostUsd,
      dailyBudgetUsd: input.opts.dailyBudgetUsd,
      error: String(err).slice(0, 500),
    });
    throw err;
  }
}

function validateBudgetOptions(opts: BudgetedLlmClientOptions): void {
  if (opts.dailyBudgetUsd !== undefined && opts.dailyBudgetUsd <= 0) {
    throw new Error("LLM 每日预算必须大于 0");
  }
  if (!opts.pricing) {
    if (opts.dailyBudgetUsd !== undefined) {
      throw new Error("配置 LLM 每日预算时必须配置输入/输出 token 单价");
    }
    return;
  }
  if (
    opts.pricing.inputUsdPerMillionTokens <= 0 ||
    opts.pricing.outputUsdPerMillionTokens <= 0 ||
    opts.pricing.maxOutputTokensPerCall <= 0
  ) {
    throw new Error("LLM token 单价和最大输出 token 必须大于 0");
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateImageTokensFromBase64(dataBase64: string): number {
  // Claude 图片 token 与尺寸相关；这里先用 base64 长度做本地预算近似。
  return Math.ceil(dataBase64.length / 4);
}

function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  pricing: LlmBudgetPricing,
): number {
  return (
    (inputTokens * pricing.inputUsdPerMillionTokens +
      outputTokens * pricing.outputUsdPerMillionTokens) /
    1_000_000
  );
}

async function readDailySpentUsd(logPath: string, date: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(logPath, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return 0;
    throw err;
  }

  return text
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => {
      try {
        const entry = JSON.parse(line) as Partial<LlmBudgetLogEntry>;
        if (
          entry.date === date &&
          entry.status === "completed" &&
          typeof entry.estimatedCostUsd === "number"
        ) {
          return sum + entry.estimatedCostUsd;
        }
      } catch {
        // 手写或截断日志行不参与预算累计，保留后续有效行。
      }
      return sum;
    }, 0);
}

async function appendBudgetLog(logPath: string, entry: LlmBudgetLogEntry): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(dropUndefined(entry))}\n`, "utf8");
}

function dropUndefined(value: LlmBudgetLogEntry): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Record<string, unknown>;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

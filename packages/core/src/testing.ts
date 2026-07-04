/**
 * A scriptable fake LlmClient for offline tests of dream/ask. Instead of hitting
 * the gateway, it returns queued responses (or runs a handler) and records the
 * calls it saw, so tests can assert on prompts and drive deterministic outputs.
 */
import type { CompleteOptions, CompleteResult, JSONOptions } from "@homebrain/llm";
import type { LlmClient } from "./llm.ts";

export interface RecordedCall {
  kind: "complete" | "json";
  opts: CompleteOptions;
}

type JsonHandler = (opts: JSONOptions<unknown>) => unknown;
type TextHandler = (opts: CompleteOptions) => string;

export class FakeLlm implements LlmClient {
  calls: RecordedCall[] = [];
  private jsonQueue: unknown[] = [];
  private textQueue: string[] = [];
  private jsonHandler?: JsonHandler;
  private textHandler?: TextHandler;

  /** Queue a structured (completeJSON) response value. */
  queueJSON(value: unknown): this {
    this.jsonQueue.push(value);
    return this;
  }

  /** Queue a text (complete) response. */
  queueText(text: string): this {
    this.textQueue.push(text);
    return this;
  }

  /** Handle every completeJSON call dynamically (overrides the queue). */
  onJSON(handler: JsonHandler): this {
    this.jsonHandler = handler;
    return this;
  }

  onText(handler: TextHandler): this {
    this.textHandler = handler;
    return this;
  }

  private static result(): CompleteResult {
    return { text: "", model: "fake", inputTokens: 10, outputTokens: 10, costUsd: 0 };
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    this.calls.push({ kind: "complete", opts });
    const text = this.textHandler ? this.textHandler(opts) : this.textQueue.shift() ?? "";
    return { ...FakeLlm.result(), text };
  }

  async completeJSON<T>(opts: JSONOptions<T>): Promise<{ value: T; result: CompleteResult }> {
    this.calls.push({ kind: "json", opts });
    const raw = this.jsonHandler ? this.jsonHandler(opts as JSONOptions<unknown>) : this.jsonQueue.shift();
    if (raw === undefined) throw new Error("FakeLlm: no queued JSON response");
    const value = opts.validate ? opts.validate(raw) : (raw as T);
    return { value, result: FakeLlm.result() };
  }
}

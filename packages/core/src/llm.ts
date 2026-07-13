/**
 * The narrow LLM surface the knowledge engine depends on. Wrapping the gateway
 * behind this interface lets dream/ask be unit-tested with a fake client (no
 * network) and keeps the engine decoupled from the transport (plan R6/R7).
 */
import {
  complete as gwComplete,
  completeJSON as gwCompleteJSON,
  type CompleteOptions,
  type CompleteResult,
  type JSONOptions,
} from "@homebrain/llm";

export interface LlmClient {
  complete(opts: CompleteOptions): Promise<CompleteResult>;
  completeJSON<T>(opts: JSONOptions<T>): Promise<{ value: T; result: CompleteResult }>;
}

/** The production client, backed by the real gateway. */
export const gatewayClient: LlmClient = {
  complete: gwComplete,
  completeJSON: gwCompleteJSON,
};

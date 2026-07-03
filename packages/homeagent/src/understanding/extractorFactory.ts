import type { HomeagentConfig } from "../config";
import type { FetchLike } from "../llm/claude";
import { createConfiguredLlmClient } from "../llm/factory";
import type { LlmTextClient } from "../llm/types";
import {
  createLlmMemoryExtractor,
  createPassthroughExtractor,
  type MemoryExtractor,
} from "./extractor";

export interface MemoryExtractorFactoryOptions {
  fetch?: FetchLike;
  client?: LlmTextClient;
}

export function createMemoryExtractor(
  cfg: HomeagentConfig,
  opts: MemoryExtractorFactoryOptions = {},
): MemoryExtractor {
  const client = opts.client ?? createConfiguredLlmClient(cfg, { fetch: opts.fetch });
  if (!client) return createPassthroughExtractor();

  return createLlmMemoryExtractor({
    client,
  });
}

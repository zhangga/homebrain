import type { HomeagentConfig } from "../config";
import { createBudgetedLlmClient, type BudgetedLlmClient, type LlmBudgetPricing } from "./budget";
import { createClaudeClient, DEFAULT_CLAUDE_MODEL, type FetchLike } from "./claude";

export interface ConfiguredLlmClientOptions {
  fetch?: FetchLike;
  now?: () => Date;
}

export function createConfiguredLlmClient(
  cfg: HomeagentConfig,
  opts: ConfiguredLlmClientOptions = {},
): BudgetedLlmClient | undefined {
  if (!cfg.anthropicApiKey) return undefined;

  const claudeClient = createClaudeClient({
    apiKey: cfg.anthropicApiKey,
    model: cfg.anthropicModel ?? DEFAULT_CLAUDE_MODEL,
    maxTokens: cfg.llmMaxOutputTokensPerCall,
    fetch: opts.fetch,
  });

  return createBudgetedLlmClient({
    client: claudeClient,
    logPath: cfg.llmLogPath,
    dailyBudgetUsd: cfg.llmDailyBudgetUsd,
    pricing: buildPricing(cfg),
    now: opts.now,
  });
}

function buildPricing(cfg: HomeagentConfig): LlmBudgetPricing | undefined {
  if (
    cfg.llmInputUsdPerMillionTokens === undefined ||
    cfg.llmOutputUsdPerMillionTokens === undefined
  ) {
    return undefined;
  }
  return {
    inputUsdPerMillionTokens: cfg.llmInputUsdPerMillionTokens,
    outputUsdPerMillionTokens: cfg.llmOutputUsdPerMillionTokens,
    maxOutputTokensPerCall: cfg.llmMaxOutputTokensPerCall,
  };
}

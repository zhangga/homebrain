/**
 * Central configuration, resolved once from environment variables.
 *
 * Only six env vars are user-facing (see plan §6). ANTHROPIC_BASE_URL /
 * ANTHROPIC_AUTH_TOKEN are injected by the host. Everything else has a sane
 * default so `bun start` works with zero setup beyond the token.
 *
 * Model IDs are the gateway's real identifiers (verified against /v1/models):
 * haiku is used for cheap classification, the default (sonnet) for ask, and a
 * heavy tier (opus) reserved for expensive distillation when warranted.
 */
import { resolve } from "node:path";

export interface Config {
  gatewayBaseUrl: string;
  gatewayToken: string;
  dataDir: string;
  /** default model for ask/distill */
  model: string;
  /** cheap model for intent classification and short judgments */
  modelFast: string;
  /** heavy model reserved for complex synthesis (opt-in) */
  modelHeavy: string;
  dailyBudgetUsd: number;
  webPort: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got ${raw}`);
  return n;
}

let cached: Config | undefined;

export function loadConfig(env = process.env): Config {
  const dataDir = resolve(env.HOMEBRAIN_DATA_DIR ?? "./data");
  return {
    gatewayBaseUrl: (env.ANTHROPIC_BASE_URL ?? req("ANTHROPIC_BASE_URL")).replace(/\/+$/, ""),
    gatewayToken: env.ANTHROPIC_AUTH_TOKEN ?? req("ANTHROPIC_AUTH_TOKEN"),
    dataDir,
    model: env.HOMEBRAIN_LLM_MODEL ?? "claude-sonnet-5",
    modelFast: env.HOMEBRAIN_LLM_MODEL_FAST ?? "claude-haiku-4-5-20251001",
    modelHeavy: env.HOMEBRAIN_LLM_MODEL_HEAVY ?? "claude-opus-4-8",
    dailyBudgetUsd: num("HOMEBRAIN_DAILY_BUDGET_USD", 5),
    webPort: num("HOMEBRAIN_WEB_PORT", 3000),
  };
}

/** Memoized config for the running process. */
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test/rebind helper: clears the memoized config. */
export function resetConfig(): void {
  cached = undefined;
}

/**
 * Call logging + daily budget enforcement.
 *
 * Every gateway call appends one JSON line to data/logs/llm-YYYY-MM-DD.jsonl.
 * The budget tracker sums today's estimated spend and blocks new calls once the
 * cap is hit. Blocking is *advisory by purpose*: the orchestrator passes a
 * `purpose` so that answering (user-facing) can be prioritized while distillation
 * (deferrable) is shed first when the budget is tight.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "@homebrain/shared";

/** Why a call is being made — drives budget prioritization. */
export type CallPurpose = "ask" | "distill" | "classify" | "other";

export interface CallRecord {
  t: string;
  model: string;
  purpose: CallPurpose;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  space?: string;
  ok: boolean;
  ms: number;
}

/** Local YYYY-MM-DD in Asia/Shanghai, the operating timezone for the budget day. */
export function localDay(d = new Date()): string {
  // en-CA gives ISO-like YYYY-MM-DD formatting.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function logDir(): string {
  return join(config().dataDir, "logs");
}

function logPath(day = localDay()): string {
  return join(logDir(), `llm-${day}.jsonl`);
}

export function recordCall(rec: CallRecord): void {
  mkdirSync(logDir(), { recursive: true });
  appendFileSync(logPath(), JSON.stringify(rec) + "\n", "utf8");
}

/** Sum of estimated USD spent so far today. Reads the day's JSONL log. */
export function spentToday(day = localDay()): number {
  const path = logPath(day);
  if (!existsSync(path)) return 0;
  let total = 0;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as CallRecord;
      if (typeof rec.costUsd === "number") total += rec.costUsd;
    } catch {
      // ignore malformed lines; a partial write should not break accounting
    }
  }
  return total;
}

export interface BudgetDecision {
  allowed: boolean;
  spent: number;
  budget: number;
  reason?: string;
}

/**
 * Decide whether a call of `purpose` may proceed under today's budget.
 *
 * Deferrable purposes (distill) are shed at the full cap. User-facing purposes
 * (ask, classify) get a grace multiplier so a conversation is never cut off
 * mid-answer purely by the soft budget — the cap primarily throttles the
 * expensive batch distillation.
 */
export function checkBudget(purpose: CallPurpose, budget = config().dailyBudgetUsd): BudgetDecision {
  const spent = spentToday();
  const deferrable = purpose === "distill" || purpose === "other";
  const limit = deferrable ? budget : budget * 1.5;
  if (spent >= limit) {
    return {
      allowed: false,
      spent,
      budget,
      reason: `daily budget ${deferrable ? "" : "(grace) "}exhausted: $${spent.toFixed(
        4,
      )} >= $${limit.toFixed(2)} for purpose=${purpose}`,
    };
  }
  return { allowed: true, spent, budget };
}

/** Raised when a call is blocked by the budget. Callers may downgrade/defer. */
export class BudgetExceededError extends Error {
  constructor(public decision: BudgetDecision) {
    super(decision.reason ?? "daily budget exceeded");
    this.name = "BudgetExceededError";
  }
}

/** Daily guided-learning delivery with startup catch-up and retry-safe state. */
import { logger } from "@homeagent/shared";
import type {
  KnowledgeEngine,
  LearningDelivery,
  LearningPlan,
  LearningSession,
} from "@homeagent/core";
import { dayKey, localHour, type RuntimeLoopHealth } from "./scheduler.ts";

const log = logger.child("learning-scheduler");

export interface LearningScheduleConfig {
  tickMs: number;
}

export const DEFAULT_LEARNING_SCHEDULE: LearningScheduleConfig = {
  tickMs: 15 * 60 * 1000,
};

export type LearningNotify = LearningDelivery;

export function shouldRunLearningPlan(
  plan: LearningPlan,
  current: LearningSession | undefined,
  now: Date,
): boolean {
  if (plan.status !== "active") return false;
  if (current?.status === "prepared") return true;
  if (current?.status === "awaiting_reply") return false;
  if (localHour(now) < plan.hour) return false;
  return plan.lastDeliveredAt === undefined
    || dayKey(new Date(plan.lastDeliveredAt)) !== dayKey(now);
}

export function learningNotification(
  plan: LearningPlan,
  session: LearningSession,
): string {
  return [
    `📖 ${plan.name} · 第 ${session.sequence} 课`,
    `今日范围：${session.sectionTitle}`,
    "",
    "## 今日原文",
    session.excerpt,
    "",
    session.guide,
    "",
    "读完后回复并 @我，以“学习回答：”开头；如需跳过，发送 `/learn skip <计划名称或序号>`。",
  ].join("\n");
}

export class LearningScheduler {
  private readonly engine: KnowledgeEngine;
  private readonly cfg: LearningScheduleConfig;
  private readonly notify?: LearningNotify;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private started = false;
  private lastStatus?: "ok" | "error";
  private lastTickAt?: number;
  private lastSuccessAt?: number;
  private lastFailureAt?: number;
  private lastReason?: string;
  private lastError?: string;

  constructor(
    engine: KnowledgeEngine,
    opts: { cfg?: Partial<LearningScheduleConfig>; notify?: LearningNotify } = {},
  ) {
    this.engine = engine;
    this.cfg = { ...DEFAULT_LEARNING_SCHEDULE, ...opts.cfg };
    this.notify = opts.notify;
  }

  async start(): Promise<void> {
    this.started = true;
    try {
      await this.tick("startup-catchup");
      this.timer = setInterval(() => {
        void this.tick("interval").catch((error) => {
          log.error("learning scheduler tick failed", { err: String(error) });
        });
      }, this.cfg.tickMs);
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  health(): RuntimeLoopHealth {
    return {
      started: this.started,
      running: this.running,
      lastStatus: this.lastStatus,
      lastTickAt: this.lastTickAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastReason: this.lastReason,
      lastError: this.lastError,
    };
  }

  async tick(reason: string, now = new Date()): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    this.lastTickAt = Date.now();
    this.lastReason = reason;
    const delivered: string[] = [];
    const errors: string[] = [];
    try {
      for (const plan of this.engine.learning.list()) {
        const current = this.engine.learning.currentSession(plan.id);
        if (!shouldRunLearningPlan(plan, current, now)) continue;
        try {
          const advanced = await this.engine.deliverLearningSession(
            plan.id,
            now.getTime(),
            async (currentPlan, source, session) => {
              if (!this.notify) throw new Error("learning notification transport is unavailable");
              await this.notify(currentPlan, source, session);
            },
          );
          if (advanced) delivered.push(plan.id);
        } catch (error) {
          errors.push(`${plan.id}: ${String(error)}`);
          log.error("scheduled learning delivery failed", {
            planId: plan.id,
            err: String(error),
          });
        }
      }
    } catch (error) {
      errors.push(String(error));
      throw error;
    } finally {
      this.running = false;
      if (errors.length === 0) {
        this.lastStatus = "ok";
        this.lastSuccessAt = Date.now();
        this.lastError = undefined;
      } else {
        this.lastStatus = "error";
        this.lastFailureAt = Date.now();
        this.lastError = errors.join("; ").slice(0, 500);
      }
    }
    return delivered;
  }
}

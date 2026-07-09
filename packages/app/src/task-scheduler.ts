/**
 * Task scheduler (task-execution platform). A coarse-tick loop mirroring the
 * dream Scheduler (scheduler.ts): it wakes on an interval (and once at startup)
 * and runs any enabled task whose cadence is due. The run/skip decision is a
 * pure function (shouldRunTask) so the policy is unit-tested without timers.
 *
 * Each task has its own cadence (hourly / daily-at-hour); unlike the dream
 * scheduler's single global hour, cadence is per task. On success, if the task
 * opts in and its space is bound to a feishu chat, a summary is pushed via the
 * optional notify callback (wired to connector.notice in main.ts).
 */
import { logger } from "@homebrain/shared";
import type { KnowledgeEngine, Task, TaskReport } from "@homebrain/core";
import { localHour, dayKey } from "./scheduler.ts";

const log = logger.child("task-scheduler");

export interface TaskScheduleConfig {
  /** wake cadence in ms; default 15 min */
  tickMs: number;
}

export const DEFAULT_TASK_SCHEDULE: TaskScheduleConfig = {
  tickMs: 15 * 60 * 1000,
};

/**
 * Decide whether a task should run now. Runs when enabled AND:
 *   - never run before, OR
 *   - hourly: last run >= ~1h ago, OR
 *   - daily: at/after its hour and not yet run today.
 */
export function shouldRunTask(task: Task, now: Date): boolean {
  if (!task.enabled) return false;
  if (task.lastRunAt === undefined) return true;

  if (task.cadence === "hourly") {
    return now.getTime() - task.lastRunAt >= 3600_000;
  }
  // daily
  if (localHour(now) >= task.hour) {
    return dayKey(new Date(task.lastRunAt)) !== dayKey(now);
  }
  return false;
}

/** Called after a successful run when the task opts into notifications. */
export type TaskNotify = (task: Task, report: TaskReport) => void | Promise<void>;

export class TaskScheduler {
  private engine: KnowledgeEngine;
  private cfg: TaskScheduleConfig;
  private notify?: TaskNotify;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(engine: KnowledgeEngine, opts: { cfg?: Partial<TaskScheduleConfig>; notify?: TaskNotify } = {}) {
    this.engine = engine;
    this.cfg = { ...DEFAULT_TASK_SCHEDULE, ...opts.cfg };
    this.notify = opts.notify;
  }

  /** Start the loop and run an immediate catch-up pass. */
  async start(): Promise<void> {
    await this.tick("startup-catchup");
    this.timer = setInterval(() => void this.tick("interval"), this.cfg.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One scheduling pass over all tasks. Exposed for tests. Returns ids that ran. */
  async tick(reason: string, now = new Date()): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    const ran: string[] = [];
    try {
      for (const task of this.engine.tasks.list()) {
        if (!shouldRunTask(task, now)) continue;
        log.info("running scheduled task", { taskId: task.id, space: task.space, reason });
        try {
          const report = await this.engine.runTask(task.id);
          ran.push(task.id);
          if (report.ok && task.notify && this.notify) {
            await this.notify(task, report);
          }
        } catch (err) {
          log.error("scheduled task failed", { taskId: task.id, err: String(err) });
        }
      }
    } finally {
      this.running = false;
    }
    return ran;
  }
}

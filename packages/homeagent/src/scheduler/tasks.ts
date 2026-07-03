import type { Connector } from "../connectors/types";
import { dispatchDuePortions } from "../tasks/dispatcher";
import type { TaskStore } from "../tasks/store";

export const DEFAULT_TASK_DISPATCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type TaskDispatchTickResult =
  | { skipped: false; date: string; dispatched: number }
  | { skipped: true; reason: "missing_channel" };

export interface TaskDispatchTickOptions {
  taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched">;
  connector: Pick<Connector, "sendMessage">;
  channelId?: string;
  now?: () => Date;
}

export interface TaskDispatchSchedulerOptions extends TaskDispatchTickOptions {
  intervalMs?: number;
  runOnStart?: boolean;
  setTimer?: (callback: () => void, intervalMs: number) => unknown;
  clearTimer?: (timerId: unknown) => void;
  onError?: (err: unknown) => void;
}

export interface TaskDispatchScheduler {
  tick(): Promise<TaskDispatchTickResult>;
  idle(): Promise<void>;
  stop(): void;
}

/** 单次任务派发 tick：cron/入口/测试都走这一条路径。 */
export async function runTaskDispatchTick(
  opts: TaskDispatchTickOptions,
): Promise<TaskDispatchTickResult> {
  if (!opts.channelId) return { skipped: true, reason: "missing_channel" };

  const date = toDateKey((opts.now ?? (() => new Date()))());
  const result = await dispatchDuePortions({
    taskStore: opts.taskStore,
    connector: opts.connector,
    channelId: opts.channelId,
    date,
  });

  return { skipped: false, date, dispatched: result.dispatched };
}

/** 极薄的 interval wrapper；生产里保持常驻，测试里注入 timer。 */
export function startTaskDispatchScheduler(
  opts: TaskDispatchSchedulerOptions,
): TaskDispatchScheduler {
  const setTimer = opts.setTimer ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const clearTimer =
    opts.clearTimer ?? ((timerId) => clearInterval(timerId as ReturnType<typeof setInterval>));
  const intervalMs = opts.intervalMs ?? DEFAULT_TASK_DISPATCH_INTERVAL_MS;

  let lastRun: Promise<void> = Promise.resolve();
  const runScheduledTick = () => {
    lastRun = runTaskDispatchTick(opts).then(
      () => undefined,
      (err) => {
        opts.onError?.(err);
      },
    );
  };

  const timerId = setTimer(runScheduledTick, intervalMs);
  if (opts.runOnStart) runScheduledTick();

  return {
    tick: () => runTaskDispatchTick(opts),
    idle: () => lastRun,
    stop: () => clearTimer(timerId),
  };
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

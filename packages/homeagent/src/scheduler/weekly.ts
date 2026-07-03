import type { Connector } from "../connectors/types";

export const DEFAULT_WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface WeeklyBrain {
  ask(input: { question: string }): Promise<{ answer: string }>;
}

export type WeeklyTickResult =
  | { skipped: false; weekStart: string; weekEnd: string }
  | { skipped: true; reason: "missing_channel" };

export interface WeeklyTickOptions {
  brain: WeeklyBrain;
  connector: Pick<Connector, "sendMessage">;
  channelId?: string;
  now?: () => Date;
}

export interface WeeklySchedulerOptions extends WeeklyTickOptions {
  intervalMs?: number;
  runOnStart?: boolean;
  setTimer?: (callback: () => void, intervalMs: number) => unknown;
  clearTimer?: (timerId: unknown) => void;
  onError?: (err: unknown) => void;
}

export interface WeeklyScheduler {
  tick(): Promise<WeeklyTickResult>;
  idle(): Promise<void>;
  stop(): void;
}

/** 单次家庭周报：按本周范围问 homebrain，再发到配置频道。 */
export async function runWeeklyTick(
  opts: WeeklyTickOptions,
): Promise<WeeklyTickResult> {
  if (!opts.channelId) return { skipped: true, reason: "missing_channel" };

  const now = (opts.now ?? (() => new Date()))();
  const today = toDateKey(now);
  const { weekStart, weekEnd } = weekRange(now);
  const result = await opts.brain.ask({
    question: buildWeeklyQuestion({ today, weekStart, weekEnd }),
  });
  await opts.connector.sendMessage({
    channelId: opts.channelId,
    text: `家庭周报（${weekStart} 至 ${weekEnd}）\n${result.answer}`,
  });

  return { skipped: false, weekStart, weekEnd };
}

/** 极薄的 interval wrapper；生产里保持常驻，测试里注入 timer。 */
export function startWeeklyScheduler(opts: WeeklySchedulerOptions): WeeklyScheduler {
  const setTimer = opts.setTimer ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const clearTimer =
    opts.clearTimer ?? ((timerId) => clearInterval(timerId as ReturnType<typeof setInterval>));
  const intervalMs = opts.intervalMs ?? DEFAULT_WEEKLY_INTERVAL_MS;

  let lastRun: Promise<void> = Promise.resolve();
  const runScheduledTick = () => {
    lastRun = runWeeklyTick(opts).then(
      () => undefined,
      (err) => {
        opts.onError?.(err);
      },
    );
  };

  const timerId = setTimer(runScheduledTick, intervalMs);
  if (opts.runOnStart) runScheduledTick();

  return {
    tick: () => runWeeklyTick(opts),
    idle: () => lastRun,
    stop: () => clearTimer(timerId),
  };
}

function buildWeeklyQuestion(input: {
  today: string;
  weekStart: string;
  weekEnd: string;
}): string {
  return `今天是 ${input.today}。本周范围是 ${input.weekStart} 到 ${input.weekEnd}。请生成家庭周报：总结本周家里发生的事情、孩子进展、待跟进事项，回答简洁。`;
}

function weekRange(date: Date): { weekStart: string; weekEnd: string } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = start.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  start.setUTCDate(start.getUTCDate() + mondayOffset);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { weekStart: toDateKey(start), weekEnd: toDateKey(end) };
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

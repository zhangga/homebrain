import type { Connector } from "../connectors/types";

export const DEFAULT_ON_THIS_DAY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface OnThisDayMemory {
  slug: string;
  title?: string;
  occurredAt?: string;
}

export interface OnThisDayBrain {
  recall(input: { from: string; to: string }): Promise<OnThisDayMemory[]>;
}

export type OnThisDayTickResult =
  | { skipped: false; from: string; to: string; recalled: number }
  | { skipped: true; reason: "missing_channel" }
  | { skipped: true; reason: "empty_recall"; from: string; to: string };

export interface OnThisDayTickOptions {
  brain: OnThisDayBrain;
  connector: Pick<Connector, "sendMessage">;
  channelId?: string;
  now?: () => Date;
}

export interface OnThisDaySchedulerOptions extends OnThisDayTickOptions {
  intervalMs?: number;
  runOnStart?: boolean;
  setTimer?: (callback: () => void, intervalMs: number) => unknown;
  clearTimer?: (timerId: unknown) => void;
  onError?: (err: unknown) => void;
}

export interface OnThisDayScheduler {
  tick(): Promise<OnThisDayTickResult>;
  idle(): Promise<void>;
  stop(): void;
}

/** 单次那年今日：查询去年今日前后一天，有内容才发。 */
export async function runOnThisDayTick(
  opts: OnThisDayTickOptions,
): Promise<OnThisDayTickResult> {
  if (!opts.channelId) return { skipped: true, reason: "missing_channel" };

  const { from, to } = lastYearWindow((opts.now ?? (() => new Date()))());
  const memories = await opts.brain.recall({ from, to });
  if (memories.length === 0) return { skipped: true, reason: "empty_recall", from, to };

  await opts.connector.sendMessage({
    channelId: opts.channelId,
    text: formatOnThisDayMessage({ from, to, memories }),
  });

  return { skipped: false, from, to, recalled: memories.length };
}

/** 极薄的 interval wrapper；生产里保持常驻，测试里注入 timer。 */
export function startOnThisDayScheduler(
  opts: OnThisDaySchedulerOptions,
): OnThisDayScheduler {
  const setTimer = opts.setTimer ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const clearTimer =
    opts.clearTimer ?? ((timerId) => clearInterval(timerId as ReturnType<typeof setInterval>));
  const intervalMs = opts.intervalMs ?? DEFAULT_ON_THIS_DAY_INTERVAL_MS;

  let lastRun: Promise<void> = Promise.resolve();
  const runScheduledTick = () => {
    lastRun = runOnThisDayTick(opts).then(
      () => undefined,
      (err) => {
        opts.onError?.(err);
      },
    );
  };

  const timerId = setTimer(runScheduledTick, intervalMs);
  if (opts.runOnStart) runScheduledTick();

  return {
    tick: () => runOnThisDayTick(opts),
    idle: () => lastRun,
    stop: () => clearTimer(timerId),
  };
}

function formatOnThisDayMessage(input: {
  from: string;
  to: string;
  memories: OnThisDayMemory[];
}): string {
  const lines = input.memories.map((memory) => {
    const date = memory.occurredAt ?? "未知日期";
    return `- ${date} ${memory.title ?? memory.slug}`;
  });
  return [`那年今日（${input.from} 至 ${input.to}）`, ...lines].join("\n");
}

function lastYearWindow(date: Date): { from: string; to: string } {
  const center = new Date(Date.UTC(date.getUTCFullYear() - 1, date.getUTCMonth(), date.getUTCDate()));
  const from = new Date(center);
  from.setUTCDate(center.getUTCDate() - 1);
  const to = new Date(center);
  to.setUTCDate(center.getUTCDate() + 1);
  return { from: toDateKey(from), to: toDateKey(to) };
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

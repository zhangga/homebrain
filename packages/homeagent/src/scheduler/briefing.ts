import type { Connector } from "../connectors/types";

export const DEFAULT_BRIEFING_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface BriefingBrain {
  ask(input: { question: string }): Promise<{ answer: string }>;
}

export type BriefingTickResult =
  | { skipped: false; date: string }
  | { skipped: true; reason: "missing_channel" };

export interface BriefingTickOptions {
  brain: BriefingBrain;
  connector: Pick<Connector, "sendMessage">;
  channelId?: string;
  now?: () => Date;
}

export interface BriefingSchedulerOptions extends BriefingTickOptions {
  intervalMs?: number;
  runOnStart?: boolean;
  setTimer?: (callback: () => void, intervalMs: number) => unknown;
  clearTimer?: (timerId: unknown) => void;
  onError?: (err: unknown) => void;
}

export interface BriefingScheduler {
  tick(): Promise<BriefingTickResult>;
  idle(): Promise<void>;
  stop(): void;
}

/** 单次家庭早报：问 homebrain，再发到配置频道。 */
export async function runBriefingTick(
  opts: BriefingTickOptions,
): Promise<BriefingTickResult> {
  if (!opts.channelId) return { skipped: true, reason: "missing_channel" };

  const date = toDateKey((opts.now ?? (() => new Date()))());
  const result = await opts.brain.ask({ question: buildBriefingQuestion(date) });
  await opts.connector.sendMessage({
    channelId: opts.channelId,
    text: `家庭早报（${date}）\n${result.answer}`,
  });

  return { skipped: false, date };
}

/** 极薄的 interval wrapper；生产里保持常驻，测试里注入 timer。 */
export function startBriefingScheduler(
  opts: BriefingSchedulerOptions,
): BriefingScheduler {
  const setTimer = opts.setTimer ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const clearTimer =
    opts.clearTimer ?? ((timerId) => clearInterval(timerId as ReturnType<typeof setInterval>));
  const intervalMs = opts.intervalMs ?? DEFAULT_BRIEFING_INTERVAL_MS;

  let lastRun: Promise<void> = Promise.resolve();
  const runScheduledTick = () => {
    lastRun = runBriefingTick(opts).then(
      () => undefined,
      (err) => {
        opts.onError?.(err);
      },
    );
  };

  const timerId = setTimer(runScheduledTick, intervalMs);
  if (opts.runOnStart) runScheduledTick();

  return {
    tick: () => runBriefingTick(opts),
    idle: () => lastRun,
    stop: () => clearTimer(timerId),
  };
}

function buildBriefingQuestion(date: string): string {
  return `今天是 ${date}。请生成今天的家庭早报：提醒今天的安排、待办、重要信息，回答简洁。`;
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

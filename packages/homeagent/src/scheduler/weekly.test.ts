import { expect, test } from "bun:test";
import type { Connector, OutgoingMessage } from "../connectors/types";
import { runWeeklyTick, startWeeklyScheduler } from "./weekly";

class FakeConnector implements Pick<Connector, "sendMessage"> {
  readonly sent: OutgoingMessage[] = [];

  async sendMessage(msg: OutgoingMessage): Promise<void> {
    this.sent.push(msg);
  }
}

class FakeBrain {
  readonly askCalls: Array<{ question: string }> = [];

  async ask(input: { question: string }): Promise<{ answer: string; citations: [] }> {
    this.askCalls.push(input);
    return { answer: "本周完成了英语复习，周末要准备科学小实验。", citations: [] };
  }
}

test("runWeeklyTick：询问 homebrain 并发送家庭周报", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain();

  const result = await runWeeklyTick({
    brain,
    connector,
    channelId: "family",
    now: () => new Date("2026-06-24T20:00:00.000Z"),
  });

  expect(result).toEqual({
    skipped: false,
    weekStart: "2026-06-22",
    weekEnd: "2026-06-28",
  });
  expect(brain.askCalls).toEqual([
    {
      question:
        "今天是 2026-06-24。本周范围是 2026-06-22 到 2026-06-28。请生成家庭周报：总结本周家里发生的事情、孩子进展、待跟进事项，回答简洁。",
    },
  ]);
  expect(connector.sent).toEqual([
    {
      channelId: "family",
      text: "家庭周报（2026-06-22 至 2026-06-28）\n本周完成了英语复习，周末要准备科学小实验。",
    },
  ]);
});

test("runWeeklyTick：未配置频道时跳过", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain();

  const result = await runWeeklyTick({
    brain,
    connector,
    now: () => new Date("2026-06-24T20:00:00.000Z"),
  });

  expect(result).toEqual({ skipped: true, reason: "missing_channel" });
  expect(brain.askCalls).toEqual([]);
  expect(connector.sent).toEqual([]);
});

test("startWeeklyScheduler：按 interval 注册 tick，stop 时清理", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain();
  const intervals: Array<() => void> = [];
  const cleared: unknown[] = [];

  const scheduler = startWeeklyScheduler({
    brain,
    connector,
    channelId: "family",
    intervalMs: 7_000,
    now: () => new Date("2026-06-24T20:00:00.000Z"),
    setTimer(callback, intervalMs) {
      expect(intervalMs).toBe(7_000);
      intervals.push(callback);
      return "weekly-timer";
    },
    clearTimer(timerId) {
      cleared.push(timerId);
    },
  });

  expect(intervals).toHaveLength(1);
  intervals[0]!();
  await scheduler.idle();
  expect(connector.sent).toEqual([
    {
      channelId: "family",
      text: "家庭周报（2026-06-22 至 2026-06-28）\n本周完成了英语复习，周末要准备科学小实验。",
    },
  ]);

  scheduler.stop();
  expect(cleared).toEqual(["weekly-timer"]);
});

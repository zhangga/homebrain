import { expect, test } from "bun:test";
import type { Connector, OutgoingMessage } from "../connectors/types";
import { runBriefingTick, startBriefingScheduler } from "./briefing";

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
    return { answer: "今天记得带校服，晚上 8 点复习英语。", citations: [] };
  }
}

test("runBriefingTick：询问 homebrain 并发送家庭早报", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain();

  const result = await runBriefingTick({
    brain,
    connector,
    channelId: "family",
    now: () => new Date("2026-06-24T07:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, date: "2026-06-24" });
  expect(brain.askCalls).toEqual([
    {
      question:
        "今天是 2026-06-24。请生成今天的家庭早报：提醒今天的安排、待办、重要信息，回答简洁。",
    },
  ]);
  expect(connector.sent).toEqual([
    {
      channelId: "family",
      text: "家庭早报（2026-06-24）\n今天记得带校服，晚上 8 点复习英语。",
    },
  ]);
});

test("runBriefingTick：未配置频道时跳过", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain();

  const result = await runBriefingTick({
    brain,
    connector,
    now: () => new Date("2026-06-24T07:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: true, reason: "missing_channel" });
  expect(brain.askCalls).toEqual([]);
  expect(connector.sent).toEqual([]);
});

test("startBriefingScheduler：按 interval 注册 tick，stop 时清理", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain();
  const intervals: Array<() => void> = [];
  const cleared: unknown[] = [];

  const scheduler = startBriefingScheduler({
    brain,
    connector,
    channelId: "family",
    intervalMs: 1_000,
    now: () => new Date("2026-06-24T07:30:00.000Z"),
    setTimer(callback, intervalMs) {
      expect(intervalMs).toBe(1_000);
      intervals.push(callback);
      return 11;
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
      text: "家庭早报（2026-06-24）\n今天记得带校服，晚上 8 点复习英语。",
    },
  ]);

  scheduler.stop();
  expect(cleared).toEqual([11]);
});

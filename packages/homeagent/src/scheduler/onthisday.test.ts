import { expect, test } from "bun:test";
import type { Connector, OutgoingMessage } from "../connectors/types";
import { runOnThisDayTick, startOnThisDayScheduler } from "./onthisday";

class FakeConnector implements Pick<Connector, "sendMessage"> {
  readonly sent: OutgoingMessage[] = [];

  async sendMessage(msg: OutgoingMessage): Promise<void> {
    this.sent.push(msg);
  }
}

class FakeBrain {
  readonly recallCalls: Array<{ from: string; to: string }> = [];

  constructor(
    private readonly memories: Array<{ slug: string; title?: string; occurredAt?: string }>,
  ) {}

  async recall(input: { from: string; to: string }): Promise<
    Array<{ slug: string; title?: string; occurredAt?: string }>
  > {
    this.recallCalls.push(input);
    return this.memories;
  }
}

test("runOnThisDayTick：查询去年今日窗口并发送那年今日", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain([
    {
      slug: "inbox/2025-06-24-family-trip",
      title: "# 全家去了海边",
      occurredAt: "2025-06-24",
    },
    {
      slug: "inbox/2025-06-25-school",
      title: "# 第一次做科学实验",
      occurredAt: "2025-06-25",
    },
  ]);

  const result = await runOnThisDayTick({
    brain,
    connector,
    channelId: "family",
    now: () => new Date("2026-06-24T08:00:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, from: "2025-06-23", to: "2025-06-25", recalled: 2 });
  expect(brain.recallCalls).toEqual([{ from: "2025-06-23", to: "2025-06-25" }]);
  expect(connector.sent).toEqual([
    {
      channelId: "family",
      text:
        "那年今日（2025-06-23 至 2025-06-25）\n" +
        "- 2025-06-24 # 全家去了海边\n" +
        "- 2025-06-25 # 第一次做科学实验",
    },
  ]);
});

test("runOnThisDayTick：没有回忆时不发送", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain([]);

  const result = await runOnThisDayTick({
    brain,
    connector,
    channelId: "family",
    now: () => new Date("2026-06-24T08:00:00.000Z"),
  });

  expect(result).toEqual({ skipped: true, reason: "empty_recall", from: "2025-06-23", to: "2025-06-25" });
  expect(connector.sent).toEqual([]);
});

test("runOnThisDayTick：未配置频道时跳过", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain([{ slug: "x" }]);

  const result = await runOnThisDayTick({
    brain,
    connector,
    now: () => new Date("2026-06-24T08:00:00.000Z"),
  });

  expect(result).toEqual({ skipped: true, reason: "missing_channel" });
  expect(brain.recallCalls).toEqual([]);
  expect(connector.sent).toEqual([]);
});

test("startOnThisDayScheduler：按 interval 注册 tick，stop 时清理", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain([{ slug: "inbox/2025-06-24", title: "# 去年今日", occurredAt: "2025-06-24" }]);
  const intervals: Array<() => void> = [];
  const cleared: unknown[] = [];

  const scheduler = startOnThisDayScheduler({
    brain,
    connector,
    channelId: "family",
    intervalMs: 1_000,
    now: () => new Date("2026-06-24T08:00:00.000Z"),
    setTimer(callback, intervalMs) {
      expect(intervalMs).toBe(1_000);
      intervals.push(callback);
      return "onthisday-timer";
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
      text: "那年今日（2025-06-23 至 2025-06-25）\n- 2025-06-24 # 去年今日",
    },
  ]);

  scheduler.stop();
  expect(cleared).toEqual(["onthisday-timer"]);
});

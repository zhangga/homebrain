import { expect, test } from "bun:test";
import type { Connector, OutgoingMessage } from "../connectors/types";
import type { DuePortion, TaskStore } from "../tasks/store";
import { runTaskDispatchTick, startTaskDispatchScheduler } from "./tasks";

class FakeConnector implements Pick<Connector, "sendMessage"> {
  readonly sent: OutgoingMessage[] = [];

  async sendMessage(msg: OutgoingMessage): Promise<void> {
    this.sent.push(msg);
  }
}

test("runTaskDispatchTick：按当天日期派发任务份额", async () => {
  const connector = new FakeConnector();
  const portion: DuePortion = {
    goalId: "goal-1",
    memberSlug: "kid",
    title: "小王子",
    date: "2026-06-24",
    unitFrom: 1,
    unitTo: 4,
    dispatched: false,
  };
  const marked: Array<{ goalId: string; date: string }> = [];
  const taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched"> = {
    listDuePortions(filter) {
      expect(filter).toEqual({ date: "2026-06-24" });
      return [portion];
    },
    markPortionDispatched(input) {
      marked.push(input);
    },
  };

  const result = await runTaskDispatchTick({
    taskStore,
    connector,
    channelId: "family",
    now: () => new Date("2026-06-24T09:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, date: "2026-06-24", dispatched: 1 });
  expect(connector.sent).toEqual([
    { channelId: "family", text: "今日任务：kid 读《小王子》第 1-4 单元" },
  ]);
  expect(marked).toEqual([{ goalId: "goal-1", date: "2026-06-24" }]);
});

test("runTaskDispatchTick：未配置频道时跳过派发", async () => {
  const connector = new FakeConnector();
  const taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched"> = {
    listDuePortions() {
      throw new Error("不应查询任务");
    },
    markPortionDispatched() {
      throw new Error("不应标记任务");
    },
  };

  const result = await runTaskDispatchTick({
    taskStore,
    connector,
    now: () => new Date("2026-06-24T09:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: true, reason: "missing_channel" });
  expect(connector.sent).toEqual([]);
});

test("startTaskDispatchScheduler：按 interval 注册 tick，stop 时清理", async () => {
  const connector = new FakeConnector();
  const taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched"> = {
    listDuePortions() {
      return [];
    },
    markPortionDispatched() {
      throw new Error("无待派发任务时不应标记");
    },
  };
  const intervals: Array<() => void> = [];
  const cleared: unknown[] = [];

  const scheduler = startTaskDispatchScheduler({
    taskStore,
    connector,
    channelId: "family",
    intervalMs: 1_000,
    now: () => new Date("2026-06-24T09:30:00.000Z"),
    setTimer(callback, intervalMs) {
      expect(intervalMs).toBe(1_000);
      intervals.push(callback);
      return 7;
    },
    clearTimer(timerId) {
      cleared.push(timerId);
    },
  });

  expect(intervals).toHaveLength(1);
  intervals[0]!();
  await scheduler.idle();
  expect(connector.sent).toEqual([]);

  scheduler.stop();
  expect(cleared).toEqual([7]);
});

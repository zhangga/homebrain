import { expect, test } from "bun:test";
import type { Connector, OutgoingMessage } from "../connectors/types";
import type { MemberRecord } from "../members/store";
import type { DuePortion, TaskStore } from "../tasks/store";
import { startHomeagentSchedulers } from "./index";

class FakeConnector implements Pick<Connector, "sendMessage"> {
  readonly sent: OutgoingMessage[] = [];

  async sendMessage(msg: OutgoingMessage): Promise<void> {
    this.sent.push(msg);
  }
}

class FakeBrain {
  readonly askCalls: Array<{ question: string }> = [];
  readonly recallCalls: Array<{ from: string; to: string }> = [];

  async ask(input: { question: string }): Promise<{ answer: string; citations: [] }> {
    this.askCalls.push(input);
    return { answer: "今天 8 点复习英语。", citations: [] };
  }

  async recall(input: { from: string; to: string }): Promise<
    Array<{ slug: string; title?: string; occurredAt?: string }>
  > {
    this.recallCalls.push(input);
    return [{ slug: "inbox/2025-06-24", title: "# 去年今日", occurredAt: "2025-06-24" }];
  }
}

test("startHomeagentSchedulers：配置频道后启动任务派发 scheduler", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain();
  const portion: DuePortion = {
    goalId: "goal-1",
    memberSlug: "kid",
    title: "小王子",
    date: "2026-06-24",
    unitFrom: 2,
    unitTo: 2,
    dispatched: false,
  };
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  const taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched"> = {
    listDuePortions(filter) {
      expect(filter).toEqual({ date: "2026-06-24" });
      return [portion];
    },
    markPortionDispatched() {},
  };

  const schedulers = startHomeagentSchedulers({
    cfg: {
      taskDispatchChannelId: "family",
      taskDispatchIntervalMs: 60_000,
      taskDispatchOnStart: true,
      briefingIntervalMs: 120_000,
      briefingOnStart: false,
      weeklyIntervalMs: 604_800_000,
      weeklyOnStart: false,
      onThisDayIntervalMs: 86_400_000,
      onThisDayOnStart: false,
    },
    brain,
    connector,
    taskStore,
    now: () => new Date("2026-06-24T09:30:00.000Z"),
    setTaskTimer(callback, intervalMs) {
      expect(intervalMs).toBe(60_000);
      timers.push(callback);
      return 9;
    },
    clearTaskTimer(timerId) {
      cleared.push(timerId);
    },
  });

  await schedulers.idle();
  expect(timers).toHaveLength(1);
  expect(connector.sent).toEqual([
    { channelId: "family", text: "今日任务：kid 读《小王子》第 2 单元" },
  ]);

  schedulers.stop();
  expect(cleared).toEqual([9]);
});

test("startHomeagentSchedulers：未配置任务频道时不启动派发 timer", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain();
  const taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched"> = {
    listDuePortions() {
      throw new Error("不应查询任务");
    },
    markPortionDispatched() {
      throw new Error("不应标记任务");
    },
  };

  const schedulers = startHomeagentSchedulers({
    cfg: {
      taskDispatchIntervalMs: 60_000,
      taskDispatchOnStart: true,
      briefingIntervalMs: 120_000,
      briefingOnStart: true,
      weeklyIntervalMs: 604_800_000,
      weeklyOnStart: true,
      onThisDayIntervalMs: 86_400_000,
      onThisDayOnStart: true,
    },
    brain,
    connector,
    taskStore,
    setTaskTimer() {
      throw new Error("不应启动 timer");
    },
  });

  await schedulers.idle();
  expect(connector.sent).toEqual([]);
  schedulers.stop();
});

test("startHomeagentSchedulers：配置早报频道后启动 briefing scheduler", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain();
  const briefingTimers: Array<() => void> = [];
  const cleared: unknown[] = [];
  const taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched"> = {
    listDuePortions() {
      throw new Error("不应查询任务");
    },
    markPortionDispatched() {
      throw new Error("不应标记任务");
    },
  };

  const schedulers = startHomeagentSchedulers({
    cfg: {
      taskDispatchIntervalMs: 60_000,
      taskDispatchOnStart: false,
      briefingChannelId: "briefing",
      briefingIntervalMs: 120_000,
      briefingOnStart: true,
      weeklyIntervalMs: 604_800_000,
      weeklyOnStart: false,
      onThisDayIntervalMs: 86_400_000,
      onThisDayOnStart: false,
    },
    brain,
    connector,
    taskStore,
    now: () => new Date("2026-06-24T07:30:00.000Z"),
    setBriefingTimer(callback, intervalMs) {
      expect(intervalMs).toBe(120_000);
      briefingTimers.push(callback);
      return "briefing-timer";
    },
    clearBriefingTimer(timerId) {
      cleared.push(timerId);
    },
  });

  await schedulers.idle();
  expect(briefingTimers).toHaveLength(1);
  expect(brain.askCalls).toEqual([
    {
      question:
        "今天是 2026-06-24。请生成今天的家庭早报：提醒今天的安排、待办、重要信息，回答简洁。",
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "briefing", text: "家庭早报（2026-06-24）\n今天 8 点复习英语。" },
  ]);

  schedulers.stop();
  expect(cleared).toEqual(["briefing-timer"]);
});

test("startHomeagentSchedulers：配置周报频道后启动 weekly scheduler", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain();
  const weeklyTimers: Array<() => void> = [];
  const cleared: unknown[] = [];
  const taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched"> = {
    listDuePortions() {
      throw new Error("不应查询任务");
    },
    markPortionDispatched() {
      throw new Error("不应标记任务");
    },
  };

  const schedulers = startHomeagentSchedulers({
    cfg: {
      taskDispatchIntervalMs: 60_000,
      taskDispatchOnStart: false,
      briefingIntervalMs: 120_000,
      briefingOnStart: false,
      weeklyChannelId: "weekly",
      weeklyIntervalMs: 604_800_000,
      weeklyOnStart: true,
      onThisDayIntervalMs: 86_400_000,
      onThisDayOnStart: false,
    },
    brain,
    connector,
    taskStore,
    now: () => new Date("2026-06-24T20:00:00.000Z"),
    setWeeklyTimer(callback, intervalMs) {
      expect(intervalMs).toBe(604_800_000);
      weeklyTimers.push(callback);
      return "weekly-timer";
    },
    clearWeeklyTimer(timerId) {
      cleared.push(timerId);
    },
  });

  await schedulers.idle();
  expect(weeklyTimers).toHaveLength(1);
  expect(brain.askCalls).toEqual([
    {
      question:
        "今天是 2026-06-24。本周范围是 2026-06-22 到 2026-06-28。请生成家庭周报：总结本周家里发生的事情、孩子进展、待跟进事项，回答简洁。",
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "weekly", text: "家庭周报（2026-06-22 至 2026-06-28）\n今天 8 点复习英语。" },
  ]);

  schedulers.stop();
  expect(cleared).toEqual(["weekly-timer"]);
});

test("startHomeagentSchedulers：配置那年今日频道后启动 onthisday scheduler", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain();
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  const taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched"> = {
    listDuePortions() {
      throw new Error("不应查询任务");
    },
    markPortionDispatched() {
      throw new Error("不应标记任务");
    },
  };

  const schedulers = startHomeagentSchedulers({
    cfg: {
      taskDispatchIntervalMs: 60_000,
      taskDispatchOnStart: false,
      briefingIntervalMs: 120_000,
      briefingOnStart: false,
      weeklyIntervalMs: 604_800_000,
      weeklyOnStart: false,
      onThisDayChannelId: "memory",
      onThisDayIntervalMs: 86_400_000,
      onThisDayOnStart: true,
    },
    brain,
    connector,
    taskStore,
    now: () => new Date("2026-06-24T08:00:00.000Z"),
    setOnThisDayTimer(callback, intervalMs) {
      expect(intervalMs).toBe(86_400_000);
      timers.push(callback);
      return "onthisday-timer";
    },
    clearOnThisDayTimer(timerId) {
      cleared.push(timerId);
    },
  });

  await schedulers.idle();
  expect(timers).toHaveLength(1);
  expect(brain.recallCalls).toEqual([{ from: "2025-06-23", to: "2025-06-25" }]);
  expect(connector.sent).toEqual([
    { channelId: "memory", text: "那年今日（2025-06-23 至 2025-06-25）\n- 2025-06-24 # 去年今日" },
  ]);

  schedulers.stop();
  expect(cleared).toEqual(["onthisday-timer"]);
});

test("startHomeagentSchedulers：启用画像刷新后启动 profile scheduler", async () => {
  const connector = new FakeConnector();
  const brain = new FakeBrain();
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  const updates: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched"> = {
    listDuePortions() {
      throw new Error("不应查询任务");
    },
    markPortionDispatched() {
      throw new Error("不应标记任务");
    },
  };
  const members: MemberRecord[] = [
    { connector: "cli", externalId: "local", slug: "dad", displayName: "Dad" },
  ];

  const schedulers = startHomeagentSchedulers({
    cfg: {
      taskDispatchIntervalMs: 60_000,
      taskDispatchOnStart: false,
      briefingIntervalMs: 120_000,
      briefingOnStart: false,
      weeklyIntervalMs: 604_800_000,
      weeklyOnStart: false,
      onThisDayIntervalMs: 86_400_000,
      onThisDayOnStart: false,
      profileRefreshEnabled: true,
      profileRefreshIntervalMs: 3_600_000,
      profileRefreshOnStart: true,
    },
    brain,
    connector,
    taskStore,
    memberStore: { listMembers: () => members },
    profileUpdater: {
      async updateFromFacts(input) {
        updates.push(input.member);
        return { updated: true };
      },
    },
    now: () => new Date("2026-06-24T08:00:00.000Z"),
    setProfileRefreshTimer(callback, intervalMs) {
      expect(intervalMs).toBe(3_600_000);
      timers.push(callback);
      return "profile-refresh-timer";
    },
    clearProfileRefreshTimer(timerId) {
      cleared.push(timerId);
    },
  });

  await schedulers.idle();
  expect(timers).toHaveLength(1);
  expect(updates).toEqual([{ slug: "dad" }]);

  schedulers.stop();
  expect(cleared).toEqual(["profile-refresh-timer"]);
});

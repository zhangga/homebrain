import { expect, test } from "bun:test";
import type { MemberRecord } from "../members/store";
import { runProfileRefreshTick, startProfileRefreshScheduler } from "./profiles";

class FakeBrain {
  readonly askCalls: Array<{ question: string }> = [];

  async ask(input: { question: string }): Promise<{ answer: string }> {
    this.askCalls.push(input);
    return { answer: `长期事实：${input.question.includes("kid") ? "孩子喜欢科普书" : "爸爸喜欢咖啡"}` };
  }
}

test("runProfileRefreshTick：按成员生成周期性画像事实", async () => {
  const brain = new FakeBrain();
  const updates: Array<unknown> = [];
  const members: MemberRecord[] = [
    { connector: "cli", externalId: "local", slug: "dad", displayName: "Dad" },
    { connector: "feishu", externalId: "ou-kid", slug: "kid", displayName: "Kid" },
  ];

  const result = await runProfileRefreshTick({
    brain,
    memberStore: { listMembers: () => members },
    profileUpdater: {
      async updateFromFacts(input) {
        updates.push(input);
        return { updated: true };
      },
    },
    now: () => new Date("2026-06-24T08:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, date: "2026-06-24", members: 2, updated: 2 });
  expect(brain.askCalls).toHaveLength(2);
  expect(brain.askCalls[0]!.question).toContain("今天是 2026-06-24");
  expect(brain.askCalls[0]!.question).toContain("成员 slug: dad");
  expect(brain.askCalls[0]!.question).toContain("显示名: Dad");
  expect(brain.askCalls[0]!.question).toContain("每行一条");
  expect(brain.askCalls[0]!.question).toContain("不要编号、项目符号、标题或解释");
  expect(brain.askCalls[1]!.question).toContain("成员 slug: kid");
  expect(brain.askCalls[1]!.question).toContain("显示名: Kid");
  expect(updates).toEqual([
    {
      member: { slug: "dad" },
      facts: [{ text: "爸爸喜欢咖啡", tags: ["profile"], occurredAt: "2026-06-24" }],
      updatedAt: "2026-06-24T08:30:00.000Z",
    },
    {
      member: { slug: "kid" },
      facts: [{ text: "孩子喜欢科普书", tags: ["profile"], occurredAt: "2026-06-24" }],
      updatedAt: "2026-06-24T08:30:00.000Z",
    },
  ]);
});

test("runProfileRefreshTick：没有成员时跳过", async () => {
  const result = await runProfileRefreshTick({
    brain: new FakeBrain(),
    memberStore: { listMembers: () => [] },
    profileUpdater: {
      async updateFromFacts() {
        throw new Error("没有成员时不应更新画像");
      },
    },
  });

  expect(result).toEqual({ skipped: true, reason: "empty_members" });
});

test("runProfileRefreshTick：多条画像事实拆分写入并去重", async () => {
  const updates: Array<unknown> = [];
  const member: MemberRecord = {
    connector: "cli",
    externalId: "local",
    slug: "kid",
    displayName: "Kid",
  };

  const result = await runProfileRefreshTick({
    brain: {
      async ask() {
        return {
          answer: ["事实要点：", "- 喜欢科普书", "2. 对花生过敏", "- 喜欢科普书", "- 无"].join(
            "\n",
          ),
        };
      },
    },
    memberStore: { listMembers: () => [member] },
    profileUpdater: {
      async updateFromFacts(input) {
        updates.push(input);
        return { updated: true };
      },
    },
    now: () => new Date("2026-06-24T08:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, date: "2026-06-24", members: 1, updated: 1 });
  expect(updates).toEqual([
    {
      member: { slug: "kid" },
      facts: [
        { text: "喜欢科普书", tags: ["profile"], occurredAt: "2026-06-24" },
        { text: "对花生过敏", tags: ["profile"], occurredAt: "2026-06-24" },
      ],
      updatedAt: "2026-06-24T08:30:00.000Z",
    },
  ]);
});

test("runProfileRefreshTick：项目符号里的空结果不写画像", async () => {
  const updates: Array<unknown> = [];
  const result = await runProfileRefreshTick({
    brain: {
      async ask() {
        return { answer: ["事实要点：", "- 暂无新事实。", "- 没有"].join("\n") };
      },
    },
    memberStore: {
      listMembers: () => [{ connector: "cli", externalId: "local", slug: "dad" }],
    },
    profileUpdater: {
      async updateFromFacts(input) {
        updates.push(input);
        return { updated: true };
      },
    },
    now: () => new Date("2026-06-24T08:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, date: "2026-06-24", members: 1, updated: 0 });
  expect(updates).toEqual([]);
});

test("runProfileRefreshTick：自然语言空结果说明不写画像", async () => {
  const updates: Array<unknown> = [];
  const result = await runProfileRefreshTick({
    brain: {
      async ask() {
        return {
          answer: [
            "没有新的长期画像事实可写入。",
            "原因：最近只有一次性提醒和短期情绪。",
          ].join("\n"),
        };
      },
    },
    memberStore: {
      listMembers: () => [{ connector: "cli", externalId: "local", slug: "kid" }],
    },
    profileUpdater: {
      async updateFromFacts(input) {
        updates.push(input);
        return { updated: true };
      },
    },
    now: () => new Date("2026-06-24T08:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, date: "2026-06-24", members: 1, updated: 0 });
  expect(updates).toEqual([]);
});

test("runProfileRefreshTick：可写入事实为空的说明不写画像", async () => {
  const updates: Array<unknown> = [];
  const result = await runProfileRefreshTick({
    brain: {
      async ask() {
        return {
          answer: [
            "无可写入的长期画像事实。",
            "没有可以写入 USER.md 的新事实。",
            "暂无需要写入的事实。",
          ].join("\n"),
        };
      },
    },
    memberStore: {
      listMembers: () => [{ connector: "cli", externalId: "local", slug: "kid" }],
    },
    profileUpdater: {
      async updateFromFacts(input) {
        updates.push(input);
        return { updated: true };
      },
    },
    now: () => new Date("2026-06-24T08:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, date: "2026-06-24", members: 1, updated: 0 });
  expect(updates).toEqual([]);
});

test("runProfileRefreshTick：清理画像事实标签前缀", async () => {
  const updates: Array<unknown> = [];
  const result = await runProfileRefreshTick({
    brain: {
      async ask() {
        return {
          answer: ["长期事实：孩子喜欢科普书", "- 画像事实：对花生过敏"].join("\n"),
        };
      },
    },
    memberStore: {
      listMembers: () => [{ connector: "cli", externalId: "local", slug: "kid" }],
    },
    profileUpdater: {
      async updateFromFacts(input) {
        updates.push(input);
        return { updated: true };
      },
    },
    now: () => new Date("2026-06-24T08:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, date: "2026-06-24", members: 1, updated: 1 });
  expect(updates).toEqual([
    {
      member: { slug: "kid" },
      facts: [
        { text: "孩子喜欢科普书", tags: ["profile"], occurredAt: "2026-06-24" },
        { text: "对花生过敏", tags: ["profile"], occurredAt: "2026-06-24" },
      ],
      updatedAt: "2026-06-24T08:30:00.000Z",
    },
  ]);
});

test("runProfileRefreshTick：过滤画像归纳前导说明", async () => {
  const updates: Array<unknown> = [];
  const result = await runProfileRefreshTick({
    brain: {
      async ask() {
        return {
          answer: ["以下是需要写入 USER.md 的长期画像事实：", "- 孩子喜欢科普书"].join(
            "\n",
          ),
        };
      },
    },
    memberStore: {
      listMembers: () => [{ connector: "cli", externalId: "local", slug: "kid" }],
    },
    profileUpdater: {
      async updateFromFacts(input) {
        updates.push(input);
        return { updated: true };
      },
    },
    now: () => new Date("2026-06-24T08:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, date: "2026-06-24", members: 1, updated: 1 });
  expect(updates).toEqual([
    {
      member: { slug: "kid" },
      facts: [{ text: "孩子喜欢科普书", tags: ["profile"], occurredAt: "2026-06-24" }],
      updatedAt: "2026-06-24T08:30:00.000Z",
    },
  ]);
});

test("runProfileRefreshTick：过滤不确定画像候选", async () => {
  const updates: Array<unknown> = [];
  const result = await runProfileRefreshTick({
    brain: {
      async ask() {
        return {
          answer: [
            "可能喜欢科普书",
            "似乎对花生过敏",
            "不确定是否还在学钢琴",
            "孩子长期在学自然拼读",
          ].join("\n"),
        };
      },
    },
    memberStore: {
      listMembers: () => [{ connector: "cli", externalId: "local", slug: "kid" }],
    },
    profileUpdater: {
      async updateFromFacts(input) {
        updates.push(input);
        return { updated: true };
      },
    },
    now: () => new Date("2026-06-24T08:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, date: "2026-06-24", members: 1, updated: 1 });
  expect(updates).toEqual([
    {
      member: { slug: "kid" },
      facts: [{ text: "孩子长期在学自然拼读", tags: ["profile"], occurredAt: "2026-06-24" }],
      updatedAt: "2026-06-24T08:30:00.000Z",
    },
  ]);
});

test("runProfileRefreshTick：过滤排除性画像说明", async () => {
  const updates: Array<unknown> = [];
  const result = await runProfileRefreshTick({
    brain: {
      async ask() {
        return {
          answer: [
            "不要写入：今天只是临时情绪",
            "排除：一次性提醒买铅笔",
            "忽略：短期作业通知",
            "孩子长期在学自然拼读",
          ].join("\n"),
        };
      },
    },
    memberStore: {
      listMembers: () => [{ connector: "cli", externalId: "local", slug: "kid" }],
    },
    profileUpdater: {
      async updateFromFacts(input) {
        updates.push(input);
        return { updated: true };
      },
    },
    now: () => new Date("2026-06-24T08:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, date: "2026-06-24", members: 1, updated: 1 });
  expect(updates).toEqual([
    {
      member: { slug: "kid" },
      facts: [{ text: "孩子长期在学自然拼读", tags: ["profile"], occurredAt: "2026-06-24" }],
      updatedAt: "2026-06-24T08:30:00.000Z",
    },
  ]);
});

test("runProfileRefreshTick：过滤一次性或短期内容说明", async () => {
  const updates: Array<unknown> = [];
  const result = await runProfileRefreshTick({
    brain: {
      async ask() {
        return {
          answer: [
            "一次性提醒：明天带美术材料，不适合写入长期画像。",
            "短期情绪：今天有点累，不需要写入 USER.md。",
            "孩子长期在学自然拼读",
          ].join("\n"),
        };
      },
    },
    memberStore: {
      listMembers: () => [{ connector: "cli", externalId: "local", slug: "kid" }],
    },
    profileUpdater: {
      async updateFromFacts(input) {
        updates.push(input);
        return { updated: true };
      },
    },
    now: () => new Date("2026-06-24T08:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, date: "2026-06-24", members: 1, updated: 1 });
  expect(updates).toEqual([
    {
      member: { slug: "kid" },
      facts: [{ text: "孩子长期在学自然拼读", tags: ["profile"], occurredAt: "2026-06-24" }],
      updatedAt: "2026-06-24T08:30:00.000Z",
    },
  ]);
});

test("runProfileRefreshTick：过滤无需更新画像说明", async () => {
  const updates: Array<unknown> = [];
  const result = await runProfileRefreshTick({
    brain: {
      async ask() {
        return {
          answer: [
            "本次没有值得写入长期画像的事实。",
            "暂不需要更新 USER.md。",
            "没有长期价值的内容。",
            "无需更新画像。",
            "孩子没有过敏史。",
          ].join("\n"),
        };
      },
    },
    memberStore: {
      listMembers: () => [{ connector: "cli", externalId: "local", slug: "kid" }],
    },
    profileUpdater: {
      async updateFromFacts(input) {
        updates.push(input);
        return { updated: true };
      },
    },
    now: () => new Date("2026-06-24T08:30:00.000Z"),
  });

  expect(result).toEqual({ skipped: false, date: "2026-06-24", members: 1, updated: 1 });
  expect(updates).toEqual([
    {
      member: { slug: "kid" },
      facts: [{ text: "孩子没有过敏史。", tags: ["profile"], occurredAt: "2026-06-24" }],
      updatedAt: "2026-06-24T08:30:00.000Z",
    },
  ]);
});

test("startProfileRefreshScheduler：按 interval 注册 tick，stop 时清理", async () => {
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  const updates: Array<unknown> = [];
  const scheduler = startProfileRefreshScheduler({
    brain: new FakeBrain(),
    memberStore: {
      listMembers: () => [{ connector: "cli", externalId: "local", slug: "dad" }],
    },
    profileUpdater: {
      async updateFromFacts(input) {
        updates.push(input.member);
        return { updated: true };
      },
    },
    intervalMs: 3_600_000,
    runOnStart: true,
    now: () => new Date("2026-06-24T08:30:00.000Z"),
    setTimer(callback, intervalMs) {
      expect(intervalMs).toBe(3_600_000);
      timers.push(callback);
      return "profile-timer";
    },
    clearTimer(timerId) {
      cleared.push(timerId);
    },
  });

  await scheduler.idle();
  expect(timers).toHaveLength(1);
  expect(updates).toEqual([{ slug: "dad" }]);

  scheduler.stop();
  expect(cleared).toEqual(["profile-timer"]);
});

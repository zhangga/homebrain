import { expect, test } from "bun:test";
import { createLlmTaskPlanner } from "./planner";

test("task planner：解析 LLM 返回的复杂目标拆解", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const planner = createLlmTaskPlanner({
    client: {
      async generateText(input) {
        calls.push(input);
        return JSON.stringify({
          title: "自然拼读",
          horizonDays: 7,
          totalUnits: 14,
        });
      },
    },
  });

  const plan = await planner.planGoal({
    text: "我想学完自然拼读",
    member: { slug: "kid" },
    startDate: "2026-06-24",
  });

  expect(plan).toEqual({
    title: "自然拼读",
    horizonDays: 7,
    totalUnits: 14,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.user).toContain("我想学完自然拼读");
  expect(calls[0]!.user).toContain("startDate: 2026-06-24");
});

test("task planner：解析非均摊每日份额", async () => {
  const planner = createLlmTaskPlanner({
    client: {
      async generateText() {
        return JSON.stringify({
          title: "自然拼读",
          horizonDays: 4,
          totalUnits: 8,
          dailyPortions: [
            { day: 1, unitFrom: 1, unitTo: 1 },
            { day: 2, unitFrom: 2, unitTo: 4 },
            { day: 4, unitFrom: 5, unitTo: 8 },
          ],
        });
      },
    },
  });

  await expect(
    planner.planGoal({
      text: "我想一周内学完自然拼读，周三休息",
      member: { slug: "kid" },
      startDate: "2026-06-24",
    }),
  ).resolves.toEqual({
    title: "自然拼读",
    horizonDays: 4,
    totalUnits: 8,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 1 },
      { day: 2, unitFrom: 2, unitTo: 4 },
      { day: 4, unitFrom: 5, unitTo: 8 },
    ],
  });
});

test("task planner：丢弃不完整或非正数的拆解结果", async () => {
  const planner = createLlmTaskPlanner({
    client: {
      async generateText() {
        return JSON.stringify({ title: "自然拼读", horizonDays: 0, totalUnits: 14 });
      },
    },
  });

  await expect(
    planner.planGoal({
      text: "我想学完自然拼读",
      member: { slug: "kid" },
      startDate: "2026-06-24",
    }),
  ).resolves.toBeUndefined();
});

test("task planner：丢弃越界或重叠的非均摊份额", async () => {
  const planner = createLlmTaskPlanner({
    client: {
      async generateText() {
        return JSON.stringify({
          title: "自然拼读",
          horizonDays: 4,
          totalUnits: 8,
          dailyPortions: [
            { day: 1, unitFrom: 1, unitTo: 4 },
            { day: 2, unitFrom: 4, unitTo: 10 },
          ],
        });
      },
    },
  });

  await expect(
    planner.planGoal({
      text: "我想一周内学完自然拼读",
      member: { slug: "kid" },
      startDate: "2026-06-24",
    }),
  ).resolves.toEqual({
    title: "自然拼读",
    horizonDays: 4,
    totalUnits: 8,
  });
});

test("task planner：丢弃缺口或未覆盖全部单元的非均摊份额", async () => {
  const planner = createLlmTaskPlanner({
    client: {
      async generateText() {
        return JSON.stringify({
          title: "口算",
          horizonDays: 3,
          totalUnits: 5,
          dailyPortions: [
            { day: 1, unitFrom: 1, unitTo: 2 },
            { day: 2, unitFrom: 4, unitTo: 5 },
          ],
        });
      },
    },
  });

  await expect(
    planner.planGoal({
      text: "我想3天做完5题口算",
      member: { slug: "kid" },
      startDate: "2026-06-24",
    }),
  ).resolves.toEqual({
    title: "口算",
    horizonDays: 3,
    totalUnits: 5,
  });
});

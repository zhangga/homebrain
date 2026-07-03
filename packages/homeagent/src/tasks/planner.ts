import type { MemberRef } from "homebrain";
import type { LlmTextClient } from "../llm/types";
import { TASK_PLANNER_SYSTEM_PROMPT, buildPlannerUserPrompt } from "../understanding/prompts";

export interface PlannedTaskGoal {
  title?: string;
  horizonDays: number;
  totalUnits: number;
  dailyPortions?: PlannedDailyPortion[];
}

export interface PlannedDailyPortion {
  day: number;
  unitFrom: number;
  unitTo: number;
}

export interface TaskPlanner {
  planGoal(input: {
    text: string;
    member: MemberRef;
    startDate: string;
  }): Promise<PlannedTaskGoal | undefined>;
}

export interface LlmTaskPlannerOptions {
  client: LlmTextClient;
}

export function createLlmTaskPlanner(opts: LlmTaskPlannerOptions): TaskPlanner {
  return {
    async planGoal(input) {
      const output = await opts.client.generateText({
        system: TASK_PLANNER_SYSTEM_PROMPT,
        user: buildPlannerUserPrompt(input),
      });
      return normalizePlan(parsePlan(output));
    },
  };
}

function parsePlan(output: string): unknown {
  const text = stripJsonFence(output.trim());
  if (text === "null") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`任务 planner 输出非 JSON：${output.slice(0, 120)}`);
  }
}

function normalizePlan(value: unknown): PlannedTaskGoal | undefined {
  if (!isRecord(value)) return undefined;
  const horizonDays = toPositiveInteger(value.horizonDays);
  const totalUnits = toPositiveInteger(value.totalUnits);
  if (!horizonDays || !totalUnits) return undefined;
  const dailyPortions = normalizeDailyPortions(value.dailyPortions, horizonDays, totalUnits);
  return {
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : undefined,
    horizonDays,
    totalUnits,
    ...(dailyPortions === undefined ? {} : { dailyPortions }),
  };
}

function normalizeDailyPortions(
  value: unknown,
  horizonDays: number,
  totalUnits: number,
): PlannedDailyPortion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const portions: PlannedDailyPortion[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const day = toPositiveInteger(item.day);
    const unitFrom = toPositiveInteger(item.unitFrom);
    const unitTo = toPositiveInteger(item.unitTo);
    if (!day || !unitFrom || !unitTo || day > horizonDays || unitFrom > unitTo) {
      return undefined;
    }
    portions.push({ day, unitFrom, unitTo });
  }
  const sorted = portions.sort((a, b) => a.day - b.day || a.unitFrom - b.unitFrom);
  let lastDay = 0;
  let expectedUnitFrom = 1;
  for (const portion of sorted) {
    if (
      portion.day === lastDay ||
      portion.unitFrom !== expectedUnitFrom ||
      portion.unitTo > totalUnits
    ) {
      return undefined;
    }
    lastDay = portion.day;
    expectedUnitFrom = portion.unitTo + 1;
  }
  if (expectedUnitFrom !== totalUnits + 1) return undefined;
  return sorted;
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

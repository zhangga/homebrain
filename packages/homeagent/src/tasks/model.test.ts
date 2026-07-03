import { test, expect } from "bun:test";
import { buildActiveDates, splitIntoPortions } from "./model";

test("splitIntoPortions：均摊，余数前置", () => {
  expect(splitIntoPortions({ startUnit: 1, totalUnits: 10, days: 3 })).toEqual([
    { from: 1, to: 4 }, // 4
    { from: 5, to: 7 }, // 3
    { from: 8, to: 10 }, // 3
  ]);
});

test("splitIntoPortions：从中途重排（收到 too_hard 后剩 5 单元/5 天）", () => {
  expect(splitIntoPortions({ startUnit: 6, totalUnits: 10, days: 5 })).toEqual([
    { from: 6, to: 6 },
    { from: 7, to: 7 },
    { from: 8, to: 8 },
    { from: 9, to: 9 },
    { from: 10, to: 10 },
  ]);
});

test("splitIntoPortions：单元少于天数，多余的天无份额", () => {
  expect(splitIntoPortions({ startUnit: 1, totalUnits: 2, days: 5 })).toEqual([
    { from: 1, to: 1 },
    { from: 2, to: 2 },
  ]);
});

test("splitIntoPortions：边界返回空", () => {
  expect(splitIntoPortions({ startUnit: 1, totalUnits: 0, days: 3 })).toEqual([]);
  expect(splitIntoPortions({ startUnit: 1, totalUnits: 10, days: 0 })).toEqual([]);
});

test("buildActiveDates：按休息日跳过派发日期", () => {
  expect(
    buildActiveDates({
      startDate: "2026-06-26",
      days: 3,
      restWeekdays: [0, 6],
    }),
  ).toEqual(["2026-06-26", "2026-06-29", "2026-06-30"]);

  expect(
    buildActiveDates({
      startDate: "2026-06-24",
      days: 3,
      restWeekdays: [3],
    }),
  ).toEqual(["2026-06-25", "2026-06-26", "2026-06-27"]);
});

test("buildActiveDates：支持按日期间隔派发", () => {
  expect(
    buildActiveDates({
      startDate: "2026-06-24",
      days: 4,
      dateSpacingDays: 2,
    }),
  ).toEqual(["2026-06-24", "2026-06-26", "2026-06-28", "2026-06-30"]);

  expect(
    buildActiveDates({
      startDate: "2026-06-24",
      days: 3,
      dateSpacingDays: 3,
    }),
  ).toEqual(["2026-06-24", "2026-06-27", "2026-06-30"]);
});

test("buildActiveDates：支持连续学习若干天后休息若干天的周期", () => {
  expect(
    buildActiveDates({
      startDate: "2026-06-24",
      days: 5,
      activeRestCycle: { activeDays: 2, restDays: 1 },
    }),
  ).toEqual(["2026-06-24", "2026-06-25", "2026-06-27", "2026-06-28", "2026-06-30"]);
});

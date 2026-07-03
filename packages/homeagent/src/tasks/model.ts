/** 一个学习 / 阅读目标 */
export interface LearningGoal {
  id: string;
  memberSlug: string;
  title: string; // 《XXX》/ "背 500 单词"
  totalUnits: number; // 章节数 / 单词数
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  status: "active" | "paused" | "done";
}

export type Feedback = "done" | "partial" | "too_hard" | "skip";

export interface PlannedPortion {
  day: number; // 从 startDate 起算，第 1 天 = startDate
  unitFrom: number;
  unitTo: number;
}

export interface ActiveRestCycle {
  activeDays: number;
  restDays: number;
}

/** 某一天派发的份额 */
export interface DailyPortion {
  goalId: string;
  date: string; // YYYY-MM-DD
  unitFrom: number; // 含
  unitTo: number; // 含
  dispatched: boolean;
  feedback?: Feedback;
  note?: string; // 成员原话
}

/**
 * 把 [startUnit..totalUnits] 的剩余单元按天均摊到 days 天，返回每天 [from,to]（含）。
 * 余数前置（前几天各多分一个）。纯函数：planner 拆解 + 收到 too_hard/partial 后重排都用它。
 */
export function splitIntoPortions(opts: {
  startUnit: number; // 从第几个单元开始（含），1-based
  totalUnits: number; // 目标总单元
  days: number; // 剩余天数
}): Array<{ from: number; to: number }> {
  const { startUnit, totalUnits, days } = opts;
  const remaining = totalUnits - startUnit + 1;
  if (days <= 0 || remaining <= 0) return [];

  const base = Math.floor(remaining / days);
  let extra = remaining % days; // 前 extra 天各多分一个
  const out: Array<{ from: number; to: number }> = [];
  let cursor = startUnit;
  for (let d = 0; d < days; d++) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    if (size <= 0) break; // 单元比天少时，后面的天没有份额
    out.push({ from: cursor, to: cursor + size - 1 });
    cursor += size;
  }
  return out;
}

/** 从 startDate 起取 days 个学习日；restWeekdays 用 UTC weekday：周日=0，周一=1。 */
export function buildActiveDates(opts: {
  startDate: string;
  days: number;
  restWeekdays?: number[];
  dateSpacingDays?: number;
  activeRestCycle?: ActiveRestCycle;
}): string[] {
  if (opts.days <= 0) return [];
  const rest = new Set((opts.restWeekdays ?? []).filter((day) => day >= 0 && day <= 6));
  if (rest.size >= 7) return [];
  const activeRestCycle = normalizeActiveRestCycle(opts.activeRestCycle);
  const spacingDays =
    opts.dateSpacingDays !== undefined &&
    Number.isInteger(opts.dateSpacingDays) &&
    opts.dateSpacingDays > 1
      ? opts.dateSpacingDays
      : 1;

  const dates: string[] = [];
  let cursor = opts.startDate;
  while (dates.length < opts.days) {
    if (
      rest.has(weekday(cursor)) ||
      (activeRestCycle !== undefined && isCycleRestDate(opts.startDate, cursor, activeRestCycle))
    ) {
      cursor = addDays(cursor, 1);
      continue;
    }
    dates.push(cursor);
    cursor = addDays(cursor, activeRestCycle === undefined ? spacingDays : 1);
  }
  return dates;
}

function normalizeActiveRestCycle(cycle: ActiveRestCycle | undefined): ActiveRestCycle | undefined {
  if (!cycle) return undefined;
  if (!Number.isInteger(cycle.activeDays) || !Number.isInteger(cycle.restDays)) return undefined;
  if (cycle.activeDays <= 0 || cycle.restDays <= 0) return undefined;
  return cycle;
}

function isCycleRestDate(startDate: string, date: string, cycle: ActiveRestCycle): boolean {
  const period = cycle.activeDays + cycle.restDays;
  return daysBetween(startDate, date) % period >= cycle.activeDays;
}

function daysBetween(from: string, to: string): number {
  const fromTime = Date.parse(`${from}T00:00:00.000Z`);
  const toTime = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toTime - fromTime) / 86_400_000);
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

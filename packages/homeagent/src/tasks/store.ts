import { Database } from "bun:sqlite";
import {
  buildActiveDates,
  splitIntoPortions,
  type ActiveRestCycle,
  type DailyPortion,
  type Feedback,
  type PlannedPortion,
} from "./model";

export interface TaskGoalRecord {
  id: string;
  memberSlug: string;
  title?: string;
  sourceText: string;
  horizonDays?: number;
  restWeekdays?: number[];
  dateSpacingDays?: number;
  activeRestCycle?: ActiveRestCycle;
  status: "active" | "paused" | "done";
  createdAt: string;
  updatedAt: string;
}

export interface TaskFeedbackRecord {
  id: string;
  memberSlug: string;
  goalId?: string;
  feedback: Feedback;
  note: string;
  createdAt: string;
}

export interface DuePortion extends DailyPortion {
  memberSlug: string;
  title?: string;
}

export interface PortionFeedbackResult {
  portion: DailyPortion;
  replanned: DailyPortion[];
  goalCompleted: boolean;
}

export interface TaskStore {
  createGoal(input: {
    memberSlug: string;
    title?: string;
    sourceText: string;
    horizonDays?: number;
  }): TaskGoalRecord;
  listGoals(filter?: { memberSlug?: string }): TaskGoalRecord[];
  recordFeedback(input: {
    memberSlug: string;
    goalId?: string;
    feedback: Feedback;
    note: string;
  }): TaskFeedbackRecord;
  listFeedback(filter?: { memberSlug?: string; goalId?: string }): TaskFeedbackRecord[];
  planDailyPortions(input: {
    goalId: string;
    startDate: string;
    totalUnits: number;
    days: number;
    startUnit?: number;
    portions?: PlannedPortion[];
    restWeekdays?: number[];
    dateSpacingDays?: number;
    activeRestCycle?: ActiveRestCycle;
  }): DailyPortion[];
  listDuePortions(filter: { date: string; memberSlug?: string }): DuePortion[];
  markPortionDispatched(input: { goalId: string; date: string }): void;
  pauseLatestGoal(input: {
    memberSlug: string;
    targetTitle?: string;
  }): TaskGoalRecord | undefined;
  resumeLatestPausedGoal(input: {
    memberSlug: string;
    date: string;
    targetTitle?: string;
  }): TaskGoalRecord | undefined;
  recordLatestPortionFeedback(input: {
    memberSlug: string;
    date: string;
    feedback: Feedback;
    note: string;
    targetTitle?: string;
    completedUnit?: number;
    completedRatio?: number;
    remainingUnits?: number;
    extraUnits?: number;
    deferDays?: number;
  }): PortionFeedbackResult | undefined;
  close(): void;
}

interface TaskGoalRow {
  id: string;
  member_slug: string;
  title: string | null;
  source_text: string;
  horizon_days: number | null;
  rest_weekdays: string | null;
  date_spacing_days: number | null;
  active_days_per_cycle: number | null;
  rest_days_per_cycle: number | null;
  schedule_start_date: string | null;
  status: "active" | "paused" | "done";
  created_at: string;
  updated_at: string;
}

interface TaskFeedbackRow {
  id: string;
  member_slug: string;
  goal_id: string | null;
  feedback: Feedback;
  note: string;
  created_at: string;
}

interface DailyPortionRow {
  goal_id: string;
  date: string;
  unit_from: number;
  unit_to: number;
  dispatched: number;
  feedback: Feedback | null;
  note: string | null;
  member_slug?: string;
  title?: string | null;
  rest_weekdays?: string | null;
  date_spacing_days?: number | null;
  active_days_per_cycle?: number | null;
  rest_days_per_cycle?: number | null;
  schedule_start_date?: string | null;
}

export function createTaskStore(opts: {
  dbPath: string;
  now?: () => string;
  createId?: (kind: "goal" | "feedback") => string;
}): TaskStore {
  const db = new Database(opts.dbPath);
  const now = opts.now ?? (() => new Date().toISOString());
  const createId = opts.createId ?? defaultId;

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_goals (
      id TEXT PRIMARY KEY,
      member_slug TEXT NOT NULL,
      title TEXT,
      source_text TEXT NOT NULL,
      horizon_days INTEGER,
      rest_weekdays TEXT,
      date_spacing_days INTEGER,
      active_days_per_cycle INTEGER,
      rest_days_per_cycle INTEGER,
      schedule_start_date TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS task_goals_member_status_idx
      ON task_goals (member_slug, status, created_at);

    CREATE TABLE IF NOT EXISTS task_feedback (
      id TEXT PRIMARY KEY,
      member_slug TEXT NOT NULL,
      goal_id TEXT,
      feedback TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (goal_id) REFERENCES task_goals(id)
    );

    CREATE INDEX IF NOT EXISTS task_feedback_member_idx
      ON task_feedback (member_slug, created_at);

    CREATE TABLE IF NOT EXISTS daily_portions (
      goal_id TEXT NOT NULL,
      date TEXT NOT NULL,
      unit_from INTEGER NOT NULL,
      unit_to INTEGER NOT NULL,
      dispatched INTEGER NOT NULL DEFAULT 0,
      feedback TEXT,
      note TEXT,
      PRIMARY KEY (goal_id, date),
      FOREIGN KEY (goal_id) REFERENCES task_goals(id)
    );

    CREATE INDEX IF NOT EXISTS daily_portions_date_dispatched_idx
      ON daily_portions (date, dispatched);
  `);
  ensureColumn(db, "task_goals", "rest_weekdays", "TEXT");
  ensureColumn(db, "task_goals", "date_spacing_days", "INTEGER");
  ensureColumn(db, "task_goals", "active_days_per_cycle", "INTEGER");
  ensureColumn(db, "task_goals", "rest_days_per_cycle", "INTEGER");
  ensureColumn(db, "task_goals", "schedule_start_date", "TEXT");

  return {
    createGoal(input) {
      const timestamp = now();
      const record: TaskGoalRecord = {
        id: createId("goal"),
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      db.query(
        `INSERT INTO task_goals
          (id, member_slug, title, source_text, horizon_days, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.memberSlug,
        record.title ?? null,
        record.sourceText,
        record.horizonDays ?? null,
        record.status,
        record.createdAt,
        record.updatedAt,
      );
      return record;
    },

    listGoals(filter = {}) {
      const rows = filter.memberSlug
        ? db
            .query(
              `SELECT id, member_slug, title, source_text, horizon_days, rest_weekdays, date_spacing_days,
                      active_days_per_cycle, rest_days_per_cycle, schedule_start_date,
                      status, created_at, updated_at
               FROM task_goals
               WHERE member_slug = ?
               ORDER BY created_at, id`,
            )
            .all(filter.memberSlug)
        : db
            .query(
              `SELECT id, member_slug, title, source_text, horizon_days, rest_weekdays, date_spacing_days,
                      active_days_per_cycle, rest_days_per_cycle, schedule_start_date,
                      status, created_at, updated_at
               FROM task_goals
               ORDER BY created_at, id`,
            )
            .all();
      return (rows as TaskGoalRow[]).map(rowToGoal);
    },

    recordFeedback(input) {
      const record: TaskFeedbackRecord = {
        id: createId("feedback"),
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: now(),
      };
      db.query(
        `INSERT INTO task_feedback
          (id, member_slug, goal_id, feedback, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.memberSlug,
        record.goalId ?? null,
        record.feedback,
        record.note,
        record.createdAt,
      );
      return record;
    },

    listFeedback(filter = {}) {
      let sql = `SELECT id, member_slug, goal_id, feedback, note, created_at FROM task_feedback`;
      const clauses: string[] = [];
      const params: string[] = [];
      if (filter.memberSlug) {
        clauses.push("member_slug = ?");
        params.push(filter.memberSlug);
      }
      if (filter.goalId) {
        clauses.push("goal_id = ?");
        params.push(filter.goalId);
      }
      if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
      sql += " ORDER BY created_at, id";
      return (db.query(sql).all(...params) as TaskFeedbackRow[]).map(rowToFeedback);
    },

    planDailyPortions(input) {
      const portions = buildDailyPortions(input);
      const restWeekdays = normalizeRestWeekdays(input.restWeekdays);
      const dateSpacingDays = normalizeDateSpacingDays(input.dateSpacingDays);
      const activeRestCycle = normalizeActiveRestCycle(input.activeRestCycle);

      const insert = db.query(
        `INSERT OR REPLACE INTO daily_portions
          (goal_id, date, unit_from, unit_to, dispatched, feedback, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const replacePortions = db.transaction((records: DailyPortion[]) => {
        db.query("DELETE FROM daily_portions WHERE goal_id = ?").run(input.goalId);
        for (const record of records) {
          insert.run(
            record.goalId,
            record.date,
            record.unitFrom,
            record.unitTo,
            record.dispatched ? 1 : 0,
            record.feedback ?? null,
            record.note ?? null,
          );
        }
        db.query(
          `UPDATE task_goals
           SET rest_weekdays = ?,
               date_spacing_days = ?,
               active_days_per_cycle = ?,
               rest_days_per_cycle = ?,
               schedule_start_date = ?
           WHERE id = ?`,
        ).run(
          restWeekdays.length ? JSON.stringify(restWeekdays) : null,
          dateSpacingDays ?? null,
          activeRestCycle?.activeDays ?? null,
          activeRestCycle?.restDays ?? null,
          input.startDate,
          input.goalId,
        );
      });
      replacePortions(portions);
      return portions;
    },

    listDuePortions(filter) {
      const params: Array<string | number> = [filter.date, 0];
      let sql = `
        SELECT p.goal_id, p.date, p.unit_from, p.unit_to, p.dispatched, p.feedback, p.note,
               g.member_slug, g.title
        FROM daily_portions p
        JOIN task_goals g ON g.id = p.goal_id
        WHERE p.date = ? AND p.dispatched = ? AND g.status = 'active'
      `;
      if (filter.memberSlug) {
        sql += " AND g.member_slug = ?";
        params.push(filter.memberSlug);
      }
      sql += " ORDER BY g.member_slug, p.goal_id";
      return (db.query(sql).all(...params) as DailyPortionRow[]).map(rowToDuePortion);
    },

    markPortionDispatched(input) {
      db.query(
        `UPDATE daily_portions
         SET dispatched = 1
         WHERE goal_id = ? AND date = ?`,
      ).run(input.goalId, input.date);
    },

    pauseLatestGoal(input) {
      const match = input.targetTitle?.trim();
      const params = match ? [input.memberSlug, match] : [input.memberSlug];
      const row = db
        .query(
          `SELECT id, member_slug, title, source_text, horizon_days, rest_weekdays, date_spacing_days,
                  active_days_per_cycle, rest_days_per_cycle, schedule_start_date,
                  status, created_at, updated_at
           FROM task_goals
           WHERE member_slug = ? AND status = 'active'
           ${match ? "AND title = ?" : ""}
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
        )
        .get(...params) as TaskGoalRow | null;
      if (!row) return undefined;

      const updatedAt = now();
      db.query(
        `UPDATE task_goals
         SET status = 'paused', updated_at = ?
         WHERE id = ?`,
      ).run(updatedAt, row.id);
      return rowToGoal({ ...row, status: "paused", updated_at: updatedAt });
    },

    resumeLatestPausedGoal(input) {
      const match = input.targetTitle?.trim();
      const params = match ? [input.memberSlug, match] : [input.memberSlug];
      const row = db
        .query(
          `SELECT id, member_slug, title, source_text, horizon_days, rest_weekdays, date_spacing_days,
                  active_days_per_cycle, rest_days_per_cycle, schedule_start_date,
                  status, created_at, updated_at
           FROM task_goals
           WHERE member_slug = ? AND status = 'paused'
           ${match ? "AND title = ?" : ""}
           ORDER BY updated_at DESC, created_at DESC, id DESC
           LIMIT 1`,
        )
        .get(...params) as TaskGoalRow | null;
      if (!row) return undefined;

      const remainingRows = db
        .query(
          `SELECT goal_id, date, unit_from, unit_to, dispatched, feedback, note
           FROM daily_portions
           WHERE goal_id = ? AND feedback IS NULL
           ORDER BY date`,
        )
        .all(row.id) as DailyPortionRow[];
      const usedDates = new Set(
        (
          db
            .query(
              `SELECT date
               FROM daily_portions
               WHERE goal_id = ? AND feedback IS NOT NULL`,
            )
            .all(row.id) as Array<{ date: string }>
        ).map((record) => record.date),
      );
      const rebased = rebaseRemainingPortions(
        remainingRows,
        input.date,
        usedDates,
        parseRestWeekdaysField(row.rest_weekdays),
        normalizeActiveRestCycle({
          activeDays: row.active_days_per_cycle ?? 0,
          restDays: row.rest_days_per_cycle ?? 0,
        }),
        row.schedule_start_date ?? undefined,
      );
      const updatedAt = now();

      const resumeGoal = db.transaction((records: DailyPortion[]) => {
        db.query(
          `UPDATE task_goals
           SET status = 'active', updated_at = ?
           WHERE id = ?`,
        ).run(updatedAt, row.id);
        db.query("DELETE FROM daily_portions WHERE goal_id = ? AND feedback IS NULL").run(row.id);
        const insert = db.query(
          `INSERT INTO daily_portions
            (goal_id, date, unit_from, unit_to, dispatched, feedback, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const record of records) {
          insert.run(
            record.goalId,
            record.date,
            record.unitFrom,
            record.unitTo,
            record.dispatched ? 1 : 0,
            record.feedback ?? null,
            record.note ?? null,
          );
        }
      });
      resumeGoal(rebased);

      return rowToGoal({ ...row, status: "active", updated_at: updatedAt });
    },

    recordLatestPortionFeedback(input) {
      const match = input.targetTitle?.trim();
      const params: Array<string | number> = [input.memberSlug, input.date];
      let targetClause = "";
      if (match) {
        targetClause = " AND g.title = ?";
        params.push(match);
      }
      const row = db
        .query(
          `SELECT p.goal_id, p.date, p.unit_from, p.unit_to, p.dispatched, p.feedback, p.note,
                  g.rest_weekdays, g.date_spacing_days,
                  g.active_days_per_cycle, g.rest_days_per_cycle, g.schedule_start_date
           FROM daily_portions p
           JOIN task_goals g ON g.id = p.goal_id
           WHERE g.member_slug = ? AND p.date = ? AND g.status = 'active'
           ${targetClause}
           ORDER BY g.created_at DESC, p.goal_id DESC
           LIMIT 1`,
        )
        .get(...params) as DailyPortionRow | null;
      if (!row) return undefined;

      const current = rowToDailyPortion({
        ...row,
        dispatched: 1,
        feedback: input.feedback,
        note: input.note,
      });
      const futureDates = (
        db
          .query(
            `SELECT date
             FROM daily_portions
             WHERE goal_id = ? AND date > ?
             ORDER BY date`,
          )
          .all(row.goal_id, input.date) as Array<{ date: string }>
      ).map((future) => future.date);
      const totalUnitsRow = db
        .query("SELECT MAX(unit_to) AS total_units FROM daily_portions WHERE goal_id = ?")
        .get(row.goal_id) as { total_units: number | null };
      const totalUnits = totalUnitsRow.total_units ?? row.unit_to;
      const completedUnit =
        input.completedUnit ??
        completedUnitFromExtra(row, input.extraUnits) ??
        completedUnitFromRemaining(row, input.remainingUnits) ??
        completedUnitFromRatio(row, input.completedRatio);
      const startUnit =
        completedUnit === undefined
          ? input.feedback === "done"
            ? row.unit_to + 1
            : row.unit_from
          : Math.max(row.unit_from, completedUnit + 1);
      const replanDates = buildReplanDates({
        currentDate: input.date,
        futureDates,
        hasRemainingUnits: startUnit <= totalUnits,
        deferDays: input.deferDays,
        restWeekdays: parseRestWeekdaysField(row.rest_weekdays),
        dateSpacingDays: normalizeDateSpacingDays(row.date_spacing_days ?? undefined),
        activeRestCycle: normalizeActiveRestCycle({
          activeDays: row.active_days_per_cycle ?? 0,
          restDays: row.rest_days_per_cycle ?? 0,
        }),
        cycleStartDate: row.schedule_start_date ?? undefined,
      });
      const replanned = splitIntoPortions({
        startUnit,
        totalUnits,
        days: replanDates.length,
      }).map((portion, index): DailyPortion => ({
        goalId: row.goal_id,
        date: replanDates[index]!,
        unitFrom: portion.from,
        unitTo: portion.to,
        dispatched: false,
      }));

      const shouldCloseGoal = startUnit > totalUnits && replanned.length === 0;

      const replaceFuture = db.transaction((records: DailyPortion[]) => {
        db.query(
          `UPDATE daily_portions
           SET dispatched = 1, feedback = ?, note = ?
           WHERE goal_id = ? AND date = ?`,
        ).run(input.feedback, input.note, row.goal_id, input.date);
        db.query("DELETE FROM daily_portions WHERE goal_id = ? AND date > ?").run(
          row.goal_id,
          input.date,
        );
        const insert = db.query(
          `INSERT INTO daily_portions
            (goal_id, date, unit_from, unit_to, dispatched, feedback, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const record of records) {
          insert.run(
            record.goalId,
            record.date,
            record.unitFrom,
            record.unitTo,
            record.dispatched ? 1 : 0,
            record.feedback ?? null,
            record.note ?? null,
          );
        }
        if (shouldCloseGoal) {
          db.query(
            `UPDATE task_goals
             SET status = 'done', updated_at = ?
             WHERE id = ?`,
          ).run(now(), row.goal_id);
        }
      });
      replaceFuture(replanned);

      return { portion: current, replanned, goalCompleted: shouldCloseGoal };
    },

    close() {
      db.close();
    },
  };
}

function defaultId(kind: "goal" | "feedback"): string {
  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function rowToGoal(row: TaskGoalRow): TaskGoalRecord {
  const restWeekdays = parseRestWeekdaysField(row.rest_weekdays);
  const dateSpacingDays = normalizeDateSpacingDays(row.date_spacing_days ?? undefined);
  const activeRestCycle = normalizeActiveRestCycle({
    activeDays: row.active_days_per_cycle ?? 0,
    restDays: row.rest_days_per_cycle ?? 0,
  });
  return {
    id: row.id,
    memberSlug: row.member_slug,
    title: row.title ?? undefined,
    sourceText: row.source_text,
    horizonDays: row.horizon_days ?? undefined,
    ...(restWeekdays.length ? { restWeekdays } : {}),
    ...(dateSpacingDays === undefined ? {} : { dateSpacingDays }),
    ...(activeRestCycle === undefined ? {} : { activeRestCycle }),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToFeedback(row: TaskFeedbackRow): TaskFeedbackRecord {
  return {
    id: row.id,
    memberSlug: row.member_slug,
    goalId: row.goal_id ?? undefined,
    feedback: row.feedback,
    note: row.note,
    createdAt: row.created_at,
  };
}

function rowToDailyPortion(row: DailyPortionRow): DailyPortion {
  return {
    goalId: row.goal_id,
    date: row.date,
    unitFrom: row.unit_from,
    unitTo: row.unit_to,
    dispatched: row.dispatched === 1,
    feedback: row.feedback ?? undefined,
    note: row.note ?? undefined,
  };
}

function rowToDuePortion(row: DailyPortionRow): DuePortion {
  return {
    ...rowToDailyPortion(row),
    memberSlug: row.member_slug!,
    title: row.title ?? undefined,
  };
}

function buildDailyPortions(input: {
  goalId: string;
  startDate: string;
  totalUnits: number;
  days: number;
  startUnit?: number;
  portions?: PlannedPortion[];
  restWeekdays?: number[];
  dateSpacingDays?: number;
  activeRestCycle?: ActiveRestCycle;
}): DailyPortion[] {
  const dateSpacingDays = normalizeDateSpacingDays(input.dateSpacingDays);
  const activeRestCycle = normalizeActiveRestCycle(input.activeRestCycle);
  if (input.portions?.length) {
    const dates = buildActiveDates({
      startDate: input.startDate,
      days: input.days,
      restWeekdays: input.restWeekdays,
      dateSpacingDays,
      activeRestCycle,
    });
    return input.portions.flatMap((portion): DailyPortion[] => {
      const date = dates[portion.day - 1];
      if (!date) return [];
      return [
        {
          goalId: input.goalId,
          date,
          unitFrom: portion.unitFrom,
          unitTo: portion.unitTo,
          dispatched: false,
        },
      ];
    });
  }
  const dates = buildActiveDates({
    startDate: input.startDate,
    days: input.days,
    restWeekdays: input.restWeekdays,
    dateSpacingDays,
    activeRestCycle,
  });
  return splitIntoPortions({
    startUnit: input.startUnit ?? 1,
    totalUnits: input.totalUnits,
    days: dates.length,
  }).map((portion, index): DailyPortion => ({
    goalId: input.goalId,
    date: dates[index]!,
    unitFrom: portion.from,
    unitTo: portion.to,
    dispatched: false,
  }));
}

function buildReplanDates(input: {
  currentDate: string;
  futureDates: string[];
  hasRemainingUnits: boolean;
  deferDays?: number;
  restWeekdays?: number[];
  dateSpacingDays?: number;
  activeRestCycle?: ActiveRestCycle;
  cycleStartDate?: string;
}): string[] {
  if (!input.hasRemainingUnits) return [];
  const rest = normalizeRestWeekdays(input.restWeekdays);
  const spacingDays = normalizeDateSpacingDays(input.dateSpacingDays) ?? 1;
  const activeRestCycle = normalizeActiveRestCycle(input.activeRestCycle);
  const cycleStartDate = activeRestCycle === undefined ? undefined : input.cycleStartDate;
  if (input.deferDays !== undefined && input.deferDays > 0) {
    const used = new Set<string>();
    return [input.currentDate, ...input.futureDates].map((date) =>
      nextActiveDate(addDays(date, input.deferDays!), rest, used, activeRestCycle, cycleStartDate),
    );
  }
  return input.futureDates.length === 0
    ? [
        nextActiveDate(
          addDays(input.currentDate, activeRestCycle === undefined ? spacingDays : 1),
          rest,
          new Set(),
          activeRestCycle,
          cycleStartDate,
        ),
      ]
    : input.futureDates;
}

function completedUnitFromRemaining(
  row: DailyPortionRow,
  remainingUnits: number | undefined,
): number | undefined {
  if (remainingUnits === undefined) return undefined;
  const plannedUnits = row.unit_to - row.unit_from + 1;
  const boundedRemaining = Math.min(remainingUnits, plannedUnits);
  return row.unit_to - boundedRemaining;
}

function completedUnitFromExtra(
  row: DailyPortionRow,
  extraUnits: number | undefined,
): number | undefined {
  if (extraUnits === undefined) return undefined;
  return row.unit_to + extraUnits;
}

function completedUnitFromRatio(
  row: DailyPortionRow,
  completedRatio: number | undefined,
): number | undefined {
  if (completedRatio === undefined || !Number.isFinite(completedRatio)) return undefined;
  if (completedRatio <= 0 || completedRatio >= 1) return undefined;
  const plannedUnits = row.unit_to - row.unit_from + 1;
  const completedUnits = Math.max(1, Math.floor(plannedUnits * completedRatio));
  return Math.min(row.unit_to, row.unit_from + completedUnits - 1);
}

function rebaseRemainingPortions(
  rows: DailyPortionRow[],
  startDate: string,
  usedDates: Set<string>,
  restWeekdays: number[] = [],
  activeRestCycle?: ActiveRestCycle,
  cycleStartDate?: string,
): DailyPortion[] {
  if (rows.length === 0) return [];

  const baseDate = rows[0]!.date;
  return rows.map((row): DailyPortion => {
    const date = nextActiveDate(
      addDays(startDate, daysBetween(baseDate, row.date)),
      restWeekdays,
      usedDates,
      activeRestCycle,
      cycleStartDate,
    );
    return {
      goalId: row.goal_id,
      date,
      unitFrom: row.unit_from,
      unitTo: row.unit_to,
      dispatched: false,
    };
  });
}

function ensureColumn(db: Database, table: string, column: string, type: string): void {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function normalizeRestWeekdays(restWeekdays: number[] | undefined): number[] {
  return [...new Set(restWeekdays ?? [])]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
}

function normalizeDateSpacingDays(dateSpacingDays: number | undefined): number | undefined {
  if (dateSpacingDays === undefined) return undefined;
  return Number.isInteger(dateSpacingDays) && dateSpacingDays > 1 ? dateSpacingDays : undefined;
}

function normalizeActiveRestCycle(cycle: ActiveRestCycle | undefined): ActiveRestCycle | undefined {
  if (cycle === undefined) return undefined;
  if (!Number.isInteger(cycle.activeDays) || !Number.isInteger(cycle.restDays)) return undefined;
  if (cycle.activeDays <= 0 || cycle.restDays <= 0) return undefined;
  return cycle;
}

function parseRestWeekdaysField(value: string | null | undefined): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? normalizeRestWeekdays(parsed.filter((item): item is number => typeof item === "number"))
      : [];
  } catch {
    return [];
  }
}

function nextActiveDate(
  date: string,
  restWeekdays: number[],
  usedDates: Set<string>,
  activeRestCycle?: ActiveRestCycle,
  cycleStartDate?: string,
): string {
  const rest = new Set(restWeekdays);
  let cursor = date;
  while (
    rest.has(weekday(cursor)) ||
    usedDates.has(cursor) ||
    isCycleRestDate(cursor, activeRestCycle, cycleStartDate)
  ) {
    cursor = addDays(cursor, 1);
  }
  usedDates.add(cursor);
  return cursor;
}

function isCycleRestDate(
  date: string,
  activeRestCycle: ActiveRestCycle | undefined,
  cycleStartDate: string | undefined,
): boolean {
  if (activeRestCycle === undefined || cycleStartDate === undefined) return false;
  const period = activeRestCycle.activeDays + activeRestCycle.restDays;
  return daysBetween(cycleStartDate, date) % period >= activeRestCycle.activeDays;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function daysBetween(from: string, to: string): number {
  const fromTime = Date.parse(`${from}T00:00:00.000Z`);
  const toTime = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toTime - fromTime) / 86_400_000);
}

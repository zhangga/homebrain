import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SpaceId } from "@homeagent/shared";
import { KnowledgeEngine, type Task } from "@homeagent/core";
import { shouldRunTask, TaskScheduler } from "./task-scheduler.ts";

const SPACE: SpaceId = "team/oc_tsched";
// Fixed instants in Asia/Shanghai.
const T10 = new Date("2026-07-06T10:00:00+08:00");
const T23 = new Date("2026-07-06T23:00:00+08:00");

function task(over: Partial<Task>): Task {
  return {
    id: "task_1",
    name: "t",
    space: SPACE,
    topic: "x",
    cadence: "daily",
    hour: 8,
    enabled: true,
    notify: false,
    distillOnRun: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("shouldRunTask", () => {
  test("disabled never runs", () => {
    expect(shouldRunTask(task({ enabled: false }), T10)).toBe(false);
  });

  test("never-run task runs", () => {
    expect(shouldRunTask(task({ lastRunAt: undefined }), T10)).toBe(true);
  });

  test("daily: past hour + not run today -> run; already today -> skip", () => {
    const yesterday = new Date("2026-07-05T09:00:00+08:00").getTime();
    expect(shouldRunTask(task({ cadence: "daily", hour: 8, lastRunAt: yesterday }), T10)).toBe(true);
    const earlierToday = new Date("2026-07-06T08:30:00+08:00").getTime();
    expect(shouldRunTask(task({ cadence: "daily", hour: 8, lastRunAt: earlierToday }), T10)).toBe(false);
  });

  test("daily: before hour -> skip", () => {
    const early = new Date("2026-07-06T06:00:00+08:00");
    expect(shouldRunTask(task({ cadence: "daily", hour: 8, lastRunAt: 0 }), early)).toBe(false);
  });

  test("hourly: >=1h since last -> run; <1h -> skip", () => {
    expect(shouldRunTask(task({ cadence: "hourly", lastRunAt: T23.getTime() - 3600_000 }), T23)).toBe(true);
    expect(shouldRunTask(task({ cadence: "hourly", lastRunAt: T23.getTime() - 600_000 }), T23)).toBe(false);
  });
});

describe("TaskScheduler.tick", () => {
  let dir: string;
  let engine: KnowledgeEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-tsched-"));
    engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => "研究结果要点",
    });
    engine.ensureSpace(SPACE);
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs a due task and fires notify on success", async () => {
    const t = engine.tasks.create({ name: "调研", space: SPACE, topic: "x", notify: true })!;
    const notified: string[] = [];
    const sched = new TaskScheduler(engine, { notify: (task) => void notified.push(task.id) });
    const ran = await sched.tick("test", T10);
    expect(ran).toContain(t.id);
    expect(notified).toContain(t.id);
    expect(engine.tasks.get(t.id)?.lastStatus).toBe("ok");
  });

  test("skips a disabled task and does not notify", async () => {
    const t = engine.tasks.create({ name: "off", space: SPACE, topic: "x", enabled: false, notify: true })!;
    const notified: string[] = [];
    const sched = new TaskScheduler(engine, { notify: (task) => void notified.push(task.id) });
    const ran = await sched.tick("test", T10);
    expect(ran).not.toContain(t.id);
    expect(notified).toEqual([]);
  });

  test("exposes whether the task scheduler loop is started", async () => {
    const sched = new TaskScheduler(engine);

    await sched.start();
    expect(sched.health()).toEqual(
      expect.objectContaining({
        started: true,
        running: false,
        lastStatus: "ok",
        lastSuccessAt: expect.any(Number),
        lastReason: "startup-catchup",
      }),
    );

    sched.stop();
    expect(sched.health().started).toBe(false);
  });

  test("records a startup failure and does not claim the loop started", async () => {
    engine.tasks.list = () => {
      throw new Error("task registry unavailable");
    };
    const sched = new TaskScheduler(engine);

    await expect(sched.start()).rejects.toThrow("task registry unavailable");
    expect(sched.health()).toEqual(
      expect.objectContaining({
        started: false,
        running: false,
        lastStatus: "error",
        lastFailureAt: expect.any(Number),
        lastReason: "startup-catchup",
        lastError: expect.stringContaining("task registry unavailable"),
      }),
    );
  });
});

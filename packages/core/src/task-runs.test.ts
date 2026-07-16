import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import type { Task } from "./tasks.ts";
import {
  MAX_TASK_RUN_ERROR_CHARACTERS,
  MAX_TASK_RUN_HISTORY_PER_TASK,
  MAX_TASK_RUN_OUTPUT_CHARACTERS,
  TaskRunStore,
} from "./task-runs.ts";

let dir: string;
const SPACE: SpaceId = "team/oc_task_runs";
const TASK: Task = {
  id: "task_history",
  name: "历史任务",
  space: SPACE,
  topic: "记录运行历史",
  cadence: "daily",
  hour: 8,
  enabled: true,
  notify: false,
  distillOnRun: false,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-task-runs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TaskRunStore", () => {
  test("recovers an interrupted running record as a durable failure", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({ task: TASK, trigger: "manual", distill: false });

    const secondary = new TaskRunStore(dir);
    expect(secondary.get(run.id)?.status).toBe("running");

    const reopened = new TaskRunStore(dir, { recoverInterrupted: true });

    expect(reopened.get(run.id)).toEqual(expect.objectContaining({
      status: "failed",
      error: "应用在任务完成前停止，运行已标记为失败",
      finishedAt: expect.any(Number),
    }));
  });

  test("retains the latest 100 completed runs per task", () => {
    const store = new TaskRunStore(dir);
    for (let index = 0; index <= MAX_TASK_RUN_HISTORY_PER_TASK; index += 1) {
      const run = store.start({ task: TASK, trigger: "scheduled", distill: false });
      store.succeed(run.id, {
        finishedAt: run.startedAt,
        output: `运行输出 ${index}`,
        summary: `运行输出 ${index}`,
      });
    }

    const runs = store.list(TASK.id);
    expect(runs).toHaveLength(MAX_TASK_RUN_HISTORY_PER_TASK);
    expect(runs[0]?.output).toBe("运行输出 100");
    expect(runs.at(-1)?.output).toBe("运行输出 1");
  });

  test("bounds persisted output while recording that it was truncated", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({ task: TASK, trigger: "manual", distill: false });
    store.succeed(run.id, {
      finishedAt: run.startedAt,
      output: "x".repeat(MAX_TASK_RUN_OUTPUT_CHARACTERS + 1),
    });

    expect(store.get(run.id)).toEqual(expect.objectContaining({
      output: "x".repeat(MAX_TASK_RUN_OUTPUT_CHARACTERS),
      outputTruncated: true,
    }));
  });

  test("bounds persisted errors", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({ task: TASK, trigger: "manual", distill: false });
    store.fail(run.id, {
      finishedAt: run.startedAt,
      error: "e".repeat(MAX_TASK_RUN_ERROR_CHARACTERS + 1),
    });

    expect(store.get(run.id)?.error).toBe("e".repeat(MAX_TASK_RUN_ERROR_CHARACTERS));
  });
});

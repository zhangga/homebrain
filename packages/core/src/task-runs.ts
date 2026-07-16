import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { isSpaceId, type SpaceId } from "@homeagent/shared";
import type { Task } from "./tasks.ts";

export type TaskRunStatus = "running" | "succeeded" | "failed";
export type TaskRunTrigger = "manual" | "scheduled" | "chat" | "retry";

export interface TaskRun {
  id: string;
  taskId: string;
  taskName: string;
  space: SpaceId;
  topic: string;
  trigger: TaskRunTrigger;
  retryOf?: string;
  distill: boolean;
  status: TaskRunStatus;
  startedAt: number;
  finishedAt?: number;
  output?: string;
  outputTruncated?: boolean;
  summary?: string;
  error?: string;
  rawId?: string;
  pagesWritten?: number;
}

interface TaskRunsFile {
  version: 1;
  runs: Record<string, TaskRun>;
}

export interface StartTaskRunInput {
  task: Task;
  trigger: TaskRunTrigger;
  retryOf?: string;
  distill: boolean;
  startedAt?: number;
}

export interface FinishTaskRunInput {
  finishedAt: number;
  output?: string;
  summary?: string;
  error?: string;
  rawId?: string;
  pagesWritten?: number;
}

export interface TaskRunStoreOptions {
  recoverInterrupted?: boolean;
}

export const MAX_TASK_RUN_OUTPUT_CHARACTERS = 100_000;
export const MAX_TASK_RUN_ERROR_CHARACTERS = 20_000;
export const MAX_TASK_RUN_HISTORY_PER_TASK = 100;
const INTERRUPTED_RUN_ERROR = "应用在任务完成前停止，运行已标记为失败";

function clone(run: TaskRun): TaskRun {
  return { ...run };
}

function isTaskRun(value: unknown): value is TaskRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Partial<TaskRun>;
  const optionalStrings = [
    run.retryOf,
    run.output,
    run.summary,
    run.error,
    run.rawId,
  ].every((item) => item === undefined || typeof item === "string");
  const optionalNumbers = [run.finishedAt, run.pagesWritten].every(
    (item) => item === undefined || (typeof item === "number" && Number.isFinite(item)),
  );
  return (
    typeof run.id === "string"
    && typeof run.taskId === "string"
    && typeof run.taskName === "string"
    && typeof run.space === "string"
    && isSpaceId(run.space)
    && typeof run.topic === "string"
    && ["manual", "scheduled", "chat", "retry"].includes(String(run.trigger))
    && typeof run.distill === "boolean"
    && ["running", "succeeded", "failed"].includes(String(run.status))
    && typeof run.startedAt === "number"
    && Number.isFinite(run.startedAt)
    && optionalStrings
    && optionalNumbers
    && (run.outputTruncated === undefined || typeof run.outputTruncated === "boolean")
    && (run.status === "running" || typeof run.finishedAt === "number")
    && (run.status !== "failed" || typeof run.error === "string")
    && (run.finishedAt === undefined || run.finishedAt >= run.startedAt)
    && (run.output === undefined || run.output.length <= MAX_TASK_RUN_OUTPUT_CHARACTERS)
    && (run.error === undefined || run.error.length <= MAX_TASK_RUN_ERROR_CHARACTERS)
    && (!run.outputTruncated || run.output !== undefined)
    && (
      run.pagesWritten === undefined
      || (Number.isInteger(run.pagesWritten) && run.pagesWritten >= 0)
    )
  );
}

export class TaskRunStore {
  private readonly configPath: string;
  private readonly runs: Map<string, TaskRun>;
  private lastStartedAt: number;

  constructor(dataDir: string, opts: TaskRunStoreOptions = {}) {
    this.configPath = join(dataDir, "config", "task-runs.json");
    this.runs = this.load();
    this.lastStartedAt = 0;
    for (const run of this.runs.values()) {
      this.lastStartedAt = Math.max(this.lastStartedAt, run.startedAt);
    }
    if (opts.recoverInterrupted) this.recoverInterruptedRuns();
  }

  private load(): Map<string, TaskRun> {
    const runs = new Map<string, TaskRun>();
    if (!existsSync(this.configPath)) return runs;
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<TaskRunsFile>;
      for (const [id, value] of Object.entries(parsed.runs ?? {})) {
        if (!isTaskRun(value) || value.id !== id) continue;
        runs.set(id, clone(value));
      }
    } catch {
      // Corrupt history must not prevent the application from starting.
    }
    return runs;
  }

  private persist(): void {
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    const file: TaskRunsFile = { version: 1, runs: Object.fromEntries(this.runs) };
    try {
      writeFileSync(tempPath, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tempPath, this.configPath);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }

  private recoverInterruptedRuns(): void {
    const now = Date.now();
    let changed = false;
    const affectedTaskIds = new Set<string>();
    for (const run of this.runs.values()) {
      if (run.status !== "running") continue;
      run.status = "failed";
      run.finishedAt = Math.max(now, run.startedAt);
      run.error = INTERRUPTED_RUN_ERROR;
      affectedTaskIds.add(run.taskId);
      changed = true;
    }
    for (const taskId of affectedTaskIds) this.pruneCompletedRuns(taskId);
    if (changed) this.persist();
  }

  private pruneCompletedRuns(taskId: string): void {
    const completed = [...this.runs.values()].filter(
      (run) => run.taskId === taskId && run.status !== "running",
    );
    const excess = completed.length - MAX_TASK_RUN_HISTORY_PER_TASK;
    if (excess <= 0) return;
    for (const run of completed.slice(0, excess)) this.runs.delete(run.id);
  }

  start(input: StartTaskRunInput): TaskRun {
    const requestedStartedAt = input.startedAt ?? Date.now();
    const startedAt = Math.max(requestedStartedAt, this.lastStartedAt + 1);
    this.lastStartedAt = startedAt;
    const run: TaskRun = {
      id: `run_${randomUUID()}`,
      taskId: input.task.id,
      taskName: input.task.name,
      space: input.task.space,
      topic: input.task.topic,
      trigger: input.trigger,
      retryOf: input.retryOf,
      distill: input.distill,
      status: "running",
      startedAt,
    };
    this.runs.set(run.id, run);
    this.persist();
    return clone(run);
  }

  succeed(id: string, result: FinishTaskRunInput): TaskRun | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const output = result.output ?? "";
    run.status = "succeeded";
    run.finishedAt = result.finishedAt;
    run.output = output.slice(0, MAX_TASK_RUN_OUTPUT_CHARACTERS);
    run.outputTruncated = output.length > MAX_TASK_RUN_OUTPUT_CHARACTERS || undefined;
    run.summary = result.summary;
    run.error = undefined;
    run.rawId = result.rawId;
    run.pagesWritten = result.pagesWritten;
    this.pruneCompletedRuns(run.taskId);
    this.persist();
    return clone(run);
  }

  fail(id: string, result: FinishTaskRunInput): TaskRun | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const output = result.output;
    run.status = "failed";
    run.finishedAt = result.finishedAt;
    run.error = (result.error ?? "任务运行失败").slice(0, MAX_TASK_RUN_ERROR_CHARACTERS);
    run.output = output?.slice(0, MAX_TASK_RUN_OUTPUT_CHARACTERS);
    run.outputTruncated = output && output.length > MAX_TASK_RUN_OUTPUT_CHARACTERS
      ? true
      : undefined;
    this.pruneCompletedRuns(run.taskId);
    this.persist();
    return clone(run);
  }

  get(id: string): TaskRun | undefined {
    const run = this.runs.get(id);
    return run ? clone(run) : undefined;
  }

  has(id: string): boolean {
    return this.runs.has(id);
  }

  list(taskId?: string): TaskRun[] {
    return [...this.runs.values()]
      .filter((run) => !taskId || run.taskId === taskId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(clone);
  }

  restore(runs: TaskRun[]): TaskRun[] {
    for (const run of runs) {
      if (this.runs.has(run.id)) throw new Error(`task run id already exists: ${run.id}`);
      if (run.status === "running") throw new Error(`cannot restore a running task run: ${run.id}`);
    }
    for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
      this.runs.set(run.id, clone(run));
    }
    for (const taskId of new Set(runs.map((run) => run.taskId))) {
      this.pruneCompletedRuns(taskId);
    }
    if (runs.length > 0) this.persist();
    return runs.map(clone);
  }

  remove(id: string): boolean {
    const removed = this.runs.delete(id);
    if (removed) this.persist();
    return removed;
  }

  removeByTask(taskId: string): number {
    let removed = 0;
    for (const [id, run] of this.runs) {
      if (run.taskId !== taskId) continue;
      this.runs.delete(id);
      removed += 1;
    }
    if (removed > 0) this.persist();
    return removed;
  }

  removeBySpace(space: SpaceId): number {
    let removed = 0;
    for (const [id, run] of this.runs) {
      if (run.space !== space) continue;
      this.runs.delete(id);
      removed += 1;
    }
    if (removed > 0) this.persist();
    return removed;
  }
}

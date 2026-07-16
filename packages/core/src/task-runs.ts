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

export type TaskRunStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type TaskRunTrigger = "manual" | "scheduled" | "chat" | "retry";
export type TaskRunNotificationStatus = "pending" | "sent" | "failed";

export interface TaskRunNotification {
  status: TaskRunNotificationStatus;
  attempts: number;
  lastAttemptAt?: number;
  nextAttemptAt?: number;
  sentAt?: number;
  error?: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  taskName: string;
  space: SpaceId;
  topic: string;
  trigger: TaskRunTrigger;
  retryOf?: string;
  distill: boolean;
  notify?: boolean;
  timeoutMs?: number;
  status: TaskRunStatus;
  startedAt: number;
  finishedAt?: number;
  output?: string;
  outputTruncated?: boolean;
  summary?: string;
  error?: string;
  rawId?: string;
  pagesWritten?: number;
  notification?: TaskRunNotification;
}

interface TaskRunsFile {
  version: 2;
  runs: Record<string, TaskRun>;
}

export interface StartTaskRunInput {
  task: Task;
  trigger: TaskRunTrigger;
  retryOf?: string;
  distill: boolean;
  timeoutMs?: number;
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
export const MAX_TASK_NOTIFICATION_ATTEMPTS = 5;
const TASK_NOTIFICATION_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;
const INTERRUPTED_RUN_ERROR = "应用在任务完成前停止，运行已标记为失败";

function clone(run: TaskRun): TaskRun {
  return {
    ...run,
    notification: run.notification ? { ...run.notification } : undefined,
  };
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
  const optionalNumbers = [run.finishedAt, run.pagesWritten, run.timeoutMs].every(
    (item) => item === undefined || (typeof item === "number" && Number.isFinite(item)),
  );
  const notification = run.notification;
  const validNotification = notification === undefined || (
    typeof notification === "object"
    && notification !== null
    && !Array.isArray(notification)
    && ["pending", "sent", "failed"].includes(String(notification.status))
    && Number.isInteger(notification.attempts)
    && notification.attempts >= 0
    && [
      notification.lastAttemptAt,
      notification.nextAttemptAt,
      notification.sentAt,
    ].every((item) => item === undefined || (typeof item === "number" && Number.isFinite(item)))
    && (notification.error === undefined || typeof notification.error === "string")
    && (
      notification.error === undefined
      || notification.error.length <= MAX_TASK_RUN_ERROR_CHARACTERS
    )
    && (notification.status !== "sent" || typeof notification.sentAt === "number")
    && (notification.status !== "failed" || typeof notification.error === "string")
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
    && (run.notify === undefined || typeof run.notify === "boolean")
    && ["running", "succeeded", "failed", "cancelled", "timed_out"].includes(String(run.status))
    && typeof run.startedAt === "number"
    && Number.isFinite(run.startedAt)
    && optionalStrings
    && optionalNumbers
    && validNotification
    && (run.notification === undefined || run.status === "succeeded")
    && (run.notification === undefined || run.notify !== false)
    && (run.outputTruncated === undefined || typeof run.outputTruncated === "boolean")
    && (run.status === "running" || typeof run.finishedAt === "number")
    && (
      !["failed", "cancelled", "timed_out"].includes(String(run.status))
      || typeof run.error === "string"
    )
    && (run.finishedAt === undefined || run.finishedAt >= run.startedAt)
    && (run.output === undefined || run.output.length <= MAX_TASK_RUN_OUTPUT_CHARACTERS)
    && (run.error === undefined || run.error.length <= MAX_TASK_RUN_ERROR_CHARACTERS)
    && (!run.outputTruncated || run.output !== undefined)
    && (
      run.pagesWritten === undefined
      || (Number.isInteger(run.pagesWritten) && run.pagesWritten >= 0)
    )
    && (
      run.timeoutMs === undefined
      || (Number.isInteger(run.timeoutMs) && run.timeoutMs > 0)
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
    const file: TaskRunsFile = { version: 2, runs: Object.fromEntries(this.runs) };
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
      notify: input.task.notify,
      timeoutMs: input.timeoutMs,
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
    run.notification = run.notify
      ? { status: "pending", attempts: 0 }
      : undefined;
    this.pruneCompletedRuns(run.taskId);
    this.persist();
    return clone(run);
  }

  startNotificationAttempt(
    id: string,
    attemptedAt: number,
  ): TaskRun | undefined {
    const run = this.runs.get(id);
    if (!run || run.status !== "succeeded" || !run.notification) return undefined;
    const attempts = run.notification.attempts + 1;
    const retryDelay = TASK_NOTIFICATION_RETRY_DELAYS_MS[
      Math.min(attempts - 1, TASK_NOTIFICATION_RETRY_DELAYS_MS.length - 1)
    ]!;
    run.notification = {
      status: "pending",
      attempts,
      lastAttemptAt: attemptedAt,
      nextAttemptAt: attemptedAt + retryDelay,
    };
    this.persist();
    return clone(run);
  }

  notificationFailed(id: string, error: string): TaskRun | undefined {
    const run = this.runs.get(id);
    if (!run?.notification) return undefined;
    run.notification.status = "failed";
    run.notification.error = error.slice(0, MAX_TASK_RUN_ERROR_CHARACTERS);
    this.persist();
    return clone(run);
  }

  notificationSent(id: string, sentAt: number): TaskRun | undefined {
    const run = this.runs.get(id);
    if (!run?.notification) return undefined;
    run.notification = {
      status: "sent",
      attempts: run.notification.attempts,
      lastAttemptAt: run.notification.lastAttemptAt,
      sentAt,
    };
    this.persist();
    return clone(run);
  }

  private finishWithError(
    id: string,
    status: "failed" | "cancelled" | "timed_out",
    result: FinishTaskRunInput,
    defaultError: string,
  ): TaskRun | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const output = result.output;
    run.status = status;
    run.finishedAt = result.finishedAt;
    run.error = (result.error ?? defaultError).slice(0, MAX_TASK_RUN_ERROR_CHARACTERS);
    run.output = output?.slice(0, MAX_TASK_RUN_OUTPUT_CHARACTERS);
    run.outputTruncated = output && output.length > MAX_TASK_RUN_OUTPUT_CHARACTERS
      ? true
      : undefined;
    run.rawId = result.rawId;
    run.pagesWritten = result.pagesWritten;
    this.pruneCompletedRuns(run.taskId);
    this.persist();
    return clone(run);
  }

  fail(id: string, result: FinishTaskRunInput): TaskRun | undefined {
    return this.finishWithError(id, "failed", result, "任务运行失败");
  }

  cancel(id: string, result: FinishTaskRunInput): TaskRun | undefined {
    return this.finishWithError(id, "cancelled", result, "任务已由用户取消");
  }

  timeout(id: string, result: FinishTaskRunInput): TaskRun | undefined {
    return this.finishWithError(id, "timed_out", result, "任务运行超时");
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

  listNeedingNotification(now = Date.now()): TaskRun[] {
    return [...this.runs.values()]
      .filter((run) => (
        run.status === "succeeded"
        && run.notification !== undefined
        && run.notification.status !== "sent"
        && run.notification.attempts < MAX_TASK_NOTIFICATION_ATTEMPTS
        && (
          run.notification.nextAttemptAt === undefined
          || run.notification.nextAttemptAt <= now
        )
      ))
      .sort((a, b) => a.startedAt - b.startedAt)
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

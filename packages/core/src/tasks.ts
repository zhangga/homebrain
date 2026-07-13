/**
 * Task store (management backend, task-execution platform). A "task" is a
 * recurring or on-demand unit of work run by a space's agent CLI. The first
 * task type is topic research: periodically ask the space's CLI agent to
 * research a topic, capture the result as raw material (source "task") in that
 * space (the dream cycle later distills it into wiki pages), and optionally push
 * a summary to the bound feishu chat.
 *
 * Persisted to data/config/tasks.json using the same whole-file JSON pattern as
 * the agent store (agents.ts) and space registry (registry.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SpaceId } from "@homebrain/shared";
import { isSpaceId } from "@homebrain/shared";

/** How often a task runs. */
export type TaskCadence = "hourly" | "daily";
export const TASK_CADENCES: TaskCadence[] = ["hourly", "daily"];

/** Outcome of the last run, for display + scheduling. */
export type TaskStatus = "ok" | "error";

/** A configurable, agent-run task. Today only kind "research" exists. */
export interface Task {
  id: string;
  name: string;
  /** space the result is written to (also the source of the agent/CLI) */
  space: SpaceId;
  /** research topic / prompt handed to the agent */
  topic: string;
  cadence: TaskCadence;
  /** local hour (0-23, Asia/Shanghai) for daily cadence */
  hour: number;
  /** whether the scheduler runs it automatically */
  enabled: boolean;
  /** push a summary to the space's bound feishu chat on completion */
  notify: boolean;
  /** distill the captured output into wiki pages right after the run (default true) */
  distillOnRun: boolean;
  /** epoch ms of the last run (any outcome) */
  lastRunAt?: number;
  lastStatus?: TaskStatus;
  lastError?: string;
  /** short preview of the last successful output */
  lastSummary?: string;
  createdAt: number;
  updatedAt: number;
}

/** Fields a caller may set when creating/updating a task. */
export interface TaskInput {
  name?: string;
  space?: string;
  topic?: string;
  cadence?: string;
  hour?: number;
  enabled?: boolean;
  notify?: boolean;
  distillOnRun?: boolean;
}

/** Patch applied after a run to record its outcome. */
export interface TaskRunResult {
  at: number;
  status: TaskStatus;
  summary?: string;
  error?: string;
}

interface TasksFile {
  tasks: Record<string, Task>;
}

function normalizeCadence(raw?: string): TaskCadence {
  const v = raw?.trim() as TaskCadence | undefined;
  return v && TASK_CADENCES.includes(v) ? v : "daily";
}

function normalizeHour(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 8;
  return Math.max(0, Math.min(23, Math.trunc(raw)));
}

export class TaskStore {
  private configPath: string;
  private tasks: Map<string, Task>;

  constructor(dataDir: string) {
    this.configPath = join(dataDir, "config", "tasks.json");
    this.tasks = this.load();
  }

  private load(): Map<string, Task> {
    const map = new Map<string, Task>();
    if (existsSync(this.configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as TasksFile;
        for (const [id, t] of Object.entries(parsed.tasks ?? {})) {
          if (t && typeof t.id === "string" && isSpaceId(t.space)) {
            // Backfill for older records written before distillOnRun existed.
            if (typeof t.distillOnRun !== "boolean") t.distillOnRun = true;
            map.set(id, t);
          }
        }
      } catch {
        // corrupt file: start empty rather than crash the backend
      }
    }
    return map;
  }

  private persist(): void {
    mkdirSync(join(this.configPath, ".."), { recursive: true });
    const obj: TasksFile = { tasks: Object.fromEntries(this.tasks) };
    writeFileSync(this.configPath, JSON.stringify(obj, null, 2), "utf8");
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  /** Create a task. Requires a valid space; returns undefined if space is invalid. */
  create(input: TaskInput): Task | undefined {
    const space = input.space?.trim();
    if (!space || !isSpaceId(space)) return undefined;
    const now = Date.now();
    const task: Task = {
      id: `task_${randomUUID()}`,
      name: input.name?.trim() || "未命名任务",
      space,
      topic: input.topic?.trim() ?? "",
      cadence: normalizeCadence(input.cadence),
      hour: normalizeHour(input.hour),
      enabled: input.enabled ?? true,
      notify: input.notify ?? true,
      distillOnRun: input.distillOnRun ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.persist();
    return task;
  }

  /** Patch an existing task. Only provided fields change. Returns undefined if absent. */
  update(id: string, input: TaskInput): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (input.name !== undefined) task.name = input.name.trim() || task.name;
    if (input.space !== undefined && isSpaceId(input.space.trim())) task.space = input.space.trim() as SpaceId;
    if (input.topic !== undefined) task.topic = input.topic.trim();
    if (input.cadence !== undefined) task.cadence = normalizeCadence(input.cadence);
    if (input.hour !== undefined) task.hour = normalizeHour(input.hour);
    if (input.enabled !== undefined) task.enabled = input.enabled;
    if (input.notify !== undefined) task.notify = input.notify;
    if (input.distillOnRun !== undefined) task.distillOnRun = input.distillOnRun;
    task.updatedAt = Date.now();
    this.persist();
    return task;
  }

  /** Record the outcome of a run (for display + scheduling). */
  setLastRun(id: string, result: TaskRunResult): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.lastRunAt = result.at;
    task.lastStatus = result.status;
    task.lastSummary = result.status === "ok" ? result.summary : task.lastSummary;
    task.lastError = result.status === "error" ? result.error : undefined;
    this.persist();
  }

  remove(id: string): boolean {
    const ok = this.tasks.delete(id);
    if (ok) this.persist();
    return ok;
  }

  /** Restore exact archived task records after archive-level validation. */
  restore(tasks: Task[]): Task[] {
    const restored: Task[] = [];
    for (const task of tasks) {
      if (!isSpaceId(task.space)) throw new Error(`invalid task space: ${task.space}`);
      if (this.tasks.has(task.id)) throw new Error(`task id already exists: ${task.id}`);
      const copy = { ...task };
      this.tasks.set(copy.id, copy);
      restored.push(copy);
    }
    if (restored.length > 0) this.persist();
    return restored;
  }

  removeBySpace(space: SpaceId): number {
    let removed = 0;
    for (const [id, task] of this.tasks) {
      if (task.space !== space) continue;
      this.tasks.delete(id);
      removed += 1;
    }
    if (removed > 0) this.persist();
    return removed;
  }
}

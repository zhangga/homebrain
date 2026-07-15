/**
 * Durable user reminders. Reminders are separate from research tasks and raw
 * knowledge: they have a precise delivery time, an owner, and an explicit
 * lifecycle that survives service restarts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isSpaceId, type SpaceId } from "@homebrain/shared";

export type ReminderStatus = "scheduled" | "completed" | "cancelled";

export interface Reminder {
  id: string;
  title: string;
  space: SpaceId;
  /** Conversation that receives the proactive notification (group or p2p). */
  chatId: string;
  /** Only the creator may complete/cancel/snooze the reminder. */
  creatorId: string;
  /** Original requested delivery instant. */
  triggerAt: number;
  /** Mutable delivery instant used by retries, repetition, and snoozing. */
  nextTriggerAt: number;
  repeatEveryMs?: number;
  untilConfirmed: boolean;
  status: ReminderStatus;
  sourceMessageId?: string;
  lastNotifiedAt?: number;
  completedAt?: number;
  cancelledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReminderInput {
  title: string;
  space: string;
  chatId: string;
  creatorId: string;
  triggerAt: number;
  repeatEveryMs?: number;
  untilConfirmed?: boolean;
  sourceMessageId?: string;
}

interface RemindersFile {
  reminders: Record<string, Reminder>;
}

const MIN_REPEAT_MS = 60_000;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validStoredReminder(value: unknown): value is Reminder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reminder = value as Partial<Reminder>;
  return typeof reminder.id === "string"
    && typeof reminder.title === "string"
    && typeof reminder.space === "string"
    && isSpaceId(reminder.space)
    && typeof reminder.chatId === "string"
    && typeof reminder.creatorId === "string"
    && finite(reminder.triggerAt)
    && finite(reminder.nextTriggerAt)
    && ["scheduled", "completed", "cancelled"].includes(reminder.status ?? "")
    && typeof reminder.untilConfirmed === "boolean"
    && finite(reminder.createdAt)
    && finite(reminder.updatedAt);
}

export class ReminderStore {
  private readonly configPath: string;
  private readonly reminders: Map<string, Reminder>;

  constructor(dataDir: string) {
    this.configPath = join(dataDir, "config", "reminders.json");
    this.reminders = this.load();
  }

  private load(): Map<string, Reminder> {
    const reminders = new Map<string, Reminder>();
    if (!existsSync(this.configPath)) return reminders;
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as RemindersFile;
      for (const [id, reminder] of Object.entries(parsed.reminders ?? {})) {
        if (!validStoredReminder(reminder) || reminder.id !== id) continue;
        reminders.set(id, { ...reminder });
      }
    } catch {
      // A corrupt optional config file must not prevent Homebrain from starting.
    }
    return reminders;
  }

  private persist(): void {
    mkdirSync(join(this.configPath, ".."), { recursive: true });
    const file: RemindersFile = { reminders: Object.fromEntries(this.reminders) };
    writeFileSync(this.configPath, JSON.stringify(file, null, 2), "utf8");
  }

  list(): Reminder[] {
    return [...this.reminders.values()].sort(
      (a, b) => a.nextTriggerAt - b.nextTriggerAt || a.createdAt - b.createdAt,
    );
  }

  get(id: string): Reminder | undefined {
    return this.reminders.get(id);
  }

  has(id: string): boolean {
    return this.reminders.has(id);
  }

  create(input: ReminderInput, now = Date.now()): Reminder | undefined {
    const title = input.title.trim();
    const space = input.space.trim();
    const chatId = input.chatId.trim();
    const creatorId = input.creatorId.trim();
    if (!title || !isSpaceId(space) || !chatId || !creatorId || !finite(input.triggerAt)) {
      return undefined;
    }
    const repeatEveryMs = finite(input.repeatEveryMs) && input.repeatEveryMs >= MIN_REPEAT_MS
      ? input.repeatEveryMs
      : undefined;
    const reminder: Reminder = {
      id: `reminder_${randomUUID()}`,
      title,
      space,
      chatId,
      creatorId,
      triggerAt: input.triggerAt,
      nextTriggerAt: input.triggerAt,
      repeatEveryMs,
      untilConfirmed: Boolean(input.untilConfirmed && repeatEveryMs),
      status: "scheduled",
      sourceMessageId: input.sourceMessageId?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.reminders.set(reminder.id, reminder);
    this.persist();
    return reminder;
  }

  due(now = Date.now()): Reminder[] {
    return this.list().filter(
      (reminder) => reminder.status === "scheduled" && reminder.nextTriggerAt <= now,
    );
  }

  upcoming(space: SpaceId, from: number, to: number): Reminder[] {
    return this.list().filter(
      (reminder) => reminder.space === space
        && reminder.status === "scheduled"
        && reminder.nextTriggerAt >= from
        && reminder.nextTriggerAt <= to,
    );
  }

  markNotified(id: string, at = Date.now()): Reminder | undefined {
    const reminder = this.reminders.get(id);
    if (!reminder || reminder.status !== "scheduled") return undefined;
    reminder.lastNotifiedAt = at;
    reminder.updatedAt = at;
    if (reminder.untilConfirmed && reminder.repeatEveryMs) {
      reminder.nextTriggerAt = at + reminder.repeatEveryMs;
    } else {
      reminder.status = "completed";
      reminder.completedAt = at;
    }
    this.persist();
    return reminder;
  }

  complete(id: string, actorId: string, at = Date.now()): Reminder | undefined {
    const reminder = this.reminders.get(id);
    if (!reminder || reminder.creatorId !== actorId || reminder.status !== "scheduled") {
      return undefined;
    }
    reminder.status = "completed";
    reminder.completedAt = at;
    reminder.updatedAt = at;
    this.persist();
    return reminder;
  }

  cancel(id: string, actorId: string, at = Date.now()): Reminder | undefined {
    const reminder = this.reminders.get(id);
    if (!reminder || reminder.creatorId !== actorId || reminder.status !== "scheduled") {
      return undefined;
    }
    reminder.status = "cancelled";
    reminder.cancelledAt = at;
    reminder.updatedAt = at;
    this.persist();
    return reminder;
  }

  snooze(id: string, actorId: string, nextTriggerAt: number, at = Date.now()): Reminder | undefined {
    const reminder = this.reminders.get(id);
    if (
      !reminder
      || reminder.creatorId !== actorId
      || reminder.status !== "scheduled"
      || !finite(nextTriggerAt)
      || nextTriggerAt <= at
    ) {
      return undefined;
    }
    reminder.nextTriggerAt = nextTriggerAt;
    reminder.updatedAt = at;
    this.persist();
    return reminder;
  }

  remove(id: string): boolean {
    const removed = this.reminders.delete(id);
    if (removed) this.persist();
    return removed;
  }

  restore(reminders: Reminder[]): Reminder[] {
    const restored: Reminder[] = [];
    for (const reminder of reminders) {
      if (this.reminders.has(reminder.id)) {
        throw new Error(`reminder id already exists: ${reminder.id}`);
      }
      const copy = { ...reminder };
      this.reminders.set(copy.id, copy);
      restored.push(copy);
    }
    if (restored.length > 0) this.persist();
    return restored;
  }

  removeBySpace(space: SpaceId): number {
    let removed = 0;
    for (const [id, reminder] of this.reminders) {
      if (reminder.space !== space) continue;
      this.reminders.delete(id);
      removed += 1;
    }
    if (removed > 0) this.persist();
    return removed;
  }
}

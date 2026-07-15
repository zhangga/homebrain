import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homebrain/shared";
import { ReminderStore } from "./reminders.ts";

const SPACE: SpaceId = "team/oc_reminders";
const OTHER_SPACE: SpaceId = "personal/ou_other";
const NOW = new Date("2026-07-15T12:00:00+08:00").getTime();

describe("ReminderStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-reminders-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates a scheduled reminder and reloads it from disk", () => {
    const store = new ReminderStore(dir);
    const reminder = store.create({
      title: "去茶饼斋",
      space: SPACE,
      chatId: "oc_reminders",
      creatorId: "ou_me",
      triggerAt: NOW + 3600_000,
      sourceMessageId: "om_create",
    }, NOW);

    expect(reminder).toEqual(expect.objectContaining({
      title: "去茶饼斋",
      status: "scheduled",
      nextTriggerAt: NOW + 3600_000,
      untilConfirmed: false,
    }));
    expect(new ReminderStore(dir).get(reminder!.id)).toEqual(reminder);
  });

  test("a one-shot reminder completes after its notification is recorded", () => {
    const store = new ReminderStore(dir);
    const reminder = store.create({
      title: "开会",
      space: SPACE,
      chatId: "oc_reminders",
      creatorId: "ou_me",
      triggerAt: NOW,
    }, NOW)!;

    expect(store.due(NOW).map((item) => item.id)).toEqual([reminder.id]);
    store.markNotified(reminder.id, NOW);
    expect(store.get(reminder.id)).toEqual(expect.objectContaining({
      status: "completed",
      lastNotifiedAt: NOW,
    }));
    expect(store.due(NOW + 1)).toEqual([]);
  });

  test("a repeating reminder advances until its creator confirms it", () => {
    const store = new ReminderStore(dir);
    const reminder = store.create({
      title: "确认去大同",
      space: SPACE,
      chatId: "oc_reminders",
      creatorId: "ou_me",
      triggerAt: NOW,
      repeatEveryMs: 3 * 3600_000,
      untilConfirmed: true,
    }, NOW)!;

    store.markNotified(reminder.id, NOW);
    expect(store.get(reminder.id)).toEqual(expect.objectContaining({
      status: "scheduled",
      nextTriggerAt: NOW + 3 * 3600_000,
    }));
    expect(store.complete(reminder.id, "ou_other", NOW + 1000)).toBeUndefined();
    expect(store.complete(reminder.id, "ou_me", NOW + 1000)?.status).toBe("completed");
  });

  test("lists only scheduled reminders in the requested space and time range", () => {
    const store = new ReminderStore(dir);
    const inRange = store.create({
      title: "本周安排",
      space: SPACE,
      chatId: "oc_reminders",
      creatorId: "ou_me",
      triggerAt: NOW + 3600_000,
    }, NOW)!;
    store.create({
      title: "下月安排",
      space: SPACE,
      chatId: "oc_reminders",
      creatorId: "ou_me",
      triggerAt: NOW + 30 * 86400_000,
    }, NOW);
    store.create({
      title: "其他空间",
      space: OTHER_SPACE,
      chatId: "p2p_other",
      creatorId: "ou_other",
      triggerAt: NOW + 3600_000,
    }, NOW);

    expect(store.upcoming(SPACE, NOW, NOW + 7 * 86400_000).map((item) => item.id)).toEqual([
      inRange.id,
    ]);
  });
});

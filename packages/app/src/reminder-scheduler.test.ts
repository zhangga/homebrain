import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine } from "@homebrain/core";
import type { SpaceId } from "@homebrain/shared";
import { ReminderScheduler } from "./reminder-scheduler.ts";

const SPACE: SpaceId = "team/oc_reminder_scheduler";
const NOW = new Date("2026-07-15T12:00:00+08:00").getTime();

describe("ReminderScheduler", () => {
  let dir: string;
  let engine: KnowledgeEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-reminder-scheduler-"));
    engine = new KnowledgeEngine({ dataDir: dir });
    engine.ensureSpace(SPACE, { chatId: "oc_reminder_scheduler" });
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("delivers a due one-shot reminder and completes it", async () => {
    const reminder = engine.reminders.create({
      title: "去茶饼斋",
      space: SPACE,
      chatId: "oc_reminder_scheduler",
      creatorId: "ou_me",
      triggerAt: NOW,
    }, NOW)!;
    const notices: string[] = [];
    const scheduler = new ReminderScheduler(engine, {
      notify: async (_item, message) => void notices.push(message),
    });

    expect(await scheduler.tick("test", new Date(NOW))).toEqual([reminder.id]);
    expect(notices[0]).toContain("⏰ 提醒：去茶饼斋");
    expect(engine.reminders.get(reminder.id)?.status).toBe("completed");
  });

  test("keeps a repeating reminder scheduled and explains how to stop it", async () => {
    const reminder = engine.reminders.create({
      title: "确认去大同",
      space: SPACE,
      chatId: "oc_reminder_scheduler",
      creatorId: "ou_me",
      triggerAt: NOW,
      repeatEveryMs: 3 * 3600_000,
      untilConfirmed: true,
    }, NOW)!;
    const notices: string[] = [];
    const scheduler = new ReminderScheduler(engine, {
      notify: async (_item, message) => void notices.push(message),
    });

    await scheduler.tick("test", new Date(NOW));
    expect(notices[0]).toContain("回复并 @我“确认去大同”");
    expect(engine.reminders.get(reminder.id)).toEqual(expect.objectContaining({
      status: "scheduled",
      nextTriggerAt: NOW + 3 * 3600_000,
    }));
  });

  test("does not advance a reminder when delivery fails", async () => {
    const reminder = engine.reminders.create({
      title: "失败重试",
      space: SPACE,
      chatId: "oc_reminder_scheduler",
      creatorId: "ou_me",
      triggerAt: NOW,
    }, NOW)!;
    const scheduler = new ReminderScheduler(engine, {
      notify: async () => { throw new Error("network unavailable"); },
    });

    expect(await scheduler.tick("test", new Date(NOW))).toEqual([]);
    expect(engine.reminders.get(reminder.id)?.status).toBe("scheduled");
    expect(scheduler.health()).toEqual(expect.objectContaining({
      lastStatus: "error",
      lastError: expect.stringContaining("network unavailable"),
    }));
  });

  test("prevents deleting a space while one of its reminders is being delivered", async () => {
    engine.reminders.create({
      title: "并发投递",
      space: SPACE,
      chatId: "oc_reminder_scheduler",
      creatorId: "ou_me",
      triggerAt: NOW,
    }, NOW);
    let releaseDelivery!: () => void;
    let deliveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const scheduler = new ReminderScheduler(engine, {
      notify: async () => {
        deliveryStarted();
        await released;
      },
    });

    const tick = scheduler.tick("test", new Date(NOW));
    await started;
    await expect(engine.deleteSpace(SPACE)).rejects.toThrow("space has delivering reminders");
    releaseDelivery();
    await tick;
    expect((await engine.deleteSpace(SPACE)).status).toBe("deleted");
  });
});

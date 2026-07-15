import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeLlm,
  KnowledgeEngine,
  type LearningPlan,
  type LearningSession,
} from "@homeagent/core";
import {
  LearningScheduler,
  learningNotification,
  shouldRunLearningPlan,
} from "./learning-scheduler.ts";

const NOW = new Date("2026-07-15T10:00:00+08:00");

function plan(overrides: Partial<LearningPlan> = {}): LearningPlan {
  return {
    id: "learn_1",
    name: "读原则",
    space: "personal/ou_me",
    creatorId: "ou_me",
    chatId: "oc_p2p",
    sourceId: "source_1",
    sourceLength: 1000,
    hour: 8,
    dailyCharacters: 500,
    cursor: 0,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function session(overrides: Partial<LearningSession> = {}): LearningSession {
  return {
    id: "session_1",
    planId: "learn_1",
    sequence: 1,
    startOffset: 0,
    endOffset: 500,
    sectionTitle: "第一章",
    excerpt: "今日原文",
    guide: "## 今日目标\n理解第一章",
    status: "prepared",
    preparedAt: 1,
    ...overrides,
  };
}

describe("shouldRunLearningPlan", () => {
  test("runs once after the configured hour and waits for an answer", () => {
    expect(shouldRunLearningPlan(plan(), undefined, NOW)).toBe(true);
    expect(shouldRunLearningPlan(plan({ hour: 11 }), undefined, NOW)).toBe(false);
    expect(shouldRunLearningPlan(
      plan({ lastDeliveredAt: new Date("2026-07-15T08:00:00+08:00").getTime() }),
      undefined,
      NOW,
    )).toBe(false);
    expect(shouldRunLearningPlan(plan(), session({ status: "prepared" }), NOW)).toBe(true);
    expect(shouldRunLearningPlan(plan(), session({ status: "awaiting_reply" }), NOW)).toBe(false);
    expect(shouldRunLearningPlan(plan({ status: "paused" }), undefined, NOW)).toBe(false);
  });
});

describe("LearningScheduler", () => {
  let dir: string;
  let llm: FakeLlm;
  let engine: KnowledgeEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ha-learning-scheduler-"));
    llm = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm });
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("delivers one due lesson and does not redeliver while awaiting a reply", async () => {
    const created = seedPlan(engine);
    llm.queueText("## 今日目标\n理解第一章");
    const notified: string[] = [];
    const scheduler = new LearningScheduler(engine, {
      notify: async (_plan, _source, current) => { notified.push(current.id); },
    });

    expect(await scheduler.tick("due", NOW)).toEqual([created.id]);
    expect(await scheduler.tick("again", NOW)).toEqual([]);
    expect(notified).toHaveLength(1);
    expect(engine.learning.currentSession(created.id)?.status).toBe("awaiting_reply");
  });

  test("retries the same prepared lesson after delivery failure", async () => {
    const created = seedPlan(engine);
    llm.queueText("## 今日目标\n理解第一章");
    const attempted: string[] = [];
    const scheduler = new LearningScheduler(engine, {
      notify: async (_plan, _source, current) => {
        attempted.push(current.id);
        throw new Error("network unavailable");
      },
    });

    expect(await scheduler.tick("first", NOW)).toEqual([]);
    expect(await scheduler.tick("retry", NOW)).toEqual([]);
    expect(attempted[0]).toBe(attempted[1]);
    expect(engine.learning.currentSession(created.id)?.status).toBe("prepared");
    expect(scheduler.health()).toEqual(expect.objectContaining({
      lastStatus: "error",
      lastError: expect.stringContaining("network unavailable"),
    }));
  });

  test("renders the source excerpt, guide, and explicit answer instruction", () => {
    const message = learningNotification(plan(), session());
    expect(message).toContain("📖 读原则 · 第 1 课");
    expect(message).toContain("## 今日原文\n今日原文");
    expect(message).toContain("学习回答：");
  });
});

function seedPlan(engine: KnowledgeEngine): LearningPlan {
  return engine.learning.create({
    name: "读原则",
    space: "personal/ou_me",
    creatorId: "ou_me",
    chatId: "oc_p2p",
    sourceTitle: "原则",
    sourceContent: `# 第一章\n\n${"正文".repeat(300)}`,
    sourceRawIds: ["raw_book"],
    sourceMessageId: "om_book",
    hour: 8,
    dailyCharacters: 500,
  }, NOW.getTime() - 1000);
}

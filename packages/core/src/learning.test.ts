import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningPlanStore } from "./learning.ts";

const NOW = new Date("2026-07-15T08:00:00+08:00").getTime();

describe("LearningPlanStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ha-learning-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("persists a source snapshot and active plan", () => {
    const store = new LearningPlanStore(dir);
    const content = "# 第一章\n\n正文";

    const plan = store.create({
      name: "读原则",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "原则",
      sourceContent: content,
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
      hour: 8,
      dailyCharacters: 3000,
    }, NOW);

    expect(plan).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^learn_/),
      status: "active",
      cursor: 0,
      sourceLength: content.length,
      createdAt: NOW,
    }));
    expect(store.source(plan.id)).toEqual(expect.objectContaining({
      title: "原则",
      content,
      rawIds: ["raw_book"],
      messageId: "om_book",
    }));
    expect(new LearningPlanStore(dir).get(plan.id)).toEqual(plan);
    expect(existsSync(join(dir, "config", "learning.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "config", "learning.json"), "utf8")).plans[plan.id].name)
      .toBe("读原则");
  });

  test("keeps a prepared lesson retryable until delivery succeeds", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);

    const session = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文",
      guide: "## 今日目标\n理解正文",
      preparedAt: NOW,
    });

    expect(session).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^learn_session_/),
      sequence: 1,
      status: "prepared",
    }));
    expect(store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 8,
      sectionTitle: "不应重复",
      excerpt: "另一段",
      guide: "另一份导读",
      preparedAt: NOW + 1,
    })?.id).toBe(session?.id);

    expect(store.markDelivered(session!.id, NOW + 1000)?.status).toBe("awaiting_reply");
    expect(new LearningPlanStore(dir).currentSession(plan.id)).toEqual(expect.objectContaining({
      id: session!.id,
      status: "awaiting_reply",
      deliveredAt: NOW + 1000,
    }));
  });

  test("advances progress only after an awaiting lesson is completed", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    const session = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文内容",
      guide: "导读",
      preparedAt: NOW,
    })!;

    expect(store.completeSession(session.id, {
      learnerReply: "抢答",
      feedback: "尚未投递",
      completedAt: NOW + 1,
    })).toBeUndefined();
    expect(store.get(plan.id)?.cursor).toBe(0);

    store.markDelivered(session.id, NOW + 2);
    expect(store.completeSession(session.id, {
      learnerReply: "我的理解",
      feedback: "理解正确",
      completedAt: NOW + 3,
    })).toEqual(expect.objectContaining({
      status: "completed",
      learnerReply: "我的理解",
      feedback: "理解正确",
    }));
    const reopened = new LearningPlanStore(dir);
    expect(reopened.get(plan.id)).toEqual(expect.objectContaining({
      cursor: 4,
      status: "active",
    }));
    expect(reopened.currentSession(plan.id)).toBeUndefined();
  });

  test("enforces chat ownership while allowing explicit administrative updates", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);

    expect(store.pause(plan.id, "ou_other")).toBeUndefined();
    expect(store.pause(plan.id, "ou_me")?.status).toBe("paused");
    expect(store.resume(plan.id, "ou_me")?.status).toBe("active");
    expect(store.update(plan.id, "ou_other", { hour: 22 })).toBeUndefined();
    expect(store.update(plan.id, undefined, { hour: 99, dailyCharacters: 100 }))
      .toEqual(expect.objectContaining({ hour: 23, dailyCharacters: 500 }));
  });

  test("lets only the creator skip an awaiting lesson and completes at end of source", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    const session = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: plan.sourceLength,
      sectionTitle: "全书",
      excerpt: "正文内容共八字",
      guide: "导读",
      preparedAt: NOW,
    })!;
    store.markDelivered(session.id, NOW + 1);

    expect(store.skipCurrent(plan.id, "ou_other", NOW + 2)).toBeUndefined();
    expect(store.skipCurrent(plan.id, "ou_me", NOW + 2)?.status).toBe("skipped");
    expect(store.get(plan.id)).toEqual(expect.objectContaining({
      cursor: plan.sourceLength,
      status: "completed",
    }));
  });

  test("keeps visible state unchanged when durable persistence fails", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    Object.defineProperty(store, "persist", {
      value: () => { throw new Error("disk full"); },
    });

    expect(() => store.pause(plan.id, "ou_me", NOW + 1)).toThrow("disk full");
    expect(store.get(plan.id)?.status).toBe("active");
    expect(() => store.create({
      name: "不能留在内存",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "失败书籍",
      sourceContent: "内容",
      sourceRawIds: ["raw_failed"],
      sourceMessageId: "om_failed",
    }, NOW + 2)).toThrow("disk full");
    expect(store.list()).toHaveLength(1);
  });

  test("exports and restores a complete space-scoped learning graph", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    const session = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文内容",
      guide: "导读",
      preparedAt: NOW,
    })!;
    store.markDelivered(session.id, NOW + 1);

    const archive = store.exportBySpace("personal/ou_me");
    expect(archive).toEqual({
      plans: [expect.objectContaining({ id: plan.id })],
      sources: [expect.objectContaining({ content: "正文内容共八字" })],
      sessions: [expect.objectContaining({ id: session.id, status: "awaiting_reply" })],
    });

    const restored = new LearningPlanStore(join(dir, "restored"));
    expect(restored.restore(archive).map((item) => item.id)).toEqual([plan.id]);
    expect(restored.source(plan.id)?.content).toBe("正文内容共八字");
    expect(restored.currentSession(plan.id)?.id).toBe(session.id);
  });

  test("removes source snapshots and sessions by provenance, owner, or space", () => {
    const store = new LearningPlanStore(dir);
    const first = createPlan(store);
    const second = store.create({
      name: "另一计划",
      space: "team/oc_team",
      creatorId: "ou_other",
      chatId: "oc_team",
      sourceTitle: "另一书",
      sourceContent: "另一正文",
      sourceRawIds: ["raw_other"],
      sourceMessageId: "om_other",
    }, NOW + 1);

    expect(store.remove(first.id, "ou_other")).toBe(false);
    expect(store.removeByRawIds(new Set(["raw_1"]))).toBe(1);
    expect(store.get(first.id)).toBeUndefined();
    expect(store.removeBySpace("team/oc_team")).toBe(1);
    expect(store.get(second.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});

function createPlan(store: LearningPlanStore) {
  return store.create({
    name: "读书",
    space: "personal/ou_me",
    creatorId: "ou_me",
    chatId: "oc_p2p",
    sourceTitle: "书",
    sourceContent: "正文内容共八字",
    sourceRawIds: ["raw_1"],
    sourceMessageId: "om_1",
    hour: 8,
    dailyCharacters: 3000,
  }, NOW);
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningPlanStore, learningProgress } from "./learning.ts";

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

  test("persists a topic plan with an explicit learning route", () => {
    const store = new LearningPlanStore(dir);

    const plan = store.createTopic({
      name: "学习 Rust 异步编程",
      topic: "Rust 异步编程",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      route: [
        { title: "Future 基础", objective: "理解惰性求值与轮询模型" },
        { title: "异步运行时", objective: "理解 executor、reactor 与任务调度" },
        { title: "并发实践", objective: "能选择 join、select 与 spawn" },
      ],
    }, NOW);

    expect(plan).toEqual(expect.objectContaining({
      mode: "topic",
      topic: "Rust 异步编程",
      routeIndex: 0,
    }));
    expect(plan.adaptiveFocus).toBeUndefined();
    expect(plan.route.map((step) => [step.title, step.status, step.attempts])).toEqual([
      ["Future 基础", "active", 0],
      ["异步运行时", "pending", 0],
      ["并发实践", "pending", 0],
    ]);
    expect(store.source(plan.id)).toEqual(expect.objectContaining({
      title: "主题：Rust 异步编程",
      materials: [],
      rawIds: [],
    }));
    expect(new LearningPlanStore(dir).get(plan.id)).toEqual(plan);
  });

  test("migrates pre-topic reading state on load", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    const path = join(dir, "config", "learning.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    delete file.plans[plan.id].mode;
    delete file.plans[plan.id].route;
    delete file.plans[plan.id].routeIndex;
    delete file.sources[plan.sourceId].materials;
    writeFileSync(path, JSON.stringify(file));

    const migrated = new LearningPlanStore(dir);

    expect(migrated.get(plan.id)).toEqual(expect.objectContaining({
      mode: "reading",
      route: [],
      routeIndex: 0,
    }));
    expect(migrated.source(plan.id)?.materials).toEqual([
      expect.objectContaining({ title: "书", rawIds: ["raw_1"] }),
    ]);
  });

  test("appends distinct source materials to a topic plan without changing its route progress", () => {
    const store = new LearningPlanStore(dir);
    const plan = store.createTopic({
      name: "学习 Rust",
      topic: "Rust 异步编程",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      route: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    }, NOW);

    expect(store.addMaterial(plan.id, "ou_other", {
      title: "错误权限",
      content: "不应写入",
      rawIds: ["raw_wrong"],
      messageId: "om_wrong",
    }, NOW + 1)).toBeUndefined();
    const updated = store.addMaterial(plan.id, "ou_me", {
      title: "Rust Async Book",
      content: "Future 是一种惰性计算。",
      rawIds: ["raw_async"],
      messageId: "om_async",
    }, NOW + 2)!;

    expect(updated).toEqual(expect.objectContaining({ routeIndex: 0, cursor: 0 }));
    expect(store.source(plan.id)).toEqual(expect.objectContaining({
      rawIds: ["raw_async"],
      content: expect.stringContaining("# 来源材料：Rust Async Book"),
      materials: [expect.objectContaining({
        title: "Rust Async Book",
        rawIds: ["raw_async"],
        messageId: "om_async",
      })],
    }));
    expect(() => store.addMaterial(plan.id, "ou_me", {
      title: "重复材料",
      content: "重复",
      rawIds: ["raw_async_2"],
      messageId: "om_async",
    }, NOW + 3)).toThrow("已经添加");
    expect(new LearningPlanStore(dir).source(plan.id)?.materials).toHaveLength(1);
  });

  test("keeps a weak topic step active and advances it only after mastery", () => {
    const store = new LearningPlanStore(dir);
    const plan = store.createTopic({
      name: "学习 Rust",
      topic: "Rust 异步编程",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      route: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    }, NOW);
    const firstStep = plan.route[0]!;
    const first = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 1,
      routeStepId: firstStep.id,
      sectionTitle: firstStep.title,
      excerpt: "暂无用户材料",
      guide: "## 今日目标\n理解 Future",
      preparedAt: NOW + 1,
    })!;
    store.markDelivered(first.id, NOW + 2);

    store.completeSession(first.id, {
      learnerReply: "Future 是线程",
      feedback: "还需要区分 Future 与线程",
      mastery: "review",
      nextFocus: "Future 的惰性轮询",
      completedAt: NOW + 3,
    });
    expect(store.get(plan.id)).toEqual(expect.objectContaining({
      routeIndex: 0,
      adaptiveFocus: "Future 的惰性轮询",
      status: "active",
    }));
    expect(store.get(plan.id)?.route[0]).toEqual(expect.objectContaining({
      status: "active",
      attempts: 1,
    }));

    const retry = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 1,
      routeStepId: firstStep.id,
      sectionTitle: firstStep.title,
      excerpt: "暂无用户材料",
      guide: "## 今日目标\n补强 Future",
      preparedAt: NOW + 4,
    })!;
    store.markDelivered(retry.id, NOW + 5);
    store.completeSession(retry.id, {
      learnerReply: "Future 被 poll 才推进",
      feedback: "已经掌握",
      mastery: "ready",
      nextFocus: "executor 如何调度 Future",
      completedAt: NOW + 6,
    });

    expect(store.get(plan.id)).toEqual(expect.objectContaining({
      routeIndex: 1,
      adaptiveFocus: "executor 如何调度 Future",
      status: "active",
    }));
    expect(store.get(plan.id)?.route.map((step) => [step.status, step.attempts])).toEqual([
      ["completed", 2],
      ["active", 0],
    ]);

    const secondStep = store.get(plan.id)!.route[1]!;
    const second = store.prepareSession(plan.id, {
      startOffset: 1,
      endOffset: 2,
      routeStepId: secondStep.id,
      sectionTitle: secondStep.title,
      excerpt: "暂无用户材料",
      guide: "## 今日目标\n理解运行时",
      preparedAt: NOW + 7,
    })!;
    store.markDelivered(second.id, NOW + 8);
    store.skipCurrent(plan.id, "ou_me", NOW + 9);
    expect(store.get(plan.id)).toEqual(expect.objectContaining({
      routeIndex: 2,
      status: "completed",
    }));
    expect(learningProgress(store.get(plan.id)!)).toBe(100);
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

  test("completing or skipping the current lesson does not implicitly resume a paused plan", () => {
    const store = new LearningPlanStore(dir);
    const completedPlan = createPlan(store);
    const completedSession = store.prepareSession(completedPlan.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文内容",
      guide: "导读",
      preparedAt: NOW,
    })!;
    store.markDelivered(completedSession.id, NOW + 1);
    store.pause(completedPlan.id, "ou_me", NOW + 2);
    store.completeSession(completedSession.id, {
      learnerReply: "我的理解",
      feedback: "理解正确",
      completedAt: NOW + 3,
    });
    expect(store.get(completedPlan.id)?.status).toBe("paused");

    const skippedPlan = createPlan(store);
    const skippedSession = store.prepareSession(skippedPlan.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文内容",
      guide: "导读",
      preparedAt: NOW + 4,
    })!;
    store.markDelivered(skippedSession.id, NOW + 5);
    store.pause(skippedPlan.id, "ou_me", NOW + 6);
    store.skipCurrent(skippedPlan.id, "ou_me", NOW + 7);
    expect(store.get(skippedPlan.id)?.status).toBe("paused");
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

  test("rejects a restore graph whose current session belongs to another plan", () => {
    const source = new LearningPlanStore(join(dir, "source"));
    const first = createPlan(source);
    const second = createPlan(source);
    const session = source.prepareSession(second.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文内容",
      guide: "导读",
      preparedAt: NOW,
    })!;
    const archive = source.exportBySpace("personal/ou_me");
    archive.plans[0] = { ...archive.plans[0]!, currentSessionId: session.id };

    const target = new LearningPlanStore(join(dir, "target"));
    expect(() => target.restore(archive)).toThrow("current session");
    expect(target.list()).toEqual([]);
    expect(source.get(first.id)).toBeDefined();
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

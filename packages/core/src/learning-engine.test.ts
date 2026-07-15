import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import { FakeLlm } from "./testing.ts";

const SPACE: SpaceId = "personal/ou_me";
const NOW = new Date("2026-07-15T08:00:00+08:00").getTime();

describe("guided learning engine", () => {
  let dir: string;
  let llm: FakeLlm;
  let engine: KnowledgeEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ha-learning-engine-"));
    llm = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm });
    engine.ensureSpace(SPACE, { chatId: "oc_p2p" });
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates a plan from the longest readable record derived from the replied-to message", async () => {
    const messageId = "om_book";
    await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_me",
      chatId: "oc_p2p",
      messageId,
      content: "一本书",
    });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_me",
      chatId: "oc_p2p",
      messageId,
      content: "# 附件：principles.md\n\n# 第一章\n\n这是足够长的正文。",
      attachments: [{ kind: "file", ref: "file_book", name: "principles.md" }],
    });

    const plan = engine.createLearningPlanFromMessage({
      space: SPACE,
      chatId: "oc_p2p",
      messageId,
      creatorId: "ou_me",
      name: "读《原则》",
      hour: 9,
    });

    expect(plan).toEqual(expect.objectContaining({
      name: "读《原则》",
      creatorId: "ou_me",
      hour: 9,
    }));
    expect(engine.learning.source(plan.id)).toEqual(expect.objectContaining({
      title: "principles.md",
      rawIds: [rawId],
      content: "# 第一章\n\n这是足够长的正文。",
    }));
  });

  test("refuses a reply target that has no readable source", () => {
    expect(() => engine.createLearningPlanFromMessage({
      space: SPACE,
      chatId: "oc_p2p",
      messageId: "om_missing",
      creatorId: "ou_me",
      name: "空书",
    })).toThrow("没有找到可阅读的书籍内容");
  });

  test("prepares one grounded lesson without advancing reading progress", async () => {
    const content = `# 第一章\n\n${"正文".repeat(300)}`;
    const plan = engine.learning.create({
      name: "读原则",
      space: SPACE,
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "原则",
      sourceContent: content,
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
      dailyCharacters: 500,
    }, NOW);
    llm.queueText("## 今日目标\n理解第一章\n\n## 阅读提示\n慢读\n\n## 重点概念\n原则\n\n## 思考题\n1. 为什么？");

    const session = await engine.prepareLearningSession(plan.id, NOW + 1);

    expect(session).toEqual(expect.objectContaining({
      sequence: 1,
      status: "prepared",
      startOffset: 0,
      sectionTitle: "第一章",
      guide: expect.stringContaining("## 今日目标"),
    }));
    expect(session.excerpt).toContain("# 第一章");
    expect(engine.learning.get(plan.id)?.cursor).toBe(0);
    expect(llm.calls.at(-1)?.opts.prompt).toContain(session.excerpt);
  });

  test("retries the same prepared lesson and marks it delivered only after transport succeeds", async () => {
    const content = `# 第一章\n\n${"正文".repeat(300)}`;
    const plan = engine.learning.create({
      name: "读原则",
      space: SPACE,
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "原则",
      sourceContent: content,
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
      dailyCharacters: 500,
    }, NOW);
    llm.queueText("## 今日目标\n理解第一章");
    const delivered: string[] = [];

    await expect(engine.deliverLearningSession(plan.id, NOW + 1, async (_plan, _source, session) => {
      delivered.push(session.id);
      throw new Error("network unavailable");
    })).rejects.toThrow("network unavailable");
    expect(engine.learning.currentSession(plan.id)?.status).toBe("prepared");

    expect(await engine.deliverLearningSession(plan.id, NOW + 2, async (_plan, _source, session) => {
      delivered.push(session.id);
    })).toBe(true);
    expect(delivered[0]).toBe(delivered[1]);
    expect(engine.learning.currentSession(plan.id)?.status).toBe("awaiting_reply");
    expect(await engine.deliverLearningSession(plan.id, NOW + 3, async () => {
      throw new Error("must not redeliver");
    })).toBe(false);
  });

  test("only the learner can answer, receive feedback, and advance knowledge-backed progress", async () => {
    const plan = engine.learning.create({
      name: "读原则",
      space: SPACE,
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "原则",
      sourceContent: "# 第一章\n\n短正文",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    }, NOW);
    llm.queueText("## 今日目标\n理解第一章");
    await engine.deliverLearningSession(plan.id, NOW + 1, async () => {});

    await expect(engine.answerLearningSession(plan.id, "ou_other", "我的回答", NOW + 2))
      .rejects.toThrow("只有学习计划创建者可以提交回答");
    llm.queueText("## 回应点评\n理解正确\n\n## 需要澄清\n无\n\n## 今日总结\n掌握重点\n\n## 下一步\n继续阅读");
    const result = await engine.answerLearningSession(plan.id, "ou_me", "作者强调原则", NOW + 3);

    expect(result.feedback).toContain("## 回应点评");
    expect(result.session.status).toBe("completed");
    expect(engine.learning.get(plan.id)).toEqual(expect.objectContaining({
      cursor: plan.sourceLength,
      status: "completed",
    }));
    expect(engine.registry.store(SPACE).index().getRaw(result.rawId)).toEqual(expect.objectContaining({
      source: "learning",
      author: "ou_me",
      content: expect.stringContaining("## 我的回答\n作者强调原则"),
    }));
  });

  test("does not advance progress when the completed learning record cannot be captured", async () => {
    const plan = engine.learning.create({
      name: "读原则",
      space: SPACE,
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "原则",
      sourceContent: "# 第一章\n\n短正文",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    }, NOW);
    llm.queueText("## 今日目标\n理解第一章");
    await engine.deliverLearningSession(plan.id, NOW + 1, async () => {});
    llm.queueText("## 回应点评\n理解正确\n\n## 今日总结\n掌握重点");
    Object.defineProperty(engine, "remember", {
      value: async () => { throw new Error("capture unavailable"); },
    });

    await expect(engine.answerLearningSession(plan.id, "ou_me", "我的理解", NOW + 2))
      .rejects.toThrow("capture unavailable");
    expect(engine.learning.get(plan.id)?.cursor).toBe(0);
    expect(engine.learning.currentSession(plan.id)?.status).toBe("awaiting_reply");
  });
});

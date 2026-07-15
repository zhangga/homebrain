import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm, KnowledgeEngine } from "@homeagent/core";
import {
  handleLearningAnswer,
  handleLearningCommand,
  parseLearningAnswer,
  parseLearningCommand,
} from "./learning-commands.ts";

describe("learning command parsing", () => {
  test("recognizes explicit plan controls and answers only", () => {
    expect(parseLearningCommand("/learn")).toEqual({ verb: "list", arg: "" });
    expect(parseLearningCommand("/learn new 原则")).toEqual({ verb: "new", arg: "原则" });
    expect(parseLearningCommand("/learn 暂停 1")).toEqual({ verb: "pause", arg: "1" });
    expect(parseLearningCommand("/learn resume 原则")).toEqual({ verb: "resume", arg: "原则" });
    expect(parseLearningCommand("/learn skip 1")).toEqual({ verb: "skip", arg: "1" });
    expect(parseLearningCommand("/learn delete 原则")).toEqual({ verb: "delete", arg: "原则" });
    expect(parseLearningCommand("谁负责后端？")).toBeNull();
    expect(parseLearningAnswer("学习回答：我认为作者在区分原则和规则"))
      .toBe("我认为作者在区分原则和规则");
    expect(parseLearningAnswer("这周有什么安排？")).toBeNull();
  });
});

describe("learning command handling", () => {
  let dir: string;
  let llm: FakeLlm;
  let engine: KnowledgeEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ha-learning-commands-"));
    llm = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm });
    engine.ensureSpace("personal/ou_me", { chatId: "oc_p2p" });
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates a plan only from a replied-to readable source", async () => {
    const context = {
      space: "personal/ou_me" as const,
      chatId: "oc_p2p",
      actorId: "ou_me",
    };
    expect(await handleLearningCommand(engine, { verb: "new", arg: "原则" }, context))
      .toContain("请回复包含书籍附件");

    await engine.remember({
      space: context.space,
      source: "message",
      author: "ou_me",
      chatId: context.chatId,
      messageId: "om_book",
      content: "# 附件：book.md\n\n# 第一章\n\n正文",
    });
    const created = await handleLearningCommand(
      engine,
      { verb: "new", arg: "原则" },
      { ...context, sourceMessageId: "om_book" },
    );
    expect(created).toContain("已创建学习计划「原则」");
    expect(await handleLearningCommand(engine, { verb: "list", arg: "" }, context))
      .toContain("1. 原则");
  });

  test("scopes pause, resume, skip, and delete to the creator", async () => {
    const plan = seedAwaitingPlan(engine, "ou_me");
    const owner = { space: "personal/ou_me" as const, chatId: "oc_p2p", actorId: "ou_me" };
    const other = { ...owner, actorId: "ou_other" };

    expect(await handleLearningCommand(engine, { verb: "pause", arg: "1" }, other))
      .toContain("没找到");
    expect(await handleLearningCommand(engine, { verb: "skip", arg: "1" }, owner))
      .toContain("已跳过");
    expect(await handleLearningCommand(engine, { verb: "pause", arg: "1" }, owner))
      .toContain("已暂停");
    expect(await handleLearningCommand(engine, { verb: "resume", arg: plan.name }, owner))
      .toContain("已恢复");
    expect(await handleLearningCommand(engine, { verb: "delete", arg: "1" }, owner))
      .toContain("已删除");
    expect(engine.learning.get(plan.id)).toBeUndefined();
  });

  test("submits an answer only when exactly one owned lesson is awaiting", async () => {
    const plan = seedAwaitingPlan(engine, "ou_me");
    llm.queueText("## 回应点评\n很好\n\n## 需要澄清\n无\n\n## 今日总结\n完成\n\n## 下一步\n继续");

    const reply = await handleLearningAnswer(engine, "我的理解", {
      space: "personal/ou_me",
      chatId: "oc_p2p",
      actorId: "ou_me",
    });

    expect(reply).toContain("✅ 已记录「读书」第 1 课");
    expect(reply).toContain("## 回应点评");
    expect(engine.learning.currentSession(plan.id)).toBeUndefined();
  });
});

function seedAwaitingPlan(engine: KnowledgeEngine, creatorId: string) {
  const plan = engine.learning.create({
    name: "读书",
    space: "personal/ou_me",
    creatorId,
    chatId: "oc_p2p",
    sourceTitle: "书",
    sourceContent: "正文内容共八字",
    sourceRawIds: ["raw_book"],
    sourceMessageId: "om_book",
  }, 1);
  const session = engine.learning.prepareSession(plan.id, {
    startOffset: 0,
    endOffset: 4,
    sectionTitle: "第一章",
    excerpt: "正文内容",
    guide: "导读",
    preparedAt: 2,
  })!;
  engine.learning.markDelivered(session.id, 3);
  return plan;
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import { FakeLlm } from "./testing.ts";

const SPACE: SpaceId = "personal/ou_me";
const NOW = new Date("2026-07-15T08:00:00+08:00").getTime();

function topicGuide(sourceSection = "暂无用户材料"): string {
  return [
    "## 今日目标\n理解当前知识点",
    `## 来源材料\n${sourceSection}`,
    "## 扩展知识\n以下来自模型一般知识，未经外部检索验证。",
    "## 实践任务\n用自己的话解释概念",
    "## 思考题\n这个概念解决了什么问题？",
  ].join("\n\n");
}

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

  test("creates a topic plan from a model-generated route", async () => {
    llm.queueJSON({
      name: "Rust 异步编程入门",
      steps: [
        { title: "Future 基础", objective: "理解 Future 的惰性轮询" },
        { title: "运行时", objective: "理解 executor 与 reactor" },
        { title: "并发实践", objective: "能选择 join、select 和 spawn" },
      ],
    });

    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "Rust 异步编程",
      hour: 9,
    });

    expect(plan).toEqual(expect.objectContaining({
      name: "Rust 异步编程入门",
      topic: "Rust 异步编程",
      mode: "topic",
      hour: 9,
    }));
    expect(plan.route.map((step) => step.title)).toEqual([
      "Future 基础",
      "运行时",
      "并发实践",
    ]);
    expect(llm.calls.at(-1)).toEqual(expect.objectContaining({ kind: "json" }));
    expect(llm.calls.at(-1)?.opts.prompt).toContain("Rust 异步编程");
  });

  test("adds a replied source to an owned topic plan", async () => {
    llm.queueJSON({
      name: "Rust 异步",
      steps: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    });
    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "Rust 异步编程",
    });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_me",
      chatId: "oc_p2p",
      messageId: "om_async_book",
      content: "# 附件：async-book.md\n\n# Future\n\nFuture 是一种惰性计算。",
      attachments: [{ kind: "file", ref: "file_async", name: "async-book.md" }],
    });

    expect(() => engine.addLearningMaterialFromMessage(
      plan.id,
      "ou_other",
      "om_async_book",
    )).toThrow("只有学习计划创建者");
    const updated = engine.addLearningMaterialFromMessage(
      plan.id,
      "ou_me",
      "om_async_book",
    );
    const docRawId = await engine.remember({
      space: SPACE,
      source: "doc",
      author: "ou_me",
      chatId: "oc_p2p",
      messageId: "om_async_doc",
      content: "# 来源文档：https://example.feishu.cn/docx/async\n\n没有标题的文档正文。",
    });
    engine.addLearningMaterialFromMessage(plan.id, "ou_me", "om_async_doc");

    expect(updated.mode).toBe("topic");
    expect(engine.learning.source(plan.id)?.materials).toEqual([
      expect.objectContaining({ title: "async-book.md", rawIds: [rawId] }),
      expect.objectContaining({
        title: "https://example.feishu.cn/docx/async",
        rawIds: [docRawId],
      }),
    ]);
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

  test("prepares a topic lesson that separates supplied material from model expansion", async () => {
    llm.queueJSON({
      name: "Rust 异步",
      steps: [
        { title: "Future 基础", objective: "理解 Future 的惰性轮询" },
        { title: "运行时", objective: "理解运行时" },
      ],
    });
    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "Rust 异步编程",
    });
    engine.learning.addMaterial(plan.id, "ou_me", {
      title: "Async Book",
      content: "Future 只有在被 poll 时才会推进。",
      rawIds: ["raw_async"],
      messageId: "om_async",
    }, NOW + 1);
    llm.queueText([
      "## 今日目标\n理解 Future",
      "## 来源材料\n[材料1] Future 需要 poll",
      "## 扩展知识\n以下来自模型一般知识，未经外部检索验证。",
      "## 实践任务\n解释 poll",
      "## 思考题\n为什么 Future 是惰性的？",
    ].join("\n\n"));

    const session = await engine.prepareLearningSession(plan.id, NOW + 2);

    expect(session).toEqual(expect.objectContaining({
      routeStepId: plan.route[0]?.id,
      sectionTitle: "Future 基础",
      startOffset: 0,
      endOffset: 1,
      excerpt: expect.stringContaining("[材料1：Async Book]"),
    }));
    const prompt = llm.calls.at(-1)?.opts.prompt ?? "";
    expect(prompt).toContain("Future 只有在被 poll 时才会推进");
    expect(prompt).toContain("## 来源材料");
    expect(prompt).toContain("## 扩展知识");
    expect(engine.learning.get(plan.id)?.routeIndex).toBe(0);
  });

  test("rejects a topic lesson that fabricates a material citation or external link", async () => {
    llm.queueJSON({
      name: "Rust 异步",
      steps: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    });
    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "Rust 异步编程",
    });
    engine.learning.addMaterial(plan.id, "ou_me", {
      title: "Async Book",
      content: "Future 只有在被 poll 时才会推进。",
      rawIds: ["raw_async"],
      messageId: "om_async",
    });
    llm.queueText([
      "## 今日目标\n理解 Future",
      "## 来源材料\n[材料9] 声称 Future 会自动运行",
      "## 扩展知识\n模型一般知识，未经外部检索验证：https://invented.example/future",
      "## 实践任务\n解释 poll",
      "## 思考题\nFuture 如何推进？",
    ].join("\n\n"));

    await expect(engine.prepareLearningSession(plan.id, NOW + 1))
      .rejects.toThrow("不存在的材料");
    expect(engine.learning.currentSession(plan.id)).toBeUndefined();
  });

  test("uses every topic material and rotates long excerpts after a review", async () => {
    llm.queueJSON({
      name: "分布式系统",
      steps: [
        { title: "一致性", objective: "理解一致性模型" },
        { title: "共识", objective: "理解共识算法" },
      ],
    });
    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "分布式系统",
    });
    for (const label of ["A", "B", "C", "D"]) {
      engine.learning.addMaterial(plan.id, "ou_me", {
        title: `材料${label}`,
        content: `${label}-开头-${"甲".repeat(3_100)}${label}-后半-${"乙".repeat(3_100)}`,
        rawIds: [`raw_${label}`],
        messageId: `om_${label}`,
      });
    }
    llm.queueText(topicGuide("[材料1] 对比四份材料中的一致性定义"));
    const first = await engine.prepareLearningSession(plan.id, NOW + 1);

    for (const [index, label] of ["A", "B", "C", "D"].entries()) {
      expect(first.excerpt).toContain(`[材料${index + 1}：材料${label}]`);
      expect(first.excerpt).toContain(`${label}-开头-`);
      expect(first.excerpt).not.toContain(`${label}-后半-`);
    }
    engine.learning.markDelivered(first.id, NOW + 2);
    llm.queueJSON({
      feedback: "## 回应点评\n需要继续\n\n## 今日总结\n尚未掌握",
      mastery: "review",
      nextFocus: "比较不同一致性模型",
    });
    await engine.answerLearningSession(plan.id, "ou_me", "还不清楚", NOW + 3);
    llm.queueText(topicGuide("[材料1] 继续比较不同一致性模型"));
    const retry = await engine.prepareLearningSession(plan.id, NOW + 4);

    for (const label of ["A", "B", "C", "D"]) {
      expect(retry.excerpt).toContain(`${label}-后半-`);
    }
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

  test("uses structured mastery feedback to adapt the next topic lesson", async () => {
    llm.queueJSON({
      name: "Rust 异步",
      steps: [
        { title: "Future", objective: "理解 Future 的惰性轮询" },
        { title: "运行时", objective: "理解 executor" },
      ],
    });
    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "Rust 异步编程",
    });
    llm.queueText(topicGuide());
    await engine.deliverLearningSession(plan.id, NOW + 1, async () => {});
    llm.queueJSON({
      feedback: "## 回应点评\n把 Future 和线程混淆了\n\n## 今日总结\n需要补强轮询模型",
      mastery: "review",
      nextFocus: "用状态机解释 Future 的 poll 过程",
    });

    const result = await engine.answerLearningSession(
      plan.id,
      "ou_me",
      "Future 就是一个后台线程",
      NOW + 2,
    );

    expect(result.session).toEqual(expect.objectContaining({
      mastery: "review",
      nextFocus: "用状态机解释 Future 的 poll 过程",
    }));
    expect(result.plan).toEqual(expect.objectContaining({
      routeIndex: 0,
      adaptiveFocus: "用状态机解释 Future 的 poll 过程",
    }));
    llm.queueText(topicGuide());
    await engine.prepareLearningSession(plan.id, NOW + 3);
    expect(llm.calls.at(-1)?.opts.prompt).toContain("用状态机解释 Future 的 poll 过程");
    expect((await engine.health()).details?.learning).toEqual(expect.objectContaining({
      topic: 1,
      reading: 0,
      materials: 0,
      reviewing: 1,
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

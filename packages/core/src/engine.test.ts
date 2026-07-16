import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Knowledge } from "./knowledge.ts";
import { KnowledgeEngine } from "./engine.ts";
import { FakeLlm } from "./testing.ts";
import type { Page, SpaceId } from "@homeagent/shared";

let dir: string;
let engine: KnowledgeEngine;
const SPACE: SpaceId = "team/oc_contract";

function page(slug: string, title: string, content: string): Page {
  return {
    slug,
    type: "entity",
    title,
    summary: content.slice(0, 30),
    aliases: [],
    tags: [],
    sources: [],
    links: [],
    content,
    updatedAt: Date.now(),
    contentHash: "h",
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-engine-"));
  // No real CLI spawns in the contract test: a fake runner returns empty
  // structured results (dream analyze => no operations) and empty text.
  engine = new KnowledgeEngine({
    dataDir: dir,
    runProvider: async (_id, input) => {
      if (/JSON Schema/.test(input.prompt) && /operations/.test(input.prompt)) {
        return JSON.stringify({ operations: [], skippedRawIds: [] });
      }
      return "";
    },
  });
});

afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Knowledge seam contract", () => {
  test("engine satisfies the Knowledge interface shape", () => {
    // Structural assertion: assigning to the interface type is the contract.
    const k: Knowledge = engine;
    for (const method of [
      "remember",
      "getSpaceGovernance",
      "updateSpaceRules",
      "resetSpaceRule",
      "getRawGovernanceDetail",
      "redistillRaw",
      "deleteKnowledgePage",
      "regenerateKnowledgePage",
      "submitKnowledgeCorrection",
      "retractMessage",
      "runDreamCycle",
      "listQuarantines",
      "retryQuarantine",
      "retryQuarantines",
      "ask",
      "search",
      "getPage",
      "upsertPage",
      "listPages",
      "rebuildIndex",
      "health",
    ]) {
      expect(typeof (k as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });

  test("remember captures raw without creating pages", async () => {
    const id = await engine.remember({
      space: SPACE,
      source: "message",
      content: "记住：Alice 负责后端服务",
    });
    expect(typeof id).toBe("string");
    // no pages yet (distillation is a separate step)
    expect(await engine.listPages(SPACE)).toEqual([]);
  });

  test("message author can retract a pending capture by chat and message id", async () => {
    await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_source",
      content: "测试代号是北极星",
    });

    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_owner",
      }),
    ).toEqual({ status: "retracted", affectedPages: [], requeuedSourceIds: [] });

    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_owner",
      }),
    ).toEqual({ status: "already_retracted", affectedPages: [], requeuedSourceIds: [] });
    await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_source",
      content: "重投也不能恢复北极星",
    });
    expect((await engine.runDreamCycle(SPACE)).examined).toBe(0);
  });

  test("one user cannot retract another user's captured message", async () => {
    await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_source",
      content: "只有作者能撤回",
    });

    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_other",
      }),
    ).toEqual({ status: "forbidden", affectedPages: [], requeuedSourceIds: [] });
    expect((await engine.runDreamCycle(SPACE)).examined).toBe(1);
  });

  test("group administrator can retract another user's captured message", async () => {
    await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_source",
      content: "管理员可以治理群知识",
    });

    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_admin",
        requesterIsAdmin: true,
      }),
    ).toEqual({ status: "retracted", affectedPages: [], requeuedSourceIds: [] });
    expect((await engine.runDreamCycle(SPACE)).examined).toBe(0);
  });

  test("retraction removes every raw record derived from the same message", async () => {
    for (const source of ["message", "doc"] as const) {
      await engine.remember({
        space: SPACE,
        source,
        author: "ou_owner",
        chatId: "oc_contract",
        messageId: "om_source",
        content: source === "message" ? "见项目文档" : "文档正文",
      });
    }

    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_owner",
      }),
    ).toEqual({ status: "retracted", affectedPages: [], requeuedSourceIds: [] });
    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_owner",
      }),
    ).toEqual({ status: "already_retracted", affectedPages: [], requeuedSourceIds: [] });
    expect((await engine.runDreamCycle(SPACE)).examined).toBe(0);
  });

  test("retracting an ingested source removes affected pages and requeues surviving sources", async () => {
    const fake = new FakeLlm();
    const retractEngine = new KnowledgeEngine({ dataDir: join(dir, "retraction"), llm: fake });
    const removedId = await retractEngine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_remove",
      content: "项目代号是北极星",
    });
    const survivingId = await retractEngine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_keep",
      content: "项目负责人是 Alice",
    });
    fake.queueJSON({
      operations: [
        {
          type: "concept",
          name: "project-facts",
          title: "项目信息",
          rawIds: [removedId, survivingId],
        },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({
      title: "项目信息",
      summary: "项目代号与负责人",
      aliases: [],
      tags: [],
      links: [],
      content: "# 项目信息\n项目代号是北极星，负责人是 Alice。",
    });
    await retractEngine.runDreamCycle(SPACE);
    expect(await retractEngine.getPage(SPACE, "concepts/project-facts")).not.toBeNull();

    expect(
      await retractEngine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_remove",
        requestedBy: "ou_owner",
      }),
    ).toEqual({
      status: "retracted",
      affectedPages: ["concepts/project-facts"],
      requeuedSourceIds: [survivingId],
    });
    expect(await retractEngine.getPage(SPACE, "concepts/project-facts")).toBeNull();

    fake.queueJSON({ operations: [], skippedRawIds: [survivingId] });
    expect((await retractEngine.runDreamCycle(SPACE)).examined).toBe(1);
    retractEngine.close();
  });

  test("retracting a quarantined source clears the stale failure and requeues surviving sources", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const removedId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_quarantined_remove",
      content: "撤回这条失败来源",
    });
    const survivingId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_quarantined_keep",
      content: "保留并重新提炼这条来源",
    });
    fake.queueJSON({
      operations: [
        {
          type: "concept",
          name: "quarantined-retraction",
          title: "Quarantined Retraction",
          rawIds: [removedId, survivingId],
        },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Quarantined Retraction", summary: "", content: "" });
    await engine.runDreamCycle(SPACE);
    expect(await engine.listQuarantines(SPACE)).toHaveLength(1);

    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_quarantined_remove",
        requestedBy: "ou_owner",
      }),
    ).toEqual({
      status: "retracted",
      affectedPages: [],
      requeuedSourceIds: [survivingId],
    });
    expect(await engine.listQuarantines(SPACE)).toEqual([]);

    fake.queueJSON({ operations: [], skippedRawIds: [survivingId] });
    expect((await engine.runDreamCycle(SPACE)).examined).toBe(1);
  });

  test("upsertPage writes markdown file and is searchable", async () => {
    await engine.upsertPage(SPACE, page("entities/alice", "Alice", "Alice 负责后端服务"));
    // markdown file exists on disk
    const store = engine.registry.store(SPACE);
    expect(existsSync(join(store.wikiDir, "entities/alice.md"))).toBe(true);
    // searchable by 2-char Chinese query
    const hits = await engine.search([SPACE], "后端");
    expect(hits.map((h) => h.slug)).toEqual(["entities/alice"]);
    // retrievable
    const got = await engine.getPage(SPACE, "entities/alice");
    expect(got?.title).toBe("Alice");
  });

  test("search unions across spaces", async () => {
    const other: SpaceId = "personal/ou_me";
    await engine.upsertPage(SPACE, page("entities/a", "A", "关于缓存策略"));
    await engine.upsertPage(other, page("entities/b", "B", "另一个缓存话题"));
    const hits = await engine.search([SPACE, other], "缓存");
    expect(hits.length).toBe(2);
  });

  test("search/getPage on unknown space is empty, not an error", async () => {
    expect(await engine.search(["team/nope"], "x")).toEqual([]);
    expect(await engine.getPage("team/nope", "s")).toBeNull();
    expect(await engine.listPages("team/nope")).toEqual([]);
  });

  test("rebuildIndex reconstructs the DB from markdown files", async () => {
    await engine.upsertPage(SPACE, page("entities/alice", "Alice", "负责后端服务"));
    const store = engine.registry.store(SPACE);
    // Corrupt the DB by deleting the row directly, then rebuild from md.
    store.index().deletePage("entities/alice");
    expect(await engine.getPage(SPACE, "entities/alice")).toBeNull();
    const res = await engine.rebuildIndex(SPACE);
    expect(res.rebuilt).toBe(1);
    expect(res.corrupt).toEqual([]);
    expect(await engine.getPage(SPACE, "entities/alice")).not.toBeNull();
  });

  test("dream cycle stub is callable and returns a report", async () => {
    await engine.remember({ space: SPACE, source: "message", content: "x" });
    const report = await engine.runDreamCycle(SPACE);
    expect(report.space).toBe(SPACE);
    expect(typeof report.finishedAt).toBe("number");
  });

  test("quarantined distillations are visible through the knowledge seam", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      content: "需要恢复的提炼内容",
    });
    fake.queueJSON({
      operations: [{ type: "concept", name: "retry-me", title: "Retry Me", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Retry Me", summary: "", content: "   " });

    expect((await engine.runDreamCycle(SPACE)).pagesQuarantined).toBe(1);
    expect(await engine.listQuarantines(SPACE)).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        space: SPACE,
        slug: "concepts/retry-me",
        rawIds: [rawId],
        error: expect.stringContaining("empty content"),
        createdAt: expect.any(Number),
      }),
    ]);
  });

  test("a quarantined distillation can be retried without processing unrelated raw", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      content: "恢复后应该生成知识页",
    });
    await engine.remember({
      space: SPACE,
      source: "message",
      content: "不属于本次恢复的另一条原始记录",
    });
    fake.queueJSON({
      operations: [{ type: "concept", name: "retry-me", title: "Retry Me", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Retry Me", summary: "", content: "   " });
    await engine.runDreamCycle(SPACE, { rawIds: [rawId] });
    const record = (await engine.listQuarantines(SPACE))[0]!;

    fake.queueJSON({
      operations: [{ type: "concept", name: "retry-me", title: "Retry Me", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({
      title: "Retry Me",
      summary: "恢复成功",
      aliases: [],
      tags: [],
      links: [],
      content: "# Retry Me\n\n恢复成功。\n",
    });

    const result = await engine.retryQuarantine(SPACE, record.id);
    expect(result.status).toBe("recovered");
    expect(result.report?.examined).toBe(1);
    expect(await engine.listQuarantines(SPACE)).toEqual([]);
    expect(await engine.getPage(SPACE, "concepts/retry-me")).not.toBeNull();
    expect(engine.registry.store(SPACE).index().countRaw(true)).toBe(1);
  });

  test("an analysis failure keeps the quarantine and returns a fixed public reason", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const rawId = await engine.remember({ space: SPACE, source: "message", content: "分析重试失败" });
    fake.queueJSON({
      operations: [{ type: "concept", name: "analysis-failure", title: "Failure", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Failure", summary: "", content: "" });
    await engine.runDreamCycle(SPACE);
    const record = (await engine.listQuarantines(SPACE))[0]!;
    fake.onJSON(() => {
      throw new Error("private provider detail");
    });

    const result = await engine.retryQuarantine(SPACE, record.id);

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("重试未完成，原隔离记录已保留");
    expect(result.reason).not.toContain("private provider detail");
    expect((await engine.listQuarantines(SPACE)).map((item) => item.id)).toEqual([record.id]);
  });

  test("a missing source keeps the quarantine and returns a fixed public reason", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const rawId = await engine.remember({ space: SPACE, source: "message", content: "来源稍后丢失" });
    fake.queueJSON({
      operations: [{ type: "concept", name: "missing-source", title: "Missing", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Missing", summary: "", content: "" });
    await engine.runDreamCycle(SPACE);
    const record = (await engine.listQuarantines(SPACE))[0]!;
    engine.registry.store(SPACE).index().deleteRaw(rawId);

    expect(await engine.retryQuarantine(SPACE, record.id)).toEqual({
      status: "failed",
      id: record.id,
      reason: "部分原始来源已不存在，无法安全重试",
    });
    expect((await engine.listQuarantines(SPACE)).map((item) => item.id)).toEqual([record.id]);
  });

  test("a retry that fails generation replaces the old record with fresh evidence", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const rawId = await engine.remember({ space: SPACE, source: "message", content: "仍会失败" });
    const analyze = {
      operations: [{ type: "concept", name: "still-bad", title: "Still Bad", rawIds: [rawId] }],
      skippedRawIds: [],
    };
    fake.queueJSON(analyze).queueJSON({ title: "Still Bad", summary: "", content: "" });
    await engine.runDreamCycle(SPACE);
    const original = (await engine.listQuarantines(SPACE))[0]!;

    fake.queueJSON(analyze).queueJSON({ title: "Still Bad", summary: "", content: "" });
    const result = await engine.retryQuarantine(SPACE, original.id);
    const remaining = await engine.listQuarantines(SPACE);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("新的失败记录");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).not.toBe(original.id);
    expect(remaining[0]?.rawIds).toEqual([rawId]);
  });

  test("batch retry attempts the current quarantine snapshot once", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const first = await engine.remember({ space: SPACE, source: "message", content: "first" });
    const second = await engine.remember({ space: SPACE, source: "message", content: "second" });
    fake.queueJSON({
      operations: [
        { type: "concept", name: "first", title: "First", rawIds: [first] },
        { type: "concept", name: "second", title: "Second", rawIds: [second] },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "First", summary: "", content: "" });
    fake.queueJSON({ title: "Second", summary: "", content: "" });
    await engine.runDreamCycle(SPACE);
    expect(await engine.listQuarantines(SPACE)).toHaveLength(2);
    fake.onJSON((options) => {
      const rawIds = [first, second].filter((id) => options.prompt?.includes(id));
      return { operations: [], skippedRawIds: rawIds };
    });

    expect(await engine.retryQuarantines(SPACE)).toEqual(expect.objectContaining({
      total: 2,
      recovered: 2,
      failed: 0,
    }));
    expect(await engine.listQuarantines(SPACE)).toEqual([]);
  });

  test("legacy and malformed quarantine files remain visible", async () => {
    engine.ensureSpace(SPACE);
    const quarantineDir = join(engine.registry.store(SPACE).root, "quarantine");
    mkdirSync(quarantineDir, { recursive: true });
    writeFileSync(join(quarantineDir, "concepts__中文知识-123.json"), JSON.stringify({
      slug: "concepts/legacy",
      error: "Error: old timeout",
      rawIds: ["raw-old"],
      at: "2026-07-13T19:15:40.696Z",
    }));
    writeFileSync(join(quarantineDir, "broken-record.json"), "{broken");
    const outsideRecord = join(dir, "outside-quarantine.json");
    writeFileSync(outsideRecord, JSON.stringify({
      slug: "concepts/outside",
      error: "must not be read",
      rawIds: ["raw-outside"],
      at: "2026-07-14T19:15:40.696Z",
    }));
    symlinkSync(outsideRecord, join(quarantineDir, "linked-record.json"));

    const records = await engine.listQuarantines(SPACE);
    expect(records).toHaveLength(2);
    expect(records).toContainEqual(expect.objectContaining({
      id: "concepts__中文知识-123",
      slug: "concepts/legacy",
      error: "Error: old timeout",
      rawIds: ["raw-old"],
      createdAt: Date.parse("2026-07-13T19:15:40.696Z"),
    }));
    expect(records).toContainEqual(expect.objectContaining({
      id: "broken-record",
      slug: "（损坏的隔离记录）",
      rawIds: [],
    }));
  });

  test("raw retention preserves sources needed to recover a quarantine", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const createdAt = Date.now();
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      content: "隔离来源不能被清理",
      createdAt,
    });
    fake.queueJSON({
      operations: [{ type: "concept", name: "protected", title: "Protected", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Protected", summary: "", content: "" });
    await engine.runDreamCycle(SPACE);

    const report = await engine.pruneRawMessages(1, createdAt + 2 * 86_400_000);
    expect(report.deleted).toBe(0);
    expect(engine.registry.store(SPACE).index().listRawByIds([rawId])).toHaveLength(1);
    expect(await engine.listQuarantines(SPACE)).toHaveLength(1);
  });

  test("health reports CLI execution success and failure without probing the old gateway", async () => {
    const healthEngine = new KnowledgeEngine({
      dataDir: join(dir, "health"),
      runProvider: async (_provider, input) => {
        if (input.prompt.includes("失败主题")) throw new Error("CLI authentication failed");
        return "研究结果";
      },
    });
    healthEngine.ensureSpace(SPACE);
    const agent = healthEngine.agents.create({ name: "Codex", provider: "codex" });
    healthEngine.registry.updateMeta(SPACE, { agentId: agent.id });
    const successful = healthEngine.tasks.create({
      name: "成功任务",
      space: SPACE,
      topic: "成功主题",
      distillOnRun: false,
    })!;
    const failed = healthEngine.tasks.create({
      name: "失败任务",
      space: SPACE,
      topic: "失败主题",
      distillOnRun: false,
    })!;

    await healthEngine.runTask(successful.id);
    await healthEngine.runTask(failed.id);
    const report = await healthEngine.health();
    const providerRuns = report.details?.providerRuns as Array<Record<string, unknown>>;
    const tasks = report.details?.tasks as Array<Record<string, unknown>>;

    expect(report.ok).toBe(true);
    expect(report.details?.mode).toBe("cli-only");
    expect(providerRuns).toEqual([
      expect.objectContaining({
        provider: "codex",
        running: 0,
        lastStatus: "error",
        lastSuccessAt: expect.any(Number),
        lastFailureAt: expect.any(Number),
        lastError: "Error: CLI authentication failed",
      }),
    ]);
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: successful.id, running: false, lastStatus: "ok" }),
        expect.objectContaining({
          id: failed.id,
          running: false,
          lastStatus: "error",
          lastError: "Error: CLI authentication failed",
        }),
      ]),
    );
    healthEngine.close();
  });

  test("health reports the latest dream-cycle outcome for each space", async () => {
    await engine.remember({ space: SPACE, source: "message", content: "待提炼知识" });
    await engine.runDreamCycle(SPACE);

    const report = await engine.health();
    expect(report.details?.dreamCycles).toEqual([
      expect.objectContaining({
        space: SPACE,
        running: false,
        lastStatus: "ok",
        lastSuccessAt: expect.any(Number),
        lastExamined: 1,
      }),
    ]);
  });

  test("health keeps a task running until all concurrent runs finish", async () => {
    const completions: Array<(value: string) => void> = [];
    const healthEngine = new KnowledgeEngine({
      dataDir: join(dir, "concurrent-health"),
      runProvider: async () => new Promise<string>((resolve) => completions.push(resolve)),
    });
    healthEngine.ensureSpace(SPACE);
    const task = healthEngine.tasks.create({ name: "并发任务", space: SPACE, topic: "并发" })!;

    const first = healthEngine.runTask(task.id, { distill: false });
    const second = healthEngine.runTask(task.id, { distill: false });
    expect(completions).toHaveLength(2);

    completions[0]!("第一次完成");
    await first;
    let tasks = (await healthEngine.health()).details?.tasks as Array<Record<string, unknown>>;
    expect(tasks[0]?.running).toBe(true);

    completions[1]!("第二次完成");
    await second;
    tasks = (await healthEngine.health()).details?.tasks as Array<Record<string, unknown>>;
    expect(tasks[0]?.running).toBe(false);
    healthEngine.close();
  });

  test("health clears running state when task setup throws", async () => {
    const healthEngine = new KnowledgeEngine({
      dataDir: join(dir, "setup-failure-health"),
      runProvider: async () => "unused",
    });
    healthEngine.ensureSpace(SPACE);
    const task = healthEngine.tasks.create({ name: "失败任务", space: SPACE, topic: "失败" })!;
    healthEngine.agentForSpace = () => {
      throw new Error("agent store unavailable");
    };

    await expect(healthEngine.runTask(task.id, { distill: false })).rejects.toThrow(
      "agent store unavailable",
    );
    const tasks = (await healthEngine.health()).details?.tasks as Array<Record<string, unknown>>;
    expect(tasks[0]?.running).toBe(false);
    healthEngine.close();
  });

  test("space scaffold seeds purpose.md and schema.md", async () => {
    await engine.upsertPage(SPACE, page("entities/a", "A", "x"));
    const store = engine.registry.store(SPACE);
    expect(existsSync(join(store.root, "purpose.md"))).toBe(true);
    expect(existsSync(join(store.root, "schema.md"))).toBe(true);
  });

  test("runTask: research output is captured as a raw 'task' entry + lastRun recorded", async () => {
    // A dedicated engine whose CLI runner returns research text for the task.
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_id, input) => {
        if (/研究/.test(input.prompt)) return "要点一：...\n要点二：...";
        return "";
      },
    });
    taskEngine.ensureSpace(SPACE);
    const task = taskEngine.tasks.create({ name: "调研", space: SPACE, topic: "大模型 Agent 进展" })!;
    // distill:false keeps this test focused on capture (no dream calls)
    const report = await taskEngine.runTask(task.id, { distill: false });
    expect(report.ok).toBe(true);
    expect(report.summary).toContain("要点一");
    // captured as a raw entry with source "task"
    const raws = taskEngine.registry.store(SPACE).index().listRaw({});
    expect(raws.some((r) => r.source === "task" && r.content.includes("要点一"))).toBe(true);
    // lastRun recorded on the task
    expect(taskEngine.tasks.get(task.id)?.lastStatus).toBe("ok");
    taskEngine.close();
  });

  test("runTask: immediate distillation turns the research into a wiki page", async () => {
    // Runner serves both the research (text) and the dream steps (JSON schemas).
    let engineRef: KnowledgeEngine | undefined;
    const taskEngine: KnowledgeEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_id, input): Promise<string> => {
        const p = input.prompt;
        if (/JSON Schema/.test(p) && /operations/.test(p)) {
          // analyze: one create op referencing the pending raw id
          const rawId = engineRef?.registry.store(SPACE).index().listRaw({ onlyPending: true })[0]?.id ?? "r1";
          return JSON.stringify({
            operations: [{ type: "concept", name: "agent-tasks", title: "Agent 任务", rawIds: [rawId] }],
            skippedRawIds: [],
          });
        }
        if (/JSON Schema/.test(p)) {
          // generate: the page body
          return JSON.stringify({ title: "Agent 任务", summary: "研究要点", aliases: [], tags: [], links: [], content: "# Agent 任务\n研究要点。\n" });
        }
        return "研究要点：任务系统很有用。";
      },
    });
    engineRef = taskEngine;
    taskEngine.ensureSpace(SPACE);
    const task = taskEngine.tasks.create({ name: "调研", space: SPACE, topic: "agent tasks" })!;
    const report = await taskEngine.runTask(task.id); // distill on by default
    expect(report.ok).toBe(true);
    expect(report.pagesWritten).toBeGreaterThan(0);
    expect(await taskEngine.getPage(SPACE, "concepts/agent-tasks")).not.toBeNull();
    taskEngine.close();
  });

  test("runTask: distillOnRun=false captures raw but writes no page immediately", async () => {
    let calls = 0;
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => { calls++; return "研究结论内容"; },
    });
    taskEngine.ensureSpace(SPACE);
    const task = taskEngine.tasks.create({ name: "no-distill", space: SPACE, topic: "x", distillOnRun: false })!;
    const report = await taskEngine.runTask(task.id);
    expect(report.ok).toBe(true);
    expect(report.pagesWritten).toBeUndefined();
    // raw captured, but no distillation LLM calls beyond the single research call
    expect(taskEngine.registry.store(SPACE).index().listRaw({}).some((r) => r.source === "task")).toBe(true);
    expect(calls).toBe(1);
    taskEngine.close();
  });
});

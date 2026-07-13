import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Knowledge } from "./knowledge.ts";
import { KnowledgeEngine } from "./engine.ts";
import { FakeLlm } from "./testing.ts";
import type { Page, SpaceId } from "@homebrain/shared";

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
      "retractMessage",
      "runDreamCycle",
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
    ).toEqual({ status: "retracted", affectedPages: [], requeuedSources: 0 });

    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_owner",
      }),
    ).toEqual({ status: "not_found", affectedPages: [], requeuedSources: 0 });
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
    ).toEqual({ status: "forbidden", affectedPages: [], requeuedSources: 0 });
    expect((await engine.runDreamCycle(SPACE)).examined).toBe(1);
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
    ).toEqual({ status: "retracted", affectedPages: [], requeuedSources: 0 });
    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_owner",
      }),
    ).toEqual({ status: "not_found", affectedPages: [], requeuedSources: 0 });
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
      requeuedSources: 1,
    });
    expect(await retractEngine.getPage(SPACE, "concepts/project-facts")).toBeNull();

    fake.queueJSON({ operations: [], skippedRawIds: [survivingId] });
    expect((await retractEngine.runDreamCycle(SPACE)).examined).toBe(1);
    retractEngine.close();
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

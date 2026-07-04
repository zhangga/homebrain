import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Knowledge } from "./knowledge.ts";
import { KnowledgeEngine } from "./engine.ts";
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
  engine = new KnowledgeEngine({ dataDir: dir });
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
});

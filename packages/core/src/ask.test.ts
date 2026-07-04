import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSONOptions } from "@homebrain/llm";
import type { Page, SpaceId } from "@homebrain/shared";
import { resetConfig } from "@homebrain/shared";
import { SpaceStore } from "./space.ts";
import { ask, buildCatalog, expandGraph, resolveCitations } from "./ask.ts";
import { FakeLlm } from "./testing.ts";

let dir: string;
let store: SpaceStore;
const SPACE: SpaceId = "team/oc_ask";

function page(slug: string, title: string, content: string, extra: Partial<Page> = {}): Page {
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
    ...extra,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-ask-"));
  process.env.HOMEBRAIN_DATA_DIR = dir;
  resetConfig();
  store = new SpaceStore(SPACE, dir);
  store.ensure();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEBRAIN_DATA_DIR;
  resetConfig();
});

// Route by inspecting the schema on the JSON call: the routing schema has a
// `relevant` property, the synthesis schema has `grounded`. This lets one fake
// serve both LLM steps deterministically.
function scriptedLlm(opts: {
  routeSlugs: string[];
  relevant: boolean;
  answer: string;
  grounded: boolean;
  usedSlugs?: string[];
  generalText?: string;
}): FakeLlm {
  const fake = new FakeLlm();
  fake.onJSON((call: JSONOptions<unknown>) => {
    const props = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
    if ("relevant" in props) {
      return { slugs: opts.routeSlugs, relevant: opts.relevant };
    }
    if ("grounded" in props) {
      return {
        answer: opts.answer,
        grounded: opts.grounded,
        usedSlugs: opts.usedSlugs ?? opts.routeSlugs,
        gaps: [],
      };
    }
    throw new Error("unexpected schema in scripted fake");
  });
  fake.onText(() => opts.generalText ?? "general fallback answer");
  return fake;
}

describe("buildCatalog", () => {
  test("collects content pages and excludes singletons", () => {
    store.writePage(page("entities/alice", "Alice", "后端负责人"));
    store.writePage(page("index", "Index", "toc", { type: "index" }));
    const catalog = buildCatalog([store], "谁负责后端");
    expect(catalog.map((c) => c.ref.slug)).toEqual(["entities/alice"]);
  });
});

describe("expandGraph", () => {
  test("follows wikilinks one hop", () => {
    store.writePage(page("entities/alice", "Alice", "见 backend", { links: ["concepts/backend"] }));
    store.writePage(page("concepts/backend", "Backend", "后端"));
    const slugs = expandGraph(store, ["entities/alice"], 8);
    expect(slugs).toContain("entities/alice");
    expect(slugs).toContain("concepts/backend");
  });

  test("follows shared raw sources", () => {
    store.writePage(page("entities/alice", "Alice", "a", { sources: ["raw-1"] }));
    store.writePage(page("entities/orion", "Orion", "o", { sources: ["raw-1"] }));
    const slugs = expandGraph(store, ["entities/alice"], 8);
    expect(slugs).toContain("entities/orion");
  });

  test("respects maxPages cap", () => {
    store.writePage(page("a", "A", "x", { links: ["b"] }));
    store.writePage(page("b", "B", "x", { links: ["c"] }));
    store.writePage(page("c", "C", "x"));
    expect(expandGraph(store, ["a"], 2).length).toBe(2);
  });
});

describe("resolveCitations", () => {
  test("maps slugs to titles, dedupes, preserves order", () => {
    const loaded = [
      { slug: "entities/alice", page: page("entities/alice", "Alice", "x") },
      { slug: "concepts/backend", page: page("concepts/backend", "Backend", "x") },
    ];
    const cites = resolveCitations(["concepts/backend", "entities/alice", "concepts/backend"], loaded);
    expect(cites).toEqual([
      { slug: "concepts/backend", title: "Backend" },
      { slug: "entities/alice", title: "Alice" },
    ]);
  });

  test("ignores slugs not in loaded set", () => {
    const loaded = [{ slug: "a", page: page("a", "A", "x") }];
    expect(resolveCitations(["missing"], loaded)).toEqual([]);
  });
});

describe("ask pipeline", () => {
  test("grounded answer from knowledge base with citations (Q1)", async () => {
    store.writePage(page("entities/alice", "Alice", "Alice 负责后端服务。"));
    const fake = scriptedLlm({
      routeSlugs: ["entities/alice"],
      relevant: true,
      answer: "后端由 [[entities/alice|Alice]] 负责。",
      grounded: true,
      usedSlugs: ["entities/alice"],
    });
    const res = await ask([store], "谁负责后端？", {}, { client: fake });
    expect(res.source).toBe("knowledge");
    expect(res.citations).toEqual([{ slug: "entities/alice", title: "Alice" }]);
    expect(res.answer).toContain("Alice");
  });

  test("out-of-KB question falls back to general (Q1)", async () => {
    store.writePage(page("entities/alice", "Alice", "Alice 负责后端服务。"));
    const fake = scriptedLlm({
      routeSlugs: [],
      relevant: false,
      answer: "",
      grounded: false,
      generalText: "北京今天多云。（这不在知识库记录中）",
    });
    const res = await ask([store], "北京今天天气如何？", {}, { client: fake });
    expect(res.source).toBe("general");
    expect(res.citations).toEqual([]);
    expect(res.answer).toContain("北京");
  });

  test("empty knowledge base uses general fallback (Q3 cold start)", async () => {
    const fake = scriptedLlm({
      routeSlugs: [],
      relevant: false,
      answer: "",
      grounded: false,
      generalText: "知识库为空，这是通用回答。",
    });
    const res = await ask([store], "随便问点什么", {}, { client: fake });
    expect(res.source).toBe("general");
    // routing/synthesis should not have been called on an empty KB
    expect(fake.calls.filter((c) => c.kind === "json").length).toBe(0);
  });

  test("knowledgeOnly never falls back to general", async () => {
    const fake = scriptedLlm({ routeSlugs: [], relevant: false, answer: "", grounded: false });
    const res = await ask([store], "x", { knowledgeOnly: true }, { client: fake });
    expect(res.source).toBe("general");
    expect(res.answer).toBe("");
    // no general text call made
    expect(fake.calls.some((c) => c.kind === "complete")).toBe(false);
  });

  test("synthesis not grounded -> general fallback", async () => {
    store.writePage(page("entities/alice", "Alice", "Alice 负责后端。"));
    const fake = scriptedLlm({
      routeSlugs: ["entities/alice"],
      relevant: true,
      answer: "",
      grounded: false,
      generalText: "通用回答。",
    });
    const res = await ask([store], "问一个页面答不了的问题", {}, { client: fake });
    expect(res.source).toBe("general");
  });
});

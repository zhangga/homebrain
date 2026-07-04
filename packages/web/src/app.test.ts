import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { resetConfig, type Page, type SpaceId } from "@homebrain/shared";
import { KnowledgeEngine, FakeLlm } from "@homebrain/core";
import { createWebApp } from "./app.ts";

let dir: string;
let engine: KnowledgeEngine;
let app: Hono;
let fake: FakeLlm;
const SPACE: SpaceId = "team/oc_web";

function page(slug: string, title: string, content: string): Page {
  return {
    slug,
    type: "entity",
    title,
    summary: content.slice(0, 30),
    aliases: ["爱丽丝"],
    tags: ["team"],
    sources: ["raw-1"],
    links: [],
    content,
    updatedAt: Date.now(),
    contentHash: "h",
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hb-web-"));
  process.env.HOMEBRAIN_DATA_DIR = dir;
  resetConfig();
  fake = new FakeLlm();
  engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
  await engine.upsertPage(SPACE, page("entities/alice", "Alice", "Alice 负责后端服务。"));
  await engine.remember({ space: SPACE, source: "message", content: "一条原始消息" });
  app = createWebApp({ engine });
});

afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEBRAIN_DATA_DIR;
  resetConfig();
});

describe("web backend (read-only)", () => {
  test("home lists spaces", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("team/oc_web");
    expect(body).toContain("homebrain");
  });

  test("space detail shows knowledge pages", async () => {
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Alice");
    expect(body).toContain("知识页");
  });

  test("page view shows full content and metadata", async () => {
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}/pages/${encodeURIComponent("entities/alice")}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Alice 负责后端服务");
    expect(body).toContain("爱丽丝"); // alias
    expect(body).toContain("raw-1"); // provenance
  });

  test("raw list shows captured entries", async () => {
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}/raw`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("一条原始消息");
  });

  test("ask box renders a knowledge answer", async () => {
    // script routing + synthesis
    fake.onJSON((call) => {
      const props = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("relevant" in props) return { slugs: ["entities/alice"], relevant: true };
      if ("grounded" in props)
        return { answer: "后端由 Alice 负责。", grounded: true, usedSlugs: ["entities/alice"], gaps: [] };
      return {};
    });
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}/ask?q=${encodeURIComponent("谁负责后端？")}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("后端由 Alice 负责");
    expect(body).toContain("知识库"); // source badge
  });

  test("dream POST triggers a cycle and redirects", async () => {
    fake.queueJSON({ operations: [], skippedRawIds: [] });
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}/dream`, { method: "POST" });
    expect([302, 303]).toContain(res.status);
  });

  test("unknown space is 404", async () => {
    const res = await app.request(`/spaces/${encodeURIComponent("team/nope")}`);
    expect(res.status).toBe(404);
  });

  test("logs page renders", async () => {
    const res = await app.request("/logs");
    expect(res.status).toBe(200);
  });
});

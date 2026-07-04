/**
 * The read-only web backend (plan §V, Slice 6). A Hono app over the same
 * KnowledgeEngine the orchestrator uses. It is a *viewer*: it lists spaces,
 * pages, raw entries and LLM logs, and offers two explicitly-allowed actions the
 * plan calls out — manually triggering a dream cycle, and a question-test box
 * that calls ask() directly (not through feishu). No page create/edit (MVP).
 */
import { Hono } from "hono";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, isSpaceId, type SpaceId } from "@homebrain/shared";
import type { KnowledgeEngine } from "@homebrain/core";
import { layout } from "./layout.ts";
import {
  askView,
  logsView,
  pageView,
  rawListView,
  spaceDetailView,
  spaceListView,
} from "./views.ts";

export interface WebOptions {
  engine: KnowledgeEngine;
}

export function createWebApp(opts: WebOptions): Hono {
  const { engine } = opts;
  const app = new Hono();

  const parseSpace = (raw: string): SpaceId | null => {
    const decoded = decodeURIComponent(raw);
    return isSpaceId(decoded) ? decoded : null;
  };

  app.get("/", async (c) => {
    const spaces = engine.registry.list().map((meta) => {
      const idx = engine.registry.store(meta.id).index();
      return { meta, pages: idx.countPages(), pending: idx.countRaw(true) };
    });
    return c.html(await layout("空间", [{ label: "空间" }], await spaceListView(spaces)));
  });

  app.get("/spaces/:space", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const pages = await engine.listPages(space);
    const rawCount = engine.registry.store(space).index().countRaw();
    const meta = engine.registry.get(space);
    return c.html(
      await layout(space, [{ label: "空间", href: "/" }, { label: space }], await spaceDetailView(space, pages, rawCount, meta)),
    );
  });

  app.get("/spaces/:space/pages/:slug{.+}", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const slug = decodeURIComponent(c.req.param("slug"));
    const page = await engine.getPage(space, slug);
    if (!page) return c.notFound();
    return c.html(
      await layout(
        page.title,
        [{ label: "空间", href: "/" }, { label: space, href: `/spaces/${encodeURIComponent(space)}` }, { label: page.title }],
        await pageView(space, page),
      ),
    );
  });

  app.get("/spaces/:space/raw", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const raws = engine.registry.store(space).index().listRaw({ limit: 300 });
    return c.html(
      await layout(
        `原始条目 · ${space}`,
        [{ label: "空间", href: "/" }, { label: space, href: `/spaces/${encodeURIComponent(space)}` }, { label: "原始条目" }],
        await rawListView(space, raws.reverse()),
      ),
    );
  });

  app.get("/spaces/:space/ask", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const q = c.req.query("q") ?? null;
    const result = q && q.trim() ? await engine.ask([space], q) : null;
    return c.html(
      await layout(
        `问答测试 · ${space}`,
        [{ label: "空间", href: "/" }, { label: space, href: `/spaces/${encodeURIComponent(space)}` }, { label: "问答测试" }],
        await askView(space, q, result),
      ),
    );
  });

  app.post("/spaces/:space/dream", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    // Fire-and-forget; the detail page shows updated counts on next load.
    void engine.runDreamCycle(space).catch(() => {});
    return c.redirect(`/spaces/${encodeURIComponent(space)}`);
  });

  app.get("/logs", async (c) => {
    const logs = readLogs();
    return c.html(await layout("调用日志", [{ label: "空间", href: "/" }, { label: "调用日志" }], await logsView(logs)));
  });

  return app;
}

/** Read the last few days of LLM call logs from data/logs/*.jsonl. */
function readLogs(): { day: string; lines: string[] }[] {
  const dir = join(config().dataDir, "logs");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("llm-") && f.endsWith(".jsonl"))
    .sort()
    .reverse()
    .slice(0, 3);
  return files.map((f) => {
    const day = f.replace(/^llm-|\.jsonl$/g, "");
    const lines = readFileSync(join(dir, f), "utf8").trim().split("\n").slice(-200);
    return { day, lines };
  });
}

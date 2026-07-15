/**
 * Deterministic regeneration of the "map" pages (index, glossary, overview) from
 * the current content pages. These are what ask()'s map-routing step feeds to
 * the LLM to choose which pages to load (plan §2.3). Building them by code
 * rather than by LLM keeps them always-consistent with reality and free.
 *
 * - index: a compact table of contents — every page's slug/title/summary.
 * - glossary: title + aliases -> slug, so alias lookups resolve.
 * - overview: grouped counts + the index, a human landing page.
 */
import type { Page, PageRef } from "@homeagent/shared";
import type { SpaceStore } from "./space.ts";

function nowHash(refs: PageRef[]): string {
  // cheap hash of the map's shape so we can skip rewrites when nothing changed
  const key = refs.map((r) => `${r.slug}:${r.title}:${r.aliases.join(",")}`).join("|");
  const h = new Bun.CryptoHasher("sha256");
  h.update(key);
  return h.digest("hex").slice(0, 16);
}

function indexPage(refs: PageRef[], hash: string): Page {
  const byType = new Map<string, PageRef[]>();
  for (const r of refs) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }
  const lines: string[] = ["# Index", "", "本空间所有知识页的目录（由系统自动生成）。", ""];
  for (const [type, list] of [...byType.entries()].sort()) {
    lines.push(`## ${type}`, "");
    for (const r of list.sort((a, b) => a.slug.localeCompare(b.slug))) {
      const aliases = r.aliases.length ? ` （别名：${r.aliases.join("、")}）` : "";
      lines.push(`- [[${r.slug}|${r.title}]]${aliases}：${r.summary}`);
    }
    lines.push("");
  }
  return {
    slug: "index",
    type: "index",
    title: "Index",
    summary: `目录：${refs.length} 个知识页`,
    aliases: [],
    tags: [],
    sources: [],
    links: refs.map((r) => r.slug),
    content: lines.join("\n") + "\n",
    updatedAt: Date.now(),
    contentHash: hash,
  };
}

function glossaryPage(refs: PageRef[], hash: string): Page {
  const lines: string[] = ["# Glossary", "", "标题与别名到页面的映射（自动生成）。", ""];
  for (const r of refs.slice().sort((a, b) => a.title.localeCompare(b.title))) {
    const names = [r.title, ...r.aliases];
    lines.push(`- ${names.join(" / ")} → [[${r.slug}]]`);
  }
  return {
    slug: "glossary",
    type: "glossary",
    title: "Glossary",
    summary: `术语表：${refs.length} 项`,
    aliases: [],
    tags: [],
    sources: [],
    links: refs.map((r) => r.slug),
    content: lines.join("\n") + "\n",
    updatedAt: Date.now(),
    contentHash: hash,
  };
}

function overviewPage(refs: PageRef[], hash: string): Page {
  const counts = new Map<string, number>();
  for (const r of refs) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  const lines: string[] = ["# Overview", "", "## 概况", ""];
  for (const [type, n] of [...counts.entries()].sort()) lines.push(`- ${type}: ${n}`);
  lines.push("", `共 ${refs.length} 个知识页。详见 [[index]] 与 [[glossary]]。`, "");
  return {
    slug: "overview",
    type: "overview",
    title: "Overview",
    summary: `概况：共 ${refs.length} 个知识页`,
    aliases: [],
    tags: [],
    sources: [],
    links: ["index", "glossary"],
    content: lines.join("\n") + "\n",
    updatedAt: Date.now(),
    contentHash: hash,
  };
}

const SINGLETONS = new Set(["index", "overview", "log", "glossary"]);

/**
 * Regenerate index/glossary/overview from the current content pages. Skips the
 * rewrite when the map's shape hash is unchanged (idempotent, cheap to call
 * after every dream cycle). Returns the number of map pages written.
 */
export function refreshDigest(store: SpaceStore): number {
  const refs = store
    .index()
    .listPages()
    .filter((r) => !SINGLETONS.has(r.slug));
  const hash = nowHash(refs);

  const existing = store.index().getPage("index");
  if (existing && existing.contentHash === hash) return 0;

  store.writePage(indexPage(refs, hash));
  store.writePage(glossaryPage(refs, hash));
  store.writePage(overviewPage(refs, hash));
  return 3;
}

/**
 * ask(): question answering over the union of one or more spaces (plan §2.3,
 * Q1). The retrieval pipeline mirrors llm_wiki's design (borrowed, rewritten):
 *
 *   1. Catalog   — build a compact catalog of candidate pages. When a space is
 *                  small we use every page; when it is large we FTS-prefilter
 *                  first so the routing prompt stays bounded (plan R2).
 *   2. Route     — the LLM picks which catalog pages are actually relevant
 *                  (map routing). Selecting nothing => the KB doesn't cover it.
 *   3. Expand    — 2-hop graph expansion over the selected pages via wikilinks,
 *                  shared raw sources, and same-type signals (bounded).
 *   4. Load      — load the selected + expanded pages WHOLE (never chunked),
 *                  capped by maxPages for cost control.
 *   5. Synthesize— the LLM answers grounded in those pages, citing [[slug]].
 *
 * Source distinction (Q1): a grounded answer is tagged `knowledge` with
 * citations; when the KB is empty or routing/synthesis finds nothing relevant we
 * fall back to the model's general knowledge, tagged `general` and explicitly
 * flagged as not-in-knowledge-base.
 */
import type { AskResult, Citation, Page, PageRef, SpaceId } from "@homebrain/shared";
import { config, logger } from "@homebrain/shared";
import type { SpaceStore } from "./space.ts";
import type { AskOptions } from "./types.ts";
import { gatewayClient, type LlmClient } from "./llm.ts";

const log = logger.child("ask");

const SINGLETON = new Set(["index", "overview", "log", "glossary"]);
const DEFAULT_MAX_PAGES = 8;
const CATALOG_CAP = 60;

export interface AskDeps {
  client?: LlmClient;
}

/** A page plus the store it lives in — slugs are only unique within a space. */
export interface LocatedPage {
  space: SpaceId;
  store: SpaceStore;
  ref: PageRef;
}

// ---- step 1: catalog -------------------------------------------------------

/**
 * Build the candidate catalog across stores. Small spaces contribute all their
 * content pages; large ones contribute only FTS matches for the question, so the
 * routing prompt never blows up (plan R2). De-duplicated by space+slug.
 */
export function buildCatalog(
  stores: SpaceStore[],
  question: string,
  cap = CATALOG_CAP,
): LocatedPage[] {
  const out: LocatedPage[] = [];
  const seen = new Set<string>();
  const add = (store: SpaceStore, ref: PageRef) => {
    if (SINGLETON.has(ref.slug)) return;
    const key = `${store.space}::${ref.slug}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ space: store.space, store, ref });
  };

  for (const store of stores) {
    const idx = store.index();
    const total = idx.countPages();
    const contentTotal = idx.listPages().filter((r) => !SINGLETON.has(r.slug)).length;
    if (contentTotal <= cap) {
      for (const ref of idx.listPages()) add(store, ref);
    } else {
      // large space: FTS prefilter, then hydrate refs
      const hits = idx.search(question, cap);
      for (const h of hits) {
        const ref = idx.listPages().find((r) => r.slug === h.slug);
        if (ref) add(store, ref);
      }
    }
    void total;
  }
  return out.slice(0, cap * Math.max(1, stores.length));
}

// ---- step 2: routing -------------------------------------------------------

const ROUTE_SCHEMA = {
  type: "object",
  properties: {
    slugs: {
      type: "array",
      items: { type: "string" },
      description: "slugs of catalog pages relevant to the question (may be empty)",
    },
    relevant: {
      type: "boolean",
      description: "whether the knowledge base plausibly covers this question at all",
    },
  },
  required: ["slugs", "relevant"],
} as const;

interface RouteResult {
  slugs: string[];
  relevant: boolean;
}

function validateRoute(raw: unknown): RouteResult {
  const o = raw as Record<string, unknown>;
  const slugs = Array.isArray(o?.slugs) ? (o.slugs as unknown[]).map(String) : [];
  const relevant = typeof o?.relevant === "boolean" ? o.relevant : slugs.length > 0;
  return { slugs, relevant };
}

function routePrompt(catalog: LocatedPage[], question: string): string {
  const lines = catalog.map((c) => {
    const aliases = c.ref.aliases.length ? `（别名：${c.ref.aliases.join("、")}）` : "";
    return `- ${c.ref.slug}${aliases}：${c.ref.title}｜${c.ref.summary}`;
  });
  return [
    "下面是知识库中可用页面的目录。请判断哪些页面与用户问题相关。",
    "",
    "## 目录",
    lines.join("\n"),
    "",
    "## 用户问题",
    question,
    "",
    "任务：",
    "- 选出与问题直接相关的页面 slug（可多选；无相关页面则返回空数组）。",
    "- relevant 表示知识库是否可能涵盖该问题。",
  ].join("\n");
}

async function route(
  client: LlmClient,
  catalog: LocatedPage[],
  question: string,
  space: SpaceId | undefined,
): Promise<RouteResult> {
  const { value } = await client.completeJSON<RouteResult>({
    system: "你严格按 schema 输出，只返回结构化结果。",
    prompt: routePrompt(catalog, question),
    schema: ROUTE_SCHEMA as unknown as Record<string, unknown>,
    validate: validateRoute,
    maxTokens: 512,
    purpose: "ask",
    space,
    model: config().modelFast,
  });
  return value;
}

// ---- step 3: graph expansion ----------------------------------------------

/**
 * 2-hop expansion over selected slugs, per store. Adds pages reachable via
 * wikilinks, pages that share a raw source, and (weakly) same-type neighbors,
 * until `maxPages` is reached. Pure over the store's current pages.
 */
export function expandGraph(store: SpaceStore, seedSlugs: string[], maxPages: number): string[] {
  const idx = store.index();
  const all = idx.allPages().filter((p) => !SINGLETON.has(p.slug));
  const bySlug = new Map(all.map((p) => [p.slug, p]));
  const selected = new Set<string>(seedSlugs.filter((s) => bySlug.has(s)));

  // Precompute source -> slugs for shared-source expansion.
  const sourceToSlugs = new Map<string, string[]>();
  for (const p of all) {
    for (const src of p.sources) {
      const list = sourceToSlugs.get(src) ?? [];
      list.push(p.slug);
      sourceToSlugs.set(src, list);
    }
  }

  let frontier = [...selected];
  for (let hop = 0; hop < 2 && selected.size < maxPages; hop++) {
    const next: string[] = [];
    for (const slug of frontier) {
      const page = bySlug.get(slug);
      if (!page) continue;
      // wikilinks
      for (const link of page.links) {
        if (bySlug.has(link) && !selected.has(link)) next.push(link);
      }
      // shared sources
      for (const src of page.sources) {
        for (const other of sourceToSlugs.get(src) ?? []) {
          if (!selected.has(other)) next.push(other);
        }
      }
    }
    for (const slug of next) {
      if (selected.size >= maxPages) break;
      selected.add(slug);
    }
    frontier = next;
    if (next.length === 0) break;
  }
  return [...selected].slice(0, maxPages);
}

// ---- step 5: synthesis -----------------------------------------------------

const SYNTH_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "the answer, in the user's language" },
    grounded: {
      type: "boolean",
      description: "true if the answer is supported by the provided pages",
    },
    usedSlugs: {
      type: "array",
      items: { type: "string" },
      description: "slugs of pages actually used to answer",
    },
    gaps: {
      type: "array",
      items: { type: "string" },
      description: "aspects the provided pages did not cover",
    },
  },
  required: ["answer", "grounded", "usedSlugs"],
} as const;

interface SynthResult {
  answer: string;
  grounded: boolean;
  usedSlugs: string[];
  gaps: string[];
}

function validateSynth(raw: unknown): SynthResult {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o.answer !== "string") throw new Error("synthesis missing answer");
  return {
    answer: o.answer,
    grounded: typeof o.grounded === "boolean" ? o.grounded : false,
    usedSlugs: Array.isArray(o.usedSlugs) ? (o.usedSlugs as unknown[]).map(String) : [],
    gaps: Array.isArray(o.gaps) ? (o.gaps as unknown[]).map(String) : [],
  };
}

function synthPrompt(pages: { slug: string; page: Page }[], question: string): string {
  const blocks = pages
    .map((p) => `<page slug="${p.slug}" title="${p.page.title}">\n${p.page.content.trim()}\n</page>`)
    .join("\n\n");
  return [
    "根据下列知识库页面回答用户问题。",
    "",
    "## 知识库页面",
    blocks,
    "",
    "## 用户问题",
    question,
    "",
    "要求：",
    "- 只依据上面页面作答；引用信息处用 [[slug]] 标注来源。",
    "- 若页面确实支撑答案，grounded=true，并在 usedSlugs 列出用到的页面。",
    "- 若页面无法回答，grounded=false，answer 可留空或说明缺口，并在 gaps 说明。",
    "- 用用户提问的语言作答。",
  ].join("\n");
}

/** Prepend an agent persona to a base system prompt, when configured. */
function withInstruction(base: string, instruction?: string): string {
  const extra = instruction?.trim();
  if (!extra) return base;
  return `${extra}\n\n${base}`;
}

async function synthesize(
  client: LlmClient,
  pages: { slug: string; page: Page }[],
  question: string,
  space: SpaceId | undefined,
  model: string | undefined,
  instruction: string | undefined,
): Promise<SynthResult> {
  const { value } = await client.completeJSON<SynthResult>({
    system: withInstruction("你是严谨的知识库问答助手，只依据给定材料作答并标注引用。", instruction),
    prompt: synthPrompt(pages, question),
    schema: SYNTH_SCHEMA as unknown as Record<string, unknown>,
    validate: validateSynth,
    maxTokens: 2048,
    purpose: "ask",
    space,
    model,
  });
  return value;
}

// ---- general fallback ------------------------------------------------------

async function generalFallback(
  client: LlmClient,
  question: string,
  gaps: string[],
  model: string | undefined,
  instruction: string | undefined,
): Promise<AskResult> {
  const r = await client.complete({
    system: withInstruction(
      "你是团队/家庭知识助手。以下问题在知识库中没有相关记录，请用你的通用知识作答，" +
        "并在开头坦诚说明“这不在知识库记录中，以下是我的一般性回答”。",
      instruction,
    ),
    prompt: question,
    maxTokens: 1024,
    purpose: "ask",
    model: model ?? config().model,
  });
  return {
    answer: r.text.trim(),
    source: "general",
    citations: [],
    gaps: gaps.length ? gaps : undefined,
  };
}

// ---- citation resolution ---------------------------------------------------

/** Resolve used slugs to citations (title lookup), preserving order & de-duping. */
export function resolveCitations(
  usedSlugs: string[],
  loaded: { slug: string; page: Page }[],
): Citation[] {
  const bySlug = new Map(loaded.map((l) => [l.slug, l.page]));
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const slug of usedSlugs) {
    if (seen.has(slug)) continue;
    const page = bySlug.get(slug);
    if (!page) continue;
    seen.add(slug);
    out.push({ slug, title: page.title });
  }
  return out;
}

// ---- orchestration ---------------------------------------------------------

export async function ask(
  stores: SpaceStore[],
  question: string,
  opts: AskOptions = {},
  deps: AskDeps = {},
): Promise<AskResult> {
  const client = deps.client ?? gatewayClient;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const model = opts.model ?? config().model;
  const instruction = opts.instruction;
  const primarySpace = stores[0]?.space;

  // Empty knowledge base across all spaces -> general fallback (Q1/Q3).
  const catalog = buildCatalog(stores, question);
  if (catalog.length === 0) {
    if (opts.knowledgeOnly) {
      return { answer: "", source: "general", citations: [], gaps: ["知识库为空"] };
    }
    return generalFallback(client, question, ["知识库中暂无相关记录"], model, instruction);
  }

  // Route: which pages are relevant?
  let routed: RouteResult;
  try {
    routed = await route(client, catalog, question, primarySpace);
  } catch (err) {
    log.warn("routing failed, falling back to FTS", { err: String(err) });
    routed = { slugs: [], relevant: false };
  }

  // If routing found nothing, try FTS as a safety net before giving up.
  let selected = routed.slugs.filter((s) => catalog.some((c) => c.ref.slug === s));
  if (selected.length === 0) {
    const ftsSlugs = new Set<string>();
    for (const store of stores) for (const h of store.index().search(question, 5)) ftsSlugs.add(h.slug);
    selected = catalog.filter((c) => ftsSlugs.has(c.ref.slug)).map((c) => c.ref.slug);
  }

  if (selected.length === 0 || !routed.relevant) {
    if (opts.knowledgeOnly) {
      return { answer: "", source: "general", citations: [], gaps: ["知识库中未找到相关内容"] };
    }
    return generalFallback(client, question, ["知识库中未找到直接相关的记录"], model, instruction);
  }

  // Expand + load whole pages per store.
  const loaded: { slug: string; page: Page }[] = [];
  const bySpaceSelected = new Map<SpaceStore, string[]>();
  for (const c of catalog) {
    if (!selected.includes(c.ref.slug)) continue;
    const list = bySpaceSelected.get(c.store) ?? [];
    list.push(c.ref.slug);
    bySpaceSelected.set(c.store, list);
  }
  for (const [store, seeds] of bySpaceSelected) {
    const perStoreCap = Math.max(1, Math.ceil(maxPages / bySpaceSelected.size));
    const expanded = expandGraph(store, seeds, perStoreCap);
    for (const slug of expanded) {
      if (loaded.length >= maxPages) break;
      const page = store.index().getPage(slug);
      if (page) loaded.push({ slug, page });
    }
  }

  if (loaded.length === 0) {
    if (opts.knowledgeOnly) {
      return { answer: "", source: "general", citations: [], gaps: ["未能加载相关页面"] };
    }
    return generalFallback(client, question, ["知识库中未找到相关内容"], model, instruction);
  }

  // Synthesize a grounded answer.
  const synth = await synthesize(client, loaded, question, primarySpace, model, instruction);
  if (!synth.grounded || synth.answer.trim() === "") {
    if (opts.knowledgeOnly) {
      return {
        answer: synth.answer.trim(),
        source: "general",
        citations: [],
        gaps: synth.gaps.length ? synth.gaps : ["知识库内容不足以回答"],
      };
    }
    return generalFallback(client, question, synth.gaps, model, instruction);
  }

  const citations = resolveCitations(
    synth.usedSlugs.length ? synth.usedSlugs : loaded.map((l) => l.slug),
    loaded,
  );
  return {
    answer: synth.answer.trim(),
    source: "knowledge",
    citations,
    gaps: synth.gaps.length ? synth.gaps : undefined,
  };
}

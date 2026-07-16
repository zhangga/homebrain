# Hybrid Retrieval Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, provider-agnostic vector retrieval path that merges semantic recall with the existing FTS ranking, while leaving production defaults unchanged and measuring the recall lift in the deterministic quality suite.

**Architecture:** A focused `retrieval.ts` module owns page-to-embedding text, bounded in-memory document-vector caching, cosine ranking, and reciprocal-rank fusion. `KnowledgeEngine` accepts an optional embedding provider and exposes the experiment only through `retrieval: "hybrid"` on the existing `search()` and `ask()` option bags; missing or failed embedding providers degrade to FTS. The quality evaluator supplies fixed embedding vectors so CI can verify the hybrid plumbing without downloading a model or sending family/team content to a new external service.

**Tech Stack:** TypeScript, Bun, SQLite FTS5, existing `KnowledgeEngine`, Bun test.

---

### Task 1: Add the hybrid retrieval domain module

**Files:**
- Create: `packages/core/src/retrieval.ts`
- Create: `packages/core/src/retrieval.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/types.ts`

- [x] **Step 1: Write a failing public-behaviour test for semantic-only recall**

```ts
test("hybrid search recalls a semantic-only page and keeps exact FTS matches", async () => {
  const engine = new KnowledgeEngine({
    dataDir: dir,
    embeddingProvider: fixedEmbeddingProvider({
      "线上故障该找哪位？": [1, 0],
      "Alice 负责后端服务": [1, 0],
      "本周菜单是番茄炒蛋": [0, 1],
    }),
  });
  await engine.upsertPage(SPACE, page("entities/alice", "Alice", "Alice 负责后端服务"));
  await engine.upsertPage(SPACE, page("concepts/menu", "菜单", "本周菜单是番茄炒蛋"));

  expect((await engine.search([SPACE], "线上故障该找哪位？")).map((hit) => hit.slug)).toEqual([]);
  expect(
    (await engine.search([SPACE], "线上故障该找哪位？", { retrieval: "hybrid" }))
      .map((hit) => hit.slug),
  ).toContain("entities/alice");
});
```

- [x] **Step 2: Run the new test and verify it fails**

Run: `bun test packages/core/src/retrieval.test.ts`

Expected: FAIL because `embeddingProvider` and `retrieval: "hybrid"` do not exist.

- [x] **Step 3: Define the minimal experiment types**

```ts
export type RetrievalStrategy = "fts" | "hybrid";

export interface EmbeddingProvider {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface SearchOptions {
  limit?: number;
  retrieval?: RetrievalStrategy;
}

export interface AskOptions {
  retrieval?: RetrievalStrategy;
}
```

- [x] **Step 4: Implement bounded semantic ranking and reciprocal-rank fusion**

`packages/core/src/retrieval.ts` must:

- turn each page into a bounded string containing title, summary, aliases, tags, and content;
- cache document vectors by `space + slug + contentHash`, capped at 2,048 entries;
- validate vector count, finite values, and consistent dimensions;
- rank semantic matches by cosine similarity;
- merge FTS and semantic rankings with reciprocal-rank fusion;
- preserve `Hit.score`'s “lower is better” contract by returning the inverse fused score;
- use `space + slug` as the internal identity so equal slugs in different spaces do not collapse.

Core signatures:

```ts
export class EmbeddingSearch {
  constructor(provider: EmbeddingProvider);
  search(stores: SpaceStore[], query: string, limit: number): Promise<LocatedSearchHit[]>;
}

export async function retrieveHits(
  stores: SpaceStore[],
  query: string,
  opts: {
    limit: number;
    retrieval: RetrievalStrategy;
    embeddingSearch?: EmbeddingSearch;
    excludeSlugs?: ReadonlySet<string>;
  },
): Promise<LocatedSearchHit[]>;
```

- [x] **Step 5: Run the retrieval tests and typecheck**

Run:

```bash
bun test packages/core/src/retrieval.test.ts
bun run typecheck
```

Expected: PASS.

### Task 2: Wire the experiment into `KnowledgeEngine.search()` and `ask()`

**Files:**
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/ask.ts`
- Modify: `packages/core/src/engine.test.ts`
- Modify: `packages/core/src/ask.test.ts`

- [x] **Step 1: Write failing tests for default compatibility and failure fallback**

```ts
test("default search remains FTS even when an embedding provider exists", async () => {
  expect((await engine.search([SPACE], "线上故障该找哪位？")).toEqual([]);
});

test("hybrid search falls back to FTS when embedding fails", async () => {
  const hits = await engine.search([SPACE], "后端", { retrieval: "hybrid" });
  expect(hits.map((hit) => hit.slug)).toEqual(["entities/alice"]);
});
```

Add an ask-pipeline test with more than 60 content pages where the target page has no lexical overlap with the question. With `retrieval: "hybrid"`, the target must enter the bounded catalog and produce a grounded citation; without the option, the existing FTS path remains unchanged.

- [x] **Step 2: Run focused tests and verify the new cases fail**

Run:

```bash
bun test packages/core/src/engine.test.ts
bun test packages/core/src/ask.test.ts
```

Expected: FAIL on the new hybrid expectations.

- [x] **Step 3: Wire one `EmbeddingSearch` instance into the engine**

```ts
export interface EngineOptions {
  embeddingProvider?: EmbeddingProvider;
}

private embeddingSearch?: EmbeddingSearch;

constructor(opts: EngineOptions = {}) {
  this.embeddingSearch = opts.embeddingProvider
    ? new EmbeddingSearch(opts.embeddingProvider)
    : undefined;
}
```

`KnowledgeEngine.search()` must call `retrieveHits()`. It must use `"fts"` by default and return FTS results if no provider is configured or semantic embedding fails.

- [x] **Step 4: Add asynchronous hybrid catalog construction**

Keep the exported synchronous `buildCatalog()` unchanged for callers and tests. Add:

```ts
export async function buildCatalogWithRetrieval(
  stores: SpaceStore[],
  question: string,
  cap: number,
  retrieval: RetrievalStrategy,
  embeddingSearch?: EmbeddingSearch,
): Promise<LocatedPage[]>;
```

Small spaces still contribute all content pages. Large spaces use `retrieveHits()` so hybrid semantic candidates can enter the LLM routing catalog. The route-failure safety net must use the same selected retrieval strategy.

- [x] **Step 5: Run focused tests and typecheck**

Run:

```bash
bun test packages/core/src/retrieval.test.ts packages/core/src/ask.test.ts packages/core/src/engine.test.ts
bun run typecheck
```

Expected: PASS.

### Task 3: Measure FTS and hybrid coverage separately

**Files:**
- Modify: `quality/evaluation-cases.json`
- Modify: `scripts/ai-quality-evaluation.ts`
- Modify: `scripts/ai-quality-evaluation.test.ts`

- [x] **Step 1: Write failing report expectations**

```ts
expect(report.retrieval.ftsCoverage).toBe(0.75);
expect(report.retrieval.hybridCoverage).toBe(1);
expect(report.retrieval.hybridLift).toBe(0.25);
expect(report.recommendation.decision).toBe("validate_embedding_provider");
```

The recommendation tests must also prove:

- low routing/citation accuracy still returns `keep_fts`;
- hybrid coverage that does not beat FTS returns `keep_fts`;
- fewer than three retrieval cases returns `insufficient_data`.

- [x] **Step 2: Run the evaluator test and verify it fails**

Run: `bun test scripts/ai-quality-evaluation.test.ts`

Expected: FAIL because hybrid metrics and the new decision are absent.

- [x] **Step 3: Add fixed vector fixtures to retrieval cases**

Each retrieval case gets one query vector and one vector per page. The semantic paraphrase case uses matching vectors for “线上故障该找哪位？” and “Alice 负责后端服务” despite zero FTS overlap. These vectors are deterministic plumbing fixtures, not claims about a production embedding model.

- [x] **Step 4: Evaluate the opt-in hybrid path**

Construct `KnowledgeEngine` with a case-scoped embedding provider, call both:

```ts
await engine.search([space], item.question, { limit: 10 });
await engine.search([space], item.question, { limit: 10, retrieval: "hybrid" });
```

Add `hybridCoverage` and `hybridLift` to `RetrievalMetrics`. Emit `validate_embedding_provider` only when pipeline/citations pass, FTS is below threshold, and deterministic hybrid coverage reaches at least 85% with positive lift. The reason must explicitly say a real local/provider benchmark is still required before enabling hybrid retrieval.

- [x] **Step 5: Run evaluator tests and the CLI**

Run:

```bash
bun test scripts/ai-quality-evaluation.test.ts
bun run evaluate:quality
```

Expected: all 14 quality cases pass; FTS coverage is 0.75, hybrid coverage is 1.00, and the decision is `validate_embedding_provider`.

### Task 4: Document the experiment boundary and verify the repository

**Files:**
- Modify: `README.md`
- Modify: `docs/beta-release-runbook.md`
- Modify: `docs/superpowers/plans/2026-07-16-hybrid-retrieval-experiment.md`

- [x] **Step 1: Document opt-in semantics**

Document:

- production remains FTS by default;
- hybrid retrieval requires an explicitly injected embedding provider and `retrieval: "hybrid"`;
- semantic provider failures fall back to FTS;
- fixed vectors validate fusion plumbing only, not model quality;
- no family/team data is sent to a new provider by this change.

- [x] **Step 2: Run focused and full verification**

Run:

```bash
bun test packages/core/src/retrieval.test.ts packages/core/src/ask.test.ts packages/core/src/engine.test.ts scripts/ai-quality-evaluation.test.ts
bun run typecheck
env CLANG_MODULE_CACHE_PATH=/tmp/homeagent-clang-cache SWIFT_MODULECACHE_PATH=/tmp/homeagent-swift-cache bun run verify:beta -- --allow-dirty
git diff --check
```

Expected: PASS.

- [x] **Step 3: Review against the fixed point**

Fixed point: `200c84090cc746451b97e96f87450712f5a8414b`

Run the Standards and Spec review axes against:

```bash
git diff 200c84090cc746451b97e96f87450712f5a8414b
```

Fix every actionable finding and rerun focused verification.

- [x] **Step 4: Mark this plan complete and commit**

```bash
git add -A
git commit -m "feat: add hybrid retrieval experiment"
```

Expected: the worktree is clean and the new commit is on the current branch.

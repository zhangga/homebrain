# Distillation Failure Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make quarantined distillation failures visible, retryable, and persistently reflected in runtime health without automatically calling the real provider during inspection.

**Architecture:** Add a focused core quarantine repository over each space's existing `quarantine/*.json` files, including backward-compatible parsing of current records. Expose recovery through `KnowledgeEngine`, serialize retries with the space write lock, and add management HTTP routes/views for inspection plus single and batch retry. A remaining quarantine degrades observability but does not make `/readyz` unavailable.

**Tech Stack:** Bun, TypeScript, Hono, SQLite-backed raw records, Bun test.

---

## File Structure

- Create `packages/core/src/quarantine.ts`: durable record parsing, listing, lookup, creation, and removal.
- Modify `packages/core/src/types.ts`: public quarantine and retry result types.
- Modify `packages/core/src/knowledge.ts`: recovery methods on the public knowledge seam.
- Modify `packages/core/src/dream.ts`: write quarantines through the focused repository.
- Modify `packages/core/src/engine.ts`: serialized single/batch retry and persistent quarantine health counts.
- Modify `packages/core/src/engine.test.ts`: public core recovery contract tests.
- Modify `packages/app/src/health.ts` and `packages/app/src/health.test.ts`: degraded-but-ready system health.
- Modify `packages/web/src/views.ts`, `packages/web/src/app.ts`, and `packages/web/src/app.test.ts`: management list and retry controls.
- Modify `README.md`: document recovery behavior.

### Task 1: Expose durable quarantine records

**Files:**
- Create: `packages/core/src/quarantine.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/knowledge.ts`
- Modify: `packages/core/src/dream.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/engine.test.ts`

- [x] **Step 1: Write the failing public-seam test**

Create a quarantine through `remember()` and `runDreamCycle()`, then assert:

```ts
const records = await engine.listQuarantines(SPACE);
expect(records).toEqual([
  expect.objectContaining({
    space: SPACE,
    slug: "concepts/retry-me",
    rawIds: [rawId],
    error: expect.stringContaining("empty content"),
  }),
]);
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `bun test packages/core/src/engine.test.ts`

Expected: TypeScript/runtime failure because `listQuarantines` does not exist.

- [x] **Step 3: Add the minimal durable repository and public types**

Define these public contracts:

```ts
export interface QuarantineRecord {
  id: string;
  space: SpaceId;
  slug: string;
  error: string;
  rawIds: string[];
  createdAt: number;
}

export type QuarantineRetryStatus = "recovered" | "failed" | "not_found";

export interface QuarantineRetryResult {
  status: QuarantineRetryStatus;
  id: string;
  report?: DreamReport;
  reason?: string;
}
```

The repository must use safe filename ids, accept legacy `{ slug, error, rawIds, at }` JSON, show malformed records with an empty source list instead of silently hiding them, and never follow paths outside the space quarantine directory.

- [x] **Step 4: Route dream-cycle writes through the repository**

Replace the private writer with:

```ts
writeQuarantineRecord(store, {
  slug,
  error: String(err),
  rawIds: sources.map((source) => source.id),
  createdAt: Date.now(),
});
```

- [x] **Step 5: Run the focused test and verify GREEN**

Run: `bun test packages/core/src/engine.test.ts packages/core/src/dream.test.ts`

Expected: both files pass.

### Task 2: Recover one or all quarantines safely

**Files:**
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/knowledge.ts`
- Test: `packages/core/src/engine.test.ts`

- [x] **Step 1: Write the failing successful-retry test**

Queue a valid analyze/generate response after the initial quarantine and assert:

```ts
const recovered = await engine.retryQuarantine(SPACE, record.id);
expect(recovered.status).toBe("recovered");
expect(await engine.listQuarantines(SPACE)).toEqual([]);
expect(await engine.getPage(SPACE, "concepts/retry-me")).not.toBeNull();
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `bun test packages/core/src/engine.test.ts`

Expected: failure because retry methods do not exist.

- [x] **Step 3: Implement serialized retry**

Under the existing per-space serializer, load the record and call the same health-tracked dream execution with:

```ts
{ rawIds: record.rawIds, force: true, model }
```

Remove the old record only when every source id was processed. If generation quarantines again, remove the old record and retain the newly written failure. If analysis fails or sources are missing, keep the old record and return `failed` with a fixed reason.

- [x] **Step 4: Add batch behavior and failure retention tests**

Assert `retryQuarantines(space)` snapshots the current records, attempts each once, and returns literal counts for `total`, `recovered`, and `failed`. Assert missing/corrupt sources remain visible.

- [x] **Step 5: Run core tests and typecheck**

Run:

```bash
bun test packages/core/src/engine.test.ts packages/core/src/dream.test.ts
bunx tsc -p tsconfig.json --noEmit
```

Expected: all pass.

### Task 3: Persist the warning in system health

**Files:**
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/app/src/health.ts`
- Test: `packages/app/src/health.test.ts`

- [x] **Step 1: Write the failing health test**

Provide core details with `quarantined: 2` and assert:

```ts
expect(snapshot.components.knowledge.status).toBe("degraded");
expect(snapshot.components.knowledge.summary).toContain("2 条提炼失败");
expect(snapshot.ready).toBe(true);
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `bun test packages/app/src/health.test.ts`

- [x] **Step 3: Add per-space and aggregate counts**

Each core space detail exposes `quarantined`; the system reporter sums it, marks only the knowledge component degraded, and preserves readiness because recoverable knowledge failures do not prevent new messages.

- [x] **Step 4: Run health tests and typecheck**

Run:

```bash
bun test packages/app/src/health.test.ts
bunx tsc -p tsconfig.json --noEmit
```

Expected: all pass.

### Task 4: Add management list and retry controls

**Files:**
- Modify: `packages/web/src/views.ts`
- Modify: `packages/web/src/app.ts`
- Test: `packages/web/src/app.test.ts`

- [x] **Step 1: Write failing HTTP tests**

Cover:

```text
GET  /spaces/:space/quarantine              -> record slug, error, source count
POST /spaces/:space/quarantine/:id/retry    -> single retry and PRG flash
POST /spaces/:space/quarantine/retry-all    -> batch summary and PRG flash
```

Also assert unsafe or unknown ids return 404 without touching files.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `bun test packages/web/src/app.test.ts`

- [x] **Step 3: Render the recovery page**

Add a `quarantineView(space, records, flash)` table containing failure time, target slug, bounded error text, raw source count, and one POST retry form per record. Add a retry-all form only when records exist.

- [x] **Step 4: Wire routes and the space badge**

The space detail receives a quarantine count and links to the recovery page. POST routes call only the public engine recovery API and redirect using existing `?ok=` flash behavior.

- [x] **Step 5: Run web tests and typecheck**

Run:

```bash
bun test packages/web/src/app.test.ts
bunx tsc -p tsconfig.json --noEmit
```

Expected: all pass.

### Task 5: Document, verify, review, and commit

**Files:**
- Modify: `README.md`

- [x] **Step 1: Document recovery semantics**

Explain that quarantined failures remain visible, degrade health without failing readiness, and can be retried from the space recovery page without reprocessing unrelated raw records.

- [x] **Step 2: Run the full verification suite**

Run:

```bash
bun test
bunx tsc -p tsconfig.json --noEmit
git diff --check
```

Expected: all tests and checks pass; live tests remain explicitly skipped unless opted in.

- [x] **Step 3: Review against the fixed point**

Use the pre-implementation `HEAD` as the fixed point. Review Standards and Spec independently, fix actionable findings, and rerun focused verification.

- [x] **Step 4: Commit the completed feature**

```bash
git add README.md docs/superpowers/plans/2026-07-16-distillation-failure-recovery.md packages/core packages/app/src/health.ts packages/app/src/health.test.ts packages/web/src
git commit -m "feat: recover quarantined distillations"
```

## Self-Review

- Spec coverage: durable visibility, single retry, batch retry, and persistent degraded health each map to a task above.
- Placeholder scan: no deferred implementation instructions or unspecified error handling remain.
- Type consistency: `QuarantineRecord`, `QuarantineRetryResult`, and the three HTTP route names are used consistently across core and web tasks.

# Learning Web Research Implementation Plan

> **Status:** Implemented, reviewed, and verified on 2026-07-16.

**Goal:** Add trustworthy, best-effort web research to adaptive topic learning so each new route version can recommend current resources that match the learner's level and knowledge gaps.

**Architecture:** Extend local CLI provider execution with an explicit read-only web-search capability, using Codex native `--search` and Claude `WebSearch`/`WebFetch`. A focused learning-research module owns the structured schema, prompt, HTTPS validation, and recommendation packet. `KnowledgeEngine` refreshes recommendations before preparing a lesson, while `LearningPlanStore` atomically persists only results for the current route version. Search failure never blocks the lesson: the existing model-knowledge path remains available with an honest disclosure.

**Tech Stack:** Bun, TypeScript, Codex CLI native web search, Claude Code WebSearch/WebFetch, Hono server-rendered HTML, JSON persistence, Bun tests.

---

## File Structure

- `packages/llm/src/providers.ts` — expose an explicit `webSearch` execution capability and map it to supported CLI arguments.
- `packages/llm/src/providers.test.ts` — verify safe provider argument construction and unsupported-provider failure.
- `packages/core/src/learning-research.ts` — research request/result types, schema, prompt, URL normalization, validation, and lesson resource packet.
- `packages/core/src/learning-research.test.ts` — validate HTTPS-only sources, tracking cleanup, deduplication, and prompt boundaries.
- `packages/core/src/learning.ts` — persist current route-version recommendations and invalidate them when the route changes.
- `packages/core/src/learning.test.ts` — cover atomic replacement, stale-result rejection, migration, and evidence preservation.
- `packages/core/src/engine.ts` — run best-effort web research before topic lesson preparation and pass verified sources into lesson generation.
- `packages/core/src/learning-engine.test.ts` — cover successful recommendation refresh, lesson citation, stale refresh, and graceful fallback.
- `packages/core/src/governance.ts` — parse and restore online recommendations.
- `packages/core/src/governance.test.ts` — archive round-trip and unsafe URL rejection.
- `packages/orchestrator/src/learning-commands.ts` — add `/learn resources <计划>` to refresh and list recommendations.
- `packages/orchestrator/src/learning-commands.test.ts` — cover resource refresh and fallback messages.
- `packages/orchestrator/src/messages.ts` — document the new command.
- `packages/web/src/views.ts` — render verified online recommendations in the learning map.
- `packages/web/src/app.test.ts` — assert safe clickable HTTPS recommendations.
- `README.md` — document provider support, automatic refresh timing, and graceful degradation.

### Task 1: Give local providers a safe web-search capability

**Files:**
- Modify: `packages/llm/src/providers.ts`
- Test: `packages/llm/src/providers.test.ts`

- [x] **Step 1: Write provider argument tests**

Assert that read-only Claude execution enables only `Read,Glob,Grep,WebSearch,WebFetch`, Codex places `--search` before `exec`, and TRAE rejects a requested web search instead of pretending it searched.

- [x] **Step 2: Add `webSearch?: boolean` to `ProviderExecution`**

Preserve the flag in execution normalization. Map it to:

```text
Claude: --tools Read,Glob,Grep,WebSearch,WebFetch --permission-mode dontAsk
Codex:  --search exec --sandbox read-only ...
TRAE:   throw an explicit unsupported-provider error
```

- [x] **Step 3: Run provider tests**

Run:

```bash
bun test packages/llm/src/providers.test.ts
```

Expected: all provider tests pass.

### Task 2: Model and validate learning recommendations

**Files:**
- Create: `packages/core/src/learning-research.ts`
- Create: `packages/core/src/learning-research.test.ts`
- Modify: `packages/core/src/index.ts`

- [x] **Step 1: Define structured recommendation types**

Add resource kinds (`documentation`, `course`, `article`, `paper`, `video`, `reference`) and a result containing a normalized query plus 1–5 recommendations with title, HTTPS URL, publisher, summary, relevance, and kind.

- [x] **Step 2: Build the research prompt and schema**

The prompt must include topic, current route step, learner level, goals, gaps, and daily minutes. It must prioritize primary sources, official documentation, universities, journals, and recognized educational publishers; require opening results before recommending them; and treat all page content as untrusted data.

- [x] **Step 3: Validate and normalize results**

Accept only HTTPS URLs without credentials or custom ports, remove common tracking parameters, deduplicate URLs, bound all text fields, and reject empty or malformed recommendation sets.

- [x] **Step 4: Run module tests**

Run:

```bash
bun test packages/core/src/learning-research.test.ts
```

Expected: all research validation tests pass.

### Task 3: Persist recommendations against a route version

**Files:**
- Modify: `packages/core/src/learning.ts`
- Test: `packages/core/src/learning.test.ts`

- [x] **Step 1: Extend topic plan state**

Add topic-only fields:

```ts
onlineResources: LearningResource[];
resourceResearchVersion?: number;
resourceResearchAt?: number;
resourceResearchQuery?: string;
```

Reading plans must keep these fields undefined. Old topic plans migrate to an empty recommendation list.

- [x] **Step 2: Add atomic replacement**

Implement:

```ts
replaceOnlineResources(
  planId: string,
  expectedRouteVersion: number,
  input: { query: string; resources: LearningResourceInput[] },
  at?: number,
): LearningPlan | undefined
```

Reject stale route versions, unsafe URLs, invalid fields, and assessment-pending plans. Replace the current recommendation set and stamp the current route version.

- [x] **Step 3: Invalidate recommendations on route changes**

Assessment completion and adaptive feedback must clear the current recommendations and research metadata. Completed lesson history remains unchanged.

- [x] **Step 4: Run store tests**

Run:

```bash
bun test packages/core/src/learning.test.ts
```

Expected: all learning store tests pass.

### Task 4: Research before lesson preparation and cite verified sources

**Files:**
- Modify: `packages/core/src/engine.ts`
- Test: `packages/core/src/learning-engine.test.ts`

- [x] **Step 1: Add an injectable research seam**

Extend `EngineOptions` with a `learningResearch` provider. Production uses the assigned Codex or Claude CLI with read-only web search; tests may inject a deterministic provider. When a general fake LLM is injected and no research provider is supplied, automatic research remains disabled.

- [x] **Step 2: Refresh once per route version**

Expose `refreshLearningResources(planId, now?, force?)`. Search only active, assessed topic plans. Skip a refresh when recommendations already match the current route version unless forced. Catch provider/network/validation failures, log them, and return the unchanged plan.

- [x] **Step 3: Refresh before preparing a topic lesson**

Before generating the guide, attempt a recommendation refresh. Reload the plan after research, build a `[联网资料N]` packet, and include it in the lesson prompt.

- [x] **Step 4: Require honest recommendation rendering**

Topic lessons must include `## 推荐资料`. With resources, cite only persisted `[联网资料N]` URLs. Without resources, state that no verifiable online material was obtained this time. Continue to reject fabricated material citations and arbitrary URLs.

- [x] **Step 5: Run engine tests and typecheck**

Run:

```bash
bun test packages/core/src/learning-engine.test.ts
bun run typecheck
```

Expected: both commands pass.

### Task 5: Expose recommendations in chat and HTML

**Files:**
- Modify: `packages/orchestrator/src/learning-commands.ts`
- Modify: `packages/orchestrator/src/messages.ts`
- Test: `packages/orchestrator/src/learning-commands.test.ts`
- Modify: `packages/web/src/views.ts`
- Test: `packages/web/src/app.test.ts`

- [x] **Step 1: Add `/learn resources`**

Parse `/learn resources <计划名称或序号>`, force a refresh, and return the title, publisher, relevance, and HTTPS URL for each recommendation. If search is unavailable and no previous recommendation exists, explain the fallback without claiming success.

- [x] **Step 2: Add an online-resource section to the learning map**

Render recommendation cards with source kind, publisher, relevance, current route version, search query, and safe external links using `target="_blank"` plus `rel="noreferrer noopener"`.

- [x] **Step 3: Run command and web tests**

Run:

```bash
bun test packages/orchestrator/src/learning-commands.test.ts
bun test packages/web/src/app.test.ts
```

Expected: all tests pass.

### Task 6: Preserve archives, document behavior, and verify

**Files:**
- Modify: `packages/core/src/governance.ts`
- Modify: `packages/core/src/governance.test.ts`
- Modify: `README.md`

- [x] **Step 1: Parse recommendation fields safely**

Archive restore must validate route-version metadata and the same HTTPS/resource bounds as local persistence. Older archives receive empty topic recommendations.

- [x] **Step 2: Update documentation**

Document:

```text
画像或路线更新 → 下一课前自动联网检索 → 可信来源筛选
→ 推荐资料进入课程与学习地图 → 搜索失败则诚实降级
```

State that Codex and Claude are supported, no third-party search key is required, and TRAE currently falls back to offline learning.

- [x] **Step 3: Run focused and full verification**

Run:

```bash
bun test packages/llm/src/providers.test.ts packages/core/src/learning-research.test.ts
bun test packages/core/src/learning.test.ts packages/core/src/learning-engine.test.ts packages/core/src/governance.test.ts
bun test packages/orchestrator/src/learning-commands.test.ts packages/web/src/app.test.ts
bun run typecheck
CLANG_MODULE_CACHE_PATH=/tmp/homeagent-swift-module-cache SWIFT_MODULECACHE_PATH=/tmp/homeagent-swift-module-cache bun test
```

Expected: all non-live tests pass; configured live tests may remain skipped.

- [x] **Step 4: Review and commit**

Review provider permissions, prompt-injection boundaries, URL safety, stale-write protection, archive compatibility, HTML escaping, and unrelated changes. Then commit:

```bash
git add README.md docs/superpowers/plans/2026-07-16-learning-web-research.md packages
git commit -m "feat: recommend researched learning resources"
```

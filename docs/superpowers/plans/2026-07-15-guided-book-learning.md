# Guided Book Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user reply to an imported book or long-form document, create a durable daily learning plan, receive one grounded lesson per day in Feishu, submit an answer, get feedback, and advance reliable reading progress.

**Architecture:** Add a deep `LearningPlanStore` module in `core` that owns immutable source snapshots, plan state, and session history behind one persistence interface. `KnowledgeEngine` owns source selection and LLM work; a small app scheduler only asks which plans are due and delivers prepared sessions, while the orchestrator handles explicit `/learn` commands and `学习回答：` replies. Existing attachment/doc ingestion remains the source adapter, existing Feishu notice delivery remains the transport adapter, and completed learning sessions are captured back into the knowledge pipeline as `source="learning"`.

**Tech Stack:** Bun, TypeScript, Hono server-rendered HTML, local CLI-backed `LlmClient`, JSON persistence, existing Feishu connector and scheduler patterns.

---

## Scope and non-goals

This plan ships one end-to-end learning slice:

- Create a plan by replying to a previously captured attachment or Feishu document with `/learn new <书名>`.
- Snapshot the selected raw content so ordinary raw-retention cleanup cannot break an active plan.
- Split Markdown/text deterministically at headings and paragraph boundaries.
- Prepare and push one lesson per day, with startup catch-up and delivery retry.
- Require an explicit `学习回答：...` prefix so unrelated questions are never consumed as coursework.
- Produce feedback, advance the cursor only after an answer or explicit skip, and capture the daily learning record into the personal/team knowledge space.
- Pause, resume, skip, list, inspect, edit, export, restore, and delete plans.

This milestone intentionally does not add EPUB parsing, scanned-PDF OCR, audio/video courses, weekly rollups, spaced repetition, arbitrary agent filesystem permissions, or multiple sessions per plan per day. Those are independent follow-up milestones after the daily loop is proven.

## File map

**Create:**

- `packages/core/src/learning-content.ts` — deterministic source cleanup and heading-aware segment selection.
- `packages/core/src/learning-content.test.ts` — pure content-boundary tests.
- `packages/core/src/learning.ts` — types plus the persistence/state-transition module.
- `packages/core/src/learning.test.ts` — persistence and transition contract.
- `packages/core/src/learning-engine.test.ts` — source selection, lesson generation, delivery, feedback, and knowledge capture.
- `packages/app/src/learning-scheduler.ts` — due policy, catch-up loop, retry-safe outbound delivery.
- `packages/app/src/learning-scheduler.test.ts` — time and delivery tests.
- `packages/orchestrator/src/learning-commands.ts` — explicit command and answer parsing/handling.
- `packages/orchestrator/src/learning-commands.test.ts` — command authorization and state tests.

**Modify:**

- `packages/shared/src/types.ts` — add the `learning` raw-source discriminator.
- `packages/core/src/index.ts` — export learning modules.
- `packages/core/src/engine.ts` — expose the deep learning operations and capture completed sessions.
- `packages/core/src/governance.ts` — versioned learning archive validation.
- `packages/core/src/governance.test.ts` — export/restore/delete/retraction coverage.
- `packages/orchestrator/src/index.ts` — export learning commands.
- `packages/orchestrator/src/runtime.ts` — route learning controls before normal capture/intent classification.
- `packages/orchestrator/src/runtime.test.ts` — end-to-end chat behavior.
- `packages/app/src/main.ts` — start/stop/wire the learning scheduler.
- `packages/app/src/health.ts` and `packages/app/src/health.test.ts` — expose scheduler and plan counts.
- `packages/web/src/layout.ts` — add Learning navigation.
- `packages/web/src/views.ts` — add plan/session views.
- `packages/web/src/app.ts` and `packages/web/src/app.test.ts` — learning management routes.
- `README.md` — document the real learning workflow and correct the current “learning task completed” mismatch.

### Task 1: Add deterministic book segmentation

**Files:**

- Create: `packages/core/src/learning-content.ts`
- Create: `packages/core/src/learning-content.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing cleanup and segment-selection tests**

```ts
import { describe, expect, test } from "bun:test";
import { cleanLearningSource, nextLearningSegment } from "./learning-content.ts";

describe("learning content", () => {
  test("removes the ingestion wrapper but preserves the book heading", () => {
    const source = "# 附件：book.md\n\n# 第一章 出发\n\n第一段。\n\n第二段。";
    expect(cleanLearningSource(source)).toBe("# 第一章 出发\n\n第一段。\n\n第二段。");
  });

  test("ends a lesson at a paragraph boundary near the requested size", () => {
    const source = "# 第一章\n\n甲".repeat(40) + "\n\n# 第二章\n\n乙".repeat(40);
    const lesson = nextLearningSegment(source, 0, 120);
    expect(lesson.startOffset).toBe(0);
    expect(lesson.endOffset).toBeGreaterThan(0);
    expect(lesson.endOffset).toBeLessThanOrEqual(240);
    expect(lesson.text).toBe(source.slice(lesson.startOffset, lesson.endOffset).trim());
    expect(lesson.title).toBe("第一章");
  });

  test("continues from the exact previous offset without overlap", () => {
    const source = "# 一\n\n第一段。\n\n第二段。\n\n# 二\n\n第三段。";
    const first = nextLearningSegment(source, 0, 12);
    const second = nextLearningSegment(source, first.endOffset, 12);
    expect(second.startOffset).toBe(first.endOffset);
    expect(first.text + second.text).not.toContain("第一段。第一段。");
  });

  test("returns null after all non-whitespace content is consumed", () => {
    expect(nextLearningSegment("短文", 2, 100)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `bun test packages/core/src/learning-content.test.ts`

Expected: FAIL with `Cannot find module './learning-content.ts'`.

- [ ] **Step 3: Implement the pure content module**

```ts
export interface LearningSegment {
  startOffset: number;
  endOffset: number;
  title: string;
  text: string;
}

const WRAPPER = /^# (?:附件|来源文档)：[^\n]+\n+/u;

export function cleanLearningSource(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(WRAPPER, "").trim();
}

function headingBefore(source: string, offset: number): string {
  const prefix = source.slice(0, offset);
  const headings = [...prefix.matchAll(/^#{1,3}\s+(.+)$/gm)];
  return headings.at(-1)?.[1]?.trim() || "今日阅读";
}

export function nextLearningSegment(
  source: string,
  cursor: number,
  targetCharacters: number,
): LearningSegment | null {
  let startOffset = Math.max(0, Math.min(source.length, Math.trunc(cursor)));
  while (startOffset < source.length && /\s/u.test(source[startOffset]!)) startOffset += 1;
  if (startOffset >= source.length) return null;

  const target = Math.min(source.length, startOffset + Math.max(500, Math.trunc(targetCharacters)));
  const hardEnd = Math.min(source.length, startOffset + Math.max(1000, Math.trunc(targetCharacters) * 2));
  const tail = source.slice(target, hardEnd);
  const paragraph = tail.search(/\n\s*\n/u);
  const heading = tail.search(/\n#{1,3}\s/u);
  const candidates = [paragraph, heading].filter((value) => value >= 0);
  const endOffset = candidates.length > 0 ? target + Math.min(...candidates) : hardEnd;
  const text = source.slice(startOffset, endOffset).trim();
  return text
    ? { startOffset, endOffset, title: headingBefore(source, startOffset + 1), text }
    : null;
}
```

Export both functions from `packages/core/src/index.ts`.

- [ ] **Step 4: Run the focused tests**

Run: `bun test packages/core/src/learning-content.test.ts`

Expected: 4 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/learning-content.ts packages/core/src/learning-content.test.ts packages/core/src/index.ts
git commit -m "feat: add deterministic learning segments"
```

### Task 2: Build the durable LearningPlanStore module

**Files:**

- Create: `packages/core/src/learning.ts`
- Create: `packages/core/src/learning.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the state-transition contract tests**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningPlanStore } from "./learning.ts";

describe("LearningPlanStore", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hb-learning-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("persists a source snapshot and active plan", () => {
    const store = new LearningPlanStore(dir);
    const plan = store.create({
      name: "读原则",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "原则",
      sourceContent: "# 第一章\n\n正文",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
      hour: 8,
      dailyCharacters: 3000,
    });
    expect(plan.id).toMatch(/^learn_/);
    expect(new LearningPlanStore(dir).get(plan.id)?.sourceLength).toBe("# 第一章\n\n正文".length);
  });

  test("keeps a prepared lesson retryable until delivery succeeds", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    const session = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文",
      guide: "## 今日目标\n理解正文",
      preparedAt: 100,
    })!;
    expect(store.currentSession(plan.id)?.status).toBe("prepared");
    store.markDelivered(session.id, 200);
    expect(store.currentSession(plan.id)?.status).toBe("awaiting_reply");
  });

  test("advances only on completion or explicit skip", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    const first = store.prepareSession(plan.id, {
      startOffset: 0, endOffset: 4, sectionTitle: "一", excerpt: "正文", guide: "导读", preparedAt: 1,
    })!;
    store.markDelivered(first.id, 2);
    expect(store.get(plan.id)?.cursor).toBe(0);
    store.completeSession(first.id, { learnerReply: "我的理解", feedback: "很好", completedAt: 3 });
    expect(store.get(plan.id)?.cursor).toBe(4);
  });

  test("only the creator can mutate a plan", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    expect(store.pause(plan.id, "ou_other")).toBeUndefined();
    expect(store.pause(plan.id, "ou_me")?.status).toBe("paused");
    expect(store.resume(plan.id, "ou_me")?.status).toBe("active");
  });
});

function createPlan(store: LearningPlanStore) {
  return store.create({
    name: "读书", space: "personal/ou_me", creatorId: "ou_me", chatId: "oc_p2p",
    sourceTitle: "书", sourceContent: "正文内容", sourceRawIds: ["raw_1"],
    sourceMessageId: "om_1", hour: 8, dailyCharacters: 3000,
  });
}
```

- [ ] **Step 2: Run the contract and verify failure**

Run: `bun test packages/core/src/learning.test.ts`

Expected: FAIL because `LearningPlanStore` does not exist.

- [ ] **Step 3: Define the persisted model and public interface**

Add these exact exported shapes to `learning.ts`:

```ts
export type LearningPlanStatus = "active" | "paused" | "completed";
export type LearningSessionStatus = "prepared" | "awaiting_reply" | "completed" | "skipped";

export interface LearningSource {
  id: string;
  title: string;
  content: string;
  rawIds: string[];
  messageId: string;
  createdAt: number;
}

export interface LearningPlan {
  id: string;
  name: string;
  space: SpaceId;
  creatorId: string;
  chatId: string;
  sourceId: string;
  sourceLength: number;
  hour: number;
  dailyCharacters: number;
  cursor: number;
  status: LearningPlanStatus;
  currentSessionId?: string;
  lastDeliveredAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface LearningSession {
  id: string;
  planId: string;
  sequence: number;
  startOffset: number;
  endOffset: number;
  sectionTitle: string;
  excerpt: string;
  guide: string;
  status: LearningSessionStatus;
  learnerReply?: string;
  feedback?: string;
  preparedAt: number;
  deliveredAt?: number;
  completedAt?: number;
}

export interface LearningPlanInput {
  name: string;
  space: SpaceId;
  creatorId: string;
  chatId: string;
  sourceTitle: string;
  sourceContent: string;
  sourceRawIds: string[];
  sourceMessageId: string;
  hour?: number;
  dailyCharacters?: number;
}

export interface PrepareLearningSessionInput {
  startOffset: number;
  endOffset: number;
  sectionTitle: string;
  excerpt: string;
  guide: string;
  preparedAt: number;
}

export interface LearningArchive {
  plans: LearningPlan[];
  sources: LearningSource[];
  sessions: LearningSession[];
}
```

Implement `LearningPlanStore` over `data/config/learning.json`, using the same atomic in-memory-then-persist pattern as `ReminderStore`. Its public interface must be exactly:

```ts
export class LearningPlanStore {
  constructor(dataDir: string);
  list(): LearningPlan[];
  listBySpace(space: SpaceId): LearningPlan[];
  get(id: string): LearningPlan | undefined;
  source(planId: string): LearningSource | undefined;
  sessionsForPlan(planId: string): LearningSession[];
  currentSession(planId: string): LearningSession | undefined;
  create(input: LearningPlanInput): LearningPlan;
  update(id: string, actorId: string | undefined, patch: { hour?: number; dailyCharacters?: number }): LearningPlan | undefined;
  prepareSession(planId: string, input: PrepareLearningSessionInput): LearningSession | undefined;
  markDelivered(sessionId: string, deliveredAt: number): LearningSession | undefined;
  completeSession(sessionId: string, input: { learnerReply: string; feedback: string; completedAt: number }): LearningSession | undefined;
  skipCurrent(planId: string, actorId: string, completedAt: number): LearningSession | undefined;
  pause(id: string, actorId?: string): LearningPlan | undefined;
  resume(id: string, actorId?: string): LearningPlan | undefined;
  remove(id: string, actorId?: string): boolean;
  removeBySpace(space: SpaceId): number;
  removeByRawIds(rawIds: Set<string>): number;
  exportBySpace(space: SpaceId): LearningArchive;
  restore(archive: LearningArchive): LearningPlan[];
}
```

Enforce these invariants inside the module:

- Clamp `hour` to `0..23` and `dailyCharacters` to `500..8000`.
- Default `hour` to 8 and `dailyCharacters` to 3000 when omitted.
- `prepareSession` returns the existing prepared/awaiting session instead of creating a duplicate.
- `markDelivered` only accepts `prepared`.
- `completeSession` and `skipCurrent` only accept `awaiting_reply`, advance `cursor` to `endOffset`, clear `currentSessionId`, and mark the plan completed at end-of-source.
- Chat-side mutations always pass an actor and require `creatorId === actorId`; the authenticated/local management backend deliberately omits the actor and acts administratively.
- Every state transition persists before returning; on write failure, restore the previous maps.

- [ ] **Step 4: Run store tests and the core type checker**

Run: `bun test packages/core/src/learning.test.ts && bunx tsc -p tsconfig.json --noEmit`

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/learning.ts packages/core/src/learning.test.ts packages/core/src/index.ts
git commit -m "feat: persist learning plans and sessions"
```

### Task 3: Create plans from captured books and prepare grounded lessons

**Files:**

- Create: `packages/core/src/learning-engine.test.ts`
- Modify: `packages/core/src/engine.ts`

- [ ] **Step 1: Write failing engine tests**

Add tests covering all of these exact cases:

```ts
test("creates a plan from the longest raw record derived from a replied-to message", async () => {
  const messageId = "om_book";
  await engine.remember({ space: SPACE, source: "message", chatId: "oc", messageId, content: "一本书" });
  const rawId = await engine.remember({
    space: SPACE, source: "message", chatId: "oc", messageId,
    content: "# 附件：book.md\n\n# 第一章\n\n这是足够长的正文。",
  });
  const plan = engine.createLearningPlanFromMessage({
    space: SPACE, chatId: "oc", messageId, creatorId: "ou_me", name: "读这本书",
  });
  expect(engine.learning.source(plan.id)?.rawIds).toEqual([rawId]);
  expect(engine.learning.source(plan.id)?.content).toContain("# 第一章");
});

test("refuses to create a plan when the replied-to message has no readable source", () => {
  expect(() => engine.createLearningPlanFromMessage({
    space: SPACE, chatId: "oc", messageId: "missing", creatorId: "ou_me", name: "空书",
  })).toThrow("没有找到可阅读的书籍内容");
});

test("prepares one grounded session without advancing progress", async () => {
  const plan = seededPlan(engine);
  const session = await engine.prepareLearningSession(plan.id, 100);
  expect(session.status).toBe("prepared");
  expect(session.excerpt).toContain("第一章");
  expect(session.guide).toContain("今日目标");
  expect(engine.learning.get(plan.id)?.cursor).toBe(0);
});

test("keeps a prepared session retryable when outbound delivery fails", async () => {
  const plan = seededPlan(engine);
  await expect(engine.deliverLearningSession(plan.id, 100, async () => {
    throw new Error("network unavailable");
  })).rejects.toThrow("network unavailable");
  expect(engine.learning.currentSession(plan.id)?.status).toBe("prepared");
});
```

- [ ] **Step 2: Run the focused test and verify missing methods**

Run: `bun test packages/core/src/learning-engine.test.ts`

Expected: FAIL because the learning engine interface is absent.

- [ ] **Step 3: Add the learning module to KnowledgeEngine**

Add `readonly learning: LearningPlanStore`, initialize it with `this.dataDir`, and add these interfaces:

```ts
export interface CreateLearningPlanFromMessageInput {
  space: SpaceId;
  chatId: string;
  messageId: string;
  creatorId: string;
  name: string;
  hour?: number;
  dailyCharacters?: number;
}

export type LearningDelivery = (
  plan: LearningPlan,
  source: LearningSource,
  session: LearningSession,
) => void | Promise<void>;
```

Implement `createLearningPlanFromMessage` by loading `findRawsByMessageId`, discarding blank records, selecting the longest content record, cleaning it with `cleanLearningSource`, and snapshotting exactly that raw ID. Derive the source title from an attachment filename, the first Markdown heading, or the requested plan name, in that order.

Implement the lesson prompt as a private pure function:

```ts
function learningGuidePrompt(plan: LearningPlan, segment: LearningSegment): string {
  return [
    "你是一位严谨、耐心的中文阅读教练。只能依据下面的今日原文进行导读，不要补写书中没有的事实。",
    `学习计划：${plan.name}`,
    `今日范围：${segment.title}`,
    "",
    "## 今日原文",
    segment.text,
    "",
    "请输出 Markdown，并严格包含：",
    "## 今日目标",
    "## 阅读提示",
    "## 重点概念",
    "## 思考题",
    "思考题给出 2—3 个；不要重复粘贴今日原文。",
  ].join("\n");
}
```

Add these methods:

```ts
createLearningPlanFromMessage(input: CreateLearningPlanFromMessageInput): LearningPlan;
prepareLearningSession(planId: string, now?: number): Promise<LearningSession>;
deliverLearningSession(planId: string, now: number, deliver: LearningDelivery): Promise<boolean>;
```

`prepareLearningSession` must reuse an existing prepared/awaiting session, call `nextLearningSegment(source.content, plan.cursor, plan.dailyCharacters)`, call the space LLM outside the serializer, reject empty output, and persist a `prepared` session. `deliverLearningSession` must call the callback first and only then call `markDelivered`; a thrown callback leaves the session prepared for retry.

Use `const LEARNING_TIMEOUT_MS = 300_000` and resolve the client with `llmClientForSpace(plan.space, LEARNING_TIMEOUT_MS)` so a lesson has the same bounded long-running behavior as research tasks.

- [ ] **Step 4: Run focused engine and store tests**

Run: `bun test packages/core/src/learning-engine.test.ts packages/core/src/learning.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine.ts packages/core/src/learning-engine.test.ts
git commit -m "feat: prepare grounded book lessons"
```

### Task 4: Evaluate answers and capture daily summaries

**Files:**

- Modify: `packages/shared/src/types.ts`
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/learning-engine.test.ts`
- Modify: `packages/core/src/governance.ts`

- [ ] **Step 1: Add failing answer and authorization tests**

```ts
test("only the learner can answer and progress advances after feedback", async () => {
  const plan = seededPlan(engine);
  await engine.deliverLearningSession(plan.id, 100, async () => {});
  await expect(engine.answerLearningSession(plan.id, "ou_other", "我的回答", 200))
    .rejects.toThrow("只有学习计划创建者可以提交回答");
  const result = await engine.answerLearningSession(plan.id, "ou_me", "我的回答", 200);
  expect(result.feedback).toContain("回应点评");
  expect(engine.learning.get(plan.id)!.cursor).toBeGreaterThan(0);
  const raws = engine.registry.store(SPACE).index().listRaw({});
  expect(raws.at(-1)).toEqual(expect.objectContaining({ source: "learning" }));
});

test("an unrelated message cannot complete a learning session", async () => {
  const plan = seededPlan(engine);
  await engine.deliverLearningSession(plan.id, 100, async () => {});
  expect(engine.learning.currentSession(plan.id)?.status).toBe("awaiting_reply");
});
```

- [ ] **Step 2: Run the test and verify the raw-source/type failure**

Run: `bun test packages/core/src/learning-engine.test.ts`

Expected: FAIL because `answerLearningSession` and raw source `learning` are absent.

- [ ] **Step 3: Add feedback generation and knowledge capture**

Change `RawSource` to:

```ts
export type RawSource = "message" | "doc" | "manual" | "task" | "learning";
```

Add `learning` to `RAW_SOURCES` in governance validation.

Use this exact prompt shape:

```ts
function learningFeedbackPrompt(session: LearningSession, reply: string): string {
  return [
    "你是一位阅读教练。依据今日原文、导读和学习者回答给出具体反馈；不知道的内容不要猜。",
    "## 今日原文", session.excerpt,
    "## 今日导读", session.guide,
    "## 学习者回答", reply,
    "",
    "请输出 Markdown，并严格包含：",
    "## 回应点评",
    "## 需要澄清",
    "## 今日总结",
    "## 下一步",
  ].join("\n");
}
```

Add:

```ts
export interface LearningAnswerResult {
  plan: LearningPlan;
  session: LearningSession;
  feedback: string;
  rawId: string;
}

async answerLearningSession(
  planId: string,
  actorId: string,
  reply: string,
  now?: number,
): Promise<LearningAnswerResult>;
```

The method must require a non-empty reply, require an awaiting session, authorize the creator, generate feedback outside the per-space serializer, complete the session, and call `remember` with this deterministic record:

```ts
{
  space: plan.space,
  source: "learning",
  author: actorId,
  chatId: plan.chatId,
  content: [
    `# 学习记录：${plan.name} · 第 ${session.sequence} 课`,
    `阅读范围：${session.sectionTitle}`,
    "",
    "## 我的回答", reply,
    "",
    feedback,
  ].join("\n"),
}
```

- [ ] **Step 4: Run focused tests and type checking**

Run: `bun test packages/core/src/learning-engine.test.ts packages/core/src/governance.test.ts && bunx tsc -p tsconfig.json --noEmit`

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/core/src/engine.ts packages/core/src/learning-engine.test.ts packages/core/src/governance.ts
git commit -m "feat: capture guided learning feedback"
```

### Task 5: Add the daily LearningScheduler

**Files:**

- Create: `packages/app/src/learning-scheduler.ts`
- Create: `packages/app/src/learning-scheduler.test.ts`
- Modify: `packages/app/src/main.ts`

- [ ] **Step 1: Write due-policy and retry tests**

```ts
test("runs once after the configured Asia/Shanghai hour", () => {
  expect(shouldRunLearningPlan(plan({ hour: 8 }), undefined, new Date("2026-07-15T08:01:00+08:00"))).toBe(true);
  expect(shouldRunLearningPlan(
    plan({ hour: 8, lastDeliveredAt: new Date("2026-07-15T08:00:00+08:00").getTime() }),
    undefined,
    new Date("2026-07-15T09:00:00+08:00"),
  )).toBe(false);
});

test("retries a prepared session but blocks while awaiting the learner", () => {
  expect(shouldRunLearningPlan(plan({}), session({ status: "prepared" }), NOW)).toBe(true);
  expect(shouldRunLearningPlan(plan({}), session({ status: "awaiting_reply" }), NOW)).toBe(false);
});

test("delivery failure leaves the same prepared session for the next tick", async () => {
  const delivered: string[] = [];
  const scheduler = new LearningScheduler(engine, {
    notify: async (_plan, _source, current) => {
      delivered.push(current.id);
      throw new Error("network unavailable");
    },
  });
  await scheduler.tick("first", NOW);
  await scheduler.tick("retry", NOW);
  expect(delivered[0]).toBe(delivered[1]);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `bun test packages/app/src/learning-scheduler.test.ts`

Expected: FAIL because the scheduler module does not exist.

- [ ] **Step 3: Implement the scheduler using existing runtime-loop conventions**

Export:

```ts
export interface LearningScheduleConfig { tickMs: number; }
export const DEFAULT_LEARNING_SCHEDULE = { tickMs: 15 * 60 * 1000 };
export type LearningNotify = LearningDelivery;
export function shouldRunLearningPlan(
  plan: LearningPlan,
  current: LearningSession | undefined,
  now: Date,
): boolean;
export class LearningScheduler {
  constructor(engine: KnowledgeEngine, opts?: { cfg?: Partial<LearningScheduleConfig>; notify?: LearningNotify });
  start(): Promise<void>;
  stop(): void;
  health(): RuntimeLoopHealth;
  tick(reason: string, now?: Date): Promise<string[]>;
}
```

Reuse `localHour` and `dayKey` from `scheduler.ts`. The due policy is:

- non-active plans never run;
- a prepared session always retries;
- an awaiting session blocks new lessons;
- before the configured hour, do not run;
- after the hour, run only when `lastDeliveredAt` is not today.

The tick loops over `engine.learning.list()`, invokes `engine.deliverLearningSession`, records each delivered plan ID, and exposes errors through the same health fields as TaskScheduler.

Wire it in `main.ts` after TaskScheduler and before ReminderScheduler. Use `connector.notice(plan.chatId, learningNotification(plan, session))`, and stop it during shutdown.

Use this deterministic notification renderer:

```ts
export function learningNotification(plan: LearningPlan, session: LearningSession): string {
  return [
    `📖 ${plan.name} · 第 ${session.sequence} 课`,
    `今日范围：${session.sectionTitle}`,
    "",
    "## 今日原文",
    session.excerpt,
    "",
    session.guide,
    "",
    "读完后回复并 @我，以“学习回答：”开头；如需跳过，发送 `/learn skip <计划名称或序号>`。",
  ].join("\n");
}
```

- [ ] **Step 4: Run scheduler tests**

Run: `bun test packages/app/src/learning-scheduler.test.ts packages/app/src/task-scheduler.test.ts packages/app/src/reminder-scheduler.test.ts`

Expected: all scheduler tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/learning-scheduler.ts packages/app/src/learning-scheduler.test.ts packages/app/src/main.ts
git commit -m "feat: schedule daily guided lessons"
```

### Task 6: Add Feishu learning commands and answer routing

**Files:**

- Create: `packages/orchestrator/src/learning-commands.ts`
- Create: `packages/orchestrator/src/learning-commands.test.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/orchestrator/src/runtime.ts`
- Modify: `packages/orchestrator/src/runtime.test.ts`
- Modify: `packages/orchestrator/src/messages.ts`

- [ ] **Step 1: Write parser and runtime tests**

```ts
expect(parseLearningCommand("/learn")).toEqual({ verb: "list", arg: "" });
expect(parseLearningCommand("/learn new 原则")).toEqual({ verb: "new", arg: "原则" });
expect(parseLearningCommand("/learn pause 1")).toEqual({ verb: "pause", arg: "1" });
expect(parseLearningCommand("/learn resume 原则")).toEqual({ verb: "resume", arg: "原则" });
expect(parseLearningCommand("/learn skip 1")).toEqual({ verb: "skip", arg: "1" });
expect(parseLearningAnswer("学习回答：我认为作者在区分原则和规则")).toBe("我认为作者在区分原则和规则");
expect(parseLearningAnswer("这周有什么安排？")).toBeNull();
```

Add runtime cases proving:

- `/learn new` without replying to a source gives actionable guidance and creates nothing.
- Replying to an attachment-derived message creates one plan owned by the sender.
- Another group member cannot pause, resume, skip, delete, or answer it.
- `学习回答：...` is handled before capture/intent classification, returns feedback, and the control message itself is not stored as an ordinary message.
- A normal question while a session awaits remains a normal question.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `bun test packages/orchestrator/src/learning-commands.test.ts packages/orchestrator/src/runtime.test.ts`

Expected: FAIL because learning command routing is absent.

- [ ] **Step 3: Implement explicit parsing and handlers**

Use these public shapes:

```ts
export interface LearningCommand {
  verb: "list" | "new" | "pause" | "resume" | "skip" | "delete" | "help";
  arg: string;
}

export interface LearningCommandContext {
  space: SpaceId;
  chatId: string;
  actorId: string;
  sourceMessageId?: string;
}

export function parseLearningCommand(text: string): LearningCommand | null;
export function parseLearningAnswer(text: string): string | null;
export async function handleLearningCommand(
  engine: KnowledgeEngine,
  command: LearningCommand,
  context: LearningCommandContext,
): Promise<string>;
export async function handleLearningAnswer(
  engine: KnowledgeEngine,
  answer: string,
  context: Omit<LearningCommandContext, "sourceMessageId">,
): Promise<string>;
```

Command aliases must accept English and Chinese verbs: `list/列表`, `new/新建`, `pause/暂停`, `resume/继续`, `skip/跳过`, `delete/删除`, `help/帮助`. Find targets by 1-based index or exact case-insensitive name inside the current space and creator.

For `/learn new`, runtime resolves `connector.resolveReplyTarget(msg.messageId)` and passes its `messageId`. Reject a missing target with: `请回复包含书籍附件或飞书文档的原消息，再发送 /learn new <书名>。`

For learning answers, require exactly one awaiting plan owned by this actor in this space. Return an explicit disambiguation message if more than one is awaiting.

Route learning commands immediately after task commands and before retraction/capture. Route `学习回答：` after the reply gate confirms the bot should respond and before reminder handling. Neither form may be captured as an ordinary message.

- [ ] **Step 4: Run command and runtime tests**

Run: `bun test packages/orchestrator/src/learning-commands.test.ts packages/orchestrator/src/runtime.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/learning-commands.ts packages/orchestrator/src/learning-commands.test.ts packages/orchestrator/src/index.ts packages/orchestrator/src/runtime.ts packages/orchestrator/src/runtime.test.ts packages/orchestrator/src/messages.ts
git commit -m "feat: manage learning plans from chat"
```

### Task 7: Add Learning management pages

**Files:**

- Modify: `packages/web/src/layout.ts`
- Modify: `packages/web/src/views.ts`
- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/app.test.ts`

- [ ] **Step 1: Add failing management-page tests**

```ts
test("learning: nav, progress, session history, and administrative controls", async () => {
  const plan = seedLearningPlan(engine);
  const page = await app.request(`/learning/${encodeURIComponent(plan.id)}`);
  const body = await page.text();
  expect(page.status).toBe(200);
  expect(body).toContain("学习");
  expect(body).toContain(plan.name);
  expect(body).toContain("0%");
  expect(body).toContain("暂停");
});

test("learning: schedule edits clamp invalid values", async () => {
  const plan = seedLearningPlan(engine);
  await app.request(`/learning/${encodeURIComponent(plan.id)}`, {
    method: "POST",
    body: new URLSearchParams({ hour: "99", dailyCharacters: "100" }),
  });
  expect(engine.learning.get(plan.id)).toEqual(expect.objectContaining({ hour: 23, dailyCharacters: 500 }));
});
```

- [ ] **Step 2: Run the web tests and verify missing routes**

Run: `bun test packages/web/src/app.test.ts`

Expected: FAIL with 404 for `/learning/:id`.

- [ ] **Step 3: Add the views and routes**

Add a `学习` rail item between Tasks and Reminders. Add:

```ts
export function learningView(
  plans: LearningPlan[],
  selected: { plan: LearningPlan; source: LearningSource; sessions: LearningSession[] } | null,
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString>;
```

The list must show plan name, source title, status, daily hour, and percentage `Math.floor(cursor / sourceLength * 100)`. The detail must show owner, delivery chat, exact `cursor/sourceLength`, current-session status, and completed/skipped session history. Include forms for schedule update, pause/resume, and delete. Creation remains chat-first; the empty state must say: `在飞书中回复一本已导入的书，发送 /learn new <书名> 创建计划。`

Add routes:

```text
GET  /learning
GET  /learning/:id
POST /learning/:id
POST /learning/:id/pause
POST /learning/:id/resume
POST /learning/:id/delete
```

Management routes act administratively and therefore call store mutations without an actor ID; they must never render or accept a hidden identity field. Chat handlers always pass the real sender ID and remain owner-restricted. A missing plan returns 404, and malformed input redirects with a safe flash instead of changing state.

- [ ] **Step 4: Run all web tests**

Run: `bun test packages/web/src/app.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/layout.ts packages/web/src/views.ts packages/web/src/app.ts packages/web/src/app.test.ts
git commit -m "feat: manage learning progress in web"
```

### Task 8: Complete governance, privacy, and health integration

**Files:**

- Modify: `packages/core/src/governance.ts`
- Modify: `packages/core/src/governance.test.ts`
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/app/src/health.ts`
- Modify: `packages/app/src/health.test.ts`
- Modify: `packages/app/src/main.ts`
- Modify: `packages/web/src/views.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add tests proving:

```ts
test("space export and restore preserve learning source, progress, and sessions", async () => {
  const plan = seedLearningPlan(engine);
  const archive = await engine.exportSpace(SPACE);
  expect(archive.learning.plans.map((item) => item.id)).toContain(plan.id);
  const restored = new KnowledgeEngine({ dataDir: otherDir, runProvider: async () => "ok" });
  await restored.restoreSpace(archive);
  expect(restored.learning.source(plan.id)?.content).toContain("第一章");
});

test("retracting the source message removes copied learning content", async () => {
  const plan = seedLearningPlan(engine);
  await engine.retractMessage(SPACE, {
    chatId: "oc", messageId: "om_book", requestedBy: "ou_me", requesterIsAdmin: false,
  });
  expect(engine.learning.get(plan.id)).toBeUndefined();
});

test("deleting a space deletes its learning plans and reports the count", async () => {
  seedLearningPlan(engine);
  const result = await engine.deleteSpace(SPACE);
  expect(result.learningPlansDeleted).toBe(1);
});
```

- [ ] **Step 2: Run governance and health tests and verify failure**

Run: `bun test packages/core/src/governance.test.ts packages/app/src/health.test.ts`

Expected: FAIL because archives, deletion reports, and health do not include learning.

- [ ] **Step 3: Version and validate the portable archive**

Introduce archive version 2:

```ts
export const SPACE_ARCHIVE_VERSION = 2 as const;

export interface SpaceArchiveV2 {
  format: typeof SPACE_ARCHIVE_FORMAT;
  version: 2;
  exportedAt: number;
  space: SpaceMeta;
  agent?: Agent;
  purpose: string;
  schema: string;
  pages: Page[];
  raw: RawRecord[];
  retractions: MessageRetractionRecord[];
  tasks: Task[];
  reminders: Reminder[];
  learning: LearningArchive;
}
```

Keep parsing version 1 archives and normalize them to version 2 with `{ plans: [], sources: [], sessions: [] }`. Validate all learning IDs as non-empty and unique, require every plan/session/source to belong to a consistent graph, require every plan space to match the archive space, cap source content at 2,000,000 characters per source, validate status unions, and reject cursor/offset values outside source bounds before creating any files.

Update export, restore rollback, retraction, and deletion:

- Export `learning.exportBySpace(space)`.
- Restore learning only after all archive validation succeeds.
- On restore failure, remove newly restored learning records.
- During retraction, call `learning.removeByRawIds(removedSourceIds)` before returning success.
- During space deletion, call `learning.removeBySpace(space)` and return `learningPlansDeleted`.

- [ ] **Step 4: Add learning scheduler health**

Extend the health reporter dependencies with `learningSchedulerHealth`, add a `learningScheduler` component, and report `${active} 个进行中，${awaiting} 个等待回答`. Readiness must degrade on the scheduler’s latest failed tick using the same rule as task/reminder schedulers. Show the component in the health view and wire it from `main.ts`.

- [ ] **Step 5: Run lifecycle, health, and type tests**

Run: `bun test packages/core/src/governance.test.ts packages/app/src/health.test.ts packages/web/src/app.test.ts && bunx tsc -p tsconfig.json --noEmit`

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/governance.ts packages/core/src/governance.test.ts packages/core/src/engine.ts packages/app/src/health.ts packages/app/src/health.test.ts packages/app/src/main.ts packages/web/src/views.ts
git commit -m "feat: govern and monitor learning plans"
```

### Task 9: Document and verify the complete learning loop

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Correct the implementation-status language**

Replace the current ambiguous “学习任务已完成” statement with two explicit capabilities:

```md
- 定时研究任务：周期性调研一个主题并写回知识库。
- 引导式学习计划：回复已导入的书籍或飞书文档创建每日课程，记录阅读进度、学习回答与 Agent 点评。
```

- [ ] **Step 2: Add the user workflow and limits**

Document these commands verbatim:

```text
/learn                         查看我的学习计划
/learn new <书名>              回复书籍附件/飞书文档后创建计划
/learn pause <名称或序号>      暂停
/learn resume <名称或序号>     恢复
/learn skip <名称或序号>       跳过当前一课并推进进度
/learn delete <名称或序号>     删除计划和复制的学习源
学习回答：<你的理解或答案>      提交当前课程回答并获取点评
```

State clearly that the first release accepts content already supported by ingestion: UTF-8 text/Markdown, text-layer PDF, and Feishu docs. Retain the existing 20 MiB attachment and 200,000 extracted-character limits; scanned PDF, EPUB, Office, audio, and video remain unsupported in this milestone.

- [ ] **Step 3: Run the entire offline suite**

Run: `bun test`

Expected: all non-live tests pass, live tests remain skipped, 0 failures.

- [ ] **Step 4: Run the type checker**

Run: `bunx tsc -p tsconfig.json --noEmit`

Expected: exit code 0 with no diagnostics.

- [ ] **Step 5: Perform the real Feishu smoke flow**

Run Homebrain against the maintainer's test Feishu bot with a disposable personal space; do not use production family/team spaces for this verification.

Verify this sequence manually:

```text
1. Send a small Markdown book attachment.
2. Reply to it with `/learn new 示例书`.
3. Confirm `/learn` lists one active plan.
4. Trigger the learning scheduler tick or advance to the configured hour.
5. Confirm exactly one lesson is pushed and a second tick does not create another.
6. Send `学习回答：我的理解是……`.
7. Confirm feedback is returned, cursor advances, and one `learning` raw record exists.
8. Restart the process and confirm source, cursor, sessions, and tomorrow’s schedule persist.
9. Retract the original source message and confirm the copied learning source and plan are removed.
```

- [ ] **Step 6: Review the diff for scope and secrets**

Run: `git diff --check && git status --short && rg -n "App Secret|ANTHROPIC_AUTH_TOKEN|sk-[A-Za-z0-9]" packages docs README.md`

Expected: no whitespace errors, only intended files changed, and no credential values appear.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: explain guided book learning"
```

## Self-review results

- **Spec coverage:** Source selection, immutable snapshot, segmentation, daily scheduling, retry-safe delivery, explicit interaction, feedback, progress, pause/resume/skip/delete, web visibility, export/restore/delete/retraction, health, and documentation each have a concrete task.
- **Scope control:** Weekly summaries, spaced repetition, new file formats, and generic agent permissions are explicitly outside this milestone and do not leak into the interfaces.
- **Type consistency:** `LearningPlan`, `LearningSource`, `LearningSession`, `LearningArchive`, `LearningDelivery`, and all engine/store method names are consistent across Tasks 2–8.
- **Privacy:** Source retraction and space deletion remove copied source content; normal raw-retention cleanup does not silently break active plans.
- **Delivery semantics:** Progress never advances when generation or Feishu delivery fails, and a prepared session is retried rather than regenerated.

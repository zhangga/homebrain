# Smart Reminder Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fall back to a space-scoped LLM when deterministic reminder parsing cannot produce a reliable time, then create the reminder only after the requesting user confirms the displayed candidate.

**Architecture:** Keep `parseReminderRequest()` and the existing reminder command handler as the zero-model fast path. Add a focused structured LLM extractor for unresolved reminder requests, while the orchestrator owns a short-lived per-chat/per-user confirmation map so unconfirmed candidates never enter the durable reminder scheduler.

**Tech Stack:** TypeScript, Bun test, existing `LlmClient.completeJSON()`, `KnowledgeEngine.reminders`.

---

### Task 1: Reject falsely precise deterministic clock parsing

**Files:**
- Modify: `packages/orchestrator/src/reminder-commands.ts`
- Test: `packages/orchestrator/src/reminder-commands.test.ts`

- [ ] **Step 1: Write the failing public-parser test**

```ts
test("does not silently replace an unsupported explicit clock with a period default", () => {
  expect(parseReminderRequest("7月22日上午七点半提醒我买票", NOW)).toBeUndefined();
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `bun test packages/orchestrator/src/reminder-commands.test.ts`

Expected: FAIL because the current parser schedules the reminder at 09:00.

- [ ] **Step 3: Make the clock parser conservative**

Change `localClock()` to return `undefined` when the text contains an explicit Chinese-numeral clock such as `七点半` that its exact numeric-clock rule cannot parse. Preserve the documented defaults for a bare `上午`/`下午` period.

```ts
function localClock(text: string): { hour: number; minute: number } | undefined {
  // Existing Arabic-digit exact match remains first.
  if (/[零〇一二两三四五六七八九十百]+\s*[点时]/u.test(text)) return undefined;
  // Existing period defaults follow.
}
```

Propagate `undefined` from `shanghaiCalendarInstant()` before constructing an instant.

- [ ] **Step 4: Run the focused test and verify green**

Run: `bun test packages/orchestrator/src/reminder-commands.test.ts`

Expected: PASS.

### Task 2: Add conservative structured LLM extraction

**Files:**
- Create: `packages/orchestrator/src/reminder-inference.ts`
- Modify: `packages/orchestrator/src/runtime.test.ts`

- [ ] **Step 1: Extend the runtime fake for the reminder schema**

Add a `completeJSON()` fake branch identified by a `triggerAt` schema property. For the reported message, return:

```ts
{
  resolved: true,
  title: "购买8.5日北京去苏州的火车票",
  triggerAt: "2026-07-22T07:30:00+08:00",
  untilConfirmed: false,
}
```

Return an unresolved result for requests without a concrete time:

```ts
{ resolved: false, title: "", triggerAt: "", untilConfirmed: false }
```

- [ ] **Step 2: Write the failing chat-flow test through `Orchestrator`**

```ts
test("asks for confirmation before creating an LLM-inferred reminder", async () => {
  await orch.start();
  await connector.sendGroup(
    "@agent 7.22日上午七点半提醒我购买8.5日北京去苏州的火车票",
    true,
  );

  expect(engine.reminders.list()).toEqual([]);
  expect(connector.sent.at(-1)?.markdown).toContain("请确认");
  expect(connector.sent.at(-1)?.markdown).toContain("购买8.5日北京去苏州的火车票");
});
```

- [ ] **Step 3: Run the focused runtime test and verify red**

Run: `bun test packages/orchestrator/src/runtime.test.ts -t "asks for confirmation"`

Expected: FAIL because unresolved reminders currently return the fixed “没有识别到具体时间” response.

- [ ] **Step 4: Implement the LLM extraction boundary**

Create `inferReminderRequest(client, text, now)` using `completeJSON()` with:

```ts
interface ReminderInference {
  resolved: boolean;
  title: string;
  triggerAt: string;
  repeatEveryMs?: number;
  untilConfirmed: boolean;
}
```

The prompt must include the current Asia/Shanghai time, require an ISO-8601 offset, distinguish the time governing “提醒” from dates inside the reminder title, forbid invented defaults, and treat the user text as untrusted data. Validation must reject blank titles, invalid/offset-less timestamps, past instants, and invalid repetition intervals.

- [ ] **Step 5: Run the inference unit through the runtime test and verify it remains red only at orchestration**

Run: `bun test packages/orchestrator/src/runtime.test.ts -t "asks for confirmation"`

Expected: FAIL until Task 3 wires the extractor into the chat flow.

### Task 3: Stage, confirm, cancel, and expire candidates

**Files:**
- Modify: `packages/orchestrator/src/reminder-commands.ts`
- Modify: `packages/orchestrator/src/runtime.ts`
- Test: `packages/orchestrator/src/runtime.test.ts`

- [ ] **Step 1: Expose safe scheduling and fallback predicates**

Extract the existing durable-create block into:

```ts
export function scheduleReminderDraft(
  engine: KnowledgeEngine,
  msg: Pick<InboundMessage, "chatId" | "senderId" | "messageId">,
  space: SpaceId,
  draft: ReminderDraft,
  now = Date.now(),
): string
```

Export `needsReminderInference(text)` for reminder-bearing input left unresolved by deterministic control handling. Remove the old fixed fallback from `handleReminderMessage()` so the orchestrator can invoke the model.

- [ ] **Step 2: Add a pending candidate map in `Orchestrator`**

Key entries by `chatId + senderId` and store the draft, source message ID, and `expiresAt = now + 15 minutes`. Only exact control replies `确认`/`确认创建` and `取消`/`取消创建` consume pending state. Process these controls before group mention gating so a thread reply does not need another `@`.

- [ ] **Step 3: Wire the fallback path**

After deterministic reminder handling returns `null`, call `inferReminderRequest()` inside the existing thinking-reaction wrapper. An unresolved result returns actionable rephrasing guidance. A resolved result is staged and displayed using `formatReminderTime()` with:

```text
我理解为：
提醒内容：...
提醒时间：...
请在 15 分钟内回复「确认」后创建，回复「取消」放弃。
```

Do not write a `Reminder` at this point.

- [ ] **Step 4: Complete the confirmation test**

Extend the test with an unmentioned group reply:

```ts
await connector.sendGroup("确认", false);
expect(engine.reminders.list()).toEqual([
  expect.objectContaining({
    title: "购买8.5日北京去苏州的火车票",
    triggerAt: new Date("2026-07-22T07:30:00+08:00").getTime(),
    sourceMessageId: "om_cli-1",
    status: "scheduled",
  }),
]);
```

- [ ] **Step 5: Run the focused test and verify green**

Run: `bun test packages/orchestrator/src/runtime.test.ts -t "asks for confirmation"`

Expected: PASS.

- [ ] **Step 6: Add and satisfy cancellation coverage**

```ts
test("cancels an inferred reminder candidate without creating it", async () => {
  await orch.start();
  await connector.sendGroup(
    "@agent 7.22日上午七点半提醒我购买8.5日北京去苏州的火车票",
    true,
  );
  await connector.sendGroup("取消", false);
  expect(engine.reminders.list()).toEqual([]);
  expect(connector.sent.at(-1)?.markdown).toContain("已取消");
});
```

Run: `bun test packages/orchestrator/src/runtime.test.ts -t "inferred reminder"`

Expected: PASS.

### Task 4: Regression verification and documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document model fallback and confirmation**

Update the reminder section to say deterministic formats create immediately, while model-inferred times are displayed for explicit confirmation and remain unscheduled until confirmed.

- [ ] **Step 2: Run reminder and runtime suites**

Run: `bun test packages/orchestrator/src/reminder-commands.test.ts packages/orchestrator/src/runtime.test.ts`

Expected: PASS.

- [ ] **Step 3: Run repository type checking**

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 4: Run the full offline suite**

Run: `bun test`

Expected: PASS, excluding any pre-existing environment-specific failures that are recorded with their exact output.

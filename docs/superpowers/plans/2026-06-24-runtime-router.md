# Runtime Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first Slice 1 homeagent runtime path: route normalized connector messages to `homebrain.ask` or `homebrain.remember`.

**Architecture:** `understanding/router.ts` stays pure and platform-independent. `runtime.ts` owns the single-consumer message loop and depends only on a `Connector` plus a narrow `Homebrain` subset, so it can be tested with in-memory adapters before real gbrain/Claude are available.

**Tech Stack:** TypeScript, Bun, `bun:test`, existing `Connector` interface, existing `homebrain` package types.

---

## File Structure

- Create `packages/homeagent/src/understanding/router.ts`: pure `routeIncomingMessage()` function returning `ask`, `remember`, or `ignore`.
- Create `packages/homeagent/src/understanding/router.test.ts`: tests for `@bot` question routing, passive memory routing, and empty-message ignore.
- Create `packages/homeagent/src/runtime.ts`: `runRuntime()` and `handleIncomingMessage()` using connector + homebrain.
- Create `packages/homeagent/src/runtime.test.ts`: tests with fake connector and fake brain.
- Modify `packages/homeagent/src/index.ts`: wire `createCliConnector`, `createHomebrain`, and `runRuntime`.

### Task 1: Router

**Files:**
- Create: `packages/homeagent/src/understanding/router.test.ts`
- Create: `packages/homeagent/src/understanding/router.ts`

- [x] **Step 1: Write failing tests**

Tests should import `routeIncomingMessage` and assert:

```ts
expect(routeIncomingMessage(questionMessage)).toEqual({
  kind: "ask",
  question: "老师电话是多少",
});

expect(routeIncomingMessage(passiveMessage)).toEqual({
  kind: "remember",
  text: "老师电话 138",
});

expect(routeIncomingMessage(emptyQuestion)).toEqual({
  kind: "ignore",
  reason: "empty_message",
});
```

- [x] **Step 2: Run red**

Run: `bun test packages/homeagent/src/understanding/router.test.ts`

Expected: FAIL because `router.ts` does not exist.

- [x] **Step 3: Implement router**

Create `routeIncomingMessage(msg: IncomingMessage): MessageRoute`. Trim text. `mentionsBot` routes to `ask`; non-empty passive text routes to `remember`; empty messages route to `ignore`.

- [x] **Step 4: Run green**

Run: `bun test packages/homeagent/src/understanding/router.test.ts`

Expected: PASS.

### Task 2: Runtime

**Files:**
- Create: `packages/homeagent/src/runtime.test.ts`
- Create: `packages/homeagent/src/runtime.ts`

- [x] **Step 1: Write failing tests**

Tests should use a fake `Connector` and fake `Homebrain` subset. Assert:

```ts
await runRuntime({ connector, brain });
expect(brain.rememberCalls).toEqual([{ member: { slug: "local" }, text: "老师电话 138" }]);
expect(connector.sent).toEqual([{ channelId: "cli", text: "138" }]);
```

Also assert ignored messages do not call brain or send output.

- [x] **Step 2: Run red**

Run: `bun test packages/homeagent/src/runtime.test.ts`

Expected: FAIL because `runtime.ts` does not exist.

- [x] **Step 3: Implement runtime**

Create:

```ts
export async function runRuntime(opts: RuntimeOptions): Promise<void>;
export async function handleIncomingMessage(opts: RuntimeOptions, msg: IncomingMessage): Promise<void>;
```

Use `routeIncomingMessage()`. For `ask`, call `brain.ask({ question })` and send the answer. For `remember`, call `brain.remember({ member, text })`. Default member slug is `msg.senderId`.

- [x] **Step 4: Run green**

Run: `bun test packages/homeagent/src/runtime.test.ts`

Expected: PASS.

### Task 3: Entry Point Wiring

**Files:**
- Modify: `packages/homeagent/src/index.ts`

- [x] **Step 1: Wire runtime**

Import `createHomebrain` and `runRuntime`. Build `brain` from config and call `runRuntime({ connector, brain })`.

- [x] **Step 2: Run verification**

Run:

```bash
bun test
bun run typecheck
```

Expected: all tests pass and typecheck exits 0.

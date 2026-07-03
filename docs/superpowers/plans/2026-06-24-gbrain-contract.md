# Gbrain Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Concentrate gbrain CLI command construction, JSON parsing, and error handling behind a tested contract module before Slice 1 depends on it.

**Architecture:** `packages/homebrain/src/gbrainCli.ts` becomes the local contract module for the external gbrain executable. `packages/homebrain/src/index.ts` keeps the family-memory `Homebrain` interface and delegates CLI details to the contract module.

**Tech Stack:** TypeScript, Bun, `bun:test`, existing Bun workspace.

---

## File Structure

- Create `packages/homebrain/src/gbrainCli.ts`: gbrain CLI runner, command helpers, JSON parser, normalized query/search outputs, and contract-level errors.
- Create `packages/homebrain/src/gbrainCli.test.ts`: fake-runner tests for command construction, parsing, defaults, and error messages.
- Modify `packages/homebrain/src/index.ts`: replace local `runGbrain`/`parseJson` helpers with `createBunGbrainRunner` and `createGbrainCliContract`.
- Modify `docs/implementation-plan.md`: make Slice 0 explicitly produce executable contract tests and captured output fixtures.

### Task 1: Add gbrain CLI Contract Tests

**Files:**
- Create: `packages/homebrain/src/gbrainCli.test.ts`

- [x] **Step 1: Write the failing tests**

Create `packages/homebrain/src/gbrainCli.test.ts` with tests that import `createGbrainCliContract`, `formatGbrainError`, and a fake runner. Cover:

```ts
import { expect, test } from "bun:test";
import {
  createGbrainCliContract,
  formatGbrainError,
  type GbrainCliResult,
  type GbrainRun,
} from "./gbrainCli";

function fakeRunner(
  handler: (args: string[], input?: string) => GbrainCliResult | Promise<GbrainCliResult>,
): GbrainRun {
  return (args, input) => Promise.resolve(handler(args, input));
}

test("captureText sends capture command with source and parses JSON", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args, input) => {
      calls.push({ args, input });
      return { ok: true, stdout: "{\"id\":\"mem_1\"}", stderr: "", exitCode: 0 };
    }),
  });

  expect(await cli.captureText("老师电话 138")).toEqual({ id: "mem_1" });
  expect(calls).toEqual([
    { args: ["capture", "老师电话 138", "--source", "default", "--json"], input: undefined },
  ]);
});

test("query returns answer and defaults missing citations to empty array", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args) => {
      expect(args).toEqual(["query", "老师电话是多少", "--json"]);
      return { ok: true, stdout: "{\"answer\":\"138\"}", stderr: "", exitCode: 0 };
    }),
  });

  expect(await cli.query("老师电话是多少")).toEqual({ answer: "138", citations: [] });
});

test("search passes limit when present", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args) => {
      expect(args).toEqual(["search", "老师", "--json", "--limit", "3"]);
      return {
        ok: true,
        stdout: "[{\"slug\":\"kid\",\"title\":\"老师\",\"snippet\":\"电话\",\"score\":0.9}]",
        stderr: "",
        exitCode: 0,
      };
    }),
  });

  expect(await cli.search("老师", 3)).toEqual([
    { slug: "kid", title: "老师", snippet: "电话", score: 0.9 },
  ]);
});

test("sync returns combined log without parsing JSON", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args) => {
      expect(args).toEqual(["sync", "--source", "default"]);
      return { ok: true, stdout: "synced", stderr: "", exitCode: 0 };
    }),
  });

  expect(await cli.sync()).toEqual({ ok: true, log: "synced" });
});

test("formatGbrainError includes label, exit code, and command output", () => {
  const message = formatGbrainError("query", {
    ok: false,
    stdout: "bad stdout",
    stderr: "bad stderr",
    exitCode: 12,
  });

  expect(message).toContain("query 失败");
  expect(message).toContain("exit 12");
  expect(message).toContain("bad stderr");
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/homebrain/src/gbrainCli.test.ts`

Expected: FAIL because `./gbrainCli` does not exist.

### Task 2: Implement gbrain CLI Contract Module

**Files:**
- Create: `packages/homebrain/src/gbrainCli.ts`

- [x] **Step 1: Add the minimal implementation**

Create `packages/homebrain/src/gbrainCli.ts` with:

```ts
export interface Citation {
  slug: string;
  title?: string;
}

export interface SearchHit {
  slug: string;
  title?: string;
  snippet?: string;
  score?: number;
}

export interface GbrainCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GbrainRun = (args: string[], input?: string) => Promise<GbrainCliResult>;

export interface GbrainCliContract {
  captureText(text: string): Promise<unknown>;
  query(question: string): Promise<{ answer: string; citations: Citation[] }>;
  search(query: string, limit?: number): Promise<SearchHit[]>;
  sync(): Promise<{ ok: boolean; log?: string }>;
  version(): Promise<{ ok: boolean; version?: string }>;
}
```

Then implement `createBunGbrainRunner`, `createGbrainCliContract`, `parseGbrainJson`, and `formatGbrainError`.

- [x] **Step 2: Run tests to verify they pass**

Run: `bun test packages/homebrain/src/gbrainCli.test.ts`

Expected: PASS.

### Task 3: Wire Homebrain Through Contract Module

**Files:**
- Modify: `packages/homebrain/src/index.ts`

- [x] **Step 1: Replace local helpers**

Import from `./gbrainCli`:

```ts
import { createBunGbrainRunner, createGbrainCliContract, type Citation } from "./gbrainCli";
```

Inside `createHomebrain`, construct:

```ts
const cli = createGbrainCliContract({
  source,
  run: createBunGbrainRunner({ bin, brainDir: config.brainDir }),
});
```

Replace `runGbrain`/`parseJson` call sites with `cli.captureText`, `cli.query`, `cli.search`, `cli.sync`, and `cli.version`.

- [x] **Step 2: Run all tests**

Run: `bun test`

Expected: all tests pass.

### Task 4: Update Slice 0 Documentation

**Files:**
- Modify: `docs/implementation-plan.md`

- [x] **Step 1: Make Slice 0 executable**

Update Slice 0 output from `"gbrain 真实能力确认清单"` to include:

- captured command output fixtures for `capture`, `query`, `search`, `sync`, `doctor`, and dream-cycle commands
- contract tests around `--json` output shape
- explicit fallback decision when a command is not available on PGLite

- [x] **Step 2: Run docs-adjacent verification**

Run: `bun run typecheck`

Expected: PASS.

### Task 5: Final Verification

**Files:**
- All changed files

- [x] **Step 1: Run full verification**

Run:

```bash
bun test
bun run typecheck
```

Expected: `9+` tests pass and typecheck exits 0.

- [x] **Step 2: Inspect diff**

Run: `git diff --stat && git diff -- packages/homebrain/src/index.ts packages/homebrain/src/gbrainCli.ts docs/implementation-plan.md`

Expected: changes are limited to the contract module, Homebrain wiring, docs, and this plan.

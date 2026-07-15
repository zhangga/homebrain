# Feishu External Sharing Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guided Feishu external-sharing release flow that starts after bot creation, records per-app progress, and verifies success from a real external-group message.

**Architecture:** Keep application creation on the official Feishu SDK path, because Feishu exposes external-sharing switches only in the version publishing console and not in the SDK manifest. Persist a small per-app guide state, identify external chats through the read-only `im chats get` API, and let setup advance only after a message received after verification started comes from an external group; users may explicitly keep the bot internal-only.

**Tech Stack:** TypeScript, Bun test runner, Hono web routes, `lark-cli`, server-rendered HTML.

---

## File map

- `packages/shared/src/config.ts`: persist the external-sharing guide state and bind it to the current Feishu app id.
- `packages/shared/src/config.test.ts`: prove settings round-trip and app-specific fields survive reload.
- `packages/connectors/src/lark-setup.ts`: expose a read-only external-chat probe through the existing command runner seam.
- `packages/connectors/src/lark-setup.test.ts`: prove the exact safe CLI command and fail-closed parsing.
- `packages/web/src/external-sharing.ts`: own the guide state type, console URL, and transition rules.
- `packages/web/src/external-sharing.test.ts`: unit-test state isolation across app replacements.
- `packages/web/src/integrations.ts`: add the external-chat probe to the web setup port.
- `packages/web/src/app.ts`: start/skip routes and verification against post-start group messages.
- `packages/web/src/app.test.ts`: exercise the public HTTP workflow without creating or modifying a real Feishu app.
- `packages/web/src/setup.ts`: insert the publish/verify step into onboarding.
- `packages/web/src/setup.test.ts`: lock down setup ordering before and after restart.
- `packages/web/src/setup-view.ts`: render publish instructions, controls, and verification status.
- `packages/web/src/setup-view.test.ts`: verify safe links and user-facing actions.
- `packages/web/src/views.ts`: show the same state in Integrations for later re-entry.
- `README.md`: document Feishu's unavoidable admin publishing boundary and HomeAgent's verification behavior.

### Task 1: Persist app-scoped external-sharing progress

**Files:**
- Modify: `packages/shared/src/config.ts`
- Test: `packages/shared/src/config.test.ts`

- [ ] **Step 1: Write the failing settings round-trip test**

Add a test that saves and reloads these exact fields:

```ts
saveSettings({
  feishuExternalSharingAppId: "cli_external",
  feishuExternalSharingStartedAt: 100,
  feishuExternalSharingVerifiedAt: 200,
  feishuExternalSharingVerifiedChatId: "oc_external",
  feishuExternalSharingSkippedAppId: "",
}, dataDir);
const loaded = loadConfig({ HOMEAGENT_DATA_DIR: dataDir });
expect(loaded.feishuExternalSharingAppId).toBe("cli_external");
expect(loaded.feishuExternalSharingVerifiedChatId).toBe("oc_external");
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `bun test packages/shared/src/config.test.ts`

Expected: FAIL because the new settings are not part of `PersistedSettings` or `Config`.

- [ ] **Step 3: Add the persisted fields**

Add these optional fields to `Config` and `PersistedSettings`, add their keys to `EDITABLE_KEYS`, initialize them in `base`, and overlay finite timestamps plus cleared optional strings:

```ts
feishuExternalSharingAppId?: string;
feishuExternalSharingStartedAt?: number;
feishuExternalSharingVerifiedAt?: number;
feishuExternalSharingVerifiedChatId?: string;
feishuExternalSharingSkippedAppId?: string;
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run: `bun test packages/shared/src/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the persisted state**

```bash
git add packages/shared/src/config.ts packages/shared/src/config.test.ts
git commit -m "feat: persist Feishu external sharing progress"
```

### Task 2: Detect external groups through the read-only Feishu API

**Files:**
- Modify: `packages/connectors/src/lark-setup.ts`
- Test: `packages/connectors/src/lark-setup.test.ts`
- Modify: `packages/web/src/integrations.ts`

- [ ] **Step 1: Write failing external-chat probe tests**

Exercise the command-runner seam with an envelope response and a malformed response:

```ts
const setup = new LarkCliSetup({ runner });
expect(await setup.chatIsExternal("oc_external")).toBeTrue();
expect(calls[0]).toEqual({
  argv: ["lark-cli", "im", "chats", "get", "--chat-id", "oc_external", "--as", "bot", "--json"],
  timeoutMs: 15_000,
});
expect(await malformedSetup.chatIsExternal("oc_unknown")).toBeFalse();
```

- [ ] **Step 2: Run the connector test and confirm it fails**

Run: `bun test packages/connectors/src/lark-setup.test.ts`

Expected: FAIL because `chatIsExternal` is missing.

- [ ] **Step 3: Implement a fail-closed probe**

Add a public method that trims the chat id, rejects empty ids without invoking the runner, executes only the exact command above, accepts both `{ data: { external: true } }` and `{ external: true }`, and returns `false` on command failure, invalid JSON, or a missing boolean. Add the same method to `LarkSetupPort`:

```ts
chatIsExternal?(chatId: string): Promise<boolean>;
```

- [ ] **Step 4: Run connector tests and confirm they pass**

Run: `bun test packages/connectors/src/lark-setup.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the external-group probe**

```bash
git add packages/connectors/src/lark-setup.ts packages/connectors/src/lark-setup.test.ts packages/web/src/integrations.ts
git commit -m "feat: detect Feishu external groups"
```

### Task 3: Model and expose the guided verification workflow

**Files:**
- Create: `packages/web/src/external-sharing.ts`
- Create: `packages/web/src/external-sharing.test.ts`
- Modify: `packages/web/src/app.ts`
- Test: `packages/web/src/app.test.ts`

- [ ] **Step 1: Write failing state and HTTP tests**

Cover these observable cases:

```ts
expect(resolveExternalSharingState(config, "cli_new").state).toBe("not_started");
expect(resolveExternalSharingState({ ...config, feishuExternalSharingSkippedAppId: "cli_new" }, "cli_new").state).toBe("skipped");
expect(resolveExternalSharingState({ ...config, feishuExternalSharingVerifiedAt: 200 }, "cli_other").state).toBe("not_started");
```

At the HTTP seam, POST start, assert redirect and persisted app id/start time, add a raw group message created after the start time, return `true` from `chatIsExternal`, GET setup, and assert verification time/chat id are persisted. Also POST skip and assert the current app is marked internal-only.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test packages/web/src/external-sharing.test.ts packages/web/src/app.test.ts`

Expected: FAIL because the state helper and routes do not exist.

- [ ] **Step 3: Add the focused state module**

Define exactly these states and build only a validated Feishu app-console root URL:

```ts
export type FeishuExternalSharingState =
  | "not_started"
  | "awaiting_external_message"
  | "verified"
  | "skipped";

export interface FeishuExternalSharingStatus {
  state: FeishuExternalSharingState;
  appId?: string;
  consoleUrl?: string;
  startedAt?: number;
  verifiedAt?: number;
  verifiedChatId?: string;
  verifiedGroupName?: string;
}
```

Treat stored progress as valid only when `feishuExternalSharingAppId` matches the current app id; treat skip as valid only when `feishuExternalSharingSkippedAppId` matches.

- [ ] **Step 4: Add start, skip, and read-time verification**

Implement:

```text
POST /setup/feishu/external-sharing/start
POST /setup/feishu/external-sharing/skip
```

Start stores the current verified Feishu app id and current time, clearing prior verification and skip fields. Skip stores only the current app id as skipped. During setup/integrations reads, scan team spaces for raw `message` entries created at or after the start time, probe each distinct chat id using `chatIsExternal`, and persist the first verified chat id/time. Probe errors keep the state awaiting and never surface CLI diagnostics.

- [ ] **Step 5: Run web workflow tests and confirm they pass**

Run: `bun test packages/web/src/external-sharing.test.ts packages/web/src/app.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the workflow**

```bash
git add packages/web/src/external-sharing.ts packages/web/src/external-sharing.test.ts packages/web/src/app.ts packages/web/src/app.test.ts
git commit -m "feat: verify Feishu external sharing"
```

### Task 4: Insert the publish guide into setup and Integrations

**Files:**
- Modify: `packages/web/src/setup.ts`
- Test: `packages/web/src/setup.test.ts`
- Modify: `packages/web/src/setup-view.ts`
- Test: `packages/web/src/setup-view.test.ts`
- Modify: `packages/web/src/views.ts`
- Test: `packages/web/src/views.test.ts`

- [ ] **Step 1: Write failing setup-order tests**

Assert this state order:

```ts
// Ready bot, guide not started: publish first.
expect(buildSetupSnapshot({ ...readyInput, externalSharing: "not_started" }).current).toBe("external_share");
// Publishing submitted, restart still required: activate runtime.
expect(buildSetupSnapshot({ ...readyInput, externalSharing: "awaiting_external_message" }).current).toBe("activate");
// Runtime active, waiting for a real external message: return to verification.
expect(buildSetupSnapshot({ ...activeInput, externalSharing: "awaiting_external_message" }).current).toBe("external_share");
// Verified or intentionally skipped: continue to group invite.
expect(buildSetupSnapshot({ ...activeInput, externalSharing: "verified" }).current).toBe("invite");
```

- [ ] **Step 2: Run setup/view tests and confirm they fail**

Run: `bun test packages/web/src/setup.test.ts packages/web/src/setup-view.test.ts packages/web/src/views.test.ts`

Expected: FAIL because `external_share` and its controls are missing.

- [ ] **Step 3: Implement setup ordering**

Add `external_share` to `SetupStep` and use the order `ai → feishu → external_share → activate → invite → done`. Choose `external_share` before activation when state is `not_started`, choose activation while state is awaiting and runtime is stale, then return to `external_share` once runtime is ready until verified.

- [ ] **Step 4: Render the guide and re-entry card**

The guide must state all three unavoidable Feishu actions:

1. Open Application Publishing → Version Management & Publishing → Create Version.
2. Enable “允许机器人被添加到外部群中使用” and “允许外部用户与机器人单聊”.
3. Save, submit the release, and complete administrator approval.

Render the validated app-console link, start-verification form, internal-only skip form, and—while awaiting—the instruction to add the bot to an external group and send `@机器人 对外共享测试`. Render verified chat/group details without trusting HTML. Show the same status and restart path on `/integrations`.

- [ ] **Step 5: Run setup/view tests and confirm they pass**

Run: `bun test packages/web/src/setup.test.ts packages/web/src/setup-view.test.ts packages/web/src/views.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the UI**

```bash
git add packages/web/src/setup.ts packages/web/src/setup.test.ts packages/web/src/setup-view.ts packages/web/src/setup-view.test.ts packages/web/src/views.ts packages/web/src/views.test.ts
git commit -m "feat: guide Feishu external sharing setup"
```

### Task 5: Document and release-gate the feature

**Files:**
- Modify: `README.md`
- Verify: all touched packages

- [ ] **Step 1: Document the platform boundary**

Explain that HomeAgent requests supported permissions/events at creation time, but Feishu currently requires external-sharing switches, version submission, and admin approval in the developer console. Document that HomeAgent links directly to the current app, stores state per app, and verifies only from a post-start external-group message.

- [ ] **Step 2: Run the focused suite**

Run:

```bash
bun test packages/shared/src/config.test.ts packages/connectors/src/lark-setup.test.ts packages/web/src/external-sharing.test.ts packages/web/src/setup.test.ts packages/web/src/setup-view.test.ts packages/web/src/views.test.ts packages/web/src/app.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run repository checks**

Run:

```bash
bun run typecheck
bun test
```

Expected: typecheck exits 0 and all tests pass. No real app creation, permission mutation, publishing, or external message send occurs in tests.

- [ ] **Step 4: Review the diff and commit**

```bash
git diff --check
git status --short
git add README.md
git commit -m "docs: explain Feishu external sharing setup"
```

Expected: clean diff checks and only intentional files changed.

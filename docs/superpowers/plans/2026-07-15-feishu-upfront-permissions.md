# Feishu Upfront Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HomeAgent's first Feishu app-creation confirmation explicitly request every permission and event the product uses, and refuse to report success until both required event consumers are provisioned.

**Architecture:** Replace the implicit `lark-cli config init --new` preset dependency with Feishu's official Node SDK `registerApp`, using `createOnly: true` and a HomeAgent-owned additive `addons` manifest. Keep `lark-cli` as the credential store and runtime API client by passing the returned secret through stdin only. After creation, run bounded event-consumer probes; if Feishu still omits an event, keep the same provisioning session active and expose the official incremental authorization link instead of sending the user to the developer console.

**Tech Stack:** Bun, TypeScript, `@larksuiteoapi/node-sdk` 1.71.1+, lark-cli 1.0.69, Hono, bun:test

---

## File Structure

- Create `packages/connectors/src/lark-app-registration.ts`: official SDK adapter and the audited HomeAgent permission/event manifest.
- Create `packages/connectors/src/lark-app-registration.test.ts`: public registration-option contract tests.
- Modify `packages/connectors/src/lark-setup.ts`: registration state machine, stdin credential handoff, bounded event verification, and official repair-link handling.
- Modify `packages/connectors/src/lark-setup.test.ts`: end-to-end setup-state tests through the public `LarkCliSetup` API.
- Modify `packages/connectors/src/index.ts`: export the registration seam for assembly/tests.
- Modify `packages/connectors/package.json` and `bun.lock`: add the official SDK dependency.
- Modify `packages/web/src/setup-view.ts`, `packages/web/src/views.ts`, and their tests: explain upfront permissions/admin approval and never claim success before verification.
- Modify `README.md`: document explicit permissions, sensitive group-message approval, and completion semantics.

### Task 1: Official SDK registration manifest

**Files:**
- Create: `packages/connectors/src/lark-app-registration.ts`
- Create: `packages/connectors/src/lark-app-registration.test.ts`
- Modify: `packages/connectors/src/index.ts`
- Modify: `packages/connectors/package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Write the failing manifest test**

Assert an independently written literal list for the HomeAgent tenant scopes:

```ts
expect(HOMEAGENT_FEISHU_ADDONS).toEqual({
  preset: true,
  scopes: {
    tenant: [
      "application:bot.basic_info:read",
      "im:chat.members:bot_access",
      "im:chat:read",
      "im:message.group_at_msg.include_bot:readonly",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message.reactions:write_only",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource",
      "drive:drive.metadata:readonly",
      "docx:document:readonly",
      "wiki:node:read",
    ],
    user: ["offline_access"],
  },
  events: {
    items: {
      tenant: ["im.message.receive_v1", "im.chat.member.bot.added_v1"],
    },
  },
});
```

Also inject a fake `registerApp` function and assert the adapter sends `createOnly: true`, `source: "homeagent"`, the complete addons object, an app name/description preset, and an abort signal. Assert that the returned App Secret is available only on the internal result object, not on the URL callback payload.

- [ ] **Step 2: Run the registration test and verify RED**

Run:

```bash
bun test packages/connectors/src/lark-app-registration.test.ts
```

Expected: FAIL because the module and manifest do not exist.

- [ ] **Step 3: Add the official SDK and minimal adapter**

Add `@larksuiteoapi/node-sdk` to `@homeagent/connectors`. Implement:

```ts
export const HOMEAGENT_FEISHU_ADDONS = { /* exact audited literal */ } as const;

export interface LarkAppRegistrar {
  register(input: {
    brand: "feishu" | "lark";
    signal: AbortSignal;
    onVerificationUrl(info: { url: string; expiresInSeconds: number }): void;
  }): Promise<{
    appId: string;
    appSecret: string;
    brand: "feishu" | "lark";
  }>;
}

export function createLarkAppRegistrar(
  register: typeof registerApp = registerApp,
): LarkAppRegistrar { /* call registerApp with createOnly + addons */ }
```

Use the SDK's standard Feishu/Lark domains and let `user_info.tenant_brand` determine the returned brand when present.

- [ ] **Step 4: Run the registration test and verify GREEN**

Run:

```bash
bun test packages/connectors/src/lark-app-registration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the registration boundary**

```bash
git add packages/connectors/package.json bun.lock packages/connectors/src/lark-app-registration.ts packages/connectors/src/lark-app-registration.test.ts packages/connectors/src/index.ts
git commit -m "feat: request HomeAgent Feishu permissions upfront"
```

### Task 2: SDK-backed creation and secure credential handoff

**Files:**
- Modify: `packages/connectors/src/lark-setup.ts`
- Modify: `packages/connectors/src/lark-setup.test.ts`

- [ ] **Step 1: Write the failing SDK creation test**

Through `LarkCliSetup.startAutomatic("feishu")`, inject a fake registrar that emits an official launcher URL and later resolves `{ appId, appSecret, brand }`. Assert:

- the first returned session is `waiting_for_user` and contains only the safe URL;
- duplicate starts reuse the same session;
- after authorization, `lark-cli config init --app-id ... --app-secret-stdin --brand ...` is invoked;
- the secret appears only in the command stdin and never in argv, session JSON, messages, or thrown errors;
- cancellation/expiry aborts the SDK flow.

- [ ] **Step 2: Run the setup test and verify RED**

Run:

```bash
bun test packages/connectors/src/lark-setup.test.ts
```

Expected: FAIL because setup still spawns `lark-cli config init --new`.

- [ ] **Step 3: Replace the implicit CLI preset path**

Inject `LarkAppRegistrar` into `LarkCliSetupOptions`. Start registration in the background, update the existing `LarkProvisioningSession` from its QR callback, use the existing bounded TTL, and call a private credential configuration function that passes `${appSecret}\n` via stdin. Preserve the public safe error messages and never persist the secret in a class field.

- [ ] **Step 4: Run setup tests and verify GREEN**

Run:

```bash
bun test packages/connectors/src/lark-setup.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the creation state machine**

```bash
git add packages/connectors/src/lark-setup.ts packages/connectors/src/lark-setup.test.ts
git commit -m "refactor: create Feishu apps through official SDK"
```

### Task 3: Completion gate and in-flow repair

**Files:**
- Modify: `packages/connectors/src/lark-setup.ts`
- Modify: `packages/connectors/src/lark-setup.test.ts`

- [ ] **Step 1: Write the failing completion-gate tests**

Add two public state-machine tests:

1. Both bounded commands below succeed, so provisioning reaches `ready`:

```text
lark-cli event consume im.message.receive_v1 --as bot --timeout 1s
lark-cli event consume im.chat.member.bot.added_v1 --as bot --timeout 1s
```

2. The bot-added probe returns a failed-precondition payload with an official `open.feishu.cn/page/launcher?...` hint. Provisioning must remain `waiting_for_user`, replace the URL with that safe repair link, show “请确认完整权限和事件订阅”, poll the missing event, and become `ready` only after a later probe succeeds.

Assert that untrusted URLs and raw CLI output are never surfaced.

- [ ] **Step 2: Run setup tests and verify RED**

Run:

```bash
bun test packages/connectors/src/lark-setup.test.ts
```

Expected: FAIL because bot identity verification alone currently marks provisioning ready.

- [ ] **Step 3: Implement bounded event verification**

Add constants for the two required event keys and a helper returning `{ ready, repairUrl? }`. Probe with a short CLI timeout and a longer process deadline. Parse only the existing strict official launcher URL pattern. If a repair URL exists, retain the active provisioning TTL and poll only until both event probes pass; otherwise fail with a fixed public message.

- [ ] **Step 4: Run setup tests and verify GREEN**

Run:

```bash
bun test packages/connectors/src/lark-setup.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the completion gate**

```bash
git add packages/connectors/src/lark-setup.ts packages/connectors/src/lark-setup.test.ts
git commit -m "fix: verify Feishu events before setup completes"
```

### Task 4: User-facing authorization contract

**Files:**
- Modify: `packages/web/src/setup-view.ts`
- Modify: `packages/web/src/setup-view.test.ts`
- Modify: `packages/web/src/views.ts`
- Modify: `packages/web/src/app.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing UI tests**

Assert onboarding and Integrations explain that the first Feishu confirmation includes messaging, group membership, reactions, attachments, and both event subscriptions. The text must state that `im:message.group_msg` may need enterprise-admin approval during creation, while no developer-console configuration is expected afterward. For a repair session, assert the same “打开飞书并确认” action is rendered inside the active creation flow.

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```bash
bun test packages/web/src/setup-view.test.ts packages/web/src/app.test.ts
```

Expected: FAIL on the new copy assertions.

- [ ] **Step 3: Update the UI and docs**

Keep the page compact. Explain the upfront authorization next to the primary action, remove claims that all-group messages require a later manual developer-console step, and clarify that enterprise approval can still appear on the initial Feishu confirmation page. Update README with the exact manifest and the event completion gate.

- [ ] **Step 4: Run UI tests and verify GREEN**

Run:

```bash
bun test packages/web/src/setup-view.test.ts packages/web/src/app.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the user contract**

```bash
git add packages/web/src/setup-view.ts packages/web/src/setup-view.test.ts packages/web/src/views.ts packages/web/src/app.test.ts README.md
git commit -m "docs: explain upfront Feishu authorization"
```

### Task 5: Release verification

**Files:**
- Test only; no production changes expected.

- [ ] **Step 1: Run focused tests**

```bash
bun test packages/connectors/src/lark-app-registration.test.ts packages/connectors/src/lark-setup.test.ts packages/web/src/verification-url.test.ts packages/web/src/feishu-provisioning-view.test.ts packages/web/src/setup-view.test.ts packages/web/src/app.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run typecheck and full test suite**

```bash
bun run typecheck
bun test
```

Expected: typecheck succeeds; non-live tests pass; existing live tests remain skipped unless explicitly enabled.

- [ ] **Step 3: Check secrets, formatting, and worktree**

```bash
git diff --check main...HEAD
git diff main...HEAD | rg -n -i "app[_ -]?secret|tenant[_ -]?access[_ -]?token|bearer |private[_ -]?key|password"
git status --short
```

Expected: only documentation, password inputs, stdin assertions, and fake test secrets match; no real credential or uncommitted file remains.

- [ ] **Step 4: Verify the real current app without mutation**

Run `lark-cli auth status --json --verify` and `lark-cli event status` only. Do not create another app or change permissions during automated verification. The user's existing bot may remain down until they complete its already-generated incremental authorization link and restart.

## Self-Review

- Spec coverage: the plan explicitly requests all runtime-required permissions/events on the first confirmation, includes the sensitive all-group-message permission, gates success on real event readiness, preserves stdin-only secret handling, and keeps a no-console recovery path.
- Placeholder scan: no TBD/TODO/“similar to” steps remain; every code-changing task names exact files, commands, and observable results.
- Type consistency: `LarkAppRegistrar.register` returns `{ appId, appSecret, brand }`; `LarkCliSetup` consumes the same names; public web contracts remain `LarkProvisioningSession` and do not acquire secret fields.

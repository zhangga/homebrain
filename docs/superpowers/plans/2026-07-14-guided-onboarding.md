# Guided Onboarding and Automatic Feishu Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a fresh Homebrain process into a resumable, browser-led setup that connects an AI CLI, creates and configures a Feishu/Lark bot through `lark-cli config init --new`, activates event listeners, and verifies the first real group message.

**Architecture:** Add a single in-memory provisioning session to the connector boundary, expose only a bounded allow-listed verification URL to the web package, and derive a five-step setup snapshot from persisted settings plus live provider/Lark/runtime state. Keep manual App ID/App Secret configuration as an advanced fallback, but make one-click browser authorization the primary route.

**Tech Stack:** Bun/TypeScript, Hono server-rendered HTML, `lark-cli` 1.0.68+, macOS LaunchAgent, Bun test.

---

## Product and visual contract

- Primary journey: `选择 AI → 创建飞书机器人 → 激活监听 → 加入群聊 → 完成`.
- One primary button per screen. Technical details live under an “高级设置” disclosure.
- The setup shell does not show the eight-item admin navigation. It uses warm paper, deep ink, moss green, a vertical progress thread, and large editorial typography (`Iowan Old Style`/`Songti SC` for headings; `Avenir Next`/`PingFang SC` for body).
- The memorable device is a “memory thread”: each completed setup checkpoint becomes a filled node connected to the next action.
- Never expose raw CLI stderr, App Secret, device code, or arbitrary URLs to the browser.
- The browser authorization pattern follows current ChatGPT/Claude connector behavior: one Connect action, external authorization, automatic status refresh, then a real usage check.
- `lark-cli config init --new --brand feishu --lang zh` is the supported automatic path. It emits an `open.feishu.cn/page/cli` or `open.larksuite.com/page/cli` URL, blocks for at most ten minutes, stores the resulting secret in its own credential store, and exits after verification.
- Feishu administrator approval or publication remains visible as an explicit platform-owned checkpoint when the runtime consumers cannot become ready.

## File structure

- Create `packages/web/src/setup.ts`: pure setup-state derivation and redirect policy.
- Create `packages/web/src/setup-view.ts`: dedicated setup shell and five setup steps.
- Modify `packages/shared/src/lark.ts`: automatic provisioning value contracts.
- Modify `packages/shared/src/config.ts`: persist setup completion only.
- Modify `packages/connectors/src/lark-setup.ts`: bounded, single-session `lark-cli --new` orchestration.
- Modify `packages/web/src/integrations.ts`: expose automatic provisioning through the existing port.
- Modify `packages/web/src/app.ts`: setup routes, polling endpoint, completion, restart and first-run redirect.
- Modify `packages/app/src/main.ts`: wire automatic provisioning and safe service restart.
- Modify `packages/web/src/layout.ts`: show a compact “继续设置” affordance after onboarding, without restyling all admin screens in this slice.
- Modify `README.md`: replace the manual-first instructions with the guided flow.

### Task 1: Define safe provisioning and completion contracts

**Files:**
- Modify: `packages/shared/src/lark.ts`
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/config.test.ts`

- [ ] **Step 1: Write the failing config persistence test**

Add to `packages/shared/src/config.test.ts`:

```ts
test("persists onboarding completion independently of editable setup choices", () => {
  saveSettings({ onboardingCompletedAt: 1_784_000_000_000 }, dir);
  const cfg = loadConfig();
  expect(cfg.onboardingCompletedAt).toBe(1_784_000_000_000);
  expect(readSettings(dir).onboardingCompletedAt).toBe(1_784_000_000_000);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
bun test packages/shared/src/config.test.ts
```

Expected: TypeScript/test failure because `onboardingCompletedAt` is not part of `PersistedSettings` or `Config`.

- [ ] **Step 3: Add the contracts**

Append to `packages/shared/src/lark.ts`:

```ts
export type LarkProvisioningState =
  | "idle"
  | "starting"
  | "waiting_for_user"
  | "verifying"
  | "ready"
  | "failed"
  | "expired";

export interface LarkProvisioningSession {
  state: LarkProvisioningState;
  brand: "feishu" | "lark";
  verificationUrl?: string;
  startedAt?: number;
  expiresAt?: number;
  message: string;
}
```

Add these fields to `Config` and `PersistedSettings` in `packages/shared/src/config.ts`:

```ts
onboardingCompletedAt?: number;
```

Add `"onboardingCompletedAt"` to `EDITABLE_KEYS`, initialize it from the environment as `undefined`, overlay a finite persisted value, and leave it absent from the Settings form.

- [ ] **Step 4: Run focused tests**

Run:

```bash
bun test packages/shared/src/config.test.ts
```

Expected: all shared config tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/lark.ts packages/shared/src/config.ts packages/shared/src/config.test.ts
git commit -m "feat: add onboarding provisioning contracts"
```

### Task 2: Run one automatic Feishu provisioning session safely

**Files:**
- Modify: `packages/connectors/src/lark-setup.ts`
- Modify: `packages/connectors/src/lark-setup.test.ts`

- [ ] **Step 1: Write failing session tests**

Add a fake streaming process to `packages/connectors/src/lark-setup.test.ts` and cover the allow-listed URL, successful completion, duplicate start and failure paths:

```ts
async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

test("starts one-click app provisioning and exposes only the verification URL", async () => {
  let spawned: string[] | undefined;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const setup = new LarkCliSetup({
    provisioningSpawner: {
      spawn(argv) {
        spawned = argv;
        return {
          stdout: chunks(""),
          stderr: chunks(
            "Open the link below to configure app:\n",
            "https://open.feishu.cn/page/cli?user_code=SAFE-CODE&from=cli\n",
          ),
          exited,
          kill: () => resolveExit(143),
        };
      },
    },
  });

  const session = await setup.startAutomatic("feishu");
  expect(spawned).toEqual([
    "lark-cli", "config", "init", "--new", "--brand", "feishu", "--lang", "zh",
  ]);
  expect(session.state).toBe("waiting_for_user");
  expect(session.verificationUrl).toStartWith("https://open.feishu.cn/page/cli?");
  expect(JSON.stringify(session)).not.toContain("SAFE-CODE\n");
  resolveExit(0);
});

test("rejects an untrusted URL emitted by the child process", async () => {
  const setup = new LarkCliSetup({
    provisioningSpawner: {
      spawn: () => ({
        stdout: chunks(""),
        stderr: chunks("https://attacker.example/page/cli?token=secret\n"),
        exited: Promise.resolve(1),
        kill: () => {},
      }),
    },
  });
  const session = await setup.startAutomatic("feishu");
  expect(session.verificationUrl).toBeUndefined();
  expect(["failed", "starting"]).toContain(session.state);
});
```

- [ ] **Step 2: Run the connector test and verify failure**

Run:

```bash
bun test packages/connectors/src/lark-setup.test.ts
```

Expected: failure because `provisioningSpawner`, `startAutomatic` and `provisioningStatus` do not exist.

- [ ] **Step 3: Add the process boundary and session manager**

Add to `packages/connectors/src/lark-setup.ts`:

```ts
export interface LarkProvisioningProcess {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface LarkProvisioningSpawner {
  spawn(argv: string[]): LarkProvisioningProcess;
}

const provisioningSpawner: LarkProvisioningSpawner = {
  spawn(argv) {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
      ...process.env,
      ...NO_NOTIFIER_ENV,
    } });
    return {
      stdout: proc.stdout as unknown as AsyncIterable<Uint8Array>,
      stderr: proc.stderr as unknown as AsyncIterable<Uint8Array>,
      exited: proc.exited,
      kill: () => proc.kill("SIGTERM"),
    };
  },
};

const VERIFICATION_URL = /https:\/\/(?:open\.feishu\.cn|open\.larksuite\.com)\/page\/cli\?[^\s<>'"]+/;
const PROVISIONING_TTL_MS = 10 * 60_000;
const URL_WAIT_MS = 15_000;
```

Extend `LarkCliSetupOptions` with `provisioningSpawner?: LarkProvisioningSpawner`. Keep one child and one immutable public session snapshot on the class. `startAutomatic()` must:

1. Return the existing session when its state is `starting`, `waiting_for_user`, or `verifying`.
2. Spawn `[larkBin, "config", "init", "--new", "--brand", brand, "--lang", "zh"]`.
3. Read stdout and stderr concurrently, keep at most the last 8 KiB internally, and copy only an allow-listed verification URL into the public session.
4. Race URL discovery, early process exit, and a 15-second URL deadline.
5. On exit `0`, set `verifying`, call `status()`, and set `ready` only when Bot identity verification succeeds.
6. Map expiry/timeout text to `expired`; map every other non-zero exit to the fixed message `飞书应用创建未完成，请重试`.
7. Never include captured CLI output in `LarkProvisioningSession.message`.

Expose:

```ts
provisioningStatus(): LarkProvisioningSession {
  return { ...this.provisioning };
}
```

- [ ] **Step 4: Add duplicate and ready-state assertions**

Extend the test so two calls while waiting return the same `startedAt`, only one process is spawned, and a zero exit followed by a ready `auth status` response changes the session to `ready`.

- [ ] **Step 5: Run connector tests**

Run:

```bash
bun test packages/connectors/src/lark-setup.test.ts packages/connectors/src/lark-setup.ts
```

Expected: all connector setup tests pass and no test output contains a fake credential.

- [ ] **Step 6: Commit**

```bash
git add packages/connectors/src/lark-setup.ts packages/connectors/src/lark-setup.test.ts
git commit -m "feat: provision Feishu apps from Homebrain"
```

### Task 3: Derive a resumable setup snapshot

**Files:**
- Create: `packages/web/src/setup.ts`
- Create: `packages/web/src/setup.test.ts`
- Modify: `packages/web/src/index.ts`

- [ ] **Step 1: Write the state-machine tests**

Create `packages/web/src/setup.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildSetupSnapshot } from "./setup.ts";

const provider = { id: "codex", name: "Codex", bin: "codex", available: true, detail: "0.144.1" };

describe("buildSetupSnapshot", () => {
  test("starts at AI when the selected provider is unavailable", () => {
    expect(buildSetupSnapshot({
      defaultProvider: "claude",
      providers: [provider],
      lark: { state: "unconfigured", verified: false, message: "missing" },
      runtime: { ready: false, consumers: [] },
      restartRequired: false,
      groups: 0,
      completedAt: undefined,
    }).current).toBe("ai");
  });

  test("advances through Feishu, activation and invite", () => {
    const base = {
      defaultProvider: "codex",
      providers: [provider],
      groups: 0,
      completedAt: undefined,
    };
    expect(buildSetupSnapshot({ ...base,
      lark: { state: "unconfigured", verified: false, message: "missing" },
      runtime: { ready: false, consumers: [] }, restartRequired: false,
    }).current).toBe("feishu");
    expect(buildSetupSnapshot({ ...base,
      lark: { state: "ready", verified: true, botName: "Homebrain", botOpenId: "ou_bot", message: "ready" },
      runtime: { ready: false, consumers: [] }, restartRequired: true,
    }).current).toBe("activate");
    expect(buildSetupSnapshot({ ...base,
      lark: { state: "ready", verified: true, botName: "Homebrain", botOpenId: "ou_bot", message: "ready" },
      runtime: { ready: true, consumers: [] }, restartRequired: false,
    }).current).toBe("invite");
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
bun test packages/web/src/setup.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the pure setup model**

Create `packages/web/src/setup.ts` with these public types and decision order:

```ts
import type { LarkSetupStatus } from "@homebrain/shared";
import type { DetectedProvider } from "@homebrain/llm";
import type { FeishuRuntimeStatus } from "./integrations.ts";

export type SetupStep = "ai" | "feishu" | "activate" | "invite" | "done";

export interface SetupSnapshot {
  current: SetupStep;
  completed: SetupStep[];
  selectedProviderReady: boolean;
  larkReady: boolean;
  runtimeReady: boolean;
  groupReady: boolean;
}

export interface SetupSnapshotInput {
  defaultProvider: string;
  providers: DetectedProvider[];
  lark: LarkSetupStatus;
  runtime: FeishuRuntimeStatus;
  restartRequired: boolean;
  groups: number;
  completedAt?: number;
}

export function buildSetupSnapshot(input: SetupSnapshotInput): SetupSnapshot {
  const selectedProviderReady = input.providers.some(
    (provider) => provider.id === input.defaultProvider && provider.available,
  );
  const larkReady = input.lark.state === "ready" && input.lark.verified;
  const runtimeReady = larkReady && !input.restartRequired && input.runtime.ready;
  const groupReady = input.groups > 0;
  const current: SetupStep = input.completedAt
    ? "done"
    : !selectedProviderReady
      ? "ai"
      : !larkReady
        ? "feishu"
        : !runtimeReady
          ? "activate"
          : !groupReady
            ? "invite"
            : "done";
  const order: SetupStep[] = ["ai", "feishu", "activate", "invite", "done"];
  return {
    current,
    completed: order.slice(0, Math.max(0, order.indexOf(current))),
    selectedProviderReady,
    larkReady,
    runtimeReady,
    groupReady,
  };
}
```

Export it from `packages/web/src/index.ts`.

- [ ] **Step 4: Run setup tests**

Run:

```bash
bun test packages/web/src/setup.test.ts
```

Expected: all state transitions pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/setup.ts packages/web/src/setup.test.ts packages/web/src/index.ts
git commit -m "feat: model resumable first-run setup"
```

### Task 4: Add setup ports and HTTP routes

**Files:**
- Modify: `packages/web/src/integrations.ts`
- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/app.test.ts`

- [ ] **Step 1: Write failing route tests**

Add tests to `packages/web/src/app.test.ts` for:

```ts
test("fresh installs redirect the dashboard to guided setup", async () => {
  const fresh = createWebApp({
    engine,
    detectProviders: async () => [],
    larkSetup: {
      status: async () => ({ state: "unconfigured", verified: false, message: "missing" }),
      configure: async () => { throw new Error("unused"); },
      startAutomatic: async () => ({ state: "waiting_for_user", brand: "feishu", verificationUrl: "https://open.feishu.cn/page/cli?user_code=x", message: "waiting" }),
      provisioningStatus: () => ({ state: "idle", brand: "feishu", message: "idle" }),
    },
  });
  const response = await fresh.request("/");
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/setup");
});

test("starts automatic Feishu setup and returns a pollable safe session", async () => {
  let starts = 0;
  const session = { state: "waiting_for_user" as const, brand: "feishu" as const,
    verificationUrl: "https://open.feishu.cn/page/cli?user_code=x", message: "waiting" };
  const setupApp = createWebApp({
    engine,
    larkSetup: {
      status: async () => ({ state: "unconfigured", verified: false, message: "missing" }),
      configure: async () => { throw new Error("unused"); },
      startAutomatic: async () => { starts += 1; return session; },
      provisioningStatus: () => session,
    },
  });
  expect((await setupApp.request("/setup/feishu/automatic", { method: "POST" })).status).toBe(302);
  expect(starts).toBe(1);
  const poll = await setupApp.request("/setup/feishu/session");
  expect(await poll.json()).toEqual(session);
});
```

- [ ] **Step 2: Run the focused route tests and verify failure**

Run:

```bash
bun test packages/web/src/app.test.ts
```

Expected: failures for missing port methods and setup routes.

- [ ] **Step 3: Extend the setup port**

Update `packages/web/src/integrations.ts`:

```ts
import type { LarkProvisioningSession, LarkSetupInput, LarkSetupStatus } from "@homebrain/shared";

export interface LarkSetupPort {
  status(): Promise<LarkSetupStatus>;
  configure(input: LarkSetupInput): Promise<LarkSetupStatus>;
  startAutomatic(brand: "feishu" | "lark"): Promise<LarkProvisioningSession>;
  provisioningStatus(): LarkProvisioningSession;
}
```

- [ ] **Step 4: Add setup state loading and routes**

In `packages/web/src/app.ts`, add a `getSetupSnapshot()` helper that loads providers, current Lark status, runtime state, restart requirement, team-space count and `config().onboardingCompletedAt`. Add routes before `/`:

```ts
app.get("/setup", async (c) => {
  const snapshot = await getSetupSnapshot();
  return c.html(await setupLayout(await setupView({
    snapshot,
    providers: await getProviders(),
    models: await getModels(),
    lark: await getLarkStatus(),
    provisioning: opts.larkSetup?.provisioningStatus(),
    runtime: getFeishuRuntime() ?? { ready: false, consumers: [] },
    groups: engine.registry.list().filter((meta) => meta.id.startsWith("team/")),
    flashMsg: c.req.query("ok") ?? undefined,
  })));
});

app.post("/setup/ai", async (c) => {
  const body = await c.req.parseBody();
  const provider = str(body, "provider");
  const available = (await getProviders()).some((item) => item.id === provider && item.available);
  if (!available) return c.redirect(`/setup?ok=${encodeURIComponent("所选 AI 尚未安装或无法运行")}`);
  saveSettings({ defaultProvider: provider, defaultModel: str(body, "model") });
  return c.redirect("/setup");
});

app.post("/setup/feishu/automatic", async (c) => {
  if (!opts.larkSetup) return c.redirect(`/setup?ok=${encodeURIComponent("未检测到飞书配置组件")}`);
  const body = await c.req.parseBody();
  const brand = str(body, "brand") === "lark" ? "lark" : "feishu";
  const session = await opts.larkSetup.startAutomatic(brand);
  return c.redirect(`/setup?ok=${encodeURIComponent(session.message)}`);
});

app.get("/setup/feishu/session", (c) => {
  c.header("cache-control", "no-store");
  return c.json(opts.larkSetup?.provisioningStatus() ?? {
    state: "idle", brand: "feishu", message: "飞书配置组件不可用",
  });
});

app.post("/setup/restart", async (c) => {
  if (!opts.onServiceRestart) return c.redirect(`/setup?ok=${encodeURIComponent("请在终端重启 Homebrain")}`);
  opts.onServiceRestart();
  return c.html(restartingView());
});

app.post("/setup/finish", (c) => {
  saveSettings({ onboardingCompletedAt: Date.now() });
  return c.redirect("/");
});
```

At the top of the existing `/` route, redirect only when onboarding is not complete and the installation is not already established. Treat an installation as established for backward compatibility when Lark is ready and it already has at least one space or Agent.

- [ ] **Step 5: Invalidate provider cache after the user asks to recheck**

Add `POST /setup/providers/refresh`, set `providerCache = null`, and redirect to `/setup`. Do not spawn install commands from a POST in this slice.

- [ ] **Step 6: Run route tests**

Run:

```bash
bun test packages/web/src/app.test.ts
```

Expected: new setup route tests and all existing web tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/integrations.ts packages/web/src/app.ts packages/web/src/app.test.ts
git commit -m "feat: add guided setup routes"
```

### Task 5: Build the calm, single-action setup interface

**Files:**
- Create: `packages/web/src/setup-view.ts`
- Create: `packages/web/src/setup-view.test.ts`
- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/index.ts`

- [ ] **Step 1: Write rendering tests**

Create `packages/web/src/setup-view.test.ts` with one test per current step. Assert that:

- AI shows detected provider cards and exactly one primary submit.
- Feishu shows “一键创建飞书机器人” before the manual credential disclosure.
- A waiting session renders an allow-listed external link and polling script.
- Activate shows runtime consumers in human language, not event keys as the heading.
- Invite shows Bot name and “我已加入群聊，重新检查”.
- Done shows a link to the knowledge dashboard.

Use the literal assertion:

```ts
expect(body.indexOf("一键创建飞书机器人")).toBeLessThan(body.indexOf("手动输入 App ID"));
```

- [ ] **Step 2: Run the rendering test and verify failure**

Run:

```bash
bun test packages/web/src/setup-view.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the dedicated setup shell**

Create `packages/web/src/setup-view.ts`. The shell must include:

```css
:root {
  --paper: #f3efe4;
  --paper-deep: #e7dfcf;
  --ink: #17231e;
  --muted: #69756d;
  --moss: #2f684c;
  --moss-soft: #dce9de;
  --sun: #e7b94f;
  --line: rgba(23, 35, 30, .14);
}
body {
  margin: 0;
  color: var(--ink);
  background:
    radial-gradient(circle at 82% 8%, rgba(231,185,79,.18), transparent 28rem),
    linear-gradient(135deg, var(--paper), #f8f5ed 58%, var(--paper-deep));
  font-family: "Avenir Next", "PingFang SC", sans-serif;
}
.setup-title {
  font-family: "Iowan Old Style", "Songti SC", serif;
  font-size: clamp(2.2rem, 5vw, 4.8rem);
  line-height: .98;
  letter-spacing: -.035em;
}
```

Use a two-column desktop composition: 280 px progress thread plus a 640 px action stage. Collapse to one column below 760 px. Respect `prefers-reduced-motion`; otherwise reveal the current action with one 360 ms upward fade.

The waiting state must poll `/setup/feishu/session` every 1.5 seconds and reload only on `ready`, `failed`, or `expired`. The restart view must poll `/healthz`, then navigate back to `/setup` after the process returns.

- [ ] **Step 4: Render all five actions**

Implement these primary labels exactly:

```ts
const PRIMARY_LABELS = {
  ai: "使用这个 AI",
  feishu: "一键创建飞书机器人",
  activate: "激活消息监听",
  invite: "我已加入群聊，重新检查",
  done: "进入 Homebrain",
} as const;
```

Provider install/login commands are copyable secondary cards, not automatically executed:

```text
npm install -g @openai/codex && codex login
npm install -g @anthropic-ai/claude-code && claude auth login
```

Keep the existing App ID/App Secret form under `<details><summary>手动输入 App ID</summary>` and post it to `/integrations/bot/setup` with a hidden `returnTo=/setup` field. Update that route to honor only the allow-listed return target `/setup`.

- [ ] **Step 5: Run rendering and route tests**

Run:

```bash
bun test packages/web/src/setup-view.test.ts packages/web/src/app.test.ts
```

Expected: all setup HTML and route tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/setup-view.ts packages/web/src/setup-view.test.ts packages/web/src/app.ts packages/web/src/index.ts
git commit -m "feat: design the Homebrain setup journey"
```

### Task 6: Wire production restart, identity persistence and the existing Integrations page

**Files:**
- Modify: `packages/app/src/main.ts`
- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/views.ts`
- Modify: `packages/web/src/app.test.ts`

- [ ] **Step 1: Write the identity persistence regression test**

Add a test that returns a `ready` automatic provisioning session, loads `/setup`, and verifies `data/config/settings.json` receives `feishuBotName` and `feishuBotOpenId` before the restart action is offered.

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
bun test packages/web/src/app.test.ts
```

Expected: the automatic path does not yet persist verified identity.

- [ ] **Step 3: Reuse `persistVerifiedBot` for automatic completion**

Whenever `/setup` observes a provisioning session in `ready`, call `getLarkStatus()` and then `persistVerifiedBot(status)`. Do not trust bot identity fields from the provisioning child output.

- [ ] **Step 4: Wire the real connector**

Keep the single `new LarkCliSetup()` instance in `packages/app/src/main.ts` and pass that same instance to `createWebApp`; do not construct one instance for status and another for provisioning:

```ts
const larkSetup = new LarkCliSetup();
const app = createWebApp({
  engine,
  adminToken: cfg.webAdminToken,
  health: reportHealth,
  larkSetup,
  feishuRuntime: () => connector.health(),
  activeFeishuIdentity: cfg.feishuBotName && cfg.feishuBotOpenId
    ? { botName: cfg.feishuBotName, botOpenId: cfg.feishuBotOpenId }
    : undefined,
  onServiceRestart: () => {
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 250);
  },
});
```

- [ ] **Step 5: Make Integrations consistent with onboarding**

Change its first card primary action to link to `/setup`; retain manual credentials as an advanced maintenance action. Rename the navigation label from `Integrations` to `飞书连接` while keeping the route stable.

- [ ] **Step 6: Run app tests**

Run:

```bash
bun test packages/web/src/app.test.ts packages/app/src/service.test.ts packages/app/src/service-cli.test.ts
```

Expected: automatic setup, manual fallback and managed restart tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/main.ts packages/web/src/app.ts packages/web/src/views.ts packages/web/src/app.test.ts
git commit -m "feat: activate provisioned Feishu bots"
```

### Task 7: Document and verify the complete fresh-user journey

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-14-feishu-setup-wizard.md`

- [ ] **Step 1: Update user-facing setup instructions**

Replace the manual-first setup with:

```text
1. 启动 Homebrain，浏览器自动进入 /setup。
2. 选择已登录的 Codex 或 Claude。
3. 点击“一键创建飞书机器人”，在飞书页面确认。
4. 回到 Homebrain，点击“激活消息监听”。
5. 把机器人加入群聊，回到向导完成真实消息测试。
```

Document the manual App ID/App Secret path only under troubleshooting.

- [ ] **Step 2: Run all offline verification**

Run:

```bash
bun test
bunx tsc -p tsconfig.json --noEmit
```

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 3: Perform a clean-data smoke test without mutating the active instance**

Run on an unused port and temporary data directory:

```bash
HOMEBRAIN_DATA_DIR="$(mktemp -d)" HOMEBRAIN_WEB_PORT=3301 bun start
```

Expected: `http://127.0.0.1:3301/` redirects to `/setup`; stop it with Ctrl-C without starting automatic provisioning.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/plans/2026-07-14-feishu-setup-wizard.md
git commit -m "docs: guide non-technical Homebrain setup"
```

## Acceptance checklist

- A pristine data directory reaches a useful setup screen without reading README.
- A user with a working AI CLI and Feishu account can finish without copying App ID or App Secret.
- Refreshing or closing the browser does not start a second app-registration process.
- Only `open.feishu.cn/page/cli` and `open.larksuite.com/page/cli` URLs can reach rendered HTML.
- Automatic and manual setup both persist only verified Bot name/open_id; App Secret never enters Homebrain settings or logs.
- An unavailable event subscription becomes a human checkpoint with a direct explanation, not a generic readiness banner.
- Existing configured installations continue to open the dashboard.
- The setup works at 360 px width, with keyboard navigation and reduced motion.

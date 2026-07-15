# One-click Feishu Bot Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Integrations page create and connect a Feishu bot through the official one-click launcher, with the standard bot permissions and event subscriptions preconfigured, so users do not manually create an app in the Feishu developer console.

**Architecture:** Keep `lark-cli config init --new` as the security and provisioning boundary. Current bundled `lark-cli` 1.0.69 already invokes Feishu's official one-click app-creation flow, stores credentials in the system keychain, and provisions the standard agent permission/event preset. Reuse the existing bounded `LarkCliSetup` session from both onboarding and Integrations; add no second credential store and never return App Secret through HomeAgent. The management UI becomes a restrained integration console: one active-bot row, one primary create/replace action, then connected groups.

**Tech Stack:** Bun, TypeScript, Hono server-rendered HTML, official `lark-cli` 1.0.69+, Bun test.

---

## Scope and platform boundary

- The zero-console path covers bot creation, bot capability, private messages, group `@` messages, sending messages, message resources, reactions, `im.message.receive_v1`, and `im.chat.member.bot.added_v1`. These are included in Feishu's official intelligent-agent application preset.
- The user still must open the Feishu confirmation link or scan its QR code. An enterprise administrator may still have to approve installation under that tenant's governance policy; HomeAgent cannot bypass administrator consent.
- The sensitive `im:message.group_msg` scope for receiving messages that do not mention the bot is not part of Feishu's standard preset. The default connection therefore remains `@ mentions only`, matching the reference UI. The existing advanced “respond to all messages” option must clearly disclose that extra scope requirement.
- Multi-bot/profile routing is a separate project. This plan preserves one active bot per HomeAgent process.

## File map

- Create `packages/web/src/verification-url.ts`: one allowlist for Feishu/Lark launcher URLs shared by onboarding and Integrations.
- Create `packages/web/src/verification-url.test.ts`: rejects credential-bearing, non-HTTPS, wrong-host, and wrong-path URLs.
- Modify `packages/web/src/app.ts`: let the existing provisioning POST return to either `/setup` or `/integrations`; pass the live provisioning session into the Integrations view.
- Modify `packages/web/src/app.test.ts`: cover one-click creation from Integrations and verify no secret or subprocess output reaches HTML/JSON.
- Modify `packages/web/src/setup-view.ts`: consume the shared URL allowlist and replace stale “manually configure/publish” copy with approval-oriented recovery copy.
- Modify `packages/web/src/setup-view.test.ts`: cover `/page/launcher` and the new recovery language.
- Modify `packages/web/src/views.ts`: render the active bot, one-click create/replace state, safe confirmation link, and group list in one integration card.
- Modify `packages/web/src/layout.ts`: add the small integration-card styles needed by the reference layout.
- Modify `README.md`: document that the normal path creates the app and provisions its standard permissions/events automatically; retain manual App ID as an advanced existing-app path.

### Task 1: Reuse one-click provisioning from Integrations

**Files:**
- Modify: `packages/web/src/app.test.ts`
- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/views.ts`

- [ ] **Step 1: Write the failing route test**

Add this test next to the current automatic Feishu setup test in `packages/web/src/app.test.ts`:

```ts
test("starts official one-click Feishu creation from Integrations", async () => {
  let starts = 0;
  const session = {
    state: "waiting_for_user" as const,
    brand: "feishu" as const,
    verificationUrl: "https://open.feishu.cn/page/cli?user_code=SAFE",
    message: "请在飞书页面完成授权",
  };
  const setupApp = createWebApp({
    engine,
    detectProviders: async () => [],
    providerModels: async () => ({}),
    larkSetup: {
      status: async () => ({ state: "unconfigured", verified: false, message: "missing" }),
      configure: async () => { throw new Error("unused"); },
      startAutomatic: async () => { starts += 1; return session; },
      provisioningStatus: () => session,
    },
  });

  const response = await setupApp.request("/setup/feishu/automatic", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "brand=feishu&returnTo=%2Fintegrations",
  });

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toStartWith("/integrations?ok=");
  expect(starts).toBe(1);
  const page = await (await setupApp.request("/integrations")).text();
  expect(page).toContain("请在飞书页面完成授权");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test packages/web/src/app.test.ts --test-name-pattern "starts official one-click"
```

Expected: FAIL because the route always redirects to `/setup` and `integrationsView` does not receive/render the provisioning session.

- [ ] **Step 3: Make the provisioning POST destination explicit and bounded**

Replace the beginning and redirects of `/setup/feishu/automatic` in `packages/web/src/app.ts` with:

```ts
app.post("/setup/feishu/automatic", async (c) => {
  const body = await c.req.parseBody();
  const returnTo = str(body, "returnTo") === "/integrations" ? "/integrations" : "/setup";
  if (!opts.larkSetup?.startAutomatic) {
    return c.redirect(`${returnTo}?ok=${encodeURIComponent("当前版本未检测到一键创建组件，请使用已有应用连接")}`);
  }
  const brand = str(body, "brand") === "lark" ? "lark" : "feishu";
  try {
    const session = await opts.larkSetup.startAutomatic(brand);
    return c.redirect(`${returnTo}?ok=${encodeURIComponent(session.message)}`);
  } catch {
    return c.redirect(`${returnTo}?ok=${encodeURIComponent("无法启动飞书应用创建，请检查网络后重试")}`);
  }
});
```

This keeps `returnTo` an allowlisted internal path; do not redirect to arbitrary form input.

- [ ] **Step 4: Pass the immutable session snapshot into the Integrations view**

Change the `integrationsView` call in `packages/web/src/app.ts` to:

```ts
await integrationsView(
  cfg.feishuBotName ?? "",
  cfg.feishuBotOpenId ?? "",
  setupStatus,
  getProvisioning(),
  restartRequired,
  getFeishuRuntime(),
  groups,
  agents,
  ok,
)
```

Add `LarkProvisioningSession` to the shared imports in `packages/web/src/views.ts`, then change the view signature to:

```ts
export function integrationsView(
  botName: string,
  botOpenId: string,
  setup: LarkSetupStatus,
  provisioning: LarkProvisioningSession,
  restartRequired: boolean,
  runtime: FeishuRuntimeStatus | undefined,
  groups: SpaceMeta[],
  agents: Agent[],
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
```

Immediately after `${flash(flashMsg)}` in the current `integrationsView` return value, render the public session message:

```ts
${provisioning.state !== "idle" ? html`<div class="card"><div class="muted">${provisioning.message}</div></div>` : ""}
```

Task 3 replaces this bounded interim status with the finished confirmation control.

- [ ] **Step 5: Run the focused tests**

Run:

```bash
bun test packages/web/src/app.test.ts --test-name-pattern "Feishu|integration"
```

Expected: PASS.

- [ ] **Step 6: Commit the reusable route boundary**

```bash
git add packages/web/src/app.ts packages/web/src/app.test.ts packages/web/src/views.ts
git commit -m "feat: start Feishu bot creation from integrations"
```

### Task 2: Centralize and harden launcher URL rendering

**Files:**
- Create: `packages/web/src/verification-url.ts`
- Create: `packages/web/src/verification-url.test.ts`
- Modify: `packages/web/src/setup-view.ts`
- Modify: `packages/web/src/setup-view.test.ts`

- [ ] **Step 1: Write the failing allowlist tests**

Create `packages/web/src/verification-url.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { safeLarkVerificationUrl } from "./verification-url.ts";

describe("safeLarkVerificationUrl", () => {
  test("allows official CLI and launcher confirmation pages", () => {
    expect(safeLarkVerificationUrl("https://open.feishu.cn/page/cli?user_code=A"))
      .toBe("https://open.feishu.cn/page/cli?user_code=A");
    expect(safeLarkVerificationUrl("https://open.feishu.cn/page/launcher?user_code=B"))
      .toBe("https://open.feishu.cn/page/launcher?user_code=B");
    expect(safeLarkVerificationUrl("https://open.larksuite.com/page/launcher?user_code=C"))
      .toBe("https://open.larksuite.com/page/launcher?user_code=C");
  });

  test("rejects URLs that could exfiltrate credentials or leave Feishu", () => {
    expect(safeLarkVerificationUrl("http://open.feishu.cn/page/launcher?user_code=A")).toBeUndefined();
    expect(safeLarkVerificationUrl("https://attacker.example/page/launcher?user_code=A")).toBeUndefined();
    expect(safeLarkVerificationUrl("https://open.feishu.cn.evil.example/page/launcher")).toBeUndefined();
    expect(safeLarkVerificationUrl("https://user:pass@open.feishu.cn/page/launcher")).toBeUndefined();
    expect(safeLarkVerificationUrl("https://open.feishu.cn:444/page/launcher")).toBeUndefined();
    expect(safeLarkVerificationUrl("https://open.feishu.cn/redirect?next=https://evil.example")).toBeUndefined();
    expect(safeLarkVerificationUrl("not a url")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test packages/web/src/verification-url.test.ts
```

Expected: FAIL because `verification-url.ts` does not exist.

- [ ] **Step 3: Implement the single allowlist**

Create `packages/web/src/verification-url.ts`:

```ts
const LARK_VERIFICATION_HOSTS = new Set(["open.feishu.cn", "open.larksuite.com"]);
const LARK_VERIFICATION_PATHS = new Set(["/page/cli", "/page/launcher"]);

export function safeLarkVerificationUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.port
      || !LARK_VERIFICATION_HOSTS.has(parsed.hostname)
      || !LARK_VERIFICATION_PATHS.has(parsed.pathname)
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Replace the private onboarding helper**

In `packages/web/src/setup-view.ts`, import:

```ts
import { safeLarkVerificationUrl } from "./verification-url.ts";
```

Delete the existing `safeVerificationUrl` function and replace:

```ts
const url = safeVerificationUrl(input.provisioning.verificationUrl);
```

with:

```ts
const url = safeLarkVerificationUrl(input.provisioning.verificationUrl);
```

- [ ] **Step 5: Extend the onboarding view test to cover the official launcher URL**

Change the waiting provisioning fixture in `packages/web/src/setup-view.test.ts` to:

```ts
provisioning: {
  state: "waiting_for_user",
  brand: "feishu",
  verificationUrl: "https://open.feishu.cn/page/launcher?user_code=safe",
  message: "请完成授权",
},
```

and assert:

```ts
expect(body).toContain("https://open.feishu.cn/page/launcher?user_code=safe");
```

- [ ] **Step 6: Run the URL and setup-view tests**

Run:

```bash
bun test packages/web/src/verification-url.test.ts packages/web/src/setup-view.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the shared security boundary**

```bash
git add packages/web/src/verification-url.ts packages/web/src/verification-url.test.ts packages/web/src/setup-view.ts packages/web/src/setup-view.test.ts
git commit -m "refactor: share Feishu launcher URL validation"
```

### Task 3: Build the reference-style bot and group connection card

**Files:**
- Modify: `packages/web/src/views.ts`
- Modify: `packages/web/src/layout.ts`
- Modify: `packages/web/src/app.test.ts`

- [ ] **Step 1: Write the failing Integrations UI assertions**

Add this test near the existing Integrations tests in `packages/web/src/app.test.ts`:

```ts
test("integration page makes official one-click creation the primary bot action", async () => {
  const idle = {
    state: "idle" as const,
    brand: "feishu" as const,
    message: "尚未开始创建飞书应用",
  };
  const setupApp = createWebApp({
    engine,
    detectProviders: async () => [],
    providerModels: async () => ({}),
    larkSetup: {
      status: async () => ({ state: "unconfigured", verified: false, message: "missing" }),
      configure: async () => { throw new Error("unused"); },
      startAutomatic: async () => idle,
      provisioningStatus: () => idle,
    },
  });

  const page = await (await setupApp.request("/integrations")).text();
  expect(page).toContain("飞书机器人");
  expect(page).toContain("一键创建并连接");
  expect(page).toContain('action="/setup/feishu/automatic"');
  expect(page).toContain('name="returnTo" value="/integrations"');
  expect(page.indexOf("一键创建并连接")).toBeLessThan(page.indexOf("手动连接已有应用"));
  expect(page).toContain("飞书群聊");
});
```

Extend the test from Task 1 with:

```ts
expect(page).toContain("打开飞书并确认");
expect(page).toContain("SAFE");
expect(page).toContain("权限和事件订阅会由飞书自动配置");
expect(page).toContain("/setup/feishu/session");
expect(page).not.toContain("never-render-this-secret");
```

The literal `App Secret` field label remains available under “更多设置” for users who connect an existing app; the security assertion targets secret values, not that label.

- [ ] **Step 2: Run the UI tests to verify they fail**

Run:

```bash
bun test packages/web/src/app.test.ts --test-name-pattern "official one-click|primary bot action"
```

Expected: FAIL because the current page sends users back to onboarding and shows the manual App ID form as the main connection control.

- [ ] **Step 3: Add restrained integration-card styling**

Insert these rules after `.card`/`.row` in `packages/web/src/layout.ts`:

```css
  .integration-card { padding:0; overflow:hidden; }
  .integration-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:24px; align-items:center; padding:18px 20px; }
  .integration-row + .integration-row { border-top:1px solid var(--border); }
  .connection-pill { min-width:220px; display:flex; align-items:center; justify-content:space-between; gap:12px;
    padding:9px 12px; border:1px solid var(--border); border-radius:8px; background:#fff; color:#374151; font-size:13px; }
  .connection-pill .dot { flex:0 0 auto; margin-right:0; }
  .integration-actions { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:8px; }
  .integration-detail { padding:0 20px 18px; }
  @media (max-width:720px) {
    .integration-row { grid-template-columns:1fr; gap:12px; }
    .integration-actions { justify-content:flex-start; }
    .connection-pill { min-width:0; width:100%; }
  }
```

- [ ] **Step 4: Add a safe provisioning control to `views.ts`**

Import the shared helper:

```ts
import { safeLarkVerificationUrl } from "./verification-url.ts";
```

Add this function above `integrationsView`:

```ts
function feishuProvisioningControl(
  setup: LarkSetupStatus,
  provisioning: LarkProvisioningSession,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const url = safeLarkVerificationUrl(provisioning.verificationUrl);
  const active = ["starting", "waiting_for_user", "verifying"].includes(provisioning.state);
  if (active) {
    return html`<div class="integration-actions">
      <span class="muted">${provisioning.state === "verifying" ? "正在验证机器人…" : "等待飞书确认"}</span>
      ${url ? html`<a class="btn" href="${url}" target="_blank" rel="noreferrer">打开飞书并确认</a>` : ""}
      <script>
        (function poll() {
          fetch("/setup/feishu/session", { cache:"no-store" })
            .then(function (response) { return response.json(); })
            .then(function (session) {
              if (["ready", "failed", "expired"].includes(session.state)) location.reload();
              else setTimeout(poll, 1500);
            })
            .catch(function () { setTimeout(poll, 2500); });
        })();
      </script>
    </div>`;
  }
  const label = setup.state === "ready" && setup.verified ? "创建并切换机器人" : "一键创建并连接";
  return html`<form method="post" action="/setup/feishu/automatic" class="integration-actions">
    <input type="hidden" name="brand" value="feishu" />
    <input type="hidden" name="returnTo" value="/integrations" />
    <button type="submit">${label}</button>
  </form>`;
}
```

The interpolated link remains escaped by `hono/html`; only the shared allowlist may produce it.

- [ ] **Step 5: Replace the top of `integrationsView` with one connected surface**

Use this structure before rendering the existing `groupCards`:

```ts
return html`<h1>飞书连接</h1>
  <p class="subtitle">创建机器人、连接群聊，并管理每个群的回答方式。</p>
  ${flash(flashMsg)}

  <section class="card integration-card">
    <div class="integration-row">
      <div>
        <strong>飞书机器人</strong>
        <div class="muted">接收群消息、发送回答，并建立群知识空间。</div>
      </div>
      ${setup.state === "ready" && setup.verified
        ? html`<div class="connection-pill"><span><span class="dot"></span>${shownBotName || "已连接机器人"}</span><span>⌄</span></div>`
        : feishuProvisioningControl(setup, provisioning)}
    </div>
    ${setup.state === "ready" && setup.verified ? html`<div class="integration-row">
      <div>
        <strong>${shownBotName || "已连接机器人"}</strong>
        <div class="muted">${setup.appId ?? ""}${shownBotOpenId ? ` · ${shownBotOpenId}` : ""}</div>
      </div>
      ${feishuProvisioningControl(setup, provisioning)}
    </div>` : ""}
    <div class="integration-row">
      <div>
        <strong>飞书群聊</strong>
        <div class="muted">机器人加入群后自动建立对应工作空间。</div>
      </div>
      <span class="badge ${!restartRequired && runtime?.ready ? "ok" : "degraded"}">
        ${!restartRequired && runtime?.ready ? "消息监听已就绪" : restartRequired ? "重启后生效" : "等待连接"}
      </span>
    </div>
    <div class="integration-detail">
      <div class="muted">权限和事件订阅会由飞书自动配置；默认接收私聊和群内 @ 机器人的消息。</div>
    </div>
  </section>

  <h2>已连接群聊</h2>
  ${groupCards}

  <details class="card">
    <summary style="cursor:pointer;font-weight:600">更多设置</summary>
    <div class="muted" style="margin:10px 0 14px">手动连接已有应用，或重新验证当前 lark-cli 配置。</div>
    <form method="post" action="/integrations/bot/setup" class="stack">
      <div class="grid2">
        <div class="field"><label>App ID</label><input type="text" name="appId" placeholder="cli_..." required autocomplete="off" /></div>
        <div class="field"><label>App Secret</label><input type="password" name="appSecret" required autocomplete="new-password" /></div>
      </div>
      <input type="hidden" name="brand" value="feishu" />
      <div class="actions"><button type="submit" class="secondary">手动连接已有应用</button><button type="submit" class="secondary" formnovalidate formaction="/integrations/bot/verify">只验证现有配置</button></div>
    </form>
  </details>`;
```

Remove the old separate “引导式设置”, main App ID form, raw event-key listing, and “高级：手工覆盖 Bot 身份” blocks from the normal page. Keep the underlying `/integrations/bot` route for backward compatibility; it does not need to remain prominent in the UI.

- [ ] **Step 6: Preserve group editing and clarify the advanced full-message mode**

In each group card, keep the Agent and Topic reply controls. Change the mention toggle hint to:

```ts
<div><strong>@ mentions only</strong><div class="hint">推荐开启；一键创建后即可使用。关闭后需要企业批准“接收群内全部消息”敏感权限。</div></div>
```

Do not silently claim that non-mention capture works without `im:message.group_msg`.

- [ ] **Step 7: Run the Integrations UI tests**

Run:

```bash
bun test packages/web/src/app.test.ts --test-name-pattern "integration|official one-click"
```

Expected: PASS.

- [ ] **Step 8: Commit the reference-style integration UI**

```bash
git add packages/web/src/views.ts packages/web/src/layout.ts packages/web/src/app.test.ts
git commit -m "feat: add one-click Feishu connection card"
```

### Task 4: Remove stale manual-console guidance and document the real boundary

**Files:**
- Modify: `packages/web/src/setup-view.test.ts`
- Modify: `packages/web/src/setup-view.ts`
- Modify: `packages/web/src/views.ts`
- Modify: `README.md`

- [ ] **Step 1: Change the failing activation-copy assertions**

Replace the current `permissionFailure` assertions in `packages/web/src/setup-view.test.ts` with:

```ts
expect(permissionFailure).toContain("连接还没有通过企业确认");
expect(permissionFailure).toContain("飞书管理员批准");
expect(permissionFailure).not.toContain("进入飞书开放平台手动创建");
expect(permissionFailure).not.toContain("raw secret");
expect(permissionFailure).toContain('action="/setup/restart"');
```

Add this assertion to the Feishu creation-step test:

```ts
expect(body).toContain("自动配置机器人权限和事件订阅");
```

- [ ] **Step 2: Run the setup view test to verify it fails**

Run:

```bash
bun test packages/web/src/setup-view.test.ts
```

Expected: FAIL because the page still tells users to manually enable capabilities, permissions, event subscriptions, and publish a version.

- [ ] **Step 3: Describe the official one-click behavior accurately**

Change the Feishu-step lead in `packages/web/src/setup-view.ts` to:

```ts
<p class="lede">HomeAgent 会通过飞书官方流程创建专属机器人，自动配置机器人权限和事件订阅。你只需要在飞书页面确认，凭据由系统钥匙串保管。</p>
```

Replace the failed-consumer actions inside `activateStep` with:

```ts
const approvalNotice = html`<div class="waiting">
  <strong>连接还没有通过企业确认</strong>
  <span class="muted">应用已经创建；如果企业设置了应用审核，请让飞书管理员批准本次机器人安装，然后重新检查。</span>
</div>`;
const action = input.restartRequired
  ? input.restartable
    ? html`<form method="post" action="/setup/restart" class="actions"><button class="primary-action">激活消息监听</button></form>`
    : html`<div class="waiting"><strong>需要重启 HomeAgent</strong><span class="muted">请在启动它的终端按 Ctrl+C，然后重新运行 bun start。</span></div>`
  : failed
    ? input.restartable
      ? html`${approvalNotice}<form method="post" action="/setup/restart" class="actions"><button class="primary-action">重新检查连接</button></form>`
      : approvalNotice
    : html`<div class="waiting"><strong>正在建立消息连接…</strong><span class="muted">通常只需几秒，不需要再次重启。</span></div>
        <script>setTimeout(function () { location.reload(); }, 2000);</script>`;
```

Change the recovery details to:

```ts
<details><summary>如果重启后仍未就绪</summary><p class="muted">确认扫码账号有创建企业自建应用的权限，并检查企业管理员是否有待审批的应用授权。HomeAgent 会保留当前进度，不必重新创建机器人。</p></details>
```

- [ ] **Step 4: Update README onboarding and permission language**

Replace README's first-run Feishu steps with:

```md
3. 点击“一键创建飞书机器人”，在飞书官方页面确认。飞书会创建企业自建应用，并自动预置机器人能力、
   私聊与群内 @ 消息权限、消息发送/资源/表情权限，以及 HomeAgent 使用的两条事件订阅。App Secret
   只写入 `lark-cli` 的系统钥匙串，不进入 HomeAgent 设置、页面或日志。
4. 如果企业启用了自建应用审核，由飞书管理员批准本次安装；不需要用户进入开放平台手工创建应用或逐项配置权限。
5. LaunchAgent 托管时点击“激活消息监听”安全重启；源码运行时重启 `bun start`。
6. 把机器人加入目标群，@机器人发送第一条测试消息。HomeAgent 会按 `chat_id` 自动建立群知识空间。
```

Replace the permission caveat with:

```md
一键创建使用飞书官方智能体应用权限预设，默认覆盖私聊、群内 @、发送消息、附件下载、表情反应和事件长连接。
若关闭群的 `@ mentions only`，还需要企业额外批准敏感权限 `im:message.group_msg`；这不是默认零配置路径。
已有应用仍可在“更多设置”中通过 App ID / App Secret 接入。
```

- [ ] **Step 5: Run the focused tests**

Run:

```bash
bun test packages/web/src/setup-view.test.ts packages/web/src/app.test.ts packages/connectors/src/lark-setup.test.ts
```

Expected: PASS. The connector test proves the official command remains:

```text
lark-cli config init --new --brand feishu --lang zh
```

- [ ] **Step 6: Commit the product and documentation correction**

```bash
git add packages/web/src/setup-view.ts packages/web/src/setup-view.test.ts packages/web/src/views.ts README.md
git commit -m "docs: describe automatic Feishu app provisioning"
```

### Task 5: Full verification

**Files:**
- Verify only; no new source file is expected.

- [ ] **Step 1: Run formatting-neutral type validation**

Run:

```bash
bun run typecheck
```

Expected: exit 0 with no TypeScript diagnostics.

- [ ] **Step 2: Run the complete test suite**

Run:

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 3: Exercise the real launcher without completing creation**

Start HomeAgent against a temporary data directory:

```bash
HOMEAGENT_DATA_DIR="$(mktemp -d)" HOMEAGENT_WEB_PORT=3100 bun start
```

Open `http://127.0.0.1:3100/integrations`, click “一键创建并连接”, and verify:

1. The page renders only an HTTPS `open.feishu.cn/page/cli` or `open.feishu.cn/page/launcher` confirmation link.
2. The Feishu confirmation page states that a robot application and its permission/event preset will be created.
3. Cancelling or allowing the ten-minute link to expire produces a fixed HomeAgent error without CLI output.
4. The manual App ID form is available only under “更多设置”.

Terminate HomeAgent with Ctrl+C. Do not finish creating a disposable enterprise application during this smoke test.

- [ ] **Step 4: Check the final diff for secrets and scope creep**

Run:

```bash
git diff --check
git diff -- packages/connectors/src/lark-setup.ts packages/web/src README.md
rg -n "appSecret|client_secret|SAFE|user_code" data packages/web/src packages/connectors/src --glob '!*.test.ts'
```

Expected:

- `git diff --check` exits 0.
- `packages/connectors/src/lark-setup.ts` still sends manually supplied App Secret only through stdin.
- No provisioning secret or raw subprocess output is added to settings, HTML, or public session JSON.
- No multi-bot routing or unrelated group model change appears in the diff.

- [ ] **Step 5: Commit any verification-only correction**

If verification required a source correction, stage only that correction and commit it with a message describing the actual fix. If no correction was needed, do not create an empty commit.

## Self-review

- Spec coverage: the plan exposes one-click creation in the requested Integrations surface, relies on Feishu's official automatic permission/event preset, retains secure keychain ownership, and avoids requiring users to create an app manually.
- Security coverage: internal redirect allowlist, external URL allowlist, secret non-persistence, fixed public errors, and bounded polling are all tested.
- Product boundary: enterprise approval is stated honestly; sensitive non-mention group capture and multi-bot routing are explicitly outside the zero-console default.
- Placeholder scan: every code-changing step includes exact code or exact replacement text; no unfinished implementation marker remains.
- Type consistency: `LarkProvisioningSession` is passed from `getProvisioning()` to `integrationsView`, and the shared `safeLarkVerificationUrl()` name is consistent in both views and tests.

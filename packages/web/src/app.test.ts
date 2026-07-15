import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  readSettings,
  resetConfig,
  saveSettings,
  type Page,
  type SpaceId,
  type SystemHealthSnapshot,
} from "@homebrain/shared";
import { KnowledgeEngine, FakeLlm } from "@homebrain/core";
import { createWebApp } from "./app.ts";

let dir: string;
let engine: KnowledgeEngine;
let app: Hono;
let fake: FakeLlm;
const SPACE: SpaceId = "team/oc_web";

function page(slug: string, title: string, content: string): Page {
  return {
    slug,
    type: "entity",
    title,
    summary: content.slice(0, 30),
    aliases: ["爱丽丝"],
    tags: ["team"],
    sources: ["raw-1"],
    links: [],
    content,
    updatedAt: Date.now(),
    contentHash: "h",
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hb-web-"));
  process.env.HOMEBRAIN_DATA_DIR = dir;
  resetConfig();
  fake = new FakeLlm();
  engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
  await engine.upsertPage(SPACE, page("entities/alice", "Alice", "Alice 负责后端服务。"));
  await engine.remember({ space: SPACE, source: "message", content: "一条原始消息" });
  app = createWebApp({
    engine,
    // deterministic + fast: don't spawn real CLIs
    detectProviders: async () => [
      { id: "claude", name: "Claude Code", bin: "claude", available: true, detail: "2.x" },
      { id: "codex", name: "Codex", bin: "codex", available: false, detail: "node not found" },
      { id: "trae-cli", name: "TRAE CLI", bin: "trae-cli", available: true, detail: "0.2" },
    ],
    providerModels: async () => ({
      claude: ["sonnet", "opus"],
      codex: ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex-spark"],
      "trae-cli": ["openrouter-3o"],
    }),
  });
});

afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEBRAIN_DATA_DIR;
  resetConfig();
});

describe("web backend (read-only)", () => {
  test("health endpoints distinguish liveness from readiness", async () => {
    const snapshot: SystemHealthSnapshot = {
      status: "degraded",
      ready: false,
      checkedAt: 1_783_932_000_000,
      components: {
        feishu: {
          status: "down",
          summary: "消息消费者未就绪",
        },
      },
    };
    const healthApp = createWebApp({
      engine,
      health: async () => snapshot,
    });

    const live = await healthApp.request("/healthz");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual(
      expect.objectContaining({ status: "ok", checkedAt: expect.any(Number) }),
    );

    const ready = await healthApp.request("/readyz");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual(snapshot);
  });

  test("fresh installs redirect the dashboard to guided setup", async () => {
    await engine.deleteSpace(SPACE);
    const fresh = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      larkSetup: {
        status: async () => ({ state: "unconfigured", verified: false, message: "missing" }),
        configure: async () => { throw new Error("unused"); },
      },
    });

    const response = await fresh.request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/setup");
    expect((await fresh.request("/setup")).status).toBe(200);
  });

  test("an imported space does not hide an unconfigured production connection", async () => {
    const unconfigured = createWebApp({
      engine,
      larkSetup: {
        status: async () => ({ state: "unconfigured", verified: false, message: "missing" }),
        configure: async () => { throw new Error("unused"); },
      },
    });
    const response = await unconfigured.request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/setup");
  });

  test("starts automatic Feishu setup and exposes a pollable safe session", async () => {
    let starts = 0;
    const session = {
      state: "waiting_for_user" as const,
      brand: "feishu" as const,
      verificationUrl: "https://open.feishu.cn/page/cli?user_code=x",
      message: "等待确认",
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

    const start = await setupApp.request("/setup/feishu/automatic", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "brand=feishu",
    });
    expect(start.status).toBe(302);
    expect(starts).toBe(1);
    const poll = await setupApp.request("/setup/feishu/session");
    expect(await poll.json()).toEqual(session);
  });

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
        status: async () => ({ state: "unconfigured", verified: false, message: "never-render-this-secret" }),
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
    expect(page).toContain("打开飞书并确认");
    expect(page).toContain("SAFE");
    expect(page).toContain("权限和事件订阅会由飞书自动配置");
    expect(page).toContain("/setup/feishu/session");
    expect(page).not.toContain("never-render-this-secret");
  });

  test("recovers the verified bot identity after an automatic session is lost on restart", async () => {
    const idleSession = {
      state: "idle" as const,
      brand: "feishu" as const,
      message: "尚未开始",
    };
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          brand: "feishu",
          appId: "cli_ready",
          botName: "Homebrain",
          botOpenId: "ou_ready",
          message: "ready",
        }),
        configure: async () => { throw new Error("unused"); },
        provisioningStatus: () => idleSession,
      },
    });

    const response = await setupApp.request("/setup");
    expect(response.status).toBe(200);
    expect(readSettings(dir)).toEqual(expect.objectContaining({
      feishuBotName: "Homebrain",
      feishuBotOpenId: "ou_ready",
    }));
  });

  test("rejects a model that belongs to a different AI provider", async () => {
    const response = await app.request("/setup/ai", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "provider=claude&model=gpt-5.4",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("%E6%89%80%E9%80%89%E6%A8%A1%E5%9E%8B");
    expect(readSettings(dir).defaultModel).toBeUndefined();
  });

  test("connects managed Codex without exposing installer or login output", async () => {
    let installed = false;
    let installCalls = 0;
    let loginStarts = 0;
    let session: import("@homebrain/llm").CodexLoginSession = {
      state: "idle",
      message: "尚未连接",
    };
    const managed = createWebApp({
      engine,
      detectProviders: async () => [
        {
          id: "codex",
          name: "Codex",
          bin: "/managed/codex",
          available: installed,
          detail: installed ? "ready" : "missing",
        },
      ],
      providerModels: async () => ({ codex: ["gpt-5.4"] }),
      codexSetup: {
        canInstall: true,
        isInstalled: () => installed,
        install: async (consented) => {
          expect(consented).toBeTrue();
          installCalls += 1;
          installed = true;
        },
        startDeviceLogin: async () => {
          loginStarts += 1;
          session = {
            state: "waiting_for_user",
            verificationUrl: "https://auth.openai.com/device",
            userCode: "SAFE-CODE",
            message: "等待确认",
          };
          return session;
        },
        deviceLoginStatus: () => session,
        cancelDeviceLogin: () => ({ state: "cancelled", message: "已取消" }),
      },
    });

    const refused = await managed.request("/setup/ai/codex/install", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(refused.headers.get("location")).toContain("%E9%9C%80%E8%A6%81%E7%A1%AE%E8%AE%A4");
    expect(installCalls).toBe(0);

    await managed.request("/setup/ai/codex/install", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "consent=on",
    });
    await Bun.sleep(0);
    expect(installCalls).toBe(1);
    expect(loginStarts).toBe(1);
    expect(await (await managed.request("/setup/ai/codex/session")).json()).toEqual(session);

    session = { state: "ready", message: "ChatGPT 已连接" };
    expect((await managed.request("/setup/ai/codex/session")).status).toBe(200);
    expect(readSettings(dir)).toEqual(expect.objectContaining({
      defaultProvider: "codex",
      defaultModel: "",
    }));
  });

  test("sanitizes managed Codex installation failures", async () => {
    const secret = "raw download URL and token";
    const broken = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      codexSetup: {
        canInstall: true,
        isInstalled: () => false,
        install: async () => { throw new Error(secret); },
        startDeviceLogin: async () => ({ state: "failed", message: "失败" }),
        deviceLoginStatus: () => ({ state: "idle", message: "尚未连接" }),
        cancelDeviceLogin: () => ({ state: "cancelled", message: "已取消" }),
      },
    });
    await broken.request("/setup/ai/codex/install", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "consent=on",
    });
    await Bun.sleep(0);
    const result = JSON.stringify(await (await broken.request("/setup/ai/codex/session")).json());
    expect(result).toContain("Codex 安装未完成");
    expect(result).not.toContain(secret);
  });

  test("does not finish setup before AI, bot identity, and runtime are ready", async () => {
    const response = await app.request("/setup/finish", { method: "POST" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/setup?ok=");
    expect(readSettings(dir).onboardingCompletedAt).toBeUndefined();
  });

  test("allows an explicitly private-only finish after the connection is ready", async () => {
    saveSettings({ defaultProvider: "claude", onboardingStartedAt: Date.now() + 1_000 });
    const ready = createWebApp({
      engine,
      detectProviders: async () => [
        { id: "claude", name: "Claude Code", bin: "claude", available: true, detail: "ready" },
      ],
      providerModels: async () => ({ claude: ["sonnet"] }),
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          botName: "Homebrain",
          botOpenId: "ou_ready",
          message: "ready",
        }),
        configure: async () => { throw new Error("unused"); },
      },
      activeFeishuIdentity: { botName: "Homebrain", botOpenId: "ou_ready" },
      feishuRuntime: () => ({ ready: true, consumers: [] }),
    });
    const response = await ready.request("/setup/finish", { method: "POST" });
    expect(response.headers.get("location")).toBe("/");
    expect(readSettings(dir).onboardingCompletedAt).toEqual(expect.any(Number));
  });

  test("finishes group verification only after a new real message", async () => {
    const startedAt = Date.now() + 1_000;
    saveSettings({
      onboardingStartedAt: startedAt,
      feishuBotName: "Homebrain",
      feishuBotOpenId: "ou_ready",
    });
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [
        { id: "claude", name: "Claude Code", bin: "claude", available: true, detail: "ready" },
      ],
      providerModels: async () => ({ claude: ["sonnet"] }),
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          botName: "Homebrain",
          botOpenId: "ou_ready",
          message: "ready",
        }),
        configure: async () => { throw new Error("unused"); },
      },
      activeFeishuIdentity: { botName: "Homebrain", botOpenId: "ou_ready" },
      feishuRuntime: () => ({ ready: true, consumers: [] }),
    });

    expect(await (await setupApp.request("/setup")).text()).toContain("发送第一条共同记忆");
    await engine.remember({
      space: SPACE,
      source: "task",
      content: "不是飞书消息",
      createdAt: startedAt + 1,
    });
    expect(await (await setupApp.request("/setup")).text()).toContain("发送第一条共同记忆");
    await engine.remember({
      space: SPACE,
      source: "message",
      content: "来自本次设置的飞书消息",
      createdAt: startedAt + 2,
    });
    expect(await (await setupApp.request("/setup")).text()).toContain("一切就绪");
  });

  test("admin token protects management routes but leaves probes public", async () => {
    const secureApp = createWebApp({ engine, adminToken: "admin-secret" });

    expect((await secureApp.request("/healthz")).status).toBe(200);
    expect((await secureApp.request("/readyz")).status).toBe(200);

    const denied = await secureApp.request("/");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Basic");

    const basic = Buffer.from("homebrain:admin-secret").toString("base64");
    expect((await secureApp.request("/", { headers: { authorization: `Basic ${basic}` } })).status).toBe(200);
    expect((await secureApp.request("/governance", {
      headers: { authorization: "Bearer admin-secret" },
    })).status).toBe(200);
    expect((await secureApp.request("/", {
      headers: { authorization: "Bearer wrong" },
    })).status).toBe(401);

    expect((await secureApp.request("/governance/prune", {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    })).status).toBe(403);
    expect((await secureApp.request("/governance/prune", {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        origin: "http://localhost",
        "sec-fetch-site": "same-origin",
      },
    })).status).toBe(302);

    expect((await app.request("/governance/prune", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    })).status).toBe(403);
    expect((await app.request("/", {
      headers: { host: "attacker.example" },
    })).status).toBe(403);
  });

  test("health routes degrade safely when the reporter itself fails", async () => {
    const healthApp = createWebApp({
      engine,
      health: async () => {
        throw new Error("health aggregation failed");
      },
    });

    const live = await healthApp.request("/healthz");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual(
      expect.objectContaining({ status: "ok", checkedAt: expect.any(Number) }),
    );

    expect((await healthApp.request("/readyz")).status).toBe(503);
    expect((await healthApp.request("/health")).status).toBe(200);
  });

  test("liveness does not wait for readiness aggregation", async () => {
    const healthApp = createWebApp({
      engine,
      health: () => new Promise<SystemHealthSnapshot>(() => {}),
    });

    const live = await Promise.race([
      healthApp.request("/healthz"),
      Bun.sleep(50).then(() => {
        throw new Error("liveness timed out");
      }),
    ]);
    expect(live.status).toBe(200);
  });

  test("management backend renders component failures and a global readiness alert", async () => {
    const snapshot: SystemHealthSnapshot = {
      status: "down",
      ready: false,
      checkedAt: 1_783_932_000_000,
      components: {
        feishu: {
          status: "down",
          summary: "消息消费者未就绪",
          details: { lastEventAt: 1_783_931_000_000 },
        },
      },
    };
    const healthApp = createWebApp({ engine, health: async () => snapshot });

    const page = await healthApp.request("/health");
    expect(page.status).toBe(200);
    const healthBody = await page.text();
    expect(healthBody).toContain("运行状态");
    expect(healthBody).toContain("消息消费者未就绪");

    const homeBody = await (await healthApp.request("/")).text();
    expect(homeBody).toContain("runtime-health-alert");
    expect(homeBody).toContain("/readyz");
  });

  test("managed service status exposes a guarded restart action", async () => {
    let restarts = 0;
    const snapshot: SystemHealthSnapshot = {
      status: "ok",
      ready: true,
      checkedAt: 1_783_932_000_000,
      components: {
        service: {
          status: "ok",
          summary: "LaunchAgent 托管运行（PID 7788）",
          details: { managed: true, pid: 7788, startedAt: 1_783_931_000_000 },
        },
      },
    };
    const managedApp = createWebApp({
      engine,
      health: async () => snapshot,
      onServiceRestart: () => { restarts += 1; },
    });

    const page = await managedApp.request("/health");
    const body = await page.text();
    expect(body).toContain("后台服务");
    expect(body).toContain("PID 7788");
    expect(body).toContain('action="/service/restart"');

    const restart = await managedApp.request("/service/restart", { method: "POST" });
    expect(restart.status).toBe(302);
    expect(restarts).toBe(1);

    const manualApp = createWebApp({
      engine,
      health: async () => ({
        ...snapshot,
        components: {
          service: { ...snapshot.components.service!, details: { managed: false, pid: 7788 } },
        },
      }),
      onServiceRestart: () => { restarts += 1; },
    });
    expect((await manualApp.request("/service/restart", { method: "POST" })).status).toBe(409);
    expect(restarts).toBe(1);
  });

  test("home lists spaces", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("team/oc_web");
    expect(body).toContain("homebrain");
  });

  test("space detail shows knowledge pages", async () => {
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Alice");
    expect(body).toContain("知识页");
  });

  test("page view shows full content and metadata", async () => {
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}/pages/${encodeURIComponent("entities/alice")}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Alice 负责后端服务");
    expect(body).toContain("爱丽丝"); // alias
    expect(body).toContain("raw-1"); // provenance
  });

  test("raw list shows captured entries", async () => {
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}/raw`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("一条原始消息");
  });

  test("ask box renders a knowledge answer", async () => {
    // script routing + synthesis
    fake.onJSON((call) => {
      const props = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("relevant" in props) return { slugs: ["entities/alice"], relevant: true };
      if ("grounded" in props)
        return { answer: "后端由 Alice 负责。", grounded: true, usedSlugs: ["entities/alice"], gaps: [] };
      return {};
    });
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}/ask?q=${encodeURIComponent("谁负责后端？")}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("后端由 Alice 负责");
    expect(body).toContain("知识库"); // source badge
  });

  test("dream POST triggers a cycle and redirects", async () => {
    fake.queueJSON({ operations: [], skippedRawIds: [] });
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}/dream`, { method: "POST" });
    expect([302, 303]).toContain(res.status);
  });

  test("unknown space is 404", async () => {
    const res = await app.request(`/spaces/${encodeURIComponent("team/nope")}`);
    expect(res.status).toBe(404);
  });

  test("logs page renders", async () => {
    const res = await app.request("/logs");
    expect(res.status).toBe(200);
  });
});

describe("management backend (read-write)", () => {
  test("data governance exports, deletes, and restores a complete space", async () => {
    const governance = await app.request("/governance");
    expect(governance.status).toBe(200);
    const governanceBody = await governance.text();
    expect(governanceBody).toContain("数据治理");
    expect(governanceBody).toContain("原始消息保留");

    const exported = await app.request(`/spaces/${encodeURIComponent(SPACE)}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    const archiveText = await exported.text();
    expect(JSON.parse(archiveText)).toEqual(
      expect.objectContaining({ format: "homebrain.space", version: 1 }),
    );

    const deleted = await app.request(`/spaces/${encodeURIComponent(SPACE)}/delete`, {
      method: "POST",
    });
    expect([302, 303]).toContain(deleted.status);
    expect(engine.registry.has(SPACE)).toBe(false);

    const form = new FormData();
    form.set("archive", new File([archiveText], "space.json", { type: "application/json" }));
    const restored = await app.request("/governance/restore", { method: "POST", body: form });
    expect([302, 303]).toContain(restored.status);
    expect(engine.registry.has(SPACE)).toBe(true);
    expect(await engine.getPage(SPACE, "entities/alice")).not.toBeNull();

    const pruned = await app.request("/governance/prune", { method: "POST" });
    expect([302, 303]).toContain(pruned.status);
  });

  test("data governance rejects an unsafe archive without changing spaces", async () => {
    const form = new FormData();
    form.set(
      "archive",
      new File(
        [
          JSON.stringify({
            format: "homebrain.space",
            version: 1,
            exportedAt: 1,
            space: { id: "team/unsafe", createdAt: 1 },
            purpose: "x",
            schema: "x",
            pages: [{ slug: "../../outside", type: "concept" }],
            raw: [],
            retractions: [],
            tasks: [],
          }),
        ],
        "unsafe.json",
        { type: "application/json" },
      ),
    );

    const res = await app.request("/governance/restore", { method: "POST", body: form });
    expect([302, 303]).toContain(res.status);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("恢复失败");
    expect(engine.registry.has("team/unsafe")).toBe(false);
  });

  test("nav rail exposes the mew-style sections", async () => {
    const body = await (await app.request("/")).text();
    expect(body).toContain("Agents");
    expect(body).toContain("飞书连接");
    expect(body).toContain("设置");
  });

  test("creating an agent via POST persists and redirects to its editor", async () => {
    const form = new URLSearchParams({ name: "知识助手", instruction: "简洁作答", model: "", provider: "claude", visibility: "Team" });
    const res = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    const agents = engine.agents.list();
    expect(agents.length).toBe(1);
    expect(agents[0]!.name).toBe("知识助手");
    // the agent editor renders the saved instruction
    const view = await (await app.request(`/agents/${encodeURIComponent(agents[0]!.id)}`)).text();
    expect(view).toContain("简洁作答");
  });

  test("agents page shows detected providers; unavailable ones are disabled", async () => {
    const body = await (await app.request("/agents")).text();
    expect(body).toContain("Claude Code");
    expect(body).toContain("TRAE CLI");
    // codex is unavailable in the stub -> rendered disabled with reason
    expect(body).toContain("不可用");
    expect(body).toContain("node not found");
  });

  test("agents page embeds a per-provider model catalog for the Model dropdown", async () => {
    const body = await (await app.request("/agents")).text();
    // the client-side catalog carries each provider's models (mew: model list
    // changes with provider)
    expect(body).toContain("openrouter-3o"); // trae-cli
    expect(body).toContain("gpt-5.5"); // codex
    expect(body).toContain("sonnet"); // claude
    expect(body).toContain("agent-provider"); // the wired <select> ids
    expect(body).toContain("agent-model");
  });

  test("agent editor shows reserved task-execution fields (marked not-yet-active)", async () => {
    const body = await (await app.request("/agents")).text();
    expect(body).toContain("Workdir");
    expect(body).toContain("Permission");
    expect(body).toContain("Skills");
    expect(body).toContain("任务执行"); // the reserved-section heading
    expect(body).toContain("暂未接入"); // honesty marker
  });

  test("creating an agent persists reserved fields (workdir/permission/skills)", async () => {
    const form = new URLSearchParams({
      name: "任务助手",
      provider: "claude",
      permission: "write",
      workdir: "~/work/proj",
      skills: "code-review, summarize",
    });
    const res = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    const created = engine.agents.list().find((a) => a.name === "任务助手");
    expect(created?.permission).toBe("write");
    expect(created?.workdir).toBe("~/work/proj");
    expect(created?.skills).toEqual(["code-review", "summarize"]);
  });

  test("creating an agent with a local CLI provider persists that provider", async () => {
    const form = new URLSearchParams({ name: "海盗", instruction: "Arrr", model: "", provider: "claude", visibility: "Team" });
    const res = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    const created = engine.agents.list().find((a) => a.name === "海盗");
    expect(created?.provider).toBe("claude");
  });

  test("editing then deleting an agent works", async () => {
    const created = engine.agents.create({ name: "Temp", model: "" });
    const edit = new URLSearchParams({ name: "Renamed", instruction: "x", model: "claude-sonnet-5", visibility: "Team" });
    const r1 = await app.request(`/agents/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: edit.toString(),
    });
    expect([302, 303]).toContain(r1.status);
    expect(engine.agents.get(created.id)?.name).toBe("Renamed");

    const r2 = await app.request(`/agents/${encodeURIComponent(created.id)}/delete`, { method: "POST" });
    expect([302, 303]).toContain(r2.status);
    expect(engine.agents.has(created.id)).toBe(false);
  });

  test("integrations lists team groups and binds per-group settings", async () => {
    const agent = engine.agents.create({ name: "群助手", model: "" });
    const listing = await (await app.request("/integrations")).text();
    expect(listing).toContain("飞书连接");
    expect(listing).toContain('action="/setup/feishu/automatic"');
    expect(listing).toContain("已连接群聊");
    expect(listing).toContain(SPACE); // the seeded team space
    expect(listing).toContain('action="/integrations/groups/team%2Foc_web"');
    expect(listing).toContain("关闭后需要企业批准“接收群内全部消息”敏感权限");

    const form = new URLSearchParams({
      name: "研发群",
      agentId: agent.id,
      // mentionsOnly checkbox omitted => unchecked => respond to all
    });
    form.append("replyInThread", "on");
    const res = await app.request(`/integrations/groups/${encodeURIComponent(SPACE)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    const meta = engine.registry.get(SPACE);
    expect(meta?.name).toBe("研发群");
    expect(meta?.agentId).toBe(agent.id);
    expect(meta?.replyInThread).toBe(true);
    expect(meta?.mentionsOnly).toBe(false);
  });

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

  test("integration setup verifies app credentials and discovers the bot identity", async () => {
    const configured: { appId: string; appSecret: string; brand: string }[] = [];
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          appId: "cli_new",
          brand: "feishu",
          botName: "新机器人",
          botOpenId: "ou_new",
          message: "Bot identity: ready",
        }),
        configure: async (input) => {
          configured.push(input);
          return {
            state: "ready",
            verified: true,
            appId: input.appId,
            brand: input.brand,
            botName: "新机器人",
            botOpenId: "ou_new",
            message: "Bot identity: ready",
          };
        },
      },
    });

    const form = new URLSearchParams({
      appId: "cli_new",
      appSecret: "top-secret-value",
      brand: "feishu",
    });
    const response = await setupApp.request("/integrations/bot/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    expect([302, 303]).toContain(response.status);
    expect(configured).toEqual([
      { appId: "cli_new", appSecret: "top-secret-value", brand: "feishu" },
    ]);
    expect(readSettings(dir)).toEqual(
      expect.objectContaining({ feishuBotName: "新机器人", feishuBotOpenId: "ou_new" }),
    );
    expect(JSON.stringify(readSettings(dir))).not.toContain("top-secret-value");

    const page = await (await setupApp.request("/integrations")).text();
    expect(page).toContain("创建并切换机器人");
    expect(page).toContain("新机器人");
    expect(page).toContain("ou_new");
    expect(page).not.toContain("top-secret-value");
  });

  test("integration setup sends a real test message to a bound group", async () => {
    const sent: { chatId: string; text: string }[] = [];
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      onIntegrationTest: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    });

    const response = await setupApp.request(
      `/integrations/groups/${encodeURIComponent(SPACE)}/test`,
      { method: "POST" },
    );

    expect([302, 303]).toContain(response.status);
    expect(sent).toEqual([
      {
        chatId: "oc_web",
        text: expect.stringContaining("配置测试成功"),
      },
    ]);
    expect(response.headers.get("location")).toContain(encodeURIComponent("测试消息已发送"));
  });

  test("integration setup can re-verify an existing lark-cli profile without a secret", async () => {
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          appId: "cli_existing",
          brand: "feishu",
          botName: "现有机器人",
          botOpenId: "ou_existing",
          message: "Bot identity: ready",
        }),
        configure: async () => {
          throw new Error("not expected");
        },
      },
    });

    const response = await setupApp.request("/integrations/bot/verify", { method: "POST" });

    expect([302, 303]).toContain(response.status);
    expect(readSettings(dir)).toEqual(
      expect.objectContaining({
        feishuBotName: "现有机器人",
        feishuBotOpenId: "ou_existing",
      }),
    );
    expect(response.headers.get("location")).toContain(encodeURIComponent("Bot 身份已同步"));
  });

  test("integration setup shows whether required Feishu event consumers are ready", async () => {
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      feishuRuntime: () => ({
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready" },
          { key: "im.chat.member.bot.added_v1", state: "ready" },
        ],
      }),
    });

    const page = await (await setupApp.request("/integrations")).text();

    expect(page).toContain("消息监听已就绪");
    expect(page).toContain("权限和事件订阅会由飞书自动配置");
    expect(page).not.toContain("im.message.receive_v1");
    expect(page).not.toContain("im.chat.member.bot.added_v1");
  });

  test("integration setup keeps a restart warning until the active connector uses the new identity", async () => {
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      activeFeishuIdentity: { botName: "旧机器人", botOpenId: "ou_old" },
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          appId: "cli_new",
          brand: "feishu",
          botName: "新机器人",
          botOpenId: "ou_new",
          message: "Bot identity: ready",
        }),
        configure: async () => {
          throw new Error("not expected");
        },
      },
      feishuRuntime: () => ({
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready" },
          { key: "im.chat.member.bot.added_v1", state: "ready" },
        ],
      }),
    });

    const page = await (await setupApp.request("/integrations")).text();

    expect(page).toContain("重启后生效");
    expect(page).toContain("创建并切换机器人");
    expect(page).not.toContain("消息监听已就绪");
  });

  test("settings POST persists default provider/model + config and reflects it back", async () => {
    const form = new URLSearchParams({
      defaultProvider: "trae-cli",
      defaultModel: "openrouter-3o",
      dailyBudgetUsd: "12",
      dreamHour: "5",
      webPort: "3000",
      rawRetentionDays: "30",
    });
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    const view = await (await app.request("/settings")).text();
    // the saved default provider is selected and its model shows
    expect(view).toContain("openrouter-3o");
    expect(view).toContain('value="trae-cli" selected');
    // dreamHour value is rendered in the number input
    expect(view).toContain('value="5"');
    expect(view).toContain('name="rawRetentionDays"');
    expect(view).toContain('value="30"');
  });

  test("tasks: nav + create + edit + list rendering", async () => {
    const home = await (await app.request("/tasks")).text();
    expect(home).toContain("任务");
    expect(home).toContain("新建任务");

    const form = new URLSearchParams({ name: "每日AI", space: SPACE, topic: "大模型进展", cadence: "daily", hour: "9" });
    form.append("enabled", "on");
    form.append("notify", "on");
    // distillOnRun checkbox omitted => unchecked => false
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    const created = engine.tasks.list().find((t) => t.name === "每日AI");
    expect(created?.space).toBe(SPACE);
    expect(created?.cadence).toBe("daily");
    expect(created?.hour).toBe(9);
    expect(created?.enabled).toBe(true);
    expect(created?.distillOnRun).toBe(false); // omitted checkbox

    // editor renders the task + the distill toggle
    const editor = await (await app.request(`/tasks/${encodeURIComponent(created!.id)}`)).text();
    expect(editor).toContain("大模型进展");
    expect(editor).toContain("立即运行");
    expect(editor).toContain("完成后立即提炼");
  });

  test("tasks: create with invalid space is rejected with a flash", async () => {
    const form = new URLSearchParams({ name: "bad", space: "not-a-space", topic: "x" });
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get("location")).toContain("ok=");
    expect(engine.tasks.list().length).toBe(0);
  });

  test("tasks: manual run captures output and fires onTaskRun", async () => {
    // make the fake client return research text
    fake.onText(() => "研究结果：要点若干");
    let ranId: string | undefined;
    const app2 = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      onTaskRun: (id) => { ranId = id; },
    });
    const task = engine.tasks.create({ name: "run-me", space: SPACE, topic: "x" })!;
    const res = await app2.request(`/tasks/${encodeURIComponent(task.id)}/run`, { method: "POST" });
    expect([302, 303]).toContain(res.status);
    // runTask is fire-and-forget; give the microtask queue a beat
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.tasks.get(task.id)?.lastStatus).toBe("ok");
    expect(ranId).toBe(task.id);
    // captured into the space as a task raw entry
    expect(engine.registry.store(SPACE).index().listRaw({}).some((r) => r.source === "task")).toBe(true);
  });

  test("tasks: delete removes it", async () => {
    const task = engine.tasks.create({ name: "del", space: SPACE, topic: "x" })!;
    const res = await app.request(`/tasks/${encodeURIComponent(task.id)}/delete`, { method: "POST" });
    expect([302, 303]).toContain(res.status);
    expect(engine.tasks.has(task.id)).toBe(false);
  });
});

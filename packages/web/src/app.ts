/**
 * The management web backend. A Hono app over the same KnowledgeEngine the
 * orchestrator uses. Structured like mew: Spaces/Knowledge, Agents,
 * Integrations, Logs, Settings. Unlike the previous read-only viewer this app
 * mutates state — it creates/edits Agents, binds per-group settings, and edits
 * global settings — via POST forms. It shares one engine instance in production
 * so edits are seen immediately by the orchestrator and scheduler.
 *
 * Authentication is optional for loopback-only use and mandatory at the
 * production entrypoint for non-local binding. All dynamic values render
 * through hono/html (auto-escaped); redirects use the PRG pattern with a ?ok=
 * flash so a refresh doesn't re-POST.
 */
import { Hono } from "hono";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  config,
  saveSettings,
  isSpaceId,
  isLoopbackHost,
  type LarkBotIdentity,
  type LarkProvisioningSession,
  type LarkSetupStatus,
  type SpaceId,
  type PersistedSettings,
  type SystemHealthSnapshot,
} from "@homeagent/shared";
import {
  detectProviders,
  providerModels,
  type CodexLoginSession,
  type DetectedProvider,
} from "@homeagent/llm";
import type { KnowledgeEngine } from "@homeagent/core";
import { layout } from "./layout.ts";
import type { CodexSetupPort, FeishuRuntimeStatus, LarkSetupPort } from "./integrations.ts";
import { buildSetupSnapshot } from "./setup.ts";
import { restartingView, setupLayout, setupView } from "./setup-view.ts";
import {
  resolveExternalSharingState,
  type FeishuExternalSharingStatus,
} from "./external-sharing.ts";
import {
  agentsView,
  askView,
  integrationsView,
  healthView,
  governanceView,
  logsView,
  pageView,
  rawListView,
  remindersView,
  settingsView,
  spaceDetailView,
  spaceListView,
  tasksView,
} from "./views.ts";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface WebOptions {
  engine: KnowledgeEngine;
  /** protects all management routes; liveness/readiness probes remain public */
  adminToken?: string;
  /** process-level health reporter; production wires all runtime components */
  health?: () => Promise<SystemHealthSnapshot>;
  /** injected for tests; defaults to probing local CLIs. */
  detectProviders?: () => Promise<DetectedProvider[]>;
  /** injected for tests; defaults to the live gateway + curated CLI catalog. */
  providerModels?: () => Promise<Record<string, string[]>>;
  /** Configure and verify the local lark-cli application without persisting its secret. */
  larkSetup?: LarkSetupPort;
  /** App-managed Codex installation and ChatGPT authorization. */
  codexSetup?: CodexSetupPort;
  /** Send the setup wizard's explicit test message to a Feishu chat. */
  onIntegrationTest?: (chatId: string, text: string) => Promise<void>;
  /** Current event-consumer readiness, used to verify event subscriptions. */
  feishuRuntime?: () => FeishuRuntimeStatus;
  /** Bot identity snapshotted by the currently running connector. */
  activeFeishuIdentity?: LarkBotIdentity;
  /**
   * Optional hook invoked after a manual task run (backend "立即运行"), so the
   * app can push a summary to feishu. main.ts wires this to connector.notice;
   * unset (tests / no connector) => run still writes to the KB, just no push.
   */
  onTaskRun?: (taskId: string) => void;
  /** Gracefully terminate a launchd-managed process so KeepAlive can restart it. */
  onServiceRestart?: () => void;
}

/** Read a checkbox from a parsed form body (present => true). */
function checkbox(body: Record<string, unknown>, name: string): boolean {
  const v = body[name];
  return v === "on" || v === "true" || v === "1";
}

function str(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  return typeof v === "string" ? v : "";
}

function equalSecret(candidate: string, expected: string): boolean {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const separator = header.indexOf(" ");
  if (separator <= 0) return false;
  const scheme = header.slice(0, separator).toLowerCase();
  const credential = header.slice(separator + 1).trim();
  if (scheme === "bearer") return equalSecret(credential, token);
  if (scheme !== "basic") return false;
  try {
    const decoded = Buffer.from(credential, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon >= 0 && equalSecret(decoded.slice(colon + 1), token);
  } catch {
    return false;
  }
}

function isCrossSiteMutation(request: Request): boolean {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) {
    return false;
  }
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const expectedHost = request.headers.get("x-forwarded-host")
      ?? request.headers.get("host")
      ?? new URL(request.url).host;
    return new URL(origin).host !== expectedHost.split(",", 1)[0]!.trim();
  } catch {
    return true;
  }
}

function requestHostname(request: Request): string {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return "";
  }
}

export function createWebApp(opts: WebOptions): Hono {
  const { engine } = opts;
  const app = new Hono();
  const instanceId = randomUUID();

  if (opts.adminToken) {
    const token = opts.adminToken;
    app.use("*", async (c, next) => {
      if (c.req.path === "/healthz" || c.req.path === "/readyz") return next();
      if (isAuthorized(c.req.header("authorization"), token)) return next();
      c.header("www-authenticate", 'Basic realm="homeagent", charset="UTF-8"');
      return c.text("Unauthorized", 401);
    });
  } else {
    app.use("*", async (c, next) => {
      if (!isLoopbackHost(requestHostname(c.req.raw))) return c.text("Forbidden", 403);
      return next();
    });
  }
  app.use("*", async (c, next) => {
    if (isCrossSiteMutation(c.req.raw)) return c.text("Forbidden", 403);
    return next();
  });

  // Detect local agent CLIs once, lazily, then cache (probing spawns processes).
  const detect = opts.detectProviders ?? detectProviders;
  const listModels = opts.providerModels ?? providerModels;
  const reportHealth =
    opts.health ??
    (async (): Promise<SystemHealthSnapshot> => {
      const core = await engine.health();
      return {
        status: core.ok ? "ok" : "down",
        ready: core.ok,
        checkedAt: Date.now(),
        components: {
          knowledge: {
            status: core.ok ? "ok" : "down",
            summary: core.ok ? "知识引擎可用" : "知识引擎不可用",
            details: core.details,
          },
        },
      };
    });
  const getHealth = async (): Promise<SystemHealthSnapshot> => {
    try {
      return await reportHealth();
    } catch (err) {
      return {
        status: "down",
        ready: false,
        checkedAt: Date.now(),
        components: {
          healthReporter: {
            status: "down",
            summary: "运行状态聚合失败",
            details: { error: String(err) },
          },
        },
      };
    }
  };
  let providerCache: DetectedProvider[] | null = null;
  let modelCache: Record<string, string[]> | null = null;
  let codexInstalling = false;
  let codexInstallError: string | undefined;
  const getProviders = async (): Promise<DetectedProvider[]> => {
    if (!providerCache) providerCache = await detect();
    return providerCache;
  };
  // Model catalog: gateway list is fetched live from /v1/models (cached here so
  // we don't hit it on every render); CLI lists are curated.
  const getModels = async (): Promise<Record<string, string[]>> => {
    if (!modelCache) modelCache = await listModels();
    return modelCache;
  };
  const idleCodexLogin = (): CodexLoginSession => ({
    state: "idle",
    message: "尚未连接 ChatGPT",
  });
  const getCodexLogin = (): CodexLoginSession => {
    try {
      return opts.codexSetup?.deviceLoginStatus() ?? idleCodexLogin();
    } catch {
      return { state: "failed", message: "无法读取 ChatGPT 登录状态，请重试" };
    }
  };
  const isCodexInstalled = (): boolean => {
    try {
      return opts.codexSetup?.isInstalled() ?? false;
    } catch {
      return false;
    }
  };
  const persistReadyCodex = (session: CodexLoginSession): void => {
    if (session.state !== "ready") return;
    const current = config();
    if (current.defaultProvider !== "codex" || current.defaultModel) {
      saveSettings({ defaultProvider: "codex", defaultModel: "" });
    }
    providerCache = null;
  };
  const startCodexLogin = (): void => {
    if (!opts.codexSetup) return;
    codexInstallError = undefined;
    void opts.codexSetup.startDeviceLogin().then(persistReadyCodex).catch(() => {
      codexInstallError = "ChatGPT 登录未完成，请重试";
    });
  };
  const getLarkStatus = async (): Promise<LarkSetupStatus> => {
    if (!opts.larkSetup) {
      return {
        state: "unavailable",
        verified: false,
        message: "当前运行方式未接入 lark-cli 配置服务",
      };
    }
    try {
      return await opts.larkSetup.status();
    } catch {
      return {
        state: "invalid",
        verified: false,
        message: "无法读取 lark-cli 连接状态",
      };
    }
  };
  const getFeishuRuntime = (): FeishuRuntimeStatus | undefined => {
    try {
      return opts.feishuRuntime?.();
    } catch {
      return { ready: false, consumers: [] };
    }
  };
  const persistVerifiedBot = (status: LarkSetupStatus): boolean => {
    const identity = verifiedBotIdentity(status);
    if (!identity) return false;
    saveSettings({
      feishuBotName: identity.botName,
      feishuBotOpenId: identity.botOpenId,
    });
    return true;
  };
  const idleProvisioning = (): LarkProvisioningSession => ({
    state: "idle",
    brand: "feishu",
    message: opts.larkSetup ? "尚未开始创建飞书应用" : "未检测到飞书配置组件",
  });
  const getProvisioning = (): LarkProvisioningSession => {
    try {
      return opts.larkSetup?.provisioningStatus?.() ?? idleProvisioning();
    } catch {
      return {
        state: "failed",
        brand: "feishu",
        message: "无法读取飞书应用创建状态，请重试",
      };
    }
  };
  const getExternalSharing = async (
    status: LarkSetupStatus,
  ): Promise<FeishuExternalSharingStatus> => {
    if (
      status.state !== "ready"
      || !status.verified
      || !status.appId
      || status.brand === "lark"
    ) {
      return { state: "skipped" };
    }
    let sharing = resolveExternalSharingState(config(), status.appId);
    if (
      sharing.state === "awaiting_external_message"
      && sharing.startedAt
      && opts.larkSetup?.chatIsExternal
    ) {
      const candidates = new Map<string, string | undefined>();
      for (const meta of engine.registry.list().filter((entry) => entry.id.startsWith("team/"))) {
        const messages = engine.registry.store(meta.id).index().listRaw({}).filter(
          (entry) => entry.source === "message" && entry.createdAt >= sharing.startedAt!,
        );
        for (const entry of messages) {
          const chatId = entry.chatId ?? meta.chatId ?? meta.id.slice("team/".length);
          if (chatId) candidates.set(chatId, meta.name);
        }
      }
      for (const [chatId, groupName] of candidates) {
        let external = false;
        try {
          external = await opts.larkSetup.chatIsExternal(chatId);
        } catch {
          external = false;
        }
        if (!external) continue;
        saveSettings({
          feishuExternalSharingVerifiedAt: Date.now(),
          feishuExternalSharingVerifiedChatId: chatId,
        });
        sharing = {
          ...resolveExternalSharingState(config(), status.appId),
          ...(groupName ? { verifiedGroupName: groupName } : {}),
        };
        break;
      }
    }
    if (sharing.state === "verified" && !sharing.verifiedGroupName && sharing.verifiedChatId) {
      const group = engine.registry.list().find((meta) =>
        meta.chatId === sharing.verifiedChatId
        || meta.id === `team/${sharing.verifiedChatId}`
      );
      if (group?.name) sharing = { ...sharing, verifiedGroupName: group.name };
    }
    return sharing;
  };
  const integrationIdentityState = (status: LarkSetupStatus) => {
    const setupIdentity = verifiedBotIdentity(status);
    const activeIdentity = opts.activeFeishuIdentity;
    const restartRequired = Boolean(setupIdentity) && (
      !activeIdentity
      || activeIdentity.botName !== setupIdentity!.botName
      || activeIdentity.botOpenId !== setupIdentity!.botOpenId
    );
    return { setupIdentity, restartRequired };
  };
  const getSetupContext = async () => {
    let lark = await getLarkStatus();
    const provisioning = getProvisioning();
    const codexLogin = getCodexLogin();
    persistReadyCodex(codexLogin);
    const before = config();
    const identity = verifiedBotIdentity(lark);
    if (
      identity
      && (before.feishuBotName !== identity.botName || before.feishuBotOpenId !== identity.botOpenId)
    ) {
      persistVerifiedBot(lark);
      lark = await getLarkStatus();
    }
    let cfg = config();
    if (!cfg.onboardingCompletedAt && !cfg.onboardingStartedAt) {
      saveSettings({ onboardingStartedAt: Date.now() });
      cfg = config();
    }
    const providers = await getProviders();
    const runtime = getFeishuRuntime() ?? { ready: false, consumers: [] };
    const groups = engine.registry.list().filter((meta) => meta.id.startsWith("team/"));
    const setupStartedAt = cfg.onboardingStartedAt ?? Number.POSITIVE_INFINITY;
    const groupsWithMessages = groups.filter((meta) =>
      engine.registry.store(meta.id).index().listRaw({}).some(
        (entry) => entry.source === "message" && entry.createdAt >= setupStartedAt,
      )
    ).length;
    const { restartRequired } = integrationIdentityState(lark);
    const externalSharing = await getExternalSharing(lark);
    const health = await getHealth();
    const restartable = health.components.service?.details?.managed === true
      && opts.onServiceRestart !== undefined;
    return {
      snapshot: buildSetupSnapshot({
        defaultProvider: cfg.defaultProvider,
        providers,
        lark,
        runtime,
        restartRequired,
        groups: groupsWithMessages,
        completedAt: cfg.onboardingCompletedAt,
        externalSharing: externalSharing.state,
      }),
      providers,
      lark,
      provisioning,
      runtime,
      externalSharing,
      groups,
      restartRequired,
      restartable,
      codex: {
        enabled: opts.codexSetup !== undefined,
        canInstall: opts.codexSetup?.canInstall ?? false,
        installed: isCodexInstalled(),
        installing: codexInstalling,
        ...(codexInstallError ? { installError: codexInstallError } : {}),
        login: codexLogin,
      },
    };
  };

  const parseSpace = (raw: string): SpaceId | null => {
    const decoded = decodeURIComponent(raw);
    return isSpaceId(decoded) ? decoded : null;
  };

  // ---- health probes ------------------------------------------------------

  app.get("/healthz", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ status: "ok", checkedAt: Date.now(), instanceId, pid: process.pid });
  });

  app.get("/readyz", async (c) => {
    c.header("cache-control", "no-store");
    const snapshot = await getHealth();
    return snapshot.ready ? c.json(snapshot) : c.json(snapshot, 503);
  });

  app.get("/health", async (c) => {
    return c.html(
      await layout(
        "运行状态",
        [{ label: "运行状态" }],
        await healthView(
          await getHealth(),
          c.req.query("ok") ?? undefined,
          opts.onServiceRestart !== undefined,
        ),
        "health",
      ),
    );
  });

  app.post("/service/restart", async (c) => {
    const snapshot = await getHealth();
    const managed = snapshot.components.service?.details?.managed === true;
    if (!managed || !opts.onServiceRestart) return c.text("Service restart unavailable", 409);
    opts.onServiceRestart();
    return c.redirect(`/health?ok=${encodeURIComponent("已请求后台服务安全重启")}`);
  });

  // ---- guided first-run setup --------------------------------------------

  app.get("/setup", async (c) => {
    const setup = await getSetupContext();
    return c.html(
      await setupLayout(
        await setupView({
          ...setup,
          models: await getModels(),
          flashMsg: c.req.query("ok") ?? undefined,
        }),
      ),
    );
  });

  app.post("/setup/providers/refresh", (c) => {
    providerCache = null;
    return c.redirect("/setup");
  });

  app.post("/setup/ai/codex/install", async (c) => {
    if (!opts.codexSetup?.canInstall) {
      return c.redirect(`/setup?ok=${encodeURIComponent("当前运行方式不支持自动安装 Codex")}`);
    }
    const body = await c.req.parseBody();
    if (!checkbox(body, "consent")) {
      return c.redirect(`/setup?ok=${encodeURIComponent("需要确认后才能安装 Codex")}`);
    }
    if (!codexInstalling) {
      codexInstalling = true;
      codexInstallError = undefined;
      void opts.codexSetup.install(true).then(() => {
        codexInstalling = false;
        providerCache = null;
        startCodexLogin();
      }).catch(() => {
        codexInstalling = false;
        codexInstallError = "Codex 安装未完成，请重试";
      });
    }
    return c.redirect(`/setup?ok=${encodeURIComponent("正在准备 Codex")}`);
  });

  app.post("/setup/ai/codex/login", (c) => {
    if (!opts.codexSetup) {
      return c.redirect(`/setup?ok=${encodeURIComponent("当前运行方式未接入 ChatGPT 登录")}`);
    }
    startCodexLogin();
    return c.redirect(`/setup?ok=${encodeURIComponent("正在打开 ChatGPT 登录")}`);
  });

  app.get("/setup/ai/codex/session", (c) => {
    c.header("cache-control", "no-store");
    if (codexInstalling) {
      return c.json({ state: "installing", message: "正在下载并校验 OpenAI 官方 Codex" });
    }
    if (codexInstallError) return c.json({ state: "failed", message: codexInstallError });
    const session = getCodexLogin();
    persistReadyCodex(session);
    return c.json(session);
  });

  app.post("/setup/ai/codex/cancel", (c) => {
    opts.codexSetup?.cancelDeviceLogin();
    return c.redirect("/setup");
  });

  app.post("/setup/ai", async (c) => {
    const body = await c.req.parseBody();
    const provider = str(body, "provider");
    const available = (await getProviders()).some(
      (candidate) => candidate.id === provider && candidate.available,
    );
    if (!available) {
      return c.redirect(`/setup?ok=${encodeURIComponent("所选 AI 尚未安装或无法运行")}`);
    }
    const model = str(body, "model");
    const models = await getModels();
    if (model && !(models[provider] ?? []).includes(model)) {
      return c.redirect(`/setup?ok=${encodeURIComponent("所选模型不属于这个 AI，请重新选择")}`);
    }
    saveSettings({ defaultProvider: provider, defaultModel: model });
    return c.redirect("/setup");
  });

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

  app.get("/setup/feishu/session", async (c) => {
    c.header("cache-control", "no-store");
    const session = getProvisioning();
    if (session.state === "ready") {
      const status = await getLarkStatus();
      persistVerifiedBot(status);
    }
    return c.json(session);
  });

  app.post("/setup/feishu/external-sharing/start", async (c) => {
    const body = await c.req.parseBody();
    const returnTo = str(body, "returnTo") === "/integrations" ? "/integrations" : "/setup";
    const status = await getLarkStatus();
    if (
      status.state !== "ready"
      || !status.verified
      || !status.appId
      || status.brand === "lark"
    ) {
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("请先完成飞书机器人连接，再配置对外共享")}`);
    }
    saveSettings({
      feishuExternalSharingAppId: status.appId,
      feishuExternalSharingStartedAt: Date.now(),
      feishuExternalSharingVerifiedAt: 0,
      feishuExternalSharingVerifiedChatId: "",
      feishuExternalSharingSkippedAppId: "",
    });
    return c.redirect(`${returnTo}?ok=${encodeURIComponent("已开始验证；如提示需要重启，请先激活消息监听")}`);
  });

  app.post("/setup/feishu/external-sharing/skip", async (c) => {
    const body = await c.req.parseBody();
    const returnTo = str(body, "returnTo") === "/integrations" ? "/integrations" : "/setup";
    const status = await getLarkStatus();
    if (
      status.state !== "ready"
      || !status.verified
      || !status.appId
      || status.brand === "lark"
    ) {
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("请先完成飞书机器人连接")}`);
    }
    saveSettings({
      feishuExternalSharingAppId: "",
      feishuExternalSharingStartedAt: 0,
      feishuExternalSharingVerifiedAt: 0,
      feishuExternalSharingVerifiedChatId: "",
      feishuExternalSharingSkippedAppId: status.appId,
    });
    return c.redirect(`${returnTo}?ok=${encodeURIComponent("当前机器人将暂时仅供企业内部使用")}`);
  });

  app.post("/setup/restart", async (c) => {
    const snapshot = await getHealth();
    const managed = snapshot.components.service?.details?.managed === true;
    if (!managed || !opts.onServiceRestart) {
      return c.redirect(`/setup?ok=${encodeURIComponent("当前为终端运行，请停止后重新执行 bun start")}`);
    }
    opts.onServiceRestart();
    return c.html(await restartingView(instanceId));
  });

  app.post("/setup/finish", async (c) => {
    const setup = await getSetupContext();
    if (setup.snapshot.current !== "invite" && setup.snapshot.current !== "done") {
      return c.redirect(`/setup?ok=${encodeURIComponent("请先完成 AI、飞书机器人和消息监听设置")}`);
    }
    saveSettings({ onboardingCompletedAt: Date.now() });
    return c.redirect("/");
  });

  // ---- data governance ---------------------------------------------------

  app.get("/governance", async (c) => {
    const spaces = engine.registry.list().map((meta) => {
      const index = engine.registry.store(meta.id).index();
      return {
        meta,
        pages: index.countPages(),
        raw: index.countRaw(),
        pending: index.countRaw(true),
        tasks: engine.tasks.list().filter((task) => task.space === meta.id).length,
      };
    });
    return c.html(
      await layout(
        "数据治理",
        [{ label: "数据治理" }],
        await governanceView(spaces, config().rawRetentionDays, c.req.query("ok") ?? undefined),
        "governance",
      ),
    );
  });

  app.get("/spaces/:space/export", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const archive = await engine.exportSpace(space);
    const filename = `${space.replace(/[^a-zA-Z0-9._-]+/g, "-")}.homeagent.json`;
    c.header("content-type", "application/json; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${filename}"`);
    c.header("cache-control", "no-store");
    return c.body(JSON.stringify(archive, null, 2));
  });

  app.post("/spaces/:space/delete", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space) return c.notFound();
    try {
      const result = await engine.deleteSpace(space);
      const message = result.status === "deleted"
        ? `已删除 ${space}：${result.pagesDeleted} 个知识页、${result.rawDeleted} 条原始记录、${result.tasksDeleted} 个任务、${result.remindersDeleted} 个提醒`
        : `空间不存在：${space}`;
      return c.redirect(`/governance?ok=${encodeURIComponent(message)}`);
    } catch (err) {
      return c.redirect(`/governance?ok=${encodeURIComponent(`删除失败：${String(err)}`)}`);
    }
  });

  app.post("/governance/restore", async (c) => {
    try {
      const body = await c.req.parseBody();
      const upload = body.archive;
      if (!upload || typeof upload === "string") throw new Error("请选择 JSON 归档文件");
      if (upload.size > 50 * 1024 * 1024) throw new Error("归档文件不能超过 50 MB");
      const archive = JSON.parse(await upload.text()) as unknown;
      const restoredSpace = await engine.restoreSpace(archive);
      return c.redirect(`/governance?ok=${encodeURIComponent(`已恢复空间 ${restoredSpace}`)}`);
    } catch (err) {
      return c.redirect(`/governance?ok=${encodeURIComponent(`恢复失败：${String(err)}`)}`);
    }
  });

  app.post("/governance/prune", async (c) => {
    try {
      const report = await engine.pruneRawMessages(config().rawRetentionDays);
      const message = report.retentionDays === 0
        ? "原始消息保留为永久，未执行清理"
        : `已清理 ${report.deleted} 条超过 ${report.retentionDays} 天的已提炼消息`;
      return c.redirect(`/governance?ok=${encodeURIComponent(message)}`);
    } catch (err) {
      return c.redirect(`/governance?ok=${encodeURIComponent(`清理失败：${String(err)}`)}`);
    }
  });

  // ---- spaces / knowledge --------------------------------------------------

  app.get("/", async (c) => {
    if (!config().onboardingCompletedAt) {
      const emptyInstall = engine.registry.list().length === 0 && engine.agents.list().length === 0;
      const larkUnconfigured = opts.larkSetup
        ? !verifiedBotIdentity(await getLarkStatus())
        : false;
      if (emptyInstall || larkUnconfigured) return c.redirect("/setup");
    }
    const spaces = engine.registry.list().map((meta) => {
      const idx = engine.registry.store(meta.id).index();
      return { meta, pages: idx.countPages(), pending: idx.countRaw(true) };
    });
    return c.html(await layout("空间", [{ label: "空间 / 知识" }], await spaceListView(spaces), "spaces"));
  });

  app.get("/spaces/:space", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const pages = await engine.listPages(space);
    const rawCount = engine.registry.store(space).index().countRaw();
    const meta = engine.registry.get(space);
    return c.html(
      await layout(space, [{ label: "空间 / 知识", href: "/" }, { label: space }], await spaceDetailView(space, pages, rawCount, meta), "spaces"),
    );
  });

  app.get("/spaces/:space/pages/:slug{.+}", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const slug = decodeURIComponent(c.req.param("slug"));
    const page = await engine.getPage(space, slug);
    if (!page) return c.notFound();
    return c.html(
      await layout(
        page.title,
        [{ label: "空间 / 知识", href: "/" }, { label: space, href: `/spaces/${encodeURIComponent(space)}` }, { label: page.title }],
        await pageView(space, page),
        "spaces",
      ),
    );
  });

  app.get("/spaces/:space/raw", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const raws = engine.registry.store(space).index().listRaw({ limit: 300 });
    return c.html(
      await layout(
        `原始条目 · ${space}`,
        [{ label: "空间 / 知识", href: "/" }, { label: space, href: `/spaces/${encodeURIComponent(space)}` }, { label: "原始条目" }],
        await rawListView(space, raws.reverse()),
        "spaces",
      ),
    );
  });

  app.get("/spaces/:space/ask", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const q = c.req.query("q") ?? null;
    // The engine routes to the space's agent CLI (or the default). We pass
    // model/instruction so the test box reflects what the group would get.
    const agent = engine.agentForSpace(space);
    let result = null;
    if (q && q.trim()) {
      try {
        result = await engine.ask([space], q, {
          model: agent?.model || undefined,
          instruction: agent?.instruction || undefined,
        });
      } catch {
        result = {
          answer: "⚠️ 无法作答：本空间没有可用的回答 Agent。请在 Integrations 指定 Agent 或在设置里配置默认 CLI。",
          source: "general" as const,
          citations: [],
        };
      }
    }
    return c.html(
      await layout(
        `问答测试 · ${space}`,
        [{ label: "空间 / 知识", href: "/" }, { label: space, href: `/spaces/${encodeURIComponent(space)}` }, { label: "问答测试" }],
        await askView(space, q, result),
        "spaces",
      ),
    );
  });

  app.post("/spaces/:space/dream", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    // Per-space agent model, if assigned. Fire-and-forget.
    const model = engine.agentForSpace(space)?.model || undefined;
    void engine.runDreamCycle(space, { model }).catch(() => {});
    return c.redirect(`/spaces/${encodeURIComponent(space)}`);
  });

  // ---- Agents --------------------------------------------------------------

  app.get("/agents", async (c) => {
    const agents = engine.agents.list();
    const ok = c.req.query("ok") ?? undefined;
    const cfg = config();
    return c.html(
      await layout(
        "Agents",
        [{ label: "Agents" }],
        await agentsView(
          agents,
          null,
          await getProviders(),
          await getModels(),
          { provider: cfg.defaultProvider, model: cfg.defaultModel },
          ok,
        ),
        "agents",
      ),
    );
  });

  app.get("/agents/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const agent = engine.agents.get(id);
    if (!agent) return c.notFound();
    const ok = c.req.query("ok") ?? undefined;
    const cfg = config();
    return c.html(
      await layout(
        agent.name,
        [{ label: "Agents", href: "/agents" }, { label: agent.name }],
        await agentsView(
          engine.agents.list(),
          agent,
          await getProviders(),
          await getModels(),
          { provider: cfg.defaultProvider, model: cfg.defaultModel },
          ok,
        ),
        "agents",
      ),
    );
  });

  app.post("/agents", async (c) => {
    const body = await c.req.parseBody();
    const agent = engine.agents.create({
      name: str(body, "name"),
      instruction: str(body, "instruction"),
      model: str(body, "model"),
      reasoningEffort: str(body, "reasoningEffort"),
      provider: str(body, "provider"),
      visibility: str(body, "visibility"),
      workdir: str(body, "workdir"),
      permission: str(body, "permission"),
      skills: str(body, "skills"),
    });
    return c.redirect(`/agents/${encodeURIComponent(agent.id)}?ok=${encodeURIComponent("已创建")}`);
  });

  app.post("/agents/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!engine.agents.has(id)) return c.notFound();
    const body = await c.req.parseBody();
    engine.agents.update(id, {
      name: str(body, "name"),
      instruction: str(body, "instruction"),
      model: str(body, "model"),
      reasoningEffort: str(body, "reasoningEffort"),
      provider: str(body, "provider"),
      visibility: str(body, "visibility"),
      workdir: str(body, "workdir"),
      permission: str(body, "permission"),
      skills: str(body, "skills"),
    });
    return c.redirect(`/agents/${encodeURIComponent(id)}?ok=${encodeURIComponent("已保存")}`);
  });

  app.post("/agents/:id/delete", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    engine.agents.remove(id);
    return c.redirect(`/agents?ok=${encodeURIComponent("已删除")}`);
  });

  // ---- Tasks ---------------------------------------------------------------

  app.get("/tasks", async (c) => {
    const ok = c.req.query("ok") ?? undefined;
    return c.html(
      await layout("任务", [{ label: "任务" }], await tasksView(engine.tasks.list(), null, engine.registry.list(), ok), "tasks"),
    );
  });

  app.get("/tasks/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const task = engine.tasks.get(id);
    if (!task) return c.notFound();
    const ok = c.req.query("ok") ?? undefined;
    return c.html(
      await layout(
        task.name,
        [{ label: "任务", href: "/tasks" }, { label: task.name }],
        await tasksView(engine.tasks.list(), task, engine.registry.list(), ok),
        "tasks",
      ),
    );
  });

  app.post("/tasks", async (c) => {
    const body = await c.req.parseBody();
    const task = engine.tasks.create({
      name: str(body, "name"),
      space: str(body, "space"),
      topic: str(body, "topic"),
      cadence: str(body, "cadence"),
      hour: Number(str(body, "hour")),
      enabled: checkbox(body, "enabled"),
      notify: checkbox(body, "notify"),
      distillOnRun: checkbox(body, "distillOnRun"),
    });
    if (!task) return c.redirect(`/tasks?ok=${encodeURIComponent("创建失败：请选择有效空间")}`);
    return c.redirect(`/tasks/${encodeURIComponent(task.id)}?ok=${encodeURIComponent("已创建")}`);
  });

  app.post("/tasks/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!engine.tasks.has(id)) return c.notFound();
    const body = await c.req.parseBody();
    engine.tasks.update(id, {
      name: str(body, "name"),
      space: str(body, "space"),
      topic: str(body, "topic"),
      cadence: str(body, "cadence"),
      hour: Number(str(body, "hour")),
      enabled: checkbox(body, "enabled"),
      notify: checkbox(body, "notify"),
      distillOnRun: checkbox(body, "distillOnRun"),
    });
    return c.redirect(`/tasks/${encodeURIComponent(id)}?ok=${encodeURIComponent("已保存")}`);
  });

  app.post("/tasks/:id/delete", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    engine.tasks.remove(id);
    return c.redirect(`/tasks?ok=${encodeURIComponent("已删除")}`);
  });

  app.post("/tasks/:id/run", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!engine.tasks.has(id)) return c.notFound();
    // Fire-and-forget: research is long-running. The list shows status on reload.
    void engine
      .runTask(id)
      .then((report) => {
        if (report.ok) opts.onTaskRun?.(id);
      })
      .catch(() => {});
    return c.redirect(`/tasks/${encodeURIComponent(id)}?ok=${encodeURIComponent("任务已开始，完成后刷新查看结果")}`);
  });

  // ---- Reminders -----------------------------------------------------------

  app.get("/reminders", async (c) => {
    const ok = c.req.query("ok") ?? undefined;
    return c.html(
      await layout(
        "提醒",
        [{ label: "提醒" }],
        await remindersView(engine.reminders.list(), ok),
        "reminders",
      ),
    );
  });

  app.post("/reminders/:id/complete", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const reminder = engine.reminders.get(id);
    if (!reminder) return c.notFound();
    engine.reminders.complete(id, reminder.creatorId);
    return c.redirect(`/reminders?ok=${encodeURIComponent("已标记完成")}`);
  });

  app.post("/reminders/:id/cancel", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const reminder = engine.reminders.get(id);
    if (!reminder) return c.notFound();
    engine.reminders.cancel(id, reminder.creatorId);
    return c.redirect(`/reminders?ok=${encodeURIComponent("已取消")}`);
  });

  // ---- Integrations --------------------------------------------------------

  app.get("/integrations", async (c) => {
    const cfg = config();
    const groups = engine.registry.list().filter((m) => m.id.startsWith("team/"));
    const agents = engine.agents.list();
    const ok = c.req.query("ok") ?? undefined;
    const setupStatus = await getLarkStatus();
    const { restartRequired } = integrationIdentityState(setupStatus);
    const externalSharing = await getExternalSharing(setupStatus);
    return c.html(
      await layout(
        "Integrations",
        [{ label: "Integrations" }],
        await integrationsView({
          botName: cfg.feishuBotName ?? "",
          botOpenId: cfg.feishuBotOpenId ?? "",
          setup: setupStatus,
          provisioning: getProvisioning(),
          restartRequired,
          runtime: getFeishuRuntime(),
          externalSharing,
          groups,
          agents,
          flashMsg: ok,
        }),
        "integrations",
      ),
    );
  });

  app.post("/integrations/bot/setup", async (c) => {
    const body = await c.req.parseBody();
    const returnTo = str(body, "returnTo") === "/setup" ? "/setup" : "/integrations";
    if (!opts.larkSetup) {
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("配置失败：当前运行方式未接入 lark-cli")}`);
    }
    const appId = str(body, "appId").trim();
    const appSecret = str(body, "appSecret");
    const brand = str(body, "brand") === "lark" ? "lark" : "feishu";
    if (!appId || !appSecret) {
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("配置失败：App ID 和 App Secret 均为必填")}`);
    }
    try {
      const status = await opts.larkSetup.configure({ appId, appSecret, brand });
      if (!persistVerifiedBot(status)) {
        return c.redirect(`${returnTo}?ok=${encodeURIComponent("配置失败：应用凭据未能验证 Bot 身份")}`);
      }
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("连接已验证，Bot 身份已自动保存；重启服务后消息监听使用新应用")}`);
    } catch {
      // Deliberately avoid echoing the exception: CLI errors can include input
      // context, while App Secret must never be rendered back to the browser.
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("配置失败：请检查 App ID、App Secret 和网络后重试")}`);
    }
  });

  app.post("/integrations/bot/verify", async (c) => {
    const status = await getLarkStatus();
    if (!persistVerifiedBot(status)) {
      return c.redirect(`/integrations?ok=${encodeURIComponent("验证失败：lark-cli Bot 身份尚未就绪")}`);
    }
    return c.redirect(`/integrations?ok=${encodeURIComponent("连接已验证，Bot 身份已同步；身份变更需重启服务")}`);
  });

  app.post("/integrations/bot", async (c) => {
    const body = await c.req.parseBody();
    saveSettings({
      feishuBotName: str(body, "feishuBotName"),
      feishuBotOpenId: str(body, "feishuBotOpenId"),
    });
    return c.redirect(`/integrations?ok=${encodeURIComponent("已保存 Bot 身份（重启后生效）")}`);
  });

  app.post("/integrations/groups/:space", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const body = await c.req.parseBody();
    engine.registry.updateMeta(space, {
      name: str(body, "name"),
      agentId: str(body, "agentId"),
      replyInThread: checkbox(body, "replyInThread"),
      mentionsOnly: checkbox(body, "mentionsOnly"),
    });
    return c.redirect(`/integrations?ok=${encodeURIComponent("已保存群设置")}`);
  });

  app.post("/integrations/groups/:space/test", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !space.startsWith("team/") || !engine.registry.has(space)) return c.notFound();
    if (!opts.onIntegrationTest) {
      return c.redirect(`/integrations?ok=${encodeURIComponent("测试失败：当前运行方式未连接飞书发送通道")}`);
    }
    const meta = engine.registry.get(space);
    const chatId = meta?.chatId ?? space.slice("team/".length);
    if (!chatId) {
      return c.redirect(`/integrations?ok=${encodeURIComponent("测试失败：该群没有可用的 chat_id")}`);
    }
    try {
      await opts.onIntegrationTest(
        chatId,
        "✅ homeagent 配置测试成功：机器人发送通道可用。现在可以在群里 @我 提问。",
      );
      return c.redirect(`/integrations?ok=${encodeURIComponent("测试消息已发送，请到目标群确认")}`);
    } catch {
      return c.redirect(`/integrations?ok=${encodeURIComponent("测试失败：请检查发送消息权限、机器人可用范围和群成员状态")}`);
    }
  });

  // ---- Settings ------------------------------------------------------------

  app.get("/settings", async (c) => {
    const cfg = config();
    const ok = c.req.query("ok") ?? undefined;
    return c.html(
      await layout(
        "设置",
        [{ label: "设置" }],
        await settingsView(
          {
            defaultProvider: cfg.defaultProvider,
            defaultModel: cfg.defaultModel,
            dailyBudgetUsd: cfg.dailyBudgetUsd,
            dreamHour: cfg.dreamHour,
            rawRetentionDays: cfg.rawRetentionDays,
            webPort: cfg.webPort,
          },
          await getProviders(),
          await getModels(),
          ok,
        ),
        "settings",
      ),
    );
  });

  app.post("/settings", async (c) => {
    const body = await c.req.parseBody();
    const patch: PersistedSettings = {
      defaultProvider: str(body, "defaultProvider"),
      defaultModel: str(body, "defaultModel"),
    };
    const budget = Number(str(body, "dailyBudgetUsd"));
    if (Number.isFinite(budget)) patch.dailyBudgetUsd = budget;
    const hour = Number(str(body, "dreamHour"));
    if (Number.isFinite(hour)) patch.dreamHour = Math.max(0, Math.min(23, Math.trunc(hour)));
    const retentionDays = Number(str(body, "rawRetentionDays"));
    if (Number.isFinite(retentionDays)) {
      patch.rawRetentionDays = Math.max(0, Math.min(36_500, Math.trunc(retentionDays)));
    }
    const port = Number(str(body, "webPort"));
    if (Number.isFinite(port)) patch.webPort = Math.trunc(port);
    saveSettings(patch);
    return c.redirect(`/settings?ok=${encodeURIComponent("已保存设置")}`);
  });

  // ---- logs ----------------------------------------------------------------

  app.get("/logs", async (c) => {
    const logs = readLogs();
    return c.html(await layout("调用日志", [{ label: "调用日志" }], await logsView(logs), "logs"));
  });

  return app;
}

function verifiedBotIdentity(status: LarkSetupStatus): LarkBotIdentity | undefined {
  if (status.state !== "ready" || !status.verified || !status.botName || !status.botOpenId) {
    return undefined;
  }
  return { botName: status.botName, botOpenId: status.botOpenId };
}

/** Read the last few days of LLM call logs from data/logs/*.jsonl. */
function readLogs(): { day: string; lines: string[] }[] {
  const dir = join(config().dataDir, "logs");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("llm-") && f.endsWith(".jsonl"))
    .sort()
    .reverse()
    .slice(0, 3);
  return files.map((f) => {
    const day = f.replace(/^llm-|\.jsonl$/g, "");
    const lines = readFileSync(join(dir, f), "utf8").trim().split("\n").slice(-200);
    return { day, lines };
  });
}

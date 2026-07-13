/**
 * The management web backend. A Hono app over the same KnowledgeEngine the
 * orchestrator uses. Structured like mew: Spaces/Knowledge, Agents,
 * Integrations, Logs, Settings. Unlike the previous read-only viewer this app
 * mutates state — it creates/edits Agents, binds per-group settings, and edits
 * global settings — via POST forms. It shares one engine instance in production
 * so edits are seen immediately by the orchestrator and scheduler.
 *
 * No auth: intended for internal/localhost use (per product decision). All
 * dynamic values render through hono/html (auto-escaped); redirects use the
 * PRG pattern with a ?ok= flash so a refresh doesn't re-POST.
 */
import { Hono } from "hono";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  config,
  saveSettings,
  isSpaceId,
  type SpaceId,
  type PersistedSettings,
  type SystemHealthSnapshot,
} from "@homebrain/shared";
import { detectProviders, providerModels, type DetectedProvider } from "@homebrain/llm";
import type { KnowledgeEngine } from "@homebrain/core";
import { layout } from "./layout.ts";
import {
  agentsView,
  askView,
  integrationsView,
  healthView,
  logsView,
  pageView,
  rawListView,
  settingsView,
  spaceDetailView,
  spaceListView,
  tasksView,
} from "./views.ts";

export interface WebOptions {
  engine: KnowledgeEngine;
  /** process-level health reporter; production wires all runtime components */
  health?: () => Promise<SystemHealthSnapshot>;
  /** injected for tests; defaults to probing local CLIs. */
  detectProviders?: () => Promise<DetectedProvider[]>;
  /** injected for tests; defaults to the live gateway + curated CLI catalog. */
  providerModels?: () => Promise<Record<string, string[]>>;
  /**
   * Optional hook invoked after a manual task run (backend "立即运行"), so the
   * app can push a summary to feishu. main.ts wires this to connector.notice;
   * unset (tests / no connector) => run still writes to the KB, just no push.
   */
  onTaskRun?: (taskId: string) => void;
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

export function createWebApp(opts: WebOptions): Hono {
  const { engine } = opts;
  const app = new Hono();

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

  const parseSpace = (raw: string): SpaceId | null => {
    const decoded = decodeURIComponent(raw);
    return isSpaceId(decoded) ? decoded : null;
  };

  // ---- health probes ------------------------------------------------------

  app.get("/healthz", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ status: "ok", checkedAt: Date.now() });
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
        await healthView(await getHealth()),
        "health",
      ),
    );
  });

  // ---- spaces / knowledge --------------------------------------------------

  app.get("/", async (c) => {
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
    return c.html(await layout("Agents", [{ label: "Agents" }], await agentsView(agents, null, await getProviders(), await getModels(), ok), "agents"));
  });

  app.get("/agents/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const agent = engine.agents.get(id);
    if (!agent) return c.notFound();
    const ok = c.req.query("ok") ?? undefined;
    return c.html(
      await layout(
        agent.name,
        [{ label: "Agents", href: "/agents" }, { label: agent.name }],
        await agentsView(engine.agents.list(), agent, await getProviders(), await getModels(), ok),
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

  // ---- Integrations --------------------------------------------------------

  app.get("/integrations", async (c) => {
    const cfg = config();
    const groups = engine.registry.list().filter((m) => m.id.startsWith("team/"));
    const agents = engine.agents.list();
    const ok = c.req.query("ok") ?? undefined;
    return c.html(
      await layout(
        "Integrations",
        [{ label: "Integrations" }],
        await integrationsView(cfg.feishuBotName ?? "", cfg.feishuBotOpenId ?? "", groups, agents, ok),
        "integrations",
      ),
    );
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

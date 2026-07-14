/**
 * homebrain production entrypoint. Assembles the full system over one shared
 * KnowledgeEngine:
 *   - the feishu connector + orchestrator (inbound events -> knowledge + replies)
 *   - the read-only web backend (Bun.serve + Hono)
 *   - the dream-cycle scheduler (nightly + startup catch-up)
 * and shuts everything down gracefully on SIGINT/SIGTERM (propagating SIGTERM to
 * the lark-cli consumers — never kill -9).
 */
import { assertSafeWebBinding, config, logger } from "@homebrain/shared";
import { KnowledgeEngine } from "@homebrain/core";
import { FeishuConnector, LarkCliSetup } from "@homebrain/connectors";
import { Orchestrator } from "@homebrain/orchestrator";
import { createWebApp } from "@homebrain/web";
import { Scheduler } from "./scheduler.ts";
import { TaskScheduler } from "./task-scheduler.ts";
import { createSystemHealthReporter } from "./health.ts";
import {
  acquireProcessLock,
  runtimeServiceStatus,
  startServiceLogMaintenance,
  type ProcessLock,
} from "./service.ts";

const log = logger.child("app");

async function run(cfg: ReturnType<typeof config>, processLock: ProcessLock): Promise<void> {
  const stopLogMaintenance = startServiceLogMaintenance(cfg.dataDir);
  log.info("starting homebrain", {
    dataDir: cfg.dataDir,
    model: cfg.model,
    webHost: cfg.webHost,
    webPort: cfg.webPort,
  });

  const engine = new KnowledgeEngine();

  // 1. feishu connector + orchestrator
  const connector = new FeishuConnector();
  const orchestrator = new Orchestrator({
    engine,
    connector,
    docFetcher: (link) => connector.fetchDoc(link),
  });
  await orchestrator.start();
  log.info("orchestrator live; listening for feishu events");

  // Push a task's summary to its space-bound feishu chat (shared by the task
  // scheduler and the backend's manual "run now").
  const notifyTaskDone = async (space: string, name: string, summary?: string) => {
    const chatId = engine.registry.get(space as never)?.chatId;
    if (!chatId || !summary) return;
    await connector.notice(chatId, `🔎 任务「${name}」已完成：\n\n${summary}`);
  };

  let scheduler: Scheduler | undefined;
  let taskScheduler: TaskScheduler | undefined;
  const reportHealth = createSystemHealthReporter({
    engine,
    connectorHealth: () => connector.health(),
    dreamSchedulerHealth: () => scheduler?.health(),
    taskSchedulerHealth: () => taskScheduler?.health(),
    serviceHealth: () => runtimeServiceStatus({ startedAt: processLock.startedAt }),
  });

  // 2. management web backend
  const app = createWebApp({
    engine,
    adminToken: cfg.webAdminToken,
    health: reportHealth,
    larkSetup: new LarkCliSetup(),
    feishuRuntime: () => connector.health(),
    activeFeishuIdentity: cfg.feishuBotName && cfg.feishuBotOpenId
      ? { botName: cfg.feishuBotName, botOpenId: cfg.feishuBotOpenId }
      : undefined,
    onIntegrationTest: async (chatId, text) => connector.notice(chatId, text),
    onTaskRun: (taskId) => {
      const t = engine.tasks.get(taskId);
      if (t) void notifyTaskDone(t.space, t.name, t.lastSummary).catch(() => {});
    },
    onServiceRestart: () => {
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 250);
    },
  });
  // Local CLI providers routinely take longer than Bun's 10-second default.
  const server = Bun.serve({
    hostname: cfg.webHost,
    port: cfg.webPort,
    fetch: app.fetch,
    idleTimeout: 120,
  });
  log.info("web backend live", { url: `http://${cfg.webHost}:${server.port}` });

  // 3. dream-cycle scheduler (runs an immediate catch-up pass)
  scheduler = new Scheduler(engine);
  await scheduler.start();
  log.info("scheduler started (nightly + catch-up)");

  // 4. task scheduler (research tasks). On completion, push a summary to the
  // task's space-bound feishu chat when the task opts in.
  taskScheduler = new TaskScheduler(engine, {
    notify: async (task, report) => {
      await notifyTaskDone(task.space, task.name, report.summary);
    },
  });
  await taskScheduler.start();
  log.info("task scheduler started");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    const contain = (label: string, action: () => void) => {
      try {
        action();
      } catch (err) {
        log.error(`${label} shutdown failed`, { err: String(err) });
      }
    };
    contain("dream scheduler", () => scheduler.stop());
    contain("task scheduler", () => taskScheduler.stop());
    contain("web server", () => server.stop(true));
    try {
      await orchestrator.stop();
    } catch (err) {
      log.error("orchestrator shutdown failed", { err: String(err) });
    }
    contain("knowledge engine", () => engine.close());
    stopLogMaintenance();
    processLock.release();
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep the process alive; connectors + scheduler run in the background.
  await new Promise<void>(() => {});
}

async function main(): Promise<void> {
  const cfg = config();
  assertSafeWebBinding(cfg.webHost, cfg.webAdminToken);
  const processLock = acquireProcessLock({ dataDir: cfg.dataDir });
  try {
    await run(cfg, processLock);
  } catch (err) {
    processLock.release();
    throw err;
  }
}

main().catch((err) => {
  log.error("fatal", { err: String(err) });
  process.exit(1);
});

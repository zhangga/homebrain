/**
 * homebrain production entrypoint. Assembles the full system over one shared
 * KnowledgeEngine:
 *   - the feishu connector + orchestrator (inbound events -> knowledge + replies)
 *   - the read-only web backend (Bun.serve + Hono)
 *   - the dream-cycle scheduler (nightly + startup catch-up)
 * and shuts everything down gracefully on SIGINT/SIGTERM (propagating SIGTERM to
 * the lark-cli consumers — never kill -9).
 */
import { config, logger } from "@homebrain/shared";
import { KnowledgeEngine } from "@homebrain/core";
import { FeishuConnector } from "@homebrain/connectors";
import { Orchestrator } from "@homebrain/orchestrator";
import { createWebApp } from "@homebrain/web";
import { Scheduler } from "./scheduler.ts";

const log = logger.child("app");

async function main(): Promise<void> {
  const cfg = config();
  log.info("starting homebrain", { dataDir: cfg.dataDir, model: cfg.model, webPort: cfg.webPort });

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

  // 2. read-only web backend
  const app = createWebApp({ engine });
  const server = Bun.serve({ port: cfg.webPort, fetch: app.fetch });
  log.info("web backend live", { url: `http://localhost:${server.port}` });

  // 3. dream-cycle scheduler (runs an immediate catch-up pass)
  const scheduler = new Scheduler(engine);
  await scheduler.start();
  log.info("scheduler started (nightly + catch-up)");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    scheduler.stop();
    server.stop(true);
    await orchestrator.stop();
    engine.close();
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep the process alive; connectors + scheduler run in the background.
  await new Promise<void>(() => {});
}

main().catch((err) => {
  log.error("fatal", { err: String(err) });
  process.exit(1);
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine } from "@homebrain/core";
import { createSystemHealthReporter } from "./health.ts";

const loopHealth = {
  started: true,
  running: false,
  lastSuccessAt: 1_783_932_000_000,
};

describe("system health reporter", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("is ready only when storage, required CLIs, Feishu consumers, and schedulers are healthy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    engine.ensureSpace("team/oc_health", { chatId: "oc_health" });

    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        lastEventAt: 1_783_932_000_000,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
      now: () => 1_783_932_000_000,
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.components).toEqual(
      expect.objectContaining({
        knowledge: expect.objectContaining({ status: "ok" }),
        providers: expect.objectContaining({ status: "ok" }),
        feishu: expect.objectContaining({ status: "ok" }),
        dreamCycles: expect.objectContaining({ status: "ok" }),
        tasks: expect.objectContaining({ status: "ok" }),
        dreamScheduler: expect.objectContaining({ status: "ok" }),
        taskScheduler: expect.objectContaining({ status: "ok" }),
      }),
    );
    engine.close();
  });

  test("is not ready when an installed CLI most recently failed at runtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-provider-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => {
        throw new Error("authentication expired");
      },
    });
    const space = "team/oc_health" as const;
    engine.ensureSpace(space, { chatId: "oc_health" });
    const agent = engine.agents.create({ name: "Codex", provider: "codex" });
    engine.registry.updateMeta(space, { agentId: agent.id });
    const task = engine.tasks.create({
      name: "probe",
      space,
      topic: "probe",
      distillOnRun: false,
    })!;
    await engine.runTask(task.id);

    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.components.providers).toEqual(
      expect.objectContaining({ status: "down", summary: "CLI 最近执行失败：codex" }),
    );
    expect(snapshot.components.tasks).toEqual(
      expect.objectContaining({ status: "degraded", summary: "1 个任务最近执行失败" }),
    );
    engine.close();
  });
});

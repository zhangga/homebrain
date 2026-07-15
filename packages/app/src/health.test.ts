import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine } from "@homeagent/core";
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
    engine.reminders.create({
      title: "私密体检预约",
      space: "team/oc_health",
      chatId: "oc_health_private",
      creatorId: "ou_private",
      triggerAt: 1_783_932_100_000,
    }, 1_783_932_000_000);
    engine.learning.create({
      name: "私密阅读计划",
      space: "team/oc_health",
      chatId: "oc_health_private",
      creatorId: "ou_private",
      sourceTitle: "private-book.md",
      sourceContent: "private content",
      sourceRawIds: ["raw_private"],
      sourceMessageId: "om_private",
    }, 1_783_932_000_000);

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
      reminderSchedulerHealth: () => loopHealth,
      learningSchedulerHealth: () => loopHealth,
      serviceHealth: () => ({
        managed: true,
        pid: 7788,
        startedAt: 1_783_931_000_000,
      }),
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
      now: () => 1_783_932_000_000,
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.components.reminders?.summary).toBe("1 个待提醒，1 个提醒记录");
    expect(snapshot.components.learning?.summary).toBe("1 个进行中，0 个等待回答");
    expect(JSON.stringify(snapshot)).not.toContain("私密体检预约");
    expect(JSON.stringify(snapshot)).not.toContain("oc_health_private");
    expect(JSON.stringify(snapshot)).not.toContain("私密阅读计划");
    expect(snapshot.components).toEqual(
      expect.objectContaining({
        knowledge: expect.objectContaining({ status: "ok" }),
        providers: expect.objectContaining({ status: "ok" }),
        feishu: expect.objectContaining({ status: "ok" }),
        dreamCycles: expect.objectContaining({ status: "ok" }),
        tasks: expect.objectContaining({ status: "ok" }),
        reminders: expect.objectContaining({ status: "ok" }),
        learning: expect.objectContaining({ status: "ok" }),
        dreamScheduler: expect.objectContaining({ status: "ok" }),
        taskScheduler: expect.objectContaining({ status: "ok" }),
        reminderScheduler: expect.objectContaining({ status: "ok" }),
        learningScheduler: expect.objectContaining({ status: "ok" }),
        service: expect.objectContaining({
          status: "ok",
          details: expect.objectContaining({ managed: true, pid: 7788 }),
        }),
      }),
    );
    engine.close();
  });

  test("manual foreground runtime is visible but does not make readiness fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-service-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
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
      serviceHealth: () => ({ managed: false, pid: 8899, startedAt: 1_783_931_000_000 }),
      detectProviders: async () => [
        { id: "claude", name: "Claude", bin: "claude", available: true, detail: "2.0" },
      ],
      requiredProviderIds: () => ["claude"],
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.status).toBe("degraded");
    expect(snapshot.components.service).toEqual(expect.objectContaining({
      status: "degraded",
      summary: "当前为终端前台运行（PID 8899）",
    }));
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

  test("is not ready when a scheduler's latest tick failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-scheduler-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    engine.ensureSpace("team/oc_health", { chatId: "oc_health" });
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
      dreamSchedulerHealth: () => ({
        ...loopHealth,
        lastStatus: "error",
        lastFailureAt: loopHealth.lastSuccessAt,
        lastError: "database locked",
      }),
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.components.dreamScheduler).toEqual(
      expect.objectContaining({ status: "degraded" }),
    );
    engine.close();
  });

  test("isolates failures from each component probe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-isolation-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    engine.ensureSpace("team/oc_health", { chatId: "oc_health" });
    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => {
        throw new Error("connector probe failed");
      },
      dreamSchedulerHealth: () => {
        throw new Error("dream scheduler probe failed");
      },
      taskSchedulerHealth: () => {
        throw new Error("task scheduler probe failed");
      },
      detectProviders: async () => [],
      requiredProviderIds: () => {
        throw new Error("provider config failed");
      },
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.components).toEqual(
      expect.objectContaining({
        knowledge: expect.objectContaining({ status: "ok" }),
        feishu: expect.objectContaining({ status: "down" }),
        providers: expect.objectContaining({ status: "down" }),
        dreamScheduler: expect.objectContaining({ status: "down" }),
        taskScheduler: expect.objectContaining({ status: "down" }),
      }),
    );
    engine.close();
  });
});

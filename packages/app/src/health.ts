/**
 * Process-level health aggregation. Domain packages expose their own snapshots;
 * this module turns them into one deployment/readiness contract without
 * reaching into their private state.
 */
import { config, type ComponentHealth, type SystemHealthSnapshot } from "@homebrain/shared";
import type { ConnectorHealth } from "@homebrain/connectors";
import type { KnowledgeEngine } from "@homebrain/core";
import {
  detectProviders as detectLocalProviders,
  isCliProvider,
  type DetectedProvider,
} from "@homebrain/llm";
import type { RuntimeLoopHealth } from "./scheduler.ts";

export interface SystemHealthSources {
  engine: KnowledgeEngine;
  connectorHealth: () => ConnectorHealth;
  dreamSchedulerHealth: () => RuntimeLoopHealth | undefined;
  taskSchedulerHealth: () => RuntimeLoopHealth | undefined;
  detectProviders?: () => Promise<DetectedProvider[]>;
  requiredProviderIds?: () => string[];
  now?: () => number;
  providerProbeTtlMs?: number;
}

function requiredProvidersFor(engine: KnowledgeEngine): string[] {
  const ids = new Set<string>();
  const defaultProvider = config().defaultProvider;
  if (isCliProvider(defaultProvider)) ids.add(defaultProvider);
  for (const meta of engine.registry.list()) {
    const provider = engine.agentForSpace(meta.id)?.provider;
    if (provider && isCliProvider(provider)) ids.add(provider);
  }
  return [...ids].sort();
}

function loopComponent(label: string, health?: RuntimeLoopHealth): ComponentHealth {
  if (!health?.started) {
    return {
      status: "down",
      summary: `${label}未启动`,
      details: health ? { ...health } : undefined,
    };
  }
  const latestRunFailed = health.lastStatus === "error";
  return {
    status: latestRunFailed ? "degraded" : "ok",
    summary: latestRunFailed
      ? `${label}最近一次执行失败`
      : health.running
        ? `${label}运行中`
        : `${label}正常`,
    details: { ...health },
  };
}

/** Build a cached async reporter suitable for /healthz and /readyz. */
export function createSystemHealthReporter(
  sources: SystemHealthSources,
): () => Promise<SystemHealthSnapshot> {
  const detect = sources.detectProviders ?? detectLocalProviders;
  const requiredProviderIds =
    sources.requiredProviderIds ?? (() => requiredProvidersFor(sources.engine));
  const now = sources.now ?? Date.now;
  const ttl = sources.providerProbeTtlMs ?? 60_000;
  let providerCache: DetectedProvider[] | undefined;
  let providerCacheAt = 0;

  const providers = async (): Promise<DetectedProvider[]> => {
    const at = now();
    if (!providerCache || at - providerCacheAt >= ttl) {
      providerCache = await detect();
      providerCacheAt = at;
    }
    return providerCache;
  };

  return async () => {
    const checkedAt = now();
    const components: Record<string, ComponentHealth> = {};

    let core;
    try {
      core = await sources.engine.health();
      const spaces = (core.details?.spaces as Array<Record<string, unknown>> | undefined) ?? [];
      const pending = spaces.reduce(
        (sum, space) => sum + (typeof space.pendingRaw === "number" ? space.pendingRaw : 0),
        0,
      );
      components.knowledge = {
        status: core.ok ? "ok" : "down",
        summary: `${core.spaces} 个空间，${pending} 条待提炼`,
        details: core.details,
      };
    } catch (err) {
      core = { ok: false, spaces: 0, details: { error: String(err) } };
      components.knowledge = {
        status: "down",
        summary: "知识存储检查失败",
        details: core.details,
      };
    }

    const connector = sources.connectorHealth();
    const failedConsumers = connector.consumers.filter((consumer) => consumer.state === "failed");
    const pendingConsumers = connector.consumers.filter((consumer) => consumer.state !== "ready");
    components.feishu = {
      status: connector.ready ? "ok" : failedConsumers.length > 0 ? "down" : "degraded",
      summary: connector.ready
        ? "飞书事件消费者已就绪"
        : `未就绪：${pendingConsumers.map((consumer) => consumer.key).join("、") || "尚未启动"}`,
      details: { ...connector },
    };

    let detected: DetectedProvider[] = [];
    let providerProbeError: string | undefined;
    try {
      detected = await providers();
    } catch (err) {
      providerProbeError = String(err);
    }
    const required = [...new Set(requiredProviderIds())].sort();
    const detectedById = new Map<string, DetectedProvider>(
      detected.map((provider) => [provider.id, provider]),
    );
    const unavailable = required.filter((id) => !detectedById.get(id)?.available);
    const providerRuns =
      (core.details?.providerRuns as Array<Record<string, unknown>> | undefined) ?? [];
    const latestRuntimeFailures = providerRuns.filter(
      (run) => required.includes(String(run.provider)) && run.lastStatus === "error",
    );
    const providerReady =
      !providerProbeError && required.length > 0 && unavailable.length === 0 && latestRuntimeFailures.length === 0;
    components.providers = {
      status: providerReady ? "ok" : "down",
      summary: providerReady
        ? `必需 CLI 可用：${required.join("、")}`
        : providerProbeError
          ? "CLI 探测失败"
          : unavailable.length > 0
            ? `CLI 不可用：${unavailable.join("、")}`
            : latestRuntimeFailures.length > 0
              ? `CLI 最近执行失败：${latestRuntimeFailures.map((run) => run.provider).join("、")}`
              : "未配置可用 CLI",
      details: {
        required,
        detected,
        providerRuns,
        ...(providerProbeError ? { error: providerProbeError } : {}),
      },
    };

    const dreamCycles =
      (core.details?.dreamCycles as Array<Record<string, unknown>> | undefined) ?? [];
    const runningDreams = dreamCycles.filter((cycle) => cycle.running === true);
    const failedDreams = dreamCycles.filter((cycle) => cycle.lastStatus === "error");
    components.dreamCycles = {
      status: failedDreams.length > 0 ? "degraded" : "ok",
      summary: runningDreams.length > 0
        ? `${runningDreams.length} 个 Dream Cycle 运行中`
        : failedDreams.length > 0
          ? `${failedDreams.length} 个空间最近提炼失败`
          : "Dream Cycle 无近期失败",
      details: { runs: dreamCycles },
    };

    const tasks = (core.details?.tasks as Array<Record<string, unknown>> | undefined) ?? [];
    const runningTasks = tasks.filter((task) => task.running === true);
    const failedTasks = tasks.filter((task) => task.lastStatus === "error");
    components.tasks = {
      status: failedTasks.length > 0 ? "degraded" : "ok",
      summary: runningTasks.length > 0
        ? `${runningTasks.length} 个任务运行中`
        : failedTasks.length > 0
          ? `${failedTasks.length} 个任务最近执行失败`
          : `${tasks.length} 个任务，无近期失败`,
      details: { tasks },
    };

    const dreamHealth = sources.dreamSchedulerHealth();
    const taskHealth = sources.taskSchedulerHealth();
    components.dreamScheduler = loopComponent("Dream Cycle 调度器", dreamHealth);
    components.taskScheduler = loopComponent("任务调度器", taskHealth);

    const ready =
      core.ok &&
      connector.ready &&
      providerReady &&
      dreamHealth?.started === true &&
      taskHealth?.started === true;
    const statuses = Object.values(components).map((component) => component.status);
    const status = !ready || statuses.includes("down")
      ? "down"
      : statuses.includes("degraded")
        ? "degraded"
        : "ok";

    return { status, ready, checkedAt, components };
  };
}

import type { CommandResult, ServiceStatus } from "./service.ts";

export interface DesktopService {
  status: () => Promise<ServiceStatus>;
  install: () => Promise<ServiceStatus>;
  start: () => Promise<ServiceStatus>;
}

export type DesktopExecutor = (argv: string[], timeoutMs: number) => Promise<CommandResult>;
export type DesktopHealthCheck = (
  url: string,
  timeoutMs: number,
  expectedPid?: number,
) => Promise<boolean>;

export interface DesktopLaunchOptions {
  service: DesktopService;
  port?: number;
  executor?: DesktopExecutor;
  healthCheck?: DesktopHealthCheck;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type DesktopLaunchResult = {
  action: "opened" | "started-and-opened" | "installed-and-opened" | "failed";
};

const defaultExecutor: DesktopExecutor = async (argv, timeoutMs) => {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  try {
    return { code: await child.exited, stdout: "", stderr: "" };
  } finally {
    clearTimeout(timer);
  }
};

const defaultHealthCheck: DesktopHealthCheck = async (url, timeoutMs, expectedPid) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const health = await response.json() as {
      status?: unknown;
      instanceId?: unknown;
      pid?: unknown;
    };
    return health.status === "ok"
      && typeof health.instanceId === "string"
      && (expectedPid === undefined || health.pid === expectedPid);
  } catch {
    return false;
  }
};

export async function launchDesktop(options: DesktopLaunchOptions): Promise<DesktopLaunchResult> {
  const port = options.port ?? 3000;
  const executor = options.executor ?? defaultExecutor;
  const healthCheck = options.healthCheck ?? defaultHealthCheck;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const healthTimeoutMs = Math.min(20_000, Math.max(1, options.healthTimeoutMs ?? 20_000));
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 250);

  try {
    let current = await options.service.status();
    let action: DesktopLaunchResult["action"] = "opened";

    if (!current.installed) {
      current = await options.service.install();
      action = "installed-and-opened";
    } else if (!current.running) {
      current = await options.service.start();
      action = "started-and-opened";
    }

    const healthUrl = `http://127.0.0.1:${port}/healthz`;
    const deadline = now() + healthTimeoutMs;
    let healthy = false;
    while (now() < deadline) {
      const remaining = deadline - now();
      if (await healthCheck(healthUrl, Math.min(1_000, remaining), current.pid)) {
        healthy = now() <= deadline;
        break;
      }
      const delay = Math.min(pollIntervalMs, deadline - now());
      if (delay > 0) await sleep(delay);
    }
    if (!healthy) throw new Error("homebrain did not become healthy");

    const opened = await executor(["/usr/bin/open", `http://127.0.0.1:${port}/setup`], 5_000);
    if (opened.code !== 0) throw new Error("failed to open Homebrain setup");
    return { action };
  } catch {
    const alert = [
      'display alert "Homebrain 启动失败"',
      'message "服务暂时无法启动，请稍后重试。"',
      'as critical buttons {"好"} default button "好"',
    ].join(" ");
    try {
      await executor(["/usr/bin/osascript", "-e", alert], 10_000);
    } catch {
      // The launcher has no other safe user-visible channel at this point.
    }
    return { action: "failed" };
  }
}

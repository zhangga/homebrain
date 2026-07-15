import { describe, expect, test } from "bun:test";
import type { ServiceStatus } from "./service.ts";
import { launchDesktop, type DesktopService } from "./desktop.ts";

function status(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    installed: false,
    loaded: false,
    running: false,
    label: "com.homeagent.agent",
    plistPath: "/tmp/com.homeagent.agent.plist",
    stdoutPath: "/tmp/service.stdout.log",
    stderrPath: "/tmp/service.stderr.log",
    ...overrides,
  };
}

describe("desktop launcher", () => {
  test("installs a missing service and opens setup after it becomes healthy", async () => {
    const serviceCalls: string[] = [];
    const commands: string[][] = [];
    const service: DesktopService = {
      status: async () => (serviceCalls.push("status"), status()),
      install: async () => (
        serviceCalls.push("install"),
        status({ installed: true, loaded: true, running: true, pid: 4242 })
      ),
      start: async () => (
        serviceCalls.push("start"),
        status({ installed: true, loaded: true, running: true })
      ),
    };

    const result = await launchDesktop({
      service,
      port: 3000,
      healthCheck: async (_url, _timeout, expectedPid) => expectedPid === 4242,
      executor: async (argv) => {
        commands.push(argv);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toEqual({ action: "installed-and-opened" });
    expect(serviceCalls).toEqual(["status", "install"]);
    expect(commands).toEqual([["/usr/bin/open", "http://127.0.0.1:3000/setup"]]);
  });

  test("opens an already-running service without reinstalling it", async () => {
    const commands: string[][] = [];
    const service: DesktopService = {
      status: async () => status({ installed: true, loaded: true, running: true }),
      install: async () => {
        throw new Error("must not reinstall a running service");
      },
      start: async () => {
        throw new Error("must not start a running service");
      },
    };

    expect(await launchDesktop({
      service,
      port: 4187,
      healthCheck: async () => true,
      executor: async (argv) => (
        commands.push(argv),
        { code: 0, stdout: "", stderr: "" }
      ),
    })).toEqual({ action: "opened" });
    expect(commands).toEqual([["/usr/bin/open", "http://127.0.0.1:4187/setup"]]);
  });

  test("starts an installed service before opening setup", async () => {
    const serviceCalls: string[] = [];
    const stopped = status({ installed: true });
    const running = status({ installed: true, loaded: true, running: true });

    expect(await launchDesktop({
      service: {
        status: async () => (serviceCalls.push("status"), stopped),
        install: async () => (serviceCalls.push("install"), running),
        start: async () => (serviceCalls.push("start"), running),
      },
      healthCheck: async () => true,
      executor: async () => ({ code: 0, stdout: "", stderr: "" }),
    })).toEqual({ action: "started-and-opened" });
    expect(serviceCalls).toEqual(["status", "start"]);
  });

  test("shows a bounded macOS alert when the health port stays unavailable", async () => {
    let now = 0;
    const healthTimeouts: number[] = [];
    const commands: Array<{ argv: string[]; timeoutMs: number }> = [];
    const running = status({ installed: true, loaded: true, running: true });

    const result = await launchDesktop({
      service: {
        status: async () => running,
        install: async () => running,
        start: async () => running,
      },
      healthTimeoutMs: 30_000,
      pollIntervalMs: 5_000,
      now: () => now,
      sleep: async (ms) => { now += ms; },
      healthCheck: async (_url, timeoutMs) => (
        healthTimeouts.push(timeoutMs),
        false
      ),
      executor: async (argv, timeoutMs) => (
        commands.push({ argv, timeoutMs }),
        { code: 0, stdout: "", stderr: "" }
      ),
    });

    expect(result).toEqual({ action: "failed" });
    expect(now).toBe(20_000);
    expect(healthTimeouts).toEqual([1_000, 1_000, 1_000, 1_000]);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.argv[0]).toBe("/usr/bin/osascript");
    expect(commands[0]?.argv.join(" ")).toContain("HomeAgent 启动失败");
    expect(commands[0]?.timeoutMs).toBeLessThanOrEqual(10_000);
  });
});

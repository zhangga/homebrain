import { homedir } from "node:os";
import { LaunchAgentService, type ServiceStatus } from "./service.ts";
import { resolveRuntimePaths, type RuntimePaths } from "./runtime-paths.ts";

const USAGE = "Usage: bun run service <install|start|stop|restart|status|logs|uninstall> [--json] [--lines N] [--follow]";

export interface ServiceController {
  install: () => Promise<ServiceStatus>;
  start: () => Promise<ServiceStatus>;
  stop: () => Promise<ServiceStatus>;
  restart: () => Promise<ServiceStatus>;
  status: () => Promise<ServiceStatus>;
  uninstall: () => Promise<ServiceStatus>;
  readLogs: (lines?: number) => { stdout: string; stderr: string };
  followLogs: (lines?: number) => Promise<void>;
}

export interface ServiceCliOptions {
  service: ServiceController;
  write?: (line: string) => void;
  writeError?: (line: string) => void;
}

export interface DefaultServiceOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  homeDir?: string;
  execPath?: string;
  environment?: NodeJS.ProcessEnv;
  runtimePaths?: RuntimePaths;
}

function formatStatus(status: ServiceStatus): string {
  const started = status.startedAt ? new Date(status.startedAt).toLocaleString("zh-CN") : "—";
  return [
    `服务: ${status.running ? "running" : status.loaded ? status.state ?? "loaded" : "stopped"}`,
    `已安装: ${status.installed ? "是" : "否"}`,
    `已加载: ${status.loaded ? "是" : "否"}`,
    `PID: ${status.pid ?? "—"}`,
    `启动时间: ${started}`,
    `plist: ${status.plistPath}`,
    `stdout: ${status.stdoutPath}`,
    `stderr: ${status.stderrPath}`,
  ].join("\n");
}

function logLineCount(args: string[]): number {
  const at = args.indexOf("--lines");
  if (at < 0) return 100;
  const parsed = Number(args[at + 1]);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error("--lines must be an integer between 1 and 10000");
  }
  return parsed;
}

export async function runServiceCli(args: string[], options: ServiceCliOptions): Promise<number> {
  const write = options.write ?? console.log;
  const writeError = options.writeError ?? console.error;
  const command = args[0];
  try {
    if (command === "logs") {
      const lines = logLineCount(args);
      if (args.includes("--follow")) {
        await options.service.followLogs(lines);
      } else {
        const logs = options.service.readLogs(lines);
        write(`== stdout ==\n${logs.stdout || "(empty)"}\n\n== stderr ==\n${logs.stderr || "(empty)"}`);
      }
      return 0;
    }
    if (!command || !["install", "start", "stop", "restart", "status", "uninstall"].includes(command)) {
      writeError(USAGE);
      return 2;
    }
    const action = options.service[command as Exclude<keyof ServiceController, "readLogs" | "followLogs">];
    const status = await action.call(options.service);
    if (command === "status" && args.includes("--json")) write(JSON.stringify(status, null, 2));
    else write(formatStatus(status));
    return command === "status" && !status.running ? 1 : 0;
  } catch (err) {
    writeError(`homebrain service: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export function createDefaultService(options: DefaultServiceOptions = {}): LaunchAgentService {
  const homeDir = options.homeDir ?? homedir();
  const execPath = options.execPath ?? process.execPath;
  const environment = options.environment ?? process.env;
  const runtimePaths = options.runtimePaths ?? resolveRuntimePaths({
    execPath,
    homeDir,
    env: environment,
  });
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("cannot determine the current macOS user id");
  return new LaunchAgentService({
    platform: options.platform ?? process.platform,
    uid,
    homeDir,
    repoRoot: runtimePaths.appRoot,
    dataDir: runtimePaths.dataDir,
    logDir: runtimePaths.logDir,
    bunPath: Bun.which("bun") ?? execPath,
    bundled: runtimePaths.bundled,
    executablePath: environment.HOMEBRAIN_LAUNCHER_PATH
      ?? (runtimePaths.bundled
        ? `${runtimePaths.appRoot}/Contents/MacOS/homebrain`
        : execPath),
    environment,
  });
}

if (import.meta.main) {
  process.exitCode = await runServiceCli(process.argv.slice(2), { service: createDefaultService() });
}

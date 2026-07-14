import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";

export const SERVICE_LABEL = "com.homebrain.agent";
const SERVICE_LOG_NAMES = ["service.stdout.log", "service.stderr.log"] as const;

function shiftLogBackups(path: string): void {
  rmSync(`${path}.3`, { force: true });
  if (existsSync(`${path}.2`)) renameSync(`${path}.2`, `${path}.3`);
  if (existsSync(`${path}.1`)) renameSync(`${path}.1`, `${path}.2`);
  for (const backup of [`${path}.2`, `${path}.3`]) {
    if (existsSync(backup)) chmodSync(backup, 0o600);
  }
}

function readTailBytes(path: string, bytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Bound launchd-owned active logs without replacing their open inode. */
export function rotateActiveServiceLogs(
  dataDir: string,
  maxBytes = 10 * 1024 * 1024,
  preserveBytes = 1024 * 1024,
): void {
  const logDir = join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  for (const name of SERVICE_LOG_NAMES) {
    const path = join(logDir, name);
    writeFileSync(path, "", { encoding: "utf8", flag: "a", mode: 0o600 });
    if (statSync(path).size > maxBytes) {
      const tail = readTailBytes(path, preserveBytes);
      shiftLogBackups(path);
      writeFileSync(`${path}.1`, tail, { mode: 0o600 });
      chmodSync(`${path}.1`, 0o600);
      // launchd opens Standard*Path with append semantics, so subsequent writes
      // continue at the new end of this same inode after truncation.
      truncateSync(path, 0);
    }
    chmodSync(path, 0o600);
  }
}

export function startServiceLogMaintenance(
  dataDir: string,
  options: { managed?: boolean; maxBytes?: number; intervalMs?: number } = {},
): () => void {
  const managed = options.managed ?? process.env.HOMEBRAIN_SERVICE_MANAGED === "1";
  if (!managed) return () => {};
  const maintain = () => {
    try {
      rotateActiveServiceLogs(dataDir, options.maxBytes);
    } catch (err) {
      process.stderr.write(`homebrain log rotation failed: ${String(err)}\n`);
    }
  };
  maintain();
  const timer = setInterval(maintain, options.intervalMs ?? 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ServiceCommandRunner = (argv: string[]) => Promise<CommandResult>;

export interface LaunchAgentServiceOptions {
  platform: NodeJS.Platform;
  uid: number;
  homeDir: string;
  repoRoot: string;
  dataDir: string;
  bunPath: string;
  environment: NodeJS.ProcessEnv;
  runner?: ServiceCommandRunner;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logMaxBytes?: number;
  logPreserveBytes?: number;
}

export interface ServiceStatus {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  label: string;
  state?: string;
  pid?: number;
  lastExitCode?: number;
  startedAt?: number;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface ProcessLockOptions {
  dataDir: string;
  pid?: number;
  startedAt?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface ProcessLock {
  path: string;
  pid: number;
  startedAt: number;
  release: () => void;
}

export interface RuntimeServiceStatus {
  managed: boolean;
  pid: number;
  startedAt: number;
}

export function runtimeServiceStatus(options: {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  startedAt?: number;
} = {}): RuntimeServiceStatus {
  return {
    managed: (options.env ?? process.env).HOMEBRAIN_SERVICE_MANAGED === "1",
    pid: options.pid ?? process.pid,
    startedAt: options.startedAt ?? Date.now() - Math.round(process.uptime() * 1000),
  };
}

const defaultRunner: ServiceCommandRunner = async (argv) => {
  const process = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { code, stdout, stderr };
};

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistString(key: string, value: string): string {
  return `  <key>${key}</key>\n  <string>${xml(value)}</string>`;
}

function parsedNumber(output: string, field: string): number | undefined {
  const value = output.match(new RegExp(`\\b${field}\\s*=\\s*(-?\\d+)`))?.[1];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const flockLibrary = process.platform === "darwin"
  ? dlopen("/usr/lib/libSystem.B.dylib", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
  : process.platform === "linux"
    ? dlopen("libc.so.6", {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      })
    : undefined;

function systemFlock(fd: number, operation: number): number {
  if (!flockLibrary) throw new Error(`single-process locking is unsupported on ${process.platform}`);
  return Number(flockLibrary.symbols.flock(fd, operation));
}

/** Acquire the single-process guard, replacing only a provably stale owner. */
export function acquireProcessLock(options: ProcessLockOptions): ProcessLock {
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? Date.now();
  const alive = options.isProcessAlive ?? defaultIsProcessAlive;
  const runDir = join(options.dataDir, "run");
  const path = join(runDir, "homebrain.lock");
  const cleanupPath = `${path}.cleanup`;
  mkdirSync(runDir, { recursive: true });
  const fd = openSync(path, "a+", 0o600);
  let locked = false;
  try {
    if (systemFlock(fd, LOCK_EX | LOCK_NB) !== 0) {
      let ownerPid: number | undefined;
      try {
        const owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
        if (typeof owner.pid === "number") ownerPid = owner.pid;
      } catch {
        // The kernel lock remains authoritative even if metadata is unreadable.
      }
      throw new Error(
        ownerPid ? `homebrain is already running (PID ${ownerPid})` : "homebrain is already running",
      );
    }
    locked = true;

    // Before P3.2, homebrain used a PID-only lock. Refuse an actually live
    // legacy owner during an in-place upgrade; version 2 locks are governed by
    // the kernel and therefore cannot be confused by PID reuse.
    try {
      const previous = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; pid?: unknown };
      if (
        previous.version !== 2
        && typeof previous.pid === "number"
        && previous.pid !== pid
        && alive(previous.pid)
      ) {
        throw new Error(`homebrain is already running (PID ${previous.pid})`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("homebrain is already running")) throw err;
      // Empty/corrupt stale metadata is safe to replace while holding flock.
    }

    rmSync(cleanupPath, { recursive: true, force: true });
    ftruncateSync(fd, 0);
    writeFileSync(fd, JSON.stringify({ version: 2, pid, startedAt }), "utf8");
    fsyncSync(fd);
    chmodSync(path, 0o600);
    let released = false;
    return {
      path,
      pid,
      startedAt,
      release: () => {
        if (released) return;
        released = true;
        try {
          systemFlock(fd, LOCK_UN);
        } finally {
          closeSync(fd);
        }
      },
    };
  } catch (err) {
    if (locked) systemFlock(fd, LOCK_UN);
    closeSync(fd);
    throw err;
  }
}

/** Owns the on-disk LaunchAgent definition and launchctl lifecycle. */
export class LaunchAgentService {
  readonly plistPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  private readonly runner: ServiceCommandRunner;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logMaxBytes: number;
  private readonly logPreserveBytes: number;

  constructor(private readonly options: LaunchAgentServiceOptions) {
    this.plistPath = join(options.homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    this.stdoutPath = join(options.dataDir, "logs", "service.stdout.log");
    this.stderrPath = join(options.dataDir, "logs", "service.stderr.log");
    this.runner = options.runner ?? defaultRunner;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 100);
    this.sleep = options.sleep ?? Bun.sleep;
    this.logMaxBytes = options.logMaxBytes ?? 10 * 1024 * 1024;
    this.logPreserveBytes = options.logPreserveBytes ?? 1024 * 1024;
  }

  private assertMacOS(): void {
    if (this.options.platform !== "darwin") {
      throw new Error("homebrain service currently supports macOS LaunchAgent only");
    }
  }

  private get domain(): string {
    return `gui/${this.options.uid}`;
  }

  private get target(): string {
    return `${this.domain}/${SERVICE_LABEL}`;
  }

  private plist(): string {
    const path = this.options.environment.PATH
      || `${join(this.options.homeDir, ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
    const main = join(this.options.repoRoot, "packages", "app", "src", "main.ts");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${plistString("Label", SERVICE_LABEL)}
  <key>ProgramArguments</key>
  <array>
    <string>${xml(this.options.bunPath)}</string>
    <string>run</string>
    <string>${xml(main)}</string>
  </array>
${plistString("WorkingDirectory", this.options.repoRoot)}
  <key>EnvironmentVariables</key>
  <dict>
${plistString("HOME", this.options.homeDir)}
${plistString("PATH", path)}
${plistString("HOMEBRAIN_DATA_DIR", this.options.dataDir)}
${plistString("HOMEBRAIN_SERVICE_MANAGED", "1")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${plistString("ProcessType", "Background")}
${plistString("StandardOutPath", this.stdoutPath)}
${plistString("StandardErrorPath", this.stderrPath)}
</dict>
</plist>
`;
  }

  private async launchctl(...args: string[]): Promise<CommandResult> {
    return this.runner(["/bin/launchctl", ...args]);
  }

  private prepareLogs(): void {
    rotateActiveServiceLogs(this.options.dataDir, this.logMaxBytes, this.logPreserveBytes);
  }

  private async waitForRunning(previousPid?: number, requireReplacement = false): Promise<ServiceStatus> {
    const attempts = Math.max(1, Math.ceil(this.startupTimeoutMs / this.pollIntervalMs) + 1);
    let latest: ServiceStatus | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      latest = await this.status();
      const replaced = !requireReplacement || previousPid === undefined || latest.pid !== previousPid;
      if (latest.running && replaced) return latest;
      if (attempt + 1 < attempts) await this.sleep(this.pollIntervalMs);
    }
    throw new Error(
      `homebrain service did not reach running state within ${this.startupTimeoutMs}ms`
      + (latest?.lastExitCode !== undefined ? ` (last exit ${latest.lastExitCode})` : ""),
    );
  }

  async install(): Promise<ServiceStatus> {
    this.assertMacOS();
    const current = await this.status();
    if (current.loaded) {
      const stopped = await this.launchctl("bootout", this.target);
      if (stopped.code !== 0) {
        throw new Error(`launchctl bootout failed: ${stopped.stderr.trim() || stopped.stdout.trim() || stopped.code}`);
      }
    }
    mkdirSync(join(this.options.homeDir, "Library", "LaunchAgents"), { recursive: true });
    this.prepareLogs();
    const tempPath = `${this.plistPath}.tmp-${process.pid}`;
    writeFileSync(tempPath, this.plist(), { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, this.plistPath);
    chmodSync(this.plistPath, 0o600);

    const enabled = await this.launchctl("enable", this.target);
    if (enabled.code !== 0) {
      throw new Error(`launchctl enable failed: ${enabled.stderr.trim() || enabled.stdout.trim() || enabled.code}`);
    }
    const result = await this.launchctl("bootstrap", this.domain, this.plistPath);
    if (result.code !== 0) {
      throw new Error(`launchctl bootstrap failed: ${result.stderr.trim() || result.stdout.trim() || result.code}`);
    }
    return this.waitForRunning();
  }

  async start(): Promise<ServiceStatus> {
    this.assertMacOS();
    const current = await this.status();
    if (!current.installed) throw new Error("homebrain service is not installed; run `bun run service install`");
    if (current.running) return current;
    const result = current.loaded
      ? await this.launchctl("kickstart", this.target)
      : await this.launchctl("bootstrap", this.domain, this.plistPath);
    if (result.code !== 0) {
      throw new Error(`launchctl start failed: ${result.stderr.trim() || result.stdout.trim() || result.code}`);
    }
    return this.waitForRunning();
  }

  async stop(): Promise<ServiceStatus> {
    this.assertMacOS();
    const current = await this.status();
    if (current.loaded) {
      const result = await this.launchctl("bootout", this.target);
      if (result.code !== 0) {
        throw new Error(`launchctl stop failed: ${result.stderr.trim() || result.stdout.trim() || result.code}`);
      }
    }
    return this.status();
  }

  async restart(): Promise<ServiceStatus> {
    this.assertMacOS();
    const current = await this.status();
    if (!current.installed) throw new Error("homebrain service is not installed; run `bun run service install`");
    if (!current.loaded || !current.running) return this.start();
    const result = await this.launchctl("kill", "SIGTERM", this.target);
    if (result.code !== 0) {
      throw new Error(`launchctl restart failed: ${result.stderr.trim() || result.stdout.trim() || result.code}`);
    }
    return this.waitForRunning(current.pid, true);
  }

  async status(): Promise<ServiceStatus> {
    this.assertMacOS();
    const installed = existsSync(this.plistPath);
    const result = await this.launchctl("print", this.target);
    const loaded = result.code === 0;
    const state = loaded ? result.stdout.match(/\bstate\s*=\s*([^\n]+)/)?.[1]?.trim() : undefined;
    const pid = loaded ? parsedNumber(result.stdout, "pid") : undefined;
    const lastExitCode = loaded ? parsedNumber(result.stdout, "last exit code") : undefined;
    const lockPath = join(this.options.dataDir, "run", "homebrain.lock");
    let startedAt: number | undefined;
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; startedAt?: unknown };
        if (lock.pid === pid && typeof lock.startedAt === "number") startedAt = lock.startedAt;
      } catch {
        // A malformed lock is reported by the process guard on its next start.
      }
    }
    return {
      installed,
      loaded,
      running: loaded && (state === "running" || pid !== undefined),
      label: SERVICE_LABEL,
      state,
      pid,
      lastExitCode,
      startedAt,
      plistPath: this.plistPath,
      stdoutPath: this.stdoutPath,
      stderrPath: this.stderrPath,
    };
  }

  readLogs(lines = 100): { stdout: string; stderr: string } {
    const tail = (path: string): string => {
      if (!existsSync(path)) return "";
      const fd = openSync(path, "r");
      try {
        const size = fstatSync(fd).size;
        const maxRead = Math.min(size, 1024 * 1024);
        const buffer = Buffer.alloc(maxRead);
        const bytesRead = readSync(fd, buffer, 0, maxRead, size - maxRead);
        const rows = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
        if (size > maxRead && rows.length > 1) rows.shift(); // discard a possibly partial first line
        if (rows.at(-1) === "") rows.pop();
        return rows.slice(-lines).join("\n");
      } finally {
        closeSync(fd);
      }
    };
    return { stdout: tail(this.stdoutPath), stderr: tail(this.stderrPath) };
  }

  async followLogs(lines = 100): Promise<void> {
    mkdirSync(join(this.options.dataDir, "logs"), { recursive: true });
    for (const path of [this.stdoutPath, this.stderrPath]) {
      writeFileSync(path, "", { encoding: "utf8", flag: "a", mode: 0o600 });
      chmodSync(path, 0o600);
    }
    const tail = Bun.spawn(
      ["/usr/bin/tail", "-n", String(lines), "-F", this.stdoutPath, this.stderrPath],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    await tail.exited;
  }

  async uninstall(): Promise<ServiceStatus> {
    this.assertMacOS();
    const current = await this.status();
    if (current.loaded) {
      const result = await this.launchctl("bootout", this.target);
      if (result.code !== 0) {
        throw new Error(`launchctl uninstall failed: ${result.stderr.trim() || result.stdout.trim() || result.code}`);
      }
    }
    rmSync(this.plistPath, { force: true });
    return this.status();
  }
}

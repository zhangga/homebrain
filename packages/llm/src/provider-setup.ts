import { createHash, randomUUID } from "node:crypto";
import {
  chmod as fsChmod,
  lstat,
  mkdir as fsMkdir,
  rename as fsRename,
  rm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import { brandedEnv } from "@homeagent/shared";

const CAPTURE_LIMIT_BYTES = 8 * 1024;
const LOGIN_DETAIL_WAIT_MS = 15_000;
const LOGIN_TTL_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_LISTING_BYTES = 1024 * 1024;

const LOGIN_FAILED_MESSAGE = "ChatGPT 登录未完成，请重试";
const LOGIN_EXPIRED_MESSAGE = "ChatGPT 登录已过期，请重试";
const LOGIN_CANCELLED_MESSAGE = "已取消 ChatGPT 登录";
const LOGIN_READY_MESSAGE = "ChatGPT 已连接";

/** Keep app-managed ChatGPT credentials out of plaintext auth.json. */
export const MANAGED_CODEX_AUTH_ARGS = [
  "-c",
  'cli_auth_credentials_store="keyring"',
] as const;

export type CodexLoginState =
  | "idle"
  | "starting"
  | "waiting_for_user"
  | "verifying"
  | "ready"
  | "failed"
  | "expired"
  | "cancelled";

export interface CodexLoginSession {
  state: CodexLoginState;
  verificationUrl?: string;
  userCode?: string;
  startedAt?: number;
  expiresAt?: number;
  message: string;
}

export interface CodexLoginProcess {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface CodexLoginSpawner {
  spawn(argv: string[]): CodexLoginProcess;
}

export interface CodexCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CodexCommandRunner {
  run(argv: string[], timeoutMs: number): Promise<CodexCommandResult>;
}

export interface CodexProviderSetupOptions {
  codexBin?: string;
  spawner?: CodexLoginSpawner;
  commandRunner?: CodexCommandRunner;
  detailWaitMs?: number;
  ttlMs?: number;
}

const ACTIVE_LOGIN_STATES = new Set<CodexLoginState>([
  "starting",
  "waiting_for_user",
  "verifying",
]);

const bunCodexLoginSpawner: CodexLoginSpawner = {
  spawn(argv) {
    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    return {
      stdout: proc.stdout as unknown as AsyncIterable<Uint8Array>,
      stderr: proc.stderr as unknown as AsyncIterable<Uint8Array>,
      exited: proc.exited,
      kill: () => proc.kill("SIGTERM"),
    };
  },
};

const bunCodexCommandRunner: CodexCommandRunner = {
  async run(argv, timeoutMs) {
    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        readBounded(proc.stdout as unknown as AsyncIterable<Uint8Array>),
        readBounded(proc.stderr as unknown as AsyncIterable<Uint8Array>),
        proc.exited,
      ]);
      return {
        code: timedOut ? 124 : code,
        stdout: new TextDecoder().decode(stdout),
        stderr: new TextDecoder().decode(stderr),
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

export class CodexProviderSetup {
  private readonly codexBin: string;
  private readonly spawner: CodexLoginSpawner;
  private readonly commandRunner: CodexCommandRunner;
  private readonly detailWaitMs: number;
  private readonly ttlMs: number;
  private generation = 0;
  private process?: CodexLoginProcess;
  private session: CodexLoginSession = {
    state: "idle",
    message: "尚未连接 ChatGPT",
  };

  constructor(options: CodexProviderSetupOptions = {}) {
    this.codexBin =
      options.codexBin?.trim() || brandedEnv(process.env, "CODEX_BIN")?.trim() || "codex";
    this.spawner = options.spawner ?? bunCodexLoginSpawner;
    this.commandRunner = options.commandRunner ?? bunCodexCommandRunner;
    this.detailWaitMs = boundedDuration(options.detailWaitMs, LOGIN_DETAIL_WAIT_MS);
    this.ttlMs = boundedDuration(options.ttlMs, LOGIN_TTL_MS);
  }

  async startDeviceLogin(): Promise<CodexLoginSession> {
    if (ACTIVE_LOGIN_STATES.has(this.session.state)) return this.deviceLoginStatus();

    const generation = ++this.generation;
    if (this.process) {
      safelyKill(this.process);
      this.process = undefined;
    }

    const startedAt = Date.now();
    this.session = {
      state: "starting",
      startedAt,
      expiresAt: startedAt + this.ttlMs,
      message: "正在准备 ChatGPT 登录",
    };

    let proc: CodexLoginProcess;
    try {
      proc = this.spawner.spawn([
        this.codexBin,
        ...MANAGED_CODEX_AUTH_ARGS,
        "login",
        "--device-auth",
      ]);
      this.process = proc;
    } catch {
      this.finishLogin("failed", LOGIN_FAILED_MESSAGE);
      return this.deviceLoginStatus();
    }

    const ttlTimer = setTimeout(() => {
      if (this.generation === generation && ACTIVE_LOGIN_STATES.has(this.session.state)) {
        this.finishLogin("expired", LOGIN_EXPIRED_MESSAGE);
        safelyKill(proc);
      }
    }, this.ttlMs);
    (ttlTimer as unknown as { unref?: () => void }).unref?.();

    let captured: Uint8Array = new Uint8Array();
    let verificationUrl: string | undefined;
    let userCode: string | undefined;
    let detailsResolved = false;
    let resolveDetails!: (details: { verificationUrl: string; userCode: string }) => void;
    const detailsFound = new Promise<{ verificationUrl: string; userCode: string }>((resolve) => {
      resolveDetails = resolve;
    });
    const inspect = (chunk: Uint8Array): void => {
      captured = appendBounded(captured, chunk);
      const text = new TextDecoder().decode(captured);
      verificationUrl ??= extractAllowedLoginUrl(text);
      userCode ??= extractSafeUserCode(text);
      if (!detailsResolved && verificationUrl && userCode) {
        detailsResolved = true;
        resolveDetails({ verificationUrl, userCode });
      }
    };
    const consume = async (stream: AsyncIterable<Uint8Array>): Promise<void> => {
      for await (const chunk of stream) inspect(chunk);
    };
    const readers = [consume(proc.stdout), consume(proc.stderr)];

    let resolveExitObserved!: () => void;
    const exitObserved = new Promise<void>((resolve) => {
      resolveExitObserved = resolve;
    });
    const handledExit = (async (): Promise<void> => {
      const code = await proc.exited;
      clearTimeout(ttlTimer);
      await Promise.allSettled(readers);
      if (this.generation !== generation) {
        resolveExitObserved();
        return;
      }
      if (this.process === proc) this.process = undefined;
      if (this.session.state === "expired" || this.session.state === "cancelled") {
        resolveExitObserved();
        return;
      }
      if (this.session.state === "failed") {
        resolveExitObserved();
        return;
      }
      if (code !== 0) {
        this.finishLogin("failed", LOGIN_FAILED_MESSAGE);
        resolveExitObserved();
        return;
      }

      this.session = {
        ...this.session,
        state: "verifying",
        message: "正在确认 ChatGPT 登录",
      };
      resolveExitObserved();
      let status: CodexCommandResult;
      try {
        status = await this.commandRunner.run(
          [this.codexBin, ...MANAGED_CODEX_AUTH_ARGS, "login", "status"],
          COMMAND_TIMEOUT_MS,
        );
      } catch {
        status = { code: 1, stdout: "", stderr: "" };
      }
      if (this.generation !== generation || this.session.state !== "verifying") return;
      if (status.code === 0) this.finishLogin("ready", LOGIN_READY_MESSAGE);
      else this.finishLogin("failed", LOGIN_FAILED_MESSAGE);
    })();
    void handledExit.catch(() => {
      clearTimeout(ttlTimer);
      if (this.generation === generation && ACTIVE_LOGIN_STATES.has(this.session.state)) {
        if (this.process === proc) this.process = undefined;
        this.finishLogin("failed", LOGIN_FAILED_MESSAGE);
      }
      resolveExitObserved();
    });

    let detailTimer: ReturnType<typeof setTimeout> | undefined;
    const detailDeadline = new Promise<{ type: "deadline" }>((resolve) => {
      detailTimer = setTimeout(() => resolve({ type: "deadline" }), this.detailWaitMs);
    });
    const outcome = await Promise.race([
      detailsFound.then((details) => ({ type: "details" as const, details })),
      exitObserved.then(() => ({ type: "exit" as const })),
      detailDeadline,
    ]);
    if (detailTimer) clearTimeout(detailTimer);

    if (
      outcome.type === "details"
      && this.generation === generation
      && this.session.state === "starting"
    ) {
      this.session = {
        ...this.session,
        state: "waiting_for_user",
        verificationUrl: outcome.details.verificationUrl,
        userCode: outcome.details.userCode,
        message: "请在浏览器中确认 ChatGPT 登录",
      };
    } else if (
      outcome.type === "deadline"
      && this.generation === generation
      && this.session.state === "starting"
    ) {
      this.finishLogin("failed", LOGIN_FAILED_MESSAGE);
      safelyKill(proc);
    }

    return this.deviceLoginStatus();
  }

  deviceLoginStatus(): CodexLoginSession {
    return { ...this.session };
  }

  cancelDeviceLogin(): CodexLoginSession {
    if (!ACTIVE_LOGIN_STATES.has(this.session.state)) return this.deviceLoginStatus();
    this.finishLogin("cancelled", LOGIN_CANCELLED_MESSAGE);
    if (this.process) {
      safelyKill(this.process);
      this.process = undefined;
    }
    return this.deviceLoginStatus();
  }

  private finishLogin(state: "ready" | "failed" | "expired" | "cancelled", message: string): void {
    this.session = {
      state,
      ...(this.session.startedAt !== undefined ? { startedAt: this.session.startedAt } : {}),
      ...(this.session.expiresAt !== undefined ? { expiresAt: this.session.expiresAt } : {}),
      message,
    };
  }
}

function boundedDuration(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(LOGIN_TTL_MS, Math.trunc(value)));
}

function safelyKill(proc: CodexLoginProcess): void {
  try {
    proc.kill();
  } catch {
    // The login process may exit between observing the session and cancellation.
  }
}

function appendBounded(previous: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (chunk.byteLength >= CAPTURE_LIMIT_BYTES) {
    return chunk.slice(chunk.byteLength - CAPTURE_LIMIT_BYTES);
  }
  const kept = previous.subarray(
    Math.max(0, previous.byteLength - (CAPTURE_LIMIT_BYTES - chunk.byteLength)),
  );
  const next = new Uint8Array(kept.byteLength + chunk.byteLength);
  next.set(kept);
  next.set(chunk, kept.byteLength);
  return next;
}

async function readBounded(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  let captured: Uint8Array = new Uint8Array();
  for await (const chunk of stream) captured = appendBounded(captured, chunk);
  return captured;
}

async function readLimited(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error("command output exceeds limit");
    chunks.push(chunk);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function extractAllowedLoginUrl(text: string): string | undefined {
  const matches = text.match(/https:\/\/[^\s<>'"\u001b]+/g) ?? [];
  for (const raw of matches) {
    const candidate = raw.replace(/[),.;\]]+$/, "");
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:") continue;
      if (parsed.username || parsed.password || parsed.port) continue;
      if (parsed.hostname !== "auth.openai.com" && parsed.hostname !== "chatgpt.com") continue;
      return parsed.toString();
    } catch {
      // Keep scanning; no unparsed value crosses the provider boundary.
    }
  }
  return undefined;
}

function extractSafeUserCode(text: string): string | undefined {
  const patterns = [
    /(?:user[\s-]*code|one[\s-]*time[\s-]*code|用户代码|验证码)(?:\s+is)?\s*[:：]?\s*([A-Z0-9][A-Z0-9-]{3,31})\b/i,
    /\bcode\s*[:：]\s*([A-Z0-9][A-Z0-9-]{3,31})\b/i,
  ];
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1];
    if (value && /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/i.test(value)) return value.toUpperCase();
  }
  return undefined;
}

export type CodexReleaseTarget = "aarch64-apple-darwin" | "x86_64-apple-darwin";

export interface CodexRelease {
  version: string;
  assetName: string;
  downloadUrl: string;
  sha256: string;
}

export interface CodexReleaseDiscovery {
  latest(target: CodexReleaseTarget): Promise<CodexRelease>;
}

export interface CodexInstallNetwork {
  getJson(url: string): Promise<unknown>;
  download(url: string): Promise<Uint8Array>;
}

export interface CodexInstallFileSystem {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: Uint8Array, mode: number): Promise<void>;
  extractTarGz(archivePath: string, destinationDir: string): Promise<void>;
  assertRegularFile(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface CodexInstallResult {
  path: string;
  version: string;
  sourceUrl: string;
  sha256: string;
  installedAt: number;
}

export type CodexInstallErrorCode =
  | "consent_required"
  | "unsupported_architecture"
  | "invalid_release"
  | "download_failed"
  | "checksum_mismatch"
  | "install_failed";

const INSTALL_ERROR_MESSAGES: Record<CodexInstallErrorCode, string> = {
  consent_required: "需要你确认后才能安装 Codex",
  unsupported_architecture: "这台 Mac 暂不支持自动安装 Codex",
  invalid_release: "无法验证 Codex 官方版本",
  download_failed: "Codex 下载失败，请重试",
  checksum_mismatch: "Codex 下载校验失败，请重试",
  install_failed: "Codex 安装未完成，请重试",
};

export class CodexInstallError extends Error {
  constructor(readonly code: CodexInstallErrorCode) {
    super(INSTALL_ERROR_MESSAGES[code]);
    this.name = "CodexInstallError";
  }
}

export interface CodexReleaseInstallerOptions {
  dataDir: string;
  architecture?: string;
  network?: CodexInstallNetwork;
  files?: CodexInstallFileSystem;
  releaseDiscovery?: CodexReleaseDiscovery;
  stagingId?: () => string;
  now?: () => number;
}

const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/openai/codex/releases/latest";

const fetchCodexNetwork: CodexInstallNetwork = {
  async getJson(url) {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "HomeAgent",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("release metadata unavailable");
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > MAX_METADATA_BYTES) throw new Error("release metadata too large");
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_METADATA_BYTES) {
      throw new Error("release metadata too large");
    }
    return JSON.parse(body) as unknown;
  },
  async download(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error("release download unavailable");
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > MAX_ARCHIVE_BYTES) throw new Error("release archive too large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("release archive too large");
    return bytes;
  },
};

const nodeCodexInstallFileSystem: CodexInstallFileSystem = {
  async mkdir(path) {
    await fsMkdir(path, { recursive: true });
  },
  async writeFile(path, data, mode) {
    await fsWriteFile(path, data, { mode });
  },
  async extractTarGz(archivePath, destinationDir) {
    const listing = Bun.spawn(
      ["/usr/bin/tar", "-tzf", archivePath],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    let listingTimedOut = false;
    const listingTimer = setTimeout(() => {
      listingTimedOut = true;
      listing.kill("SIGTERM");
    }, 15_000);
    let listedBytes: Uint8Array;
    let listedCode: number;
    try {
      [listedBytes, listedCode] = await Promise.all([
        readLimited(
        listing.stdout as unknown as AsyncIterable<Uint8Array>,
        MAX_ARCHIVE_LISTING_BYTES,
        ).catch((error: unknown) => {
          listing.kill("SIGTERM");
          throw error;
        }),
        listing.exited,
      ]);
    } finally {
      clearTimeout(listingTimer);
    }
    if (listingTimedOut || listedCode !== 0) throw new Error("release archive listing failed");
    const entries = new TextDecoder().decode(listedBytes).split(/\r?\n/).filter(Boolean);
    if (
      entries.length === 0
      || entries.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))
    ) {
      throw new Error("release archive contains an unsafe path");
    }
    const proc = Bun.spawn(
      ["/usr/bin/tar", "-xzf", archivePath, "-C", destinationDir],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, 60_000);
    try {
      const code = await proc.exited;
      if (timedOut || code !== 0) throw new Error("release extraction failed");
    } finally {
      clearTimeout(timer);
    }
  },
  async assertRegularFile(path) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid release executable");
  },
  async chmod(path, mode) {
    await fsChmod(path, mode);
  },
  async rename(from, to) {
    await fsRename(from, to);
  },
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
};

export function codexTargetForArchitecture(architecture: string): CodexReleaseTarget {
  if (architecture === "arm64") return "aarch64-apple-darwin";
  if (architecture === "x64") return "x86_64-apple-darwin";
  throw new Error("不支持的 Codex macOS 架构");
}

export class GitHubCodexReleaseDiscovery implements CodexReleaseDiscovery {
  constructor(private readonly network: CodexInstallNetwork = fetchCodexNetwork) {}

  async latest(target: CodexReleaseTarget): Promise<CodexRelease> {
    const value = await this.network.getJson(GITHUB_LATEST_RELEASE_URL);
    if (!isRecord(value)) throw new Error("invalid release metadata");
    const tag = stringValue(value.tag_name);
    const version = tag?.startsWith("rust-v") ? tag.slice("rust-v".length) : undefined;
    if (!version || !isValidReleaseVersion(version)) throw new Error("invalid release version");
    const assetName = `codex-${target}.tar.gz`;
    const assets = Array.isArray(value.assets) ? value.assets : [];
    const asset = assets.find(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) && candidate.name === assetName,
    );
    if (!asset) throw new Error("release asset unavailable");
    const downloadUrl = stringValue(asset.browser_download_url);
    const digest = stringValue(asset.digest);
    const sha256 = digest?.startsWith("sha256:") ? digest.slice("sha256:".length) : undefined;
    if (!downloadUrl || !sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new Error("release digest unavailable");
    }
    return {
      version,
      assetName,
      downloadUrl,
      sha256: sha256.toLowerCase(),
    };
  }
}

export class CodexReleaseInstaller {
  private readonly dataDir: string;
  private readonly architecture: string;
  private readonly network: CodexInstallNetwork;
  private readonly files: CodexInstallFileSystem;
  private readonly releaseDiscovery: CodexReleaseDiscovery;
  private readonly stagingId: () => string;
  private readonly now: () => number;

  constructor(options: CodexReleaseInstallerOptions) {
    this.dataDir = options.dataDir;
    this.architecture = options.architecture ?? process.arch;
    this.network = options.network ?? fetchCodexNetwork;
    this.files = options.files ?? nodeCodexInstallFileSystem;
    this.releaseDiscovery =
      options.releaseDiscovery ?? new GitHubCodexReleaseDiscovery(this.network);
    this.stagingId = options.stagingId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  async installAfterConsent(consented: boolean): Promise<CodexInstallResult> {
    if (!consented) throw new CodexInstallError("consent_required");

    let target: CodexReleaseTarget;
    try {
      target = codexTargetForArchitecture(this.architecture);
    } catch {
      throw new CodexInstallError("unsupported_architecture");
    }

    let release: CodexRelease;
    try {
      release = await this.releaseDiscovery.latest(target);
    } catch {
      throw new CodexInstallError("invalid_release");
    }
    if (!isTrustedCodexRelease(release, target)) {
      throw new CodexInstallError("invalid_release");
    }

    let archive: Uint8Array;
    try {
      archive = await this.network.download(release.downloadUrl);
    } catch {
      throw new CodexInstallError("download_failed");
    }
    const actualSha256 = createHash("sha256").update(archive).digest("hex");
    if (actualSha256 !== release.sha256.toLowerCase()) {
      throw new CodexInstallError("checksum_mismatch");
    }

    const id = this.stagingId();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new CodexInstallError("install_failed");
    const binDir = join(this.dataDir, "bin");
    const stagingDir = join(binDir, `.codex-install-${id}`);
    const archivePath = join(stagingDir, release.assetName);
    const stagedExecutable = join(stagingDir, `codex-${target}`);
    const stagedReceipt = join(stagingDir, "codex-install.json");
    const destination = join(binDir, "codex");
    const receiptPath = join(binDir, "codex-install.json");
    const installedAt = this.now();
    const result: CodexInstallResult = {
      path: destination,
      version: release.version,
      sourceUrl: release.downloadUrl,
      sha256: actualSha256,
      installedAt,
    };

    let stagingCreated = false;
    try {
      await this.files.mkdir(binDir);
      await this.files.mkdir(stagingDir);
      stagingCreated = true;
      await this.files.writeFile(archivePath, archive, 0o600);
      await this.files.extractTarGz(archivePath, stagingDir);
      await this.files.assertRegularFile(stagedExecutable);
      await this.files.chmod(stagedExecutable, 0o755);
      await this.files.writeFile(
        stagedReceipt,
        new TextEncoder().encode(`${JSON.stringify({
          version: result.version,
          sourceUrl: result.sourceUrl,
          sha256: result.sha256,
          installedAt: result.installedAt,
        }, null, 2)}\n`),
        0o600,
      );
      await this.files.rename(stagedExecutable, destination);
      await this.files.rename(stagedReceipt, receiptPath);
      return result;
    } catch (error) {
      if (error instanceof CodexInstallError) throw error;
      throw new CodexInstallError("install_failed");
    } finally {
      if (stagingCreated) {
        try {
          await this.files.remove(stagingDir);
        } catch {
          // A stale private staging directory is safer than masking install status.
        }
      }
    }
  }
}

function isTrustedCodexRelease(release: CodexRelease, target: CodexReleaseTarget): boolean {
  if (!isValidReleaseVersion(release.version)) return false;
  const expectedAsset = `codex-${target}.tar.gz`;
  if (release.assetName !== expectedAsset || !/^[a-f0-9]{64}$/i.test(release.sha256)) return false;
  try {
    const url = new URL(release.downloadUrl);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port) return false;
    if (url.username || url.password || url.search || url.hash) return false;
    return url.pathname
      === `/openai/codex/releases/download/rust-v${release.version}/${expectedAsset}`;
  } catch {
    return false;
  }
}

function isValidReleaseVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-(?:alpha|beta)(?:\.\d+)?)?$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

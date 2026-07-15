/**
 * Bounded lark-cli application setup for the local management UI.
 *
 * App Secret is deliberately absent from argv and is sent only over stdin to
 * `config init --app-secret-stdin`. This module does not persist credentials;
 * lark-cli owns its application profile and token storage.
 */
import type {
  LarkProvisioningSession,
  LarkSetupInput,
  LarkSetupStatus,
} from "@homebrain/shared";
import { runFeishuCommand } from "./feishu.ts";

export interface LarkSetupCommand {
  argv: string[];
  stdin?: string;
  timeoutMs: number;
}

export interface LarkSetupCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface LarkSetupCommandRunner {
  run(command: LarkSetupCommand): Promise<LarkSetupCommandResult>;
}

export interface LarkProvisioningProcess {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface LarkProvisioningSpawner {
  spawn(argv: string[]): LarkProvisioningProcess;
}

export interface LarkCliSetupOptions {
  larkBin?: string;
  runner?: LarkSetupCommandRunner;
  provisioningSpawner?: LarkProvisioningSpawner;
  urlWaitMs?: number;
  provisioningTtlMs?: number;
}

const NO_NOTIFIER_ENV = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
};

const VERIFICATION_URL =
  /https:\/\/(?:open\.feishu\.cn|open\.larksuite\.com)\/page\/(?:cli|launcher)\?[^\s<>'"]+/;
const EXPIRED_OUTPUT = /expired|timed?\s*out|timeout|过期|超时/i;
const URL_WAIT_MS = 15_000;
const PROVISIONING_TTL_MS = 10 * 60_000;
const STREAM_CAPTURE_LIMIT_BYTES = 4 * 1024;
const FAILED_MESSAGE = "飞书应用创建未完成，请重试";
const EXPIRED_MESSAGE = "飞书应用创建已过期，请重试";

const bunLarkProvisioningSpawner: LarkProvisioningSpawner = {
  spawn(argv) {
    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...NO_NOTIFIER_ENV },
    });
    return {
      stdout: proc.stdout as unknown as AsyncIterable<Uint8Array>,
      stderr: proc.stderr as unknown as AsyncIterable<Uint8Array>,
      exited: proc.exited,
      kill: () => proc.kill("SIGTERM"),
    };
  },
};

export const bunLarkSetupRunner: LarkSetupCommandRunner = {
  async run(command): Promise<LarkSetupCommandResult> {
    try {
      const stdout = await runFeishuCommand(command.argv, {
        stdin: command.stdin,
        env: NO_NOTIFIER_ENV,
        timeoutMs: command.timeoutMs,
        terminationGraceMs: 250,
      });
      return { code: 0, stdout, stderr: "" };
    } catch (error) {
      const stderr = String(error);
      return {
        code: stderr.includes("timed out") ? 124 : 1,
        stdout: "",
        stderr,
      };
    }
  },
};

export class LarkCliSetup {
  private readonly larkBin: string;
  private readonly runner: LarkSetupCommandRunner;
  private readonly provisioningSpawner: LarkProvisioningSpawner;
  private readonly urlWaitMs: number;
  private readonly provisioningTtlMs: number;
  private provisioningGeneration = 0;
  private provisioningProcess?: LarkProvisioningProcess;
  private provisioning: LarkProvisioningSession = {
    state: "idle",
    brand: "feishu",
    message: "尚未开始创建飞书应用",
  };

  constructor(opts: LarkCliSetupOptions = {}) {
    this.larkBin = opts.larkBin ?? "lark-cli";
    this.runner = opts.runner ?? bunLarkSetupRunner;
    this.provisioningSpawner = opts.provisioningSpawner ?? bunLarkProvisioningSpawner;
    this.urlWaitMs = opts.urlWaitMs ?? URL_WAIT_MS;
    this.provisioningTtlMs = opts.provisioningTtlMs ?? PROVISIONING_TTL_MS;
  }

  async startAutomatic(brand: "feishu" | "lark"): Promise<LarkProvisioningSession> {
    if (
      this.provisioning.state === "starting" ||
      this.provisioning.state === "waiting_for_user" ||
      this.provisioning.state === "verifying"
    ) {
      return this.provisioningStatus();
    }

    const generation = ++this.provisioningGeneration;
    if (this.provisioningProcess) safelyKill(this.provisioningProcess);

    const startedAt = Date.now();
    this.provisioning = {
      state: "starting",
      brand,
      startedAt,
      expiresAt: startedAt + this.provisioningTtlMs,
      message: "正在启动飞书应用创建",
    };
    let proc: LarkProvisioningProcess;
    try {
      proc = this.provisioningSpawner.spawn([
        this.larkBin,
        "config",
        "init",
        "--new",
        "--brand",
        brand,
        "--lang",
        "zh",
      ]);
      this.provisioningProcess = proc;
    } catch {
      this.provisioning = {
        ...this.provisioning,
        state: "failed",
        message: FAILED_MESSAGE,
      };
      return this.provisioningStatus();
    }

    const ttlTimer = setTimeout(() => {
      if (
        this.provisioningGeneration === generation &&
        (this.provisioning.state === "starting" ||
          this.provisioning.state === "waiting_for_user" ||
          this.provisioning.state === "verifying")
      ) {
        this.provisioning = {
          ...this.provisioning,
          state: "expired",
          message: EXPIRED_MESSAGE,
        };
        safelyKill(proc);
      }
    }, this.provisioningTtlMs);
    (ttlTimer as unknown as { unref?: () => void }).unref?.();

    let resolveUrl!: (url: string) => void;
    const foundUrl = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    const decoder = new TextDecoder();
    let expiredOutputSeen = false;
    const consume = async (stream: AsyncIterable<Uint8Array>): Promise<void> => {
      let captured = new Uint8Array();
      for await (const chunk of stream) {
        if (chunk.byteLength >= STREAM_CAPTURE_LIMIT_BYTES) {
          captured = chunk.slice(chunk.byteLength - STREAM_CAPTURE_LIMIT_BYTES);
        } else {
          const previous = captured.subarray(
            Math.max(
              0,
              captured.byteLength - (STREAM_CAPTURE_LIMIT_BYTES - chunk.byteLength),
            ),
          );
          const next = new Uint8Array(previous.byteLength + chunk.byteLength);
          next.set(previous);
          next.set(chunk, previous.byteLength);
          captured = next;
        }
        const capturedText = decoder.decode(captured);
        if (EXPIRED_OUTPUT.test(capturedText)) expiredOutputSeen = true;
        const match = capturedText.match(VERIFICATION_URL);
        if (match) resolveUrl(match[0]);
      }
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
      if (this.provisioningGeneration !== generation) {
        resolveExitObserved();
        return;
      }
      if (this.provisioningProcess === proc) this.provisioningProcess = undefined;
      if (this.provisioning.state === "expired") {
        resolveExitObserved();
        return;
      }
      if (code !== 0) {
        this.provisioning = {
          ...this.provisioning,
          state: expiredOutputSeen ? "expired" : "failed",
          message: expiredOutputSeen ? EXPIRED_MESSAGE : FAILED_MESSAGE,
        };
        resolveExitObserved();
        return;
      }

      this.provisioning = {
        ...this.provisioning,
        state: "verifying",
        message: "正在验证飞书机器人",
      };
      resolveExitObserved();
      const status = await this.status();
      if (
        this.provisioningGeneration !== generation ||
        this.provisioning.state !== "verifying"
      ) {
        return;
      }
      this.provisioning =
        status.state === "ready" && status.verified
          ? {
              ...this.provisioning,
              state: "ready",
              message: "飞书机器人已连接",
            }
          : {
              ...this.provisioning,
              state: "failed",
              message: FAILED_MESSAGE,
            };
    })();
    void handledExit.catch(() => {
      clearTimeout(ttlTimer);
      if (this.provisioningGeneration === generation) {
        if (this.provisioningProcess === proc) this.provisioningProcess = undefined;
        if (
          this.provisioning.state === "starting" ||
          this.provisioning.state === "waiting_for_user" ||
          this.provisioning.state === "verifying"
        ) {
          this.provisioning = {
            ...this.provisioning,
            state: "failed",
            message: FAILED_MESSAGE,
          };
        }
      }
      resolveExitObserved();
    });

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<{ type: "deadline" }>((resolve) => {
      deadlineTimer = setTimeout(() => resolve({ type: "deadline" }), this.urlWaitMs);
    });
    const outcome = await Promise.race([
      foundUrl.then((verificationUrl) => ({ type: "url" as const, verificationUrl })),
      exitObserved.then(() => ({ type: "exit" as const })),
      deadline,
    ]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (
      outcome.type === "deadline" &&
      this.provisioningGeneration === generation &&
      this.provisioning.state === "starting"
    ) {
      this.provisioning = {
        ...this.provisioning,
        state: "failed",
        message: FAILED_MESSAGE,
      };
      safelyKill(proc);
    }
    if (
      outcome.type === "url" &&
      this.provisioningGeneration === generation &&
      this.provisioning.state === "starting"
    ) {
      this.provisioning = {
        ...this.provisioning,
        state: "waiting_for_user",
        verificationUrl: outcome.verificationUrl,
        message: "请在飞书页面完成授权",
      };
    }
    return this.provisioningStatus();
  }

  provisioningStatus(): LarkProvisioningSession {
    return { ...this.provisioning };
  }

  async status(): Promise<LarkSetupStatus> {
    let result: LarkSetupCommandResult;
    try {
      result = await this.runner.run({
        argv: [this.larkBin, "auth", "status", "--json", "--verify"],
        timeoutMs: 15_000,
      });
    } catch {
      return {
        state: "unavailable",
        verified: false,
        message: "lark-cli 未安装、不可执行或连接超时",
      };
    }

    if (result.code !== 0) {
      return {
        state: /not configured|config init|missing app/i.test(`${result.stdout}\n${result.stderr}`)
          ? "unconfigured"
          : "invalid",
        verified: false,
        message: result.code === 124 ? "连接验证超时" : "lark-cli 应用配置无效或无法验证",
      };
    }

    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const root = isRecord(parsed.data) ? parsed.data : parsed;
      const identities = isRecord(root.identities) ? root.identities : {};
      const bot = isRecord(identities.bot) ? identities.bot : {};
      const appId = stringValue(root.appId);
      const brandValue = stringValue(root.brand);
      const brand = brandValue === "lark" ? "lark" : brandValue === "feishu" ? "feishu" : undefined;
      const botName = stringValue(bot.appName);
      const botOpenId = stringValue(bot.openId);
      const verified = bot.verified === true && bot.available !== false;
      const ready = verified && bot.status === "ready" && Boolean(botName && botOpenId);
      return {
        state: ready ? "ready" : appId ? "invalid" : "unconfigured",
        verified,
        ...(appId ? { appId } : {}),
        ...(brand ? { brand } : {}),
        ...(botName ? { botName } : {}),
        ...(botOpenId ? { botOpenId } : {}),
        message: stringValue(bot.message) ?? (ready ? "Bot identity: ready" : "Bot 身份尚未就绪"),
      };
    } catch {
      return {
        state: "invalid",
        verified: false,
        message: "lark-cli 返回了无法识别的状态",
      };
    }
  }

  async configure(input: LarkSetupInput): Promise<LarkSetupStatus> {
    const appId = input.appId.trim();
    const appSecret = input.appSecret;
    const brand = input.brand === "lark" ? "lark" : "feishu";
    if (!appId || !appSecret) throw new Error("App ID and App Secret are required");

    let result: LarkSetupCommandResult;
    try {
      result = await this.runner.run({
        argv: [
          this.larkBin,
          "config",
          "init",
          "--app-id",
          appId,
          "--app-secret-stdin",
          "--brand",
          brand,
        ],
        stdin: `${appSecret}\n`,
        timeoutMs: 30_000,
      });
    } catch {
      throw new Error("lark-cli is unavailable");
    }
    if (result.code !== 0) {
      throw new Error(`lark-cli configuration failed (${result.code})`);
    }

    const status = await this.status();
    if (status.state !== "ready" || !status.verified) {
      throw new Error("lark-cli bot verification failed");
    }
    return status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safelyKill(proc: LarkProvisioningProcess): void {
  try {
    proc.kill();
  } catch {
    // The child may already have stopped between observing state and sending SIGTERM.
  }
}

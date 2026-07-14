/**
 * Bounded lark-cli application setup for the local management UI.
 *
 * App Secret is deliberately absent from argv and is sent only over stdin to
 * `config init --app-secret-stdin`. This module does not persist credentials;
 * lark-cli owns its application profile and token storage.
 */
import type { LarkSetupInput, LarkSetupStatus } from "@homebrain/shared";
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

export interface LarkCliSetupOptions {
  larkBin?: string;
  runner?: LarkSetupCommandRunner;
}

const NO_NOTIFIER_ENV = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
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

  constructor(opts: LarkCliSetupOptions = {}) {
    this.larkBin = opts.larkBin ?? "lark-cli";
    this.runner = opts.runner ?? bunLarkSetupRunner;
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

import { describe, expect, test } from "bun:test";
import {
  LarkCliSetup,
  type LarkProvisioningProcess,
  type LarkSetupCommand,
  type LarkSetupCommandRunner,
} from "./lark-setup.ts";
import type {
  LarkAppRegistrar,
  LarkAppRegistrationResult,
} from "./lark-app-registration.ts";

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

async function waitForProvisioningState(
  setup: LarkCliSetup,
  state: ReturnType<LarkCliSetup["provisioningStatus"]>["state"],
): Promise<ReturnType<LarkCliSetup["provisioningStatus"]>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = setup.provisioningStatus();
    if (session.state === state) return session;
    await Bun.sleep(1);
  }
  throw new Error(`Provisioning did not reach ${state}`);
}

describe("LarkCliSetup", () => {
  test("creates through the official SDK and hands credentials to lark-cli through stdin", async () => {
    const secret = "sdk-secret-never-rendered";
    let resolveRegistration!: (result: LarkAppRegistrationResult) => void;
    const registration = new Promise<LarkAppRegistrationResult>((resolve) => {
      resolveRegistration = resolve;
    });
    let registrationSignal: AbortSignal | undefined;
    const registrar: LarkAppRegistrar = {
      register(input) {
        registrationSignal = input.signal;
        input.onVerificationUrl({
          url: "https://open.feishu.cn/page/launcher?user_code=SDK-SAFE",
          expiresInSeconds: 600,
        });
        return registration;
      },
    };
    const calls: LarkSetupCommand[] = [];
    const runner: LarkSetupCommandRunner = {
      async run(command) {
        calls.push(command);
        if (command.argv.includes("config")) {
          return { code: 0, stdout: "configured", stderr: "" };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            appId: "cli_sdk",
            brand: "feishu",
            identities: {
              bot: {
                status: "ready",
                available: true,
                verified: true,
                openId: "ou_sdk",
                appName: "Homebrain",
              },
            },
          }),
          stderr: "",
        };
      },
    };
    const setup = new LarkCliSetup({ runner, registrar });

    const waiting = await setup.startAutomatic("feishu");
    const duplicate = await setup.startAutomatic("feishu");

    expect(waiting.state).toBe("waiting_for_user");
    expect(waiting.verificationUrl).toBe(
      "https://open.feishu.cn/page/launcher?user_code=SDK-SAFE",
    );
    expect(duplicate.startedAt).toBe(waiting.startedAt);
    expect(registrationSignal?.aborted).toBeFalse();

    resolveRegistration({
      appId: "cli_sdk",
      appSecret: secret,
      brand: "feishu",
    });

    const ready = await waitForProvisioningState(setup, "ready");
    expect(calls[0]).toEqual({
      argv: [
        "lark-cli",
        "config",
        "init",
        "--app-id",
        "cli_sdk",
        "--app-secret-stdin",
        "--brand",
        "feishu",
      ],
      stdin: `${secret}\n`,
      timeoutMs: 30_000,
    });
    expect(calls[0]?.argv.join(" ")).not.toContain(secret);
    expect(ready.message).toBe("飞书机器人已连接");
    expect(JSON.stringify(ready)).not.toContain(secret);
  });

  test("starts one-click app provisioning and exposes only the verification URL", async () => {
    let spawned: string[] | undefined;
    let spawnCount = 0;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const process: LarkProvisioningProcess = {
      stdout: chunks(""),
      stderr: chunks(
        "Open the link below to configure app:\n",
        "https://open.feishu.cn/page/cli?user_code=SAFE-CODE&from=cli\n",
      ),
      exited,
      kill: () => resolveExit(143),
    };
    const setup = new LarkCliSetup({
      provisioningSpawner: {
        spawn(argv) {
          spawnCount += 1;
          spawned = argv;
          return process;
        },
      },
    });

    const session = await setup.startAutomatic("feishu");
    const duplicate = await setup.startAutomatic("feishu");

    expect(spawned).toEqual([
      "lark-cli",
      "config",
      "init",
      "--new",
      "--brand",
      "feishu",
      "--lang",
      "zh",
    ]);
    expect(session.state).toBe("waiting_for_user");
    expect(session.verificationUrl).toStartWith("https://open.feishu.cn/page/cli?");
    expect(JSON.stringify(session)).not.toContain("SAFE-CODE\n");
    expect(duplicate.startedAt).toBe(session.startedAt);
    expect(spawnCount).toBe(1);
    process.kill();
  });

  test("recognizes a verification URL split across chunks while both streams are active", async () => {
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const setup = new LarkCliSetup({
      urlWaitMs: 200,
      provisioningSpawner: {
        spawn: () => ({
          stdout: chunks(
            "https://open.feishu.cn/page/",
            "cli?user_code=SPLIT-CODE\n",
          ),
          stderr: chunks("interleaved diagnostic output\n"),
          exited,
          kill: () => resolveExit(143),
        }),
      },
    });

    const session = await setup.startAutomatic("feishu");

    expect(session.state).toBe("waiting_for_user");
    expect(session.verificationUrl).toBe(
      "https://open.feishu.cn/page/cli?user_code=SPLIT-CODE",
    );
    resolveExit(143);
  });

  test("recognizes a Feishu launcher provisioning URL split across chunks", async () => {
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const setup = new LarkCliSetup({
      urlWaitMs: 200,
      provisioningSpawner: {
        spawn: () => ({
          stdout: chunks(
            "Open the provisioning page:\nhttps://open.feishu.cn/page/laun",
            "cher?app_id=cli_launcher&source=lark-cli\n",
          ),
          stderr: chunks(""),
          exited,
          kill: () => resolveExit(143),
        }),
      },
    });

    const session = await setup.startAutomatic("feishu");

    expect(session.state).toBe("waiting_for_user");
    expect(session.verificationUrl).toBe(
      "https://open.feishu.cn/page/launcher?app_id=cli_launcher&source=lark-cli",
    );
    resolveExit(143);
  });

  test(
    "rejects an untrusted URL without surfacing child-process output",
    async () => {
      const secret = "never-render-this-token";
      const setup = new LarkCliSetup({
        provisioningSpawner: {
          spawn: () => ({
            stdout: chunks(""),
            stderr: chunks(`https://attacker.example/page/cli?token=${secret}\n`),
            exited: Promise.resolve(1),
            kill: () => {},
          }),
        },
      });

      const session = await setup.startAutomatic("feishu");

      expect(session.state).toBe("failed");
      expect(session.verificationUrl).toBeUndefined();
      expect(session.message).toBe("飞书应用创建未完成，请重试");
      expect(JSON.stringify(session)).not.toContain(secret);
    },
    200,
  );

  test(
    "fails safely when lark-cli does not emit a verification URL",
    async () => {
      let killed = false;
      const setup = new LarkCliSetup({
        urlWaitMs: 5,
        provisioningSpawner: {
          spawn: () => ({
            stdout: chunks("waiting without a URL"),
            stderr: chunks(""),
            exited: new Promise<number>(() => {}),
            kill: () => {
              killed = true;
            },
          }),
        },
      });

      const session = await setup.startAutomatic("feishu");

      expect(session.state).toBe("failed");
      expect(session.verificationUrl).toBeUndefined();
      expect(session.message).toBe("飞书应用创建未完成，请重试");
      expect(killed).toBeTrue();
    },
    200,
  );

  test("maps an expired authorization to a safe expired session", async () => {
    const secret = "hidden-device-code";
    const setup = new LarkCliSetup({
      provisioningSpawner: {
        spawn: () => ({
          stdout: chunks(""),
          stderr: chunks(`Authorization timed out for ${secret}\n`),
          exited: Promise.resolve(1),
          kill: () => {},
        }),
      },
    });

    const session = await setup.startAutomatic("feishu");

    expect(session.state).toBe("expired");
    expect(session.message).toBe("飞书应用创建已过期，请重试");
    expect(JSON.stringify(session)).not.toContain(secret);
  });

  test("expires and stops a provisioning process that outlives the session", async () => {
    let killed = false;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const setup = new LarkCliSetup({
      provisioningTtlMs: 5,
      provisioningSpawner: {
        spawn: () => ({
          stdout: chunks("https://open.feishu.cn/page/cli?user_code=WAIT\n"),
          stderr: chunks(""),
          exited,
          kill: () => {
            killed = true;
            resolveExit(143);
          },
        }),
      },
    });

    const waiting = await setup.startAutomatic("feishu");
    expect(waiting.state).toBe("waiting_for_user");
    await Bun.sleep(10);
    const expired = setup.provisioningStatus();
    expect(expired.state).toBe("expired");
    expect(expired.message).toBe("飞书应用创建已过期，请重试");
    expect(killed).toBeTrue();
  });

  test("maps process startup failures to the fixed public error", async () => {
    const secret = "private-spawn-detail";
    const setup = new LarkCliSetup({
      provisioningSpawner: {
        spawn: () => {
          throw new Error(`spawn failed: ${secret}`);
        },
      },
    });

    const session = await setup.startAutomatic("feishu");

    expect(session.state).toBe("failed");
    expect(session.message).toBe("飞书应用创建未完成，请重试");
    expect(JSON.stringify(session)).not.toContain(secret);
  });

  test("becomes ready only after the created bot identity is verified", async () => {
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let resolveStatus!: (result: {
      code: number;
      stdout: string;
      stderr: string;
    }) => void;
    const statusResult = new Promise<{
      code: number;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      resolveStatus = resolve;
    });
    const runner: LarkSetupCommandRunner = {
      run: () => statusResult,
    };
    const setup = new LarkCliSetup({
      runner,
      provisioningSpawner: {
        spawn: () => ({
          stdout: chunks("https://open.feishu.cn/page/cli?user_code=VERIFY\n"),
          stderr: chunks(""),
          exited,
          kill: () => resolveExit(143),
        }),
      },
    });

    const waiting = await setup.startAutomatic("feishu");
    expect(waiting.state).toBe("waiting_for_user");
    resolveExit(0);
    const verifying = await waitForProvisioningState(setup, "verifying");
    expect(verifying.message).toBe("正在验证飞书机器人");

    resolveStatus({
      code: 0,
      stdout: JSON.stringify({
        appId: "cli_created",
        brand: "feishu",
        identities: {
          bot: {
            status: "ready",
            available: true,
            verified: true,
            openId: "ou_created",
            appName: "Homebrain",
          },
        },
      }),
      stderr: "",
    });
    const ready = await waitForProvisioningState(setup, "ready");
    expect(ready.verificationUrl).toBe(waiting.verificationUrl);
    expect(ready.message).toBe("飞书机器人已连接");
  });

  test("configures through stdin and returns the verified bot identity", async () => {
    const calls: LarkSetupCommand[] = [];
    const responses = [
      { code: 0, stdout: "configuration saved", stderr: "" },
      {
        code: 0,
        stdout: JSON.stringify({
          appId: "cli_new",
          brand: "feishu",
          verified: true,
          identities: {
            bot: {
              status: "ready",
              available: true,
              verified: true,
              openId: "ou_new",
              appName: "新机器人",
              message: "Bot identity: ready",
            },
          },
        }),
        stderr: "",
      },
    ];
    const runner: LarkSetupCommandRunner = {
      run: async (command) => {
        calls.push(command);
        return responses.shift()!;
      },
    };
    const setup = new LarkCliSetup({ runner });

    const status = await setup.configure({
      appId: "cli_new",
      appSecret: "top-secret-value",
      brand: "feishu",
    });

    expect(calls[0]?.argv).toEqual([
      "lark-cli",
      "config",
      "init",
      "--app-id",
      "cli_new",
      "--app-secret-stdin",
      "--brand",
      "feishu",
    ]);
    expect(calls[0]?.stdin).toBe("top-secret-value\n");
    expect(calls[0]?.argv.join(" ")).not.toContain("top-secret-value");
    expect(calls[1]?.argv).toEqual([
      "lark-cli",
      "auth",
      "status",
      "--json",
      "--verify",
    ]);
    expect(status).toEqual({
      state: "ready",
      verified: true,
      appId: "cli_new",
      brand: "feishu",
      botName: "新机器人",
      botOpenId: "ou_new",
      message: "Bot identity: ready",
    });
  });

  test("configuration failures never include the App Secret in the surfaced error", async () => {
    const secret = "never-render-this-secret";
    const runner: LarkSetupCommandRunner = {
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: `invalid credential: ${secret}`,
      }),
    };
    const setup = new LarkCliSetup({ runner });

    let message = "";
    try {
      await setup.configure({ appId: "cli_bad", appSecret: secret, brand: "feishu" });
    } catch (error) {
      message = String(error);
    }

    expect(message).toContain("configuration failed");
    expect(message).not.toContain(secret);
  });
});

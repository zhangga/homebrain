import { describe, expect, test } from "bun:test";
import {
  LarkCliSetup,
  type LarkSetupCommand,
  type LarkSetupCommandRunner,
} from "./lark-setup.ts";

describe("LarkCliSetup", () => {
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

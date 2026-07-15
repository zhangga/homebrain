import { describe, expect, test } from "bun:test";
import type { LarkProvisioningSession, LarkSetupStatus } from "@homebrain/shared";
import { restartingView, setupLayout, setupView } from "./setup-view.ts";
import type { SetupSnapshot, SetupStep } from "./setup.ts";

const providers = [
  { id: "codex" as const, name: "Codex", bin: "codex", available: true, detail: "0.144.1" },
  { id: "claude" as const, name: "Claude Code", bin: "claude", available: false, detail: "未安装" },
];

function snapshot(current: SetupStep): SetupSnapshot {
  const order: SetupStep[] = ["ai", "feishu", "activate", "invite", "done"];
  return {
    current,
    completed: order.slice(0, order.indexOf(current)),
    selectedProviderReady: current !== "ai",
    larkReady: ["activate", "invite", "done"].includes(current),
    runtimeReady: ["invite", "done"].includes(current),
    groupReady: current === "done",
  };
}

const lark: LarkSetupStatus = {
  state: "unconfigured",
  verified: false,
  message: "尚未配置",
};

const idle: LarkProvisioningSession = {
  state: "idle",
  brand: "feishu",
  message: "尚未开始",
};

function render(current: SetupStep, overrides: Partial<Parameters<typeof setupView>[0]> = {}): string {
  return String(setupLayout(setupView({
    snapshot: snapshot(current),
    providers,
    models: { codex: ["gpt-5.4-mini"] },
    lark,
    provisioning: idle,
    runtime: { ready: false, consumers: [] },
    groups: [],
    restartRequired: false,
    restartable: true,
    codex: {
      enabled: false,
      canInstall: false,
      installed: false,
      installing: false,
      login: { state: "idle", message: "尚未连接" },
    },
    ...overrides,
  })));
}

describe("guided setup view", () => {
  test("AI step offers one detected-provider choice and one primary submit", () => {
    const body = render("ai");
    expect(body).toContain("先连接一个 AI");
    expect(body).toContain("Codex");
    expect(body).toContain("使用这个 AI");
    expect((body.match(/class="primary-action"/g) ?? []).length).toBe(1);
  });

  test("managed AI setup installs Codex with consent and guides device login", () => {
    const install = render("ai", {
      providers: [],
      codex: {
        enabled: true,
        canInstall: true,
        installed: false,
        installing: false,
        login: { state: "idle", message: "尚未连接" },
      },
    });
    expect(install).toContain("安装并连接 ChatGPT");
    expect(install).toContain('name="consent"');
    expect(install).not.toContain("npm install");

    const waiting = render("ai", {
      providers: [],
      codex: {
        enabled: true,
        canInstall: true,
        installed: true,
        installing: false,
        login: {
          state: "waiting_for_user",
          verificationUrl: "https://auth.openai.com/device",
          userCode: "SAFE-CODE",
          message: "等待确认",
        },
      },
    });
    expect(waiting).toContain("https://auth.openai.com/device");
    expect(waiting).toContain("SAFE-CODE");
    expect(waiting).toContain("/setup/ai/codex/session");

    const repair = render("ai", {
      providers: [],
      codex: {
        enabled: true,
        canInstall: true,
        installed: true,
        installing: false,
        login: { state: "failed", message: "ChatGPT 登录未完成，请重试" },
      },
    });
    expect(repair).toContain("重新安装 Codex");
    expect(repair).toContain("替换 Homebrain 专用目录");
  });

  test("Feishu step makes one-click provisioning primary and manual credentials secondary", () => {
    const body = render("feishu");
    expect(body.indexOf("一键创建飞书机器人")).toBeLessThan(body.indexOf("手动输入 App ID"));
    expect(body).toContain('action="/setup/feishu/automatic"');
    expect(body).toContain("自动配置机器人权限和事件订阅");
  });

  test("waiting provisioning renders the safe URL and polling", () => {
    const body = render("feishu", {
      provisioning: {
        state: "waiting_for_user",
        brand: "feishu",
        verificationUrl: "https://open.feishu.cn/page/launcher?user_code=safe",
        message: "请完成授权",
      },
    });
    expect(body).toContain("https://open.feishu.cn/page/launcher?user_code=safe");
    expect(body).toContain("/setup/feishu/session");
  });

  test("activation and invitation are written in user language", () => {
    const activation = render("activate", {
      lark: { state: "ready", verified: true, botName: "小脑", botOpenId: "ou_bot", message: "ready" },
      restartRequired: true,
      runtime: { ready: false, consumers: [{ key: "im.message.receive_v1", state: "starting" }] },
    });
    expect(activation).toContain("让机器人开始接收消息");
    expect(activation).toContain("接收飞书消息");
    expect(activation).toContain("激活消息监听");

    const permissionFailure = render("activate", {
      lark: { state: "ready", verified: true, botName: "小脑", botOpenId: "ou_bot", message: "ready" },
      runtime: { ready: false, consumers: [{ key: "im.message.receive_v1", state: "failed", lastError: "raw secret" }] },
    });
    expect(permissionFailure).toContain("连接还没有通过企业确认");
    expect(permissionFailure).toContain("飞书管理员批准");
    expect(permissionFailure).not.toContain("进入飞书开放平台手动创建");
    expect(permissionFailure).not.toContain("raw secret");
    expect(permissionFailure).toContain('action="/setup/restart"');

    const invite = render("invite", {
      lark: { state: "ready", verified: true, botName: "小脑", botOpenId: "ou_bot", message: "ready" },
    });
    expect(invite).toContain("小脑");
    expect(invite).toContain("@机器人 记住：这是第一条测试消息");
    expect(invite).toContain("我已发送，重新检查");
  });

  test("failed provisioning explains the failure without exposing CLI output", () => {
    const body = render("feishu", {
      provisioning: { state: "failed", brand: "feishu", message: "飞书应用创建未完成，请重试" },
    });
    expect(body).toContain("飞书应用创建未完成，请重试");
  });

  test("restart page waits for a different process instance", () => {
    const body = String(restartingView("old-process"));
    expect(body).toContain('data-instance="old-process"');
    expect(body).toContain("health.instanceId !== oldInstance");
  });

  test("done step enters the knowledge dashboard", () => {
    const body = render("done");
    expect(body).toContain("一切就绪");
    expect(body).toContain('action="/setup/finish"');
  });
});

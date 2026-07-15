import { describe, expect, test } from "bun:test";
import { buildSetupSnapshot } from "./setup.ts";

const provider = {
  id: "codex" as const,
  name: "Codex",
  bin: "codex",
  available: true,
  detail: "0.144.1",
};

describe("buildSetupSnapshot", () => {
  test("starts at AI when the selected provider is unavailable", () => {
    expect(buildSetupSnapshot({
      defaultProvider: "claude",
      providers: [provider],
      lark: { state: "unconfigured", verified: false, message: "missing" },
      runtime: { ready: false, consumers: [] },
      restartRequired: false,
      groups: 0,
      completedAt: undefined,
    }).current).toBe("ai");
  });

  test("advances through Feishu, activation and invite", () => {
    const base = {
      defaultProvider: "codex",
      providers: [provider],
      groups: 0,
      completedAt: undefined,
    };
    expect(buildSetupSnapshot({
      ...base,
      lark: { state: "unconfigured", verified: false, message: "missing" },
      runtime: { ready: false, consumers: [] },
      restartRequired: false,
    }).current).toBe("feishu");
    expect(buildSetupSnapshot({
      ...base,
      lark: {
        state: "ready",
        verified: true,
        botName: "Homebrain",
        botOpenId: "ou_bot",
        message: "ready",
      },
      runtime: { ready: false, consumers: [] },
      restartRequired: true,
    }).current).toBe("activate");
    expect(buildSetupSnapshot({
      ...base,
      lark: {
        state: "ready",
        verified: true,
        botName: "Homebrain",
        botOpenId: "ou_bot",
        message: "ready",
      },
      runtime: { ready: true, consumers: [] },
      restartRequired: false,
    }).current).toBe("invite");
  });

  test("completed setups may skip a group but still reopen broken prerequisites", () => {
    const ready = {
      defaultProvider: "codex",
      providers: [provider],
      lark: {
        state: "ready" as const,
        verified: true,
        botName: "Homebrain",
        botOpenId: "ou_bot",
        message: "ready",
      },
      runtime: { ready: true, consumers: [] },
      restartRequired: false,
      groups: 0,
      completedAt: 1,
    };
    expect(buildSetupSnapshot(ready).current).toBe("done");
    expect(buildSetupSnapshot({
      ...ready,
      lark: { state: "unconfigured", verified: false, message: "missing" },
      runtime: { ready: false, consumers: [] },
    }).current).toBe("feishu");
  });
});

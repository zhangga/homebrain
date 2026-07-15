import { describe, expect, test } from "bun:test";
import type { Config } from "@homeagent/shared";
import {
  feishuAppConsoleUrl,
  resolveExternalSharingState,
} from "./external-sharing.ts";

const base = {
  feishuExternalSharingAppId: "cli_current",
  feishuExternalSharingStartedAt: 100,
} as Config;

describe("Feishu external sharing state", () => {
  test("keeps progress isolated to the currently configured app", () => {
    expect(resolveExternalSharingState(base, "cli_current")).toEqual(
      expect.objectContaining({
        state: "awaiting_external_message",
        appId: "cli_current",
        startedAt: 100,
      }),
    );
    expect(resolveExternalSharingState(base, "cli_replacement").state).toBe("not_started");
  });

  test("recognizes verified and explicitly skipped current apps", () => {
    expect(resolveExternalSharingState({
      ...base,
      feishuExternalSharingVerifiedAt: 200,
      feishuExternalSharingVerifiedChatId: "oc_external",
    }, "cli_current")).toEqual(expect.objectContaining({
      state: "verified",
      verifiedAt: 200,
      verifiedChatId: "oc_external",
    }));
    expect(resolveExternalSharingState({
      ...base,
      feishuExternalSharingSkippedAppId: "cli_current",
    }, "cli_current").state).toBe("skipped");
  });

  test("builds console links only for safe Feishu app ids", () => {
    expect(feishuAppConsoleUrl("cli_safe-123")).toBe(
      "https://open.feishu.cn/app/cli_safe-123",
    );
    expect(feishuAppConsoleUrl("../redirect?secret=x")).toBeUndefined();
  });
});

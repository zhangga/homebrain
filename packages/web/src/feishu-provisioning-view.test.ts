import { describe, expect, test } from "bun:test";
import type { LarkProvisioningState } from "@homebrain/shared";
import {
  feishuProvisioningPollScript,
  isFeishuProvisioningActive,
  isFeishuProvisioningFailure,
  isFeishuProvisioningTerminal,
} from "./feishu-provisioning-view.ts";

describe("Feishu provisioning view helpers", () => {
  test("classifies interactive and terminal provisioning states", () => {
    const active: LarkProvisioningState[] = ["starting", "waiting_for_user", "verifying"];
    const inactive: LarkProvisioningState[] = ["idle", "ready", "failed", "expired"];
    const terminal: LarkProvisioningState[] = ["ready", "failed", "expired"];
    const nonterminal: LarkProvisioningState[] = ["idle", "starting", "waiting_for_user", "verifying"];
    const failure: LarkProvisioningState[] = ["failed", "expired"];
    const nonfailure: LarkProvisioningState[] = ["idle", "starting", "waiting_for_user", "verifying", "ready"];

    expect(active.map(isFeishuProvisioningActive))
      .toEqual([true, true, true]);
    expect(inactive.map(isFeishuProvisioningActive))
      .toEqual([false, false, false, false]);

    expect(terminal.map(isFeishuProvisioningTerminal))
      .toEqual([true, true, true]);
    expect(nonterminal.map(isFeishuProvisioningTerminal))
      .toEqual([false, false, false, false]);
    expect(failure.map(isFeishuProvisioningFailure)).toEqual([true, true]);
    expect(nonfailure.map(isFeishuProvisioningFailure))
      .toEqual([false, false, false, false, false]);
  });

  test("polls the setup session until provisioning reaches a terminal state", () => {
    const script = String(feishuProvisioningPollScript());

    expect(script).toContain('fetch("/setup/feishu/session", { cache:"no-store" })');
    expect(script).toContain('const terminalStates = ["ready","failed","expired"];');
    expect(script).toContain("terminalStates.includes(session.state)");
    expect(script.match(/\["ready","failed","expired"\]/g)).toHaveLength(1);
    expect(script).toContain("setTimeout(poll, 1500)");
    expect(script).toContain("setTimeout(poll, 2500)");
  });
});

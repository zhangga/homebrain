import type { DetectedProvider } from "@homebrain/llm";
import type { LarkSetupStatus } from "@homebrain/shared";
import type { FeishuRuntimeStatus } from "./integrations.ts";
import type { FeishuExternalSharingState } from "./external-sharing.ts";

export type SetupStep = "ai" | "feishu" | "external_share" | "activate" | "invite" | "done";

export interface SetupSnapshot {
  current: SetupStep;
  completed: SetupStep[];
  selectedProviderReady: boolean;
  larkReady: boolean;
  runtimeReady: boolean;
  groupReady: boolean;
}

export interface SetupSnapshotInput {
  defaultProvider: string;
  providers: DetectedProvider[];
  lark: LarkSetupStatus;
  runtime: FeishuRuntimeStatus;
  restartRequired: boolean;
  groups: number;
  completedAt?: number;
  externalSharing: FeishuExternalSharingState;
}

export function buildSetupSnapshot(input: SetupSnapshotInput): SetupSnapshot {
  const selectedProviderReady = input.providers.some(
    (provider) => provider.id === input.defaultProvider && provider.available,
  );
  const larkReady = input.lark.state === "ready" && input.lark.verified;
  const runtimeReady = larkReady && !input.restartRequired && input.runtime.ready;
  const groupReady = input.groups > 0;
  const current: SetupStep = !selectedProviderReady
    ? "ai"
    : !larkReady
      ? "feishu"
      : input.externalSharing === "not_started"
        ? "external_share"
        : !runtimeReady
          ? "activate"
          : input.externalSharing === "awaiting_external_message"
            ? "external_share"
            : !groupReady && !input.completedAt
              ? "invite"
              : "done";
  const order: SetupStep[] = ["ai", "feishu", "external_share", "activate", "invite", "done"];

  return {
    current,
    completed: order.slice(0, Math.max(0, order.indexOf(current))),
    selectedProviderReady,
    larkReady,
    runtimeReady,
    groupReady,
  };
}

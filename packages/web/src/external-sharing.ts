import type { Config } from "@homeagent/shared";

export type FeishuExternalSharingState =
  | "not_started"
  | "awaiting_external_message"
  | "verified"
  | "skipped";

export interface FeishuExternalSharingStatus {
  state: FeishuExternalSharingState;
  appId?: string;
  consoleUrl?: string;
  startedAt?: number;
  verifiedAt?: number;
  verifiedChatId?: string;
  verifiedGroupName?: string;
}

const SAFE_APP_ID = /^[A-Za-z0-9_-]{3,128}$/;

export function feishuAppConsoleUrl(appId?: string): string | undefined {
  const normalized = appId?.trim();
  return normalized && SAFE_APP_ID.test(normalized)
    ? `https://open.feishu.cn/app/${normalized}`
    : undefined;
}

export function resolveExternalSharingState(
  cfg: Config,
  appId?: string,
): FeishuExternalSharingStatus {
  const normalizedAppId = appId?.trim();
  const base = {
    ...(normalizedAppId ? { appId: normalizedAppId } : {}),
    ...(feishuAppConsoleUrl(normalizedAppId)
      ? { consoleUrl: feishuAppConsoleUrl(normalizedAppId) }
      : {}),
  };
  if (!normalizedAppId) return { state: "not_started", ...base };
  if (cfg.feishuExternalSharingSkippedAppId === normalizedAppId) {
    return { state: "skipped", ...base };
  }
  if (cfg.feishuExternalSharingAppId !== normalizedAppId) {
    return { state: "not_started", ...base };
  }
  if (cfg.feishuExternalSharingVerifiedAt) {
    return {
      state: "verified",
      ...base,
      startedAt: cfg.feishuExternalSharingStartedAt,
      verifiedAt: cfg.feishuExternalSharingVerifiedAt,
      verifiedChatId: cfg.feishuExternalSharingVerifiedChatId,
    };
  }
  if (cfg.feishuExternalSharingStartedAt) {
    return {
      state: "awaiting_external_message",
      ...base,
      startedAt: cfg.feishuExternalSharingStartedAt,
    };
  }
  return { state: "not_started", ...base };
}

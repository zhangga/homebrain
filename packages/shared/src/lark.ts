/** Shared value contracts for local lark-cli application setup. */
export type LarkSetupState = "ready" | "unconfigured" | "invalid" | "unavailable";

export interface LarkBotIdentity {
  botName: string;
  botOpenId: string;
}

export interface LarkSetupStatus {
  state: LarkSetupState;
  verified: boolean;
  appId?: string;
  brand?: "feishu" | "lark";
  botName?: string;
  botOpenId?: string;
  message: string;
}

export interface LarkSetupInput {
  appId: string;
  appSecret: string;
  brand: "feishu" | "lark";
}

export type LarkProvisioningState =
  | "idle"
  | "starting"
  | "waiting_for_user"
  | "verifying"
  | "ready"
  | "failed"
  | "expired";

export interface LarkProvisioningSession {
  state: LarkProvisioningState;
  brand: "feishu" | "lark";
  verificationUrl?: string;
  startedAt?: number;
  expiresAt?: number;
  message: string;
}

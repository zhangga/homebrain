/** Public setup boundary used by the management backend. */
import type { LarkSetupInput, LarkSetupStatus } from "@homebrain/shared";

export interface LarkSetupPort {
  status(): Promise<LarkSetupStatus>;
  configure(input: LarkSetupInput): Promise<LarkSetupStatus>;
}

export interface FeishuRuntimeStatus {
  ready: boolean;
  consumers: Array<{
    key: string;
    state: string;
    lastError?: string;
  }>;
}

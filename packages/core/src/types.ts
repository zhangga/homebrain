/**
 * Core-internal types layered on the shared domain vocabulary. Options bags for
 * the Knowledge seam live here so the interface file stays declarative.
 */
import type { SpaceId } from "@homebrain/shared";

export interface DreamOptions {
  /** cap on raw entries processed this run (cost control) */
  maxEntries?: number;
  /** process only these raw entries; when set, the normal 40-entry batch cap is not applied */
  rawIds?: string[];
  /** re-distill even if the source hash is unchanged */
  force?: boolean;
  /** model override for distillation */
  model?: string;
}

export interface AskOptions {
  /** model override for synthesis */
  model?: string;
  /** agent persona / extra system instruction injected into synthesis + fallback */
  instruction?: string;
  /** max wiki pages loaded whole into the synthesis context */
  maxPages?: number;
  /** when true, never fall back to general knowledge (knowledge-only) */
  knowledgeOnly?: boolean;
}

export interface SearchOptions {
  limit?: number;
}

export interface RetractionRequest {
  chatId: string;
  messageId: string;
  requestedBy: string;
  /** trusted role assertion supplied by the chat connector */
  requesterIsAdmin?: boolean;
}

export type RetractionStatus = "retracted" | "already_retracted" | "not_found" | "forbidden";

export interface RetractionResult {
  status: RetractionStatus;
  /** content pages removed because they included the retracted source */
  affectedPages: string[];
  /** exact surviving source ids to rebuild before confirming the retraction */
  requeuedSourceIds: string[];
}

/** A space and its on-disk purpose/schema, as tracked by the registry. */
export interface SpaceMeta {
  id: SpaceId;
  createdAt: number;
  lastDreamAt?: number;
  /** feishu chat_id this space is bound to (team spaces) */
  chatId?: string;
  /** human-readable display name for the group (management backend) */
  name?: string;
  /** id of the Agent assigned to answer in this space (undefined => default) */
  agentId?: string;
  /**
   * Whether replies thread ("Topic reply" in mew). Defaults to true for team
   * spaces and false for personal when unset (see runtime send()).
   */
  replyInThread?: boolean;
  /**
   * Whether the bot only responds when @-mentioned in a group ("@ mentions
   * only" in mew). Defaults to true when unset. No effect on p2p.
   */
  mentionsOnly?: boolean;
}

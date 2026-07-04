/**
 * Core-internal types layered on the shared domain vocabulary. Options bags for
 * the Knowledge seam live here so the interface file stays declarative.
 */
import type { SpaceId } from "@homebrain/shared";

export interface DreamOptions {
  /** cap on raw entries processed this run (cost control) */
  maxEntries?: number;
  /** re-distill even if the source hash is unchanged */
  force?: boolean;
  /** model override for distillation */
  model?: string;
}

export interface AskOptions {
  /** model override for synthesis */
  model?: string;
  /** max wiki pages loaded whole into the synthesis context */
  maxPages?: number;
  /** when true, never fall back to general knowledge (knowledge-only) */
  knowledgeOnly?: boolean;
}

export interface SearchOptions {
  limit?: number;
}

/** A space and its on-disk purpose/schema, as tracked by the registry. */
export interface SpaceMeta {
  id: SpaceId;
  createdAt: number;
  lastDreamAt?: number;
  /** feishu chat_id this space is bound to (team spaces) */
  chatId?: string;
}

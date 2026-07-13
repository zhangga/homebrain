/**
 * The Knowledge seam (plan §2.2). Upper layers (orchestrator, web) depend ONLY
 * on this interface, never on the SQLite/markdown/LLM internals behind it. That
 * makes the engine replaceable — e.g. a future embedding-backed implementation
 * can be swapped in without touching callers (plan R7).
 */
import type {
  AskResult,
  DreamReport,
  Hit,
  HealthReport,
  Page,
  PageRef,
  RawEntry,
  SpaceId,
} from "@homebrain/shared";
import type {
  AskOptions,
  DreamOptions,
  RetractionRequest,
  RetractionResult,
  SearchOptions,
} from "./types.ts";

export interface Knowledge {
  /** Cheap capture — persists a raw entry, no LLM call. */
  remember(entry: RawEntry): Promise<string>;

  /** Remove one captured message, enforcing source ownership. */
  retractMessage(space: SpaceId, request: RetractionRequest): Promise<RetractionResult>;

  /** Nightly distillation: turn pending raw entries into wiki pages. */
  runDreamCycle(space: SpaceId, opts?: DreamOptions): Promise<DreamReport>;

  /**
   * Answer a question over the union of `spaces`. Returns an answer tagged
   * knowledge (grounded, with citations) or general (model fallback).
   */
  ask(spaces: SpaceId[], question: string, opts?: AskOptions): Promise<AskResult>;

  /** FTS fallback search across `spaces`. */
  search(spaces: SpaceId[], keyword: string, opts?: SearchOptions): Promise<Hit[]>;

  getPage(space: SpaceId, slug: string): Promise<Page | null>;
  upsertPage(space: SpaceId, page: Page): Promise<void>;
  listPages(space: SpaceId, type?: string): Promise<PageRef[]>;

  /** Rebuild a space's index from its markdown files. */
  rebuildIndex(space: SpaceId): Promise<{ rebuilt: number; corrupt: string[] }>;

  health(): Promise<HealthReport>;
}

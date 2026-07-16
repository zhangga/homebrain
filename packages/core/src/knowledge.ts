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
} from "@homeagent/shared";
import type {
  AskOptions,
  DreamOptions,
  QuarantineBatchRetryResult,
  QuarantineRecord,
  QuarantineRetryResult,
  RetractionRequest,
  RetractionResult,
  SearchOptions,
} from "./types.ts";
import type {
  KnowledgeCorrectionResult,
  KnowledgeGovernanceSnapshot,
  KnowledgePageDeleteResult,
  KnowledgePageRegenerationResult,
  RawGovernanceDetail,
} from "./knowledge-governance.ts";

export interface Knowledge {
  /** Cheap capture — persists a raw entry, no LLM call. */
  remember(entry: RawEntry): Promise<string>;

  /** Read and edit the human-maintained rules and governance history for a space. */
  getSpaceGovernance(space: SpaceId): Promise<KnowledgeGovernanceSnapshot>;
  updateSpaceRules(
    space: SpaceId,
    input: { purpose?: string; schema?: string },
    actor: string,
  ): Promise<KnowledgeGovernanceSnapshot>;
  resetSpaceRule(
    space: SpaceId,
    target: "purpose" | "schema",
    actor: string,
  ): Promise<KnowledgeGovernanceSnapshot>;
  getRawGovernanceDetail(space: SpaceId, rawId: string): Promise<RawGovernanceDetail | null>;
  redistillRaw(
    space: SpaceId,
    rawId: string,
    actor: string,
    model?: string,
  ): Promise<DreamReport>;
  deleteKnowledgePage(
    space: SpaceId,
    slug: string,
    actor: string,
  ): Promise<KnowledgePageDeleteResult>;
  regenerateKnowledgePage(
    space: SpaceId,
    slug: string,
    actor: string,
    model?: string,
  ): Promise<KnowledgePageRegenerationResult>;
  submitKnowledgeCorrection(
    space: SpaceId,
    slug: string,
    correction: string,
    actor: string,
    model?: string,
  ): Promise<KnowledgeCorrectionResult>;

  /** Remove one captured message, enforcing source ownership. */
  retractMessage(space: SpaceId, request: RetractionRequest): Promise<RetractionResult>;

  /** Nightly distillation: turn pending raw entries into wiki pages. */
  runDreamCycle(space: SpaceId, opts?: DreamOptions): Promise<DreamReport>;

  /** Durable failed page generations awaiting an explicit retry. */
  listQuarantines(space: SpaceId): Promise<QuarantineRecord[]>;

  retryQuarantine(space: SpaceId, id: string, model?: string): Promise<QuarantineRetryResult>;
  retryQuarantines(space: SpaceId, model?: string): Promise<QuarantineBatchRetryResult>;

  /**
   * Answer a question over the union of `spaces`. Returns an answer tagged
   * knowledge (grounded, with citations) or general (model fallback).
   */
  ask(spaces: SpaceId[], question: string, opts?: AskOptions): Promise<AskResult>;

  /** Search across `spaces`; defaults to FTS, with an explicit hybrid experiment option. */
  search(spaces: SpaceId[], keyword: string, opts?: SearchOptions): Promise<Hit[]>;

  getPage(space: SpaceId, slug: string): Promise<Page | null>;
  upsertPage(space: SpaceId, page: Page): Promise<void>;
  listPages(space: SpaceId, type?: string): Promise<PageRef[]>;

  /** Rebuild a space's index from its markdown files. */
  rebuildIndex(space: SpaceId): Promise<{ rebuilt: number; corrupt: string[] }>;

  health(): Promise<HealthReport>;
}

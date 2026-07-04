/**
 * KnowledgeEngine implements the Knowledge seam over the markdown + SQLite
 * substrate. It owns:
 *   - a SpaceRegistry (space existence + metadata),
 *   - a Serializer so all writes to one space are strictly serialized
 *     (plan §III: single-consumer, write-serialized) while reads stay lock-free.
 *
 * Distillation (runDreamCycle) and question answering (ask) are delegated to
 * dedicated modules so this file stays focused on capture, search, and page I/O.
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
import { Serializer, config, logger } from "@homebrain/shared";
import { ping } from "@homebrain/llm";
import type { Knowledge } from "./knowledge.ts";
import type { AskOptions, DreamOptions, SearchOptions } from "./types.ts";
import { SpaceRegistry } from "./registry.ts";
import { runDreamCycle } from "./dream.ts";
import { ask as askImpl } from "./ask.ts";
import { gatewayClient, type LlmClient } from "./llm.ts";

const log = logger.child("core");

export interface EngineOptions {
  dataDir?: string;
  serializer?: Serializer;
  /** override the LLM client (tests inject a fake; defaults to the gateway) */
  llm?: LlmClient;
}

export class KnowledgeEngine implements Knowledge {
  readonly registry: SpaceRegistry;
  readonly serializer: Serializer;
  private dataDir: string;
  private llm: LlmClient;

  constructor(opts: EngineOptions = {}) {
    this.dataDir = opts.dataDir ?? config().dataDir;
    this.registry = new SpaceRegistry(this.dataDir);
    this.serializer = opts.serializer ?? new Serializer();
    this.llm = opts.llm ?? gatewayClient;
  }

  /** Ensure a space exists (used by connectors when a group is joined). */
  ensureSpace(space: SpaceId, opts: { chatId?: string } = {}): void {
    this.registry.ensure(space, opts);
  }

  async remember(entry: RawEntry): Promise<string> {
    // Capture is a write; serialize per space so it never races distillation.
    return this.serializer.run(entry.space, async () => {
      const store = this.registry.ensure(entry.space, { chatId: entry.chatId });
      const id = store.index().insertRaw(entry);
      log.debug("remembered raw entry", { space: entry.space, source: entry.source, id });
      return id;
    });
  }

  async runDreamCycle(space: SpaceId, opts: DreamOptions = {}): Promise<DreamReport> {
    return this.serializer.run(space, async () => {
      const store = this.registry.ensure(space);
      const report = await runDreamCycle(store, opts, { client: this.llm });
      this.registry.setLastDream(space, report.finishedAt);
      return report;
    });
  }

  async ask(spaces: SpaceId[], question: string, opts: AskOptions = {}): Promise<AskResult> {
    // Reads do not go through the serializer.
    const stores = spaces.filter((s) => this.registry.has(s)).map((s) => this.registry.store(s));
    return askImpl(stores, question, opts, { client: this.llm });
  }

  async search(spaces: SpaceId[], keyword: string, opts: SearchOptions = {}): Promise<Hit[]> {
    const limit = opts.limit ?? 10;
    const hits: Hit[] = [];
    for (const space of spaces) {
      if (!this.registry.has(space)) continue;
      hits.push(...this.registry.store(space).index().search(keyword, limit));
    }
    // Merge across spaces by bm25 score (lower is better) and cap.
    hits.sort((a, b) => a.score - b.score);
    return hits.slice(0, limit);
  }

  async getPage(space: SpaceId, slug: string): Promise<Page | null> {
    if (!this.registry.has(space)) return null;
    return this.registry.store(space).index().getPage(slug);
  }

  async upsertPage(space: SpaceId, page: Page): Promise<void> {
    await this.serializer.run(space, async () => {
      const store = this.registry.ensure(space);
      store.writePage(page);
    });
  }

  async listPages(space: SpaceId, type?: string): Promise<PageRef[]> {
    if (!this.registry.has(space)) return [];
    return this.registry.store(space).index().listPages(type);
  }

  async rebuildIndex(space: SpaceId): Promise<{ rebuilt: number; corrupt: string[] }> {
    return this.serializer.run(space, async () => {
      const store = this.registry.ensure(space);
      return store.rebuildIndex();
    });
  }

  async health(): Promise<HealthReport> {
    const spaces = this.registry.list();
    const gatewayOk = await ping().catch(() => false);
    return {
      ok: gatewayOk,
      spaces: spaces.length,
      details: {
        gatewayOk,
        spaces: spaces.map((s) => ({
          id: s.id,
          pages: this.registry.store(s.id).index().countPages(),
          pendingRaw: this.registry.store(s.id).index().countRaw(true),
          lastDreamAt: s.lastDreamAt,
        })),
      },
    };
  }

  close(): void {
    this.registry.closeAll();
  }
}

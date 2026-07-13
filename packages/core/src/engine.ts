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
import { ping, isCliProvider, type ProviderId } from "@homebrain/llm";
import type { Knowledge } from "./knowledge.ts";
import type {
  AskOptions,
  DreamOptions,
  RetractionRequest,
  RetractionResult,
  SearchOptions,
} from "./types.ts";
import { SpaceRegistry } from "./registry.ts";
import { AgentStore, type Agent } from "./agents.ts";
import { TaskStore, type Task } from "./tasks.ts";
import { runDreamCycle } from "./dream.ts";
import { refreshDigest } from "./digest.ts";
import { ask as askImpl } from "./ask.ts";
import { gatewayClient, type LlmClient } from "./llm.ts";
import { makeCliClient, type RunProviderFn } from "./cli-client.ts";

const log = logger.child("core");

/** Thrown when a space has no runnable LLM provider (agent unset / CLI missing). */
export class NoProviderError extends Error {
  constructor(readonly space: SpaceId) {
    super(`no runnable LLM provider configured for ${space}`);
    this.name = "NoProviderError";
  }
}

/** Summary of one task run. */
export interface TaskReport {
  taskId: string;
  space: SpaceId;
  ok: boolean;
  /** short preview of the captured output (for notifications/UI) */
  summary?: string;
  error?: string;
  rawId?: string;
  /** wiki pages created/updated by the post-run distillation (when enabled) */
  pagesWritten?: number;
  startedAt: number;
  finishedAt: number;
}

/** Options for a task run. */
export interface RunTaskOptions {
  /**
   * Override immediate distillation. When omitted, the task's own
   * `distillOnRun` field decides (default true) — distill the captured output
   * into wiki pages right after the run, so research becomes a knowledge page
   * at once rather than waiting for the nightly dream cycle. Tests pass false to
   * stay offline.
   */
  distill?: boolean;
}

/** How long a research task may run before the CLI is killed (much longer than Q&A). */
const TASK_TIMEOUT_MS = 300_000;

/** Build the research prompt handed to the agent CLI for a task. */
function researchPrompt(topic: string): string {
  return [
    `请就以下主题做一次调研，输出可沉淀为团队知识的要点与结论：`,
    "",
    `## 主题`,
    topic,
    "",
    "要求：",
    "- 用中文输出，条理清晰（可用小标题/要点）。",
    "- 聚焦事实、结论、关键信息，避免空泛。",
    "- 不要执行任何命令或修改文件，只需给出研究内容文本。",
  ].join("\n");
}

export interface EngineOptions {
  dataDir?: string;
  serializer?: Serializer;
  /**
   * Override the LLM client. When set (tests), it is used for ALL spaces,
   * bypassing CLI routing. When unset (production), each space uses a
   * CLI-backed client chosen from its agent or the global default.
   */
  llm?: LlmClient;
  /** override the local-CLI runner (tests inject a fake to avoid spawning) */
  runProvider?: RunProviderFn;
}

export class KnowledgeEngine implements Knowledge {
  readonly registry: SpaceRegistry;
  readonly agents: AgentStore;
  readonly tasks: TaskStore;
  readonly serializer: Serializer;
  private dataDir: string;
  private llm?: LlmClient;
  private runProvider?: RunProviderFn;

  constructor(opts: EngineOptions = {}) {
    this.dataDir = opts.dataDir ?? config().dataDir;
    this.registry = new SpaceRegistry(this.dataDir);
    this.agents = new AgentStore(this.dataDir);
    this.tasks = new TaskStore(this.dataDir);
    this.serializer = opts.serializer ?? new Serializer();
    this.llm = opts.llm;
    this.runProvider = opts.runProvider;
  }

  /** Ensure a space exists (used by connectors when a group is joined). */
  ensureSpace(space: SpaceId, opts: { chatId?: string } = {}): void {
    this.registry.ensure(space, opts);
  }

  /** The Agent assigned to a space, if any (management backend). */
  agentForSpace(space: SpaceId): Agent | undefined {
    const meta = this.registry.get(space);
    if (!meta?.agentId) return undefined;
    return this.agents.get(meta.agentId);
  }

  /**
   * Resolve the LLM client for a space. Tests may inject a single client for
   * all spaces; otherwise every space runs through a local CLI — the space's
   * assigned agent's provider/model, or the global default (config()). Throws
   * NoProviderError if the resolved provider isn't a known CLI.
   */
  private clientForSpace(space: SpaceId, timeoutMs?: number): LlmClient {
    if (this.llm) return this.llm;
    const agent = this.agentForSpace(space);
    const cfg = config();
    const provider = agent?.provider || cfg.defaultProvider;
    const model = agent?.model || cfg.defaultModel || undefined;
    if (!isCliProvider(provider)) throw new NoProviderError(space);
    return makeCliClient(provider as ProviderId, model, this.runProvider, timeoutMs);
  }

  async remember(entry: RawEntry): Promise<string> {
    // Capture is a write; serialize per space so it never races distillation.
    return this.serializer.run(entry.space, async () => {
      const store = this.registry.ensure(entry.space, { chatId: entry.chatId });
      const index = store.index();
      if (
        entry.chatId &&
        entry.messageId &&
        index.getMessageRetraction(entry.chatId, entry.messageId)
      ) {
        log.info("ignored redelivery of retracted message", {
          space: entry.space,
          chatId: entry.chatId,
          messageId: entry.messageId,
        });
        return `retracted:${entry.messageId}`;
      }
      const id = index.insertRaw(entry);
      log.debug("remembered raw entry", { space: entry.space, source: entry.source, id });
      return id;
    });
  }

  async retractMessage(space: SpaceId, request: RetractionRequest): Promise<RetractionResult> {
    return this.serializer.run(space, async () => {
      const resultFor = (status: RetractionResult["status"]): RetractionResult => ({
        status,
        affectedPages: [],
        requeuedSources: 0,
      });
      if (!this.registry.has(space)) return resultFor("not_found");
      const index = this.registry.store(space).index();
      const matchingRawRecords = index.findRawsByMessageId(request.messageId, request.chatId);
      if (matchingRawRecords.length === 0) {
        const prior = index.getMessageRetraction(request.chatId, request.messageId);
        if (!prior) return resultFor("not_found");
        return request.requesterIsAdmin || prior.originalAuthor === request.requestedBy
          ? resultFor("already_retracted")
          : resultFor("forbidden");
      }
      if (
        !request.requesterIsAdmin &&
        matchingRawRecords.some(
          (rawRecord) => !rawRecord.author || rawRecord.author !== request.requestedBy,
        )
      ) {
        return resultFor("forbidden");
      }
      const removedSourceIds = new Set(matchingRawRecords.map((rawRecord) => rawRecord.id));

      const store = this.registry.store(space);
      const affectedPages = index
        .allPages()
        .filter((page) => page.sources.some((sourceId) => removedSourceIds.has(sourceId)))
        .map((page) => page.slug)
        .sort();
      const survivingSourceIds = new Set<string>();
      for (const slug of affectedPages) {
        const page = index.getPage(slug);
        for (const sourceId of page?.sources ?? []) {
          if (!removedSourceIds.has(sourceId) && index.getRaw(sourceId)) {
            survivingSourceIds.add(sourceId);
          }
        }
        // Delete first so a crash can only lose derived content; it can never
        // leave content derived from a source that has already been removed.
        store.deletePage(slug);
      }
      index.recordMessageRetraction({
        chatId: request.chatId,
        messageId: request.messageId,
        originalAuthor: matchingRawRecords[0]!.author!,
        retractedBy: request.requestedBy,
      });
      for (const rawRecord of matchingRawRecords) index.deleteRaw(rawRecord.id);
      index.markPending([...survivingSourceIds]);
      if (affectedPages.length > 0) refreshDigest(store);
      log.info("retracted raw message", {
        space,
        messageId: request.messageId,
        rawIds: [...removedSourceIds],
        affectedPages,
        requeuedSources: survivingSourceIds.size,
      });
      return {
        status: "retracted",
        affectedPages,
        requeuedSources: survivingSourceIds.size,
        ...(survivingSourceIds.size > 0
          ? { requeuedSourceIds: [...survivingSourceIds] }
          : {}),
      };
    });
  }

  async runDreamCycle(space: SpaceId, opts: DreamOptions = {}): Promise<DreamReport> {
    return this.serializer.run(space, async () => {
      const store = this.registry.ensure(space);
      const report = await runDreamCycle(store, opts, { client: this.clientForSpace(space) });
      this.registry.setLastDream(space, report.finishedAt);
      return report;
    });
  }

  /**
   * Run a task: hand its research topic to the space's agent CLI, capture the
   * output as raw material (source "task") in that space, and record the
   * outcome. The dream cycle later distills the raw entry into wiki pages.
   * Serialized per space so it never races capture/distillation. NoProviderError
   * propagates when the space has no runnable CLI (caller decides how to surface).
   */
  async runTask(taskId: string, opts: RunTaskOptions = {}): Promise<TaskReport> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    const startedAt = Date.now();
    this.registry.ensure(task.space);
    const agent = this.agentForSpace(task.space);
    try {
      // The LLM call runs OUTSIDE the per-space serializer — research is
      // long-running and must not block captures/distillation. Only the write
      // (remember) is serialized, and it acquires the lock itself.
      const client = this.clientForSpace(task.space, TASK_TIMEOUT_MS);
      const res = await client.complete({
        system: agent?.instruction || undefined,
        prompt: researchPrompt(task.topic),
        model: agent?.model || undefined,
        purpose: "distill",
        space: task.space,
      });
      const text = res.text.trim();
      if (!text) throw new Error("task produced empty output");
      const rawId = await this.remember({
        space: task.space,
        source: "task",
        content: `# 任务研究：${task.name}\n主题：${task.topic}\n\n${text}`,
      });
      // Distill immediately so the research becomes a wiki page now, not at the
      // next nightly cycle. The per-task `distillOnRun` is the default; an
      // explicit opts.distill overrides it. Best-effort: a distillation failure
      // doesn't fail the task (the raw entry is safely captured for later).
      let pagesWritten: number | undefined;
      const distill = opts.distill ?? task.distillOnRun;
      if (distill) {
        try {
          const report = await this.runDreamCycle(task.space);
          pagesWritten = report.pagesWritten;
        } catch (err) {
          log.warn("post-task distillation failed (raw kept for nightly)", { taskId, err: String(err) });
        }
      }
      const summary = text.slice(0, 200);
      this.tasks.setLastRun(taskId, { at: Date.now(), status: "ok", summary });
      log.info("task run ok", { taskId, space: task.space, rawId, pagesWritten });
      return { taskId, space: task.space, ok: true, summary, rawId, pagesWritten, startedAt, finishedAt: Date.now() };
    } catch (err) {
      const error = String(err);
      this.tasks.setLastRun(taskId, { at: Date.now(), status: "error", error });
      log.error("task run failed", { taskId, space: task.space, err: error });
      return { taskId, space: task.space, ok: false, error, startedAt, finishedAt: Date.now() };
    }
  }

  async ask(spaces: SpaceId[], question: string, opts: AskOptions = {}): Promise<AskResult> {
    // Reads do not go through the serializer. The client is chosen from the
    // primary (write) space — the space the message belongs to.
    const stores = spaces.filter((s) => this.registry.has(s)).map((s) => this.registry.store(s));
    const primary = spaces[0] ?? stores[0]?.space;
    const client = primary ? this.clientForSpace(primary) : this.clientForSpace(spaces[0]!);
    return askImpl(stores, question, opts, { client });
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

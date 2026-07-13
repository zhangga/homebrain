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
import {
  isCliProvider,
  runProvider as runLocalProvider,
  type ProviderId,
} from "@homebrain/llm";
import type { Knowledge } from "./knowledge.ts";
import {
  SPACE_ARCHIVE_FORMAT,
  SPACE_ARCHIVE_VERSION,
  parseSpaceArchive,
  type SpaceArchive,
  type SpaceDeleteResult,
  type RawRetentionReport,
} from "./governance.ts";
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

interface ProviderRunHealth {
  provider: ProviderId;
  running: number;
  lastStatus?: "ok" | "error";
  lastStartedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}

interface DreamCycleHealth {
  space: SpaceId;
  running: boolean;
  lastStatus?: "ok" | "error";
  lastStartedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
  lastExamined?: number;
  lastPagesWritten?: number;
}

export class KnowledgeEngine implements Knowledge {
  readonly registry: SpaceRegistry;
  readonly agents: AgentStore;
  readonly tasks: TaskStore;
  readonly serializer: Serializer;
  private dataDir: string;
  private llm?: LlmClient;
  private runProvider: RunProviderFn;
  private providerRuns = new Map<ProviderId, ProviderRunHealth>();
  private dreamCycles = new Map<SpaceId, DreamCycleHealth>();
  private runningTaskCounts = new Map<string, number>();

  constructor(opts: EngineOptions = {}) {
    this.dataDir = opts.dataDir ?? config().dataDir;
    this.registry = new SpaceRegistry(this.dataDir);
    this.agents = new AgentStore(this.dataDir);
    this.tasks = new TaskStore(this.dataDir);
    this.serializer = opts.serializer ?? new Serializer();
    this.llm = opts.llm;
    const providerRunner = opts.runProvider ?? runLocalProvider;
    this.runProvider = async (provider, input, timeoutMs) => {
      const run = this.providerRuns.get(provider) ?? { provider, running: 0 };
      run.running += 1;
      run.lastStartedAt = Date.now();
      this.providerRuns.set(provider, run);
      try {
        const output = await providerRunner(provider, input, timeoutMs);
        run.lastSuccessAt = Date.now();
        run.lastStatus = "ok";
        run.lastError = undefined;
        return output;
      } catch (err) {
        run.lastFailureAt = Date.now();
        run.lastStatus = "error";
        run.lastError = String(err);
        throw err;
      } finally {
        run.running -= 1;
      }
    };
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
        requeuedSourceIds: [],
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
        requeuedSourceIds: [...survivingSourceIds],
      };
    });
  }

  async runDreamCycle(space: SpaceId, opts: DreamOptions = {}): Promise<DreamReport> {
    return this.serializer.run(space, async () => {
      const health = this.dreamCycles.get(space) ?? { space, running: false };
      health.running = true;
      health.lastStartedAt = Date.now();
      this.dreamCycles.set(space, health);
      try {
        const store = this.registry.ensure(space);
        const report = await runDreamCycle(store, opts, { client: this.clientForSpace(space) });
        this.registry.setLastDream(space, report.finishedAt);
        health.lastExamined = report.examined;
        health.lastPagesWritten = report.pagesWritten;
        if (report.errors.length === 0) {
          health.lastSuccessAt = report.finishedAt;
          health.lastStatus = "ok";
          health.lastError = undefined;
        } else {
          health.lastFailureAt = report.finishedAt;
          health.lastStatus = "error";
          health.lastError = report.errors.join("; ").slice(0, 500);
        }
        return report;
      } catch (err) {
        health.lastFailureAt = Date.now();
        health.lastStatus = "error";
        health.lastError = String(err).slice(0, 500);
        throw err;
      } finally {
        health.running = false;
      }
    });
  }

  async exportSpace(space: SpaceId): Promise<SpaceArchive> {
    if (!this.registry.has(space)) throw new Error(`unknown space: ${space}`);
    return this.serializer.run(space, async () => {
      const meta = this.registry.get(space);
      if (!meta) throw new Error(`unknown space: ${space}`);
      const store = this.registry.store(space);
      const index = store.index();
      const agent = meta.agentId ? this.agents.get(meta.agentId) : undefined;
      return {
        format: SPACE_ARCHIVE_FORMAT,
        version: SPACE_ARCHIVE_VERSION,
        exportedAt: Date.now(),
        space: { ...meta },
        agent: agent ? { ...agent, skills: [...agent.skills] } : undefined,
        purpose: store.purpose(),
        schema: store.schema(),
        pages: store.listPagesFromDisk(),
        raw: index.listRaw({}),
        retractions: index.listMessageRetractions(),
        tasks: this.tasks.list().filter((task) => task.space === space),
      };
    });
  }

  async restoreSpace(input: unknown): Promise<SpaceId> {
    const archive = parseSpaceArchive(input);
    const space = archive.space.id;
    if (this.registry.has(space)) throw new Error(`space already exists: ${space}`);
    const initialStorageConflict = this.registry.storageConflict(space);
    if (initialStorageConflict) {
      throw new Error(`storage path conflicts with ${initialStorageConflict}: ${space}`);
    }
    await this.serializer.run(space, async () => {
      if (this.registry.has(space)) throw new Error(`space already exists: ${space}`);
      const storageConflict = this.registry.storageConflict(space);
      if (storageConflict) {
        throw new Error(`storage path conflicts with ${storageConflict}: ${space}`);
      }
      const taskConflict = archive.tasks.find((task) => this.tasks.has(task.id));
      if (taskConflict) throw new Error(`task id already exists: ${taskConflict.id}`);
      const existingAgent = archive.agent ? this.agents.get(archive.agent.id) : undefined;
      if (existingAgent && JSON.stringify(existingAgent) !== JSON.stringify(archive.agent)) {
        throw new Error(`agent id already exists with different data: ${archive.agent!.id}`);
      }
      const taskIdsBefore = new Set(this.tasks.list().map((task) => task.id));
      const agentWasPresent = Boolean(existingAgent);
      try {
        if (archive.agent) this.agents.restore(archive.agent);
        const store = this.registry.ensure(space, { chatId: archive.space.chatId });
        store.setPurpose(archive.purpose);
        store.setSchema(archive.schema);
        const index = store.index();
        for (const raw of archive.raw) index.restoreRaw(raw);
        for (const record of archive.retractions) index.restoreMessageRetraction(record);
        for (const page of archive.pages) store.writePage(page);
        this.tasks.restore(archive.tasks);
        this.registry.restoreMeta({
          ...archive.space,
          agentId: archive.space.agentId,
        });
      } catch (err) {
        for (const task of this.tasks.list()) {
          if (task.space === space && !taskIdsBefore.has(task.id)) this.tasks.remove(task.id);
        }
        if (this.registry.has(space)) this.registry.remove(space);
        if (
          archive.agent
          && !agentWasPresent
          && !this.registry.list().some((meta) => meta.agentId === archive.agent!.id)
        ) {
          this.agents.remove(archive.agent.id);
        }
        throw err;
      }
    });
    return space;
  }

  async deleteSpace(space: SpaceId): Promise<SpaceDeleteResult> {
    const empty = (): SpaceDeleteResult => ({
      status: "not_found",
      space,
      pagesDeleted: 0,
      rawDeleted: 0,
      tasksDeleted: 0,
    });
    if (!this.registry.has(space)) return empty();
    return this.serializer.run(space, async () => {
      if (!this.registry.has(space)) return empty();
      const tasks = this.tasks.list().filter((task) => task.space === space);
      if (tasks.some((task) => (this.runningTaskCounts.get(task.id) ?? 0) > 0)) {
        throw new Error(`space has running tasks: ${space}`);
      }
      if (this.dreamCycles.get(space)?.running) {
        throw new Error(`space has a running dream cycle: ${space}`);
      }
      const index = this.registry.store(space).index();
      const pagesDeleted = index.countPages();
      const rawDeleted = index.countRaw();
      let tasksDeleted = 0;
      try {
        tasksDeleted = this.tasks.removeBySpace(space);
        this.registry.remove(space);
      } catch (err) {
        const missingTasks = tasks.filter((task) => !this.tasks.has(task.id));
        if (missingTasks.length > 0) this.tasks.restore(missingTasks);
        throw err;
      }
      this.dreamCycles.delete(space);
      return { status: "deleted", space, pagesDeleted, rawDeleted, tasksDeleted };
    });
  }

  async pruneRawMessages(retentionDays: number, now = Date.now()): Promise<RawRetentionReport> {
    const days = Math.max(0, Math.trunc(retentionDays));
    const cutoff = days > 0 ? now - days * 86_400_000 : now;
    const report: RawRetentionReport = {
      retentionDays: days,
      cutoff,
      deleted: 0,
      bySpace: {},
    };
    if (days === 0) return report;
    for (const meta of this.registry.list()) {
      const deleted = await this.serializer.run(meta.id, async () => {
        if (!this.registry.has(meta.id)) return 0;
        return this.registry.store(meta.id).index().deleteExpiredRawMessages(cutoff);
      });
      if (deleted === 0) continue;
      report.bySpace[meta.id] = deleted;
      report.deleted += deleted;
    }
    return report;
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
    this.runningTaskCounts.set(taskId, (this.runningTaskCounts.get(taskId) ?? 0) + 1);
    try {
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
    } finally {
      const remaining = (this.runningTaskCounts.get(taskId) ?? 1) - 1;
      if (remaining > 0) this.runningTaskCounts.set(taskId, remaining);
      else this.runningTaskCounts.delete(taskId);
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
    let ok = true;
    const spaceDetails = spaces.map((space) => {
      try {
        const index = this.registry.store(space.id).index();
        return {
          id: space.id,
          ok: true,
          pages: index.countPages(),
          pendingRaw: index.countRaw(true),
          lastDreamAt: space.lastDreamAt,
        };
      } catch (err) {
        ok = false;
        return { id: space.id, ok: false, error: String(err), lastDreamAt: space.lastDreamAt };
      }
    });
    return {
      ok,
      spaces: spaces.length,
      details: {
        mode: "cli-only",
        providerRuns: [...this.providerRuns.values()]
          .map((run) => ({ ...run }))
          .sort((a, b) => a.provider.localeCompare(b.provider)),
        dreamCycles: [...this.dreamCycles.values()]
          .map((cycle) => ({ ...cycle }))
          .sort((a, b) => a.space.localeCompare(b.space)),
        tasks: this.tasks.list().map((task) => ({
          id: task.id,
          name: task.name,
          space: task.space,
          enabled: task.enabled,
          running: (this.runningTaskCounts.get(task.id) ?? 0) > 0,
          lastRunAt: task.lastRunAt,
          lastStatus: task.lastStatus,
          lastError: task.lastError,
        })),
        spaces: spaceDetails,
      },
    };
  }

  close(): void {
    this.registry.closeAll();
  }
}

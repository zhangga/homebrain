/** Durable guided-reading sources, plans, and lesson progress. */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { isSpaceId, type SpaceId } from "@homeagent/shared";

export type LearningPlanStatus = "active" | "paused" | "completed";
export type LearningSessionStatus = "prepared" | "awaiting_reply" | "completed" | "skipped";

export interface LearningSource {
  id: string;
  title: string;
  content: string;
  rawIds: string[];
  messageId: string;
  createdAt: number;
}

export interface LearningPlan {
  id: string;
  name: string;
  space: SpaceId;
  creatorId: string;
  chatId: string;
  sourceId: string;
  sourceLength: number;
  hour: number;
  dailyCharacters: number;
  cursor: number;
  status: LearningPlanStatus;
  currentSessionId?: string;
  lastDeliveredAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface LearningPlanInput {
  name: string;
  space: SpaceId;
  creatorId: string;
  chatId: string;
  sourceTitle: string;
  sourceContent: string;
  sourceRawIds: string[];
  sourceMessageId: string;
  hour?: number;
  dailyCharacters?: number;
}

export interface LearningSession {
  id: string;
  planId: string;
  sequence: number;
  startOffset: number;
  endOffset: number;
  sectionTitle: string;
  excerpt: string;
  guide: string;
  status: LearningSessionStatus;
  learnerReply?: string;
  feedback?: string;
  preparedAt: number;
  deliveredAt?: number;
  completedAt?: number;
}

export interface PrepareLearningSessionInput {
  startOffset: number;
  endOffset: number;
  sectionTitle: string;
  excerpt: string;
  guide: string;
  preparedAt: number;
}

export interface LearningArchive {
  plans: LearningPlan[];
  sources: LearningSource[];
  sessions: LearningSession[];
}

interface LearningFile {
  plans: Record<string, LearningPlan>;
  sources: Record<string, LearningSource>;
  sessions: Record<string, LearningSession>;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeHour(value: number | undefined): number {
  if (!finite(value)) return 8;
  return Math.max(0, Math.min(23, Math.trunc(value)));
}

function normalizeDailyCharacters(value: number | undefined): number {
  if (!finite(value)) return 3000;
  return Math.max(500, Math.min(8000, Math.trunc(value)));
}

function validSource(value: unknown): value is LearningSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Partial<LearningSource>;
  return typeof source.id === "string" && source.id.length > 0
    && typeof source.title === "string" && source.title.length > 0
    && typeof source.content === "string" && source.content.length > 0
    && Array.isArray(source.rawIds) && source.rawIds.every((id) => typeof id === "string")
    && typeof source.messageId === "string" && source.messageId.length > 0
    && finite(source.createdAt);
}

function validPlan(value: unknown): value is LearningPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<LearningPlan>;
  return typeof plan.id === "string" && plan.id.length > 0
    && typeof plan.name === "string" && plan.name.length > 0
    && typeof plan.space === "string" && isSpaceId(plan.space)
    && typeof plan.creatorId === "string" && plan.creatorId.length > 0
    && typeof plan.chatId === "string" && plan.chatId.length > 0
    && typeof plan.sourceId === "string" && plan.sourceId.length > 0
    && finite(plan.sourceLength) && plan.sourceLength > 0
    && finite(plan.hour) && plan.hour >= 0 && plan.hour <= 23
    && finite(plan.dailyCharacters) && plan.dailyCharacters >= 500 && plan.dailyCharacters <= 8000
    && finite(plan.cursor) && plan.cursor >= 0 && plan.cursor <= plan.sourceLength
    && ["active", "paused", "completed"].includes(plan.status ?? "")
    && (plan.currentSessionId === undefined || typeof plan.currentSessionId === "string")
    && (plan.lastDeliveredAt === undefined || finite(plan.lastDeliveredAt))
    && finite(plan.createdAt)
    && finite(plan.updatedAt);
}

function validSession(value: unknown): value is LearningSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Partial<LearningSession>;
  return typeof session.id === "string" && session.id.length > 0
    && typeof session.planId === "string" && session.planId.length > 0
    && finite(session.sequence) && session.sequence >= 1
    && finite(session.startOffset) && session.startOffset >= 0
    && finite(session.endOffset) && session.endOffset > session.startOffset
    && typeof session.sectionTitle === "string" && session.sectionTitle.length > 0
    && typeof session.excerpt === "string" && session.excerpt.length > 0
    && typeof session.guide === "string" && session.guide.length > 0
    && ["prepared", "awaiting_reply", "completed", "skipped"].includes(session.status ?? "")
    && (session.learnerReply === undefined || typeof session.learnerReply === "string")
    && (session.feedback === undefined || typeof session.feedback === "string")
    && finite(session.preparedAt)
    && (session.deliveredAt === undefined || finite(session.deliveredAt))
    && (session.completedAt === undefined || finite(session.completedAt));
}

export class LearningPlanStore {
  private readonly configPath: string;
  private plans = new Map<string, LearningPlan>();
  private sources = new Map<string, LearningSource>();
  private sessions = new Map<string, LearningSession>();

  constructor(dataDir: string) {
    this.configPath = join(dataDir, "config", "learning.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.configPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<LearningFile>;
      for (const [id, source] of Object.entries(parsed.sources ?? {})) {
        if (validSource(source) && source.id === id) this.sources.set(id, { ...source, rawIds: [...source.rawIds] });
      }
      for (const [id, session] of Object.entries(parsed.sessions ?? {})) {
        if (validSession(session) && session.id === id) this.sessions.set(id, { ...session });
      }
      for (const [id, plan] of Object.entries(parsed.plans ?? {})) {
        if (
          validPlan(plan) && plan.id === id && this.sources.has(plan.sourceId)
          && (!plan.currentSessionId || this.sessions.has(plan.currentSessionId))
        ) {
          this.plans.set(id, { ...plan });
        }
      }
      for (const [id, session] of this.sessions) {
        if (!this.plans.has(session.planId)) this.sessions.delete(id);
      }
    } catch {
      // Optional learning state must not prevent HomeAgent from starting.
    }
  }

  private persist(
    plans = this.plans,
    sources = this.sources,
    sessions = this.sessions,
  ): void {
    const configDir = dirname(this.configPath);
    mkdirSync(configDir, { recursive: true });
    const temporaryPath = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    const file: LearningFile = {
      plans: Object.fromEntries(plans),
      sources: Object.fromEntries(sources),
      sessions: Object.fromEntries(sessions),
    };
    try {
      writeFileSync(temporaryPath, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
      const fileDescriptor = openSync(temporaryPath, "r");
      try {
        fsyncSync(fileDescriptor);
      } finally {
        closeSync(fileDescriptor);
      }
      renameSync(temporaryPath, this.configPath);
      const directoryDescriptor = openSync(configDir, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // A successful rename consumes the temporary path.
      }
      throw error;
    }
  }

  list(): LearningPlan[] {
    return [...this.plans.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  listBySpace(space: SpaceId): LearningPlan[] {
    return this.list().filter((plan) => plan.space === space);
  }

  get(id: string): LearningPlan | undefined {
    return this.plans.get(id);
  }

  has(id: string): boolean {
    return this.plans.has(id);
  }

  source(planId: string): LearningSource | undefined {
    const plan = this.plans.get(planId);
    return plan ? this.sources.get(plan.sourceId) : undefined;
  }

  sessionsForPlan(planId: string): LearningSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.planId === planId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  currentSession(planId: string): LearningSession | undefined {
    const sessionId = this.plans.get(planId)?.currentSessionId;
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  create(input: LearningPlanInput, now = Date.now()): LearningPlan {
    const name = input.name.trim();
    const creatorId = input.creatorId.trim();
    const chatId = input.chatId.trim();
    const sourceTitle = input.sourceTitle.trim();
    const sourceContent = input.sourceContent.trim();
    const sourceMessageId = input.sourceMessageId.trim();
    const rawIds = [...new Set(input.sourceRawIds.map((id) => id.trim()).filter(Boolean))];
    if (
      !name || !isSpaceId(input.space) || !creatorId || !chatId || !sourceTitle
      || !sourceContent || !sourceMessageId || rawIds.length === 0
    ) {
      throw new Error("invalid learning plan input");
    }

    const source: LearningSource = {
      id: `learn_source_${randomUUID()}`,
      title: sourceTitle,
      content: sourceContent,
      rawIds,
      messageId: sourceMessageId,
      createdAt: now,
    };
    const plan: LearningPlan = {
      id: `learn_${randomUUID()}`,
      name,
      space: input.space,
      creatorId,
      chatId,
      sourceId: source.id,
      sourceLength: sourceContent.length,
      hour: normalizeHour(input.hour),
      dailyCharacters: normalizeDailyCharacters(input.dailyCharacters),
      cursor: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    const candidatePlans = new Map(this.plans);
    const candidateSources = new Map(this.sources);
    candidateSources.set(source.id, source);
    candidatePlans.set(plan.id, plan);
    this.persist(candidatePlans, candidateSources);
    this.sources = candidateSources;
    this.plans = candidatePlans;
    return plan;
  }

  prepareSession(
    planId: string,
    input: PrepareLearningSessionInput,
  ): LearningSession | undefined {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== "active") return undefined;
    const current = this.currentSession(planId);
    if (current && ["prepared", "awaiting_reply"].includes(current.status)) return current;
    const sectionTitle = input.sectionTitle.trim();
    const excerpt = input.excerpt.trim();
    const guide = input.guide.trim();
    if (
      !sectionTitle || !excerpt || !guide || !finite(input.preparedAt)
      || !finite(input.startOffset) || !finite(input.endOffset)
      || input.startOffset < plan.cursor || input.endOffset <= input.startOffset
      || input.endOffset > plan.sourceLength
    ) return undefined;

    const session: LearningSession = {
      id: `learn_session_${randomUUID()}`,
      planId,
      sequence: this.sessionsForPlan(planId).length + 1,
      startOffset: input.startOffset,
      endOffset: input.endOffset,
      sectionTitle,
      excerpt,
      guide,
      status: "prepared",
      preparedAt: input.preparedAt,
    };
    const candidatePlans = new Map(
      [...this.plans].map(([id, value]) => [id, { ...value }]),
    );
    const candidateSessions = new Map(
      [...this.sessions].map(([id, value]) => [id, { ...value }]),
    );
    const updatedPlan = candidatePlans.get(planId)!;
    updatedPlan.currentSessionId = session.id;
    updatedPlan.updatedAt = input.preparedAt;
    candidateSessions.set(session.id, session);
    this.persist(candidatePlans, this.sources, candidateSessions);
    this.plans = candidatePlans;
    this.sessions = candidateSessions;
    return session;
  }

  markDelivered(sessionId: string, deliveredAt = Date.now()): LearningSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "prepared" || !finite(deliveredAt)) return undefined;
    const candidatePlans = new Map(
      [...this.plans].map(([id, value]) => [id, { ...value }]),
    );
    const candidateSessions = new Map(
      [...this.sessions].map(([id, value]) => [id, { ...value }]),
    );
    const updatedSession = candidateSessions.get(sessionId)!;
    updatedSession.status = "awaiting_reply";
    updatedSession.deliveredAt = deliveredAt;
    const updatedPlan = candidatePlans.get(updatedSession.planId)!;
    updatedPlan.lastDeliveredAt = deliveredAt;
    updatedPlan.updatedAt = deliveredAt;
    this.persist(candidatePlans, this.sources, candidateSessions);
    this.plans = candidatePlans;
    this.sessions = candidateSessions;
    return updatedSession;
  }

  completeSession(
    sessionId: string,
    input: { learnerReply: string; feedback: string; completedAt: number },
  ): LearningSession | undefined {
    const session = this.sessions.get(sessionId);
    const learnerReply = input.learnerReply.trim();
    const feedback = input.feedback.trim();
    if (
      !session || session.status !== "awaiting_reply" || !learnerReply || !feedback
      || !finite(input.completedAt)
    ) return undefined;

    const candidatePlans = new Map(
      [...this.plans].map(([id, value]) => [id, { ...value }]),
    );
    const candidateSessions = new Map(
      [...this.sessions].map(([id, value]) => [id, { ...value }]),
    );
    const updatedSession = candidateSessions.get(sessionId)!;
    updatedSession.status = "completed";
    updatedSession.learnerReply = learnerReply;
    updatedSession.feedback = feedback;
    updatedSession.completedAt = input.completedAt;
    const updatedPlan = candidatePlans.get(updatedSession.planId)!;
    updatedPlan.cursor = updatedSession.endOffset;
    updatedPlan.currentSessionId = undefined;
    updatedPlan.status = updatedPlan.cursor >= updatedPlan.sourceLength ? "completed" : "active";
    updatedPlan.updatedAt = input.completedAt;
    this.persist(candidatePlans, this.sources, candidateSessions);
    this.plans = candidatePlans;
    this.sessions = candidateSessions;
    return updatedSession;
  }

  update(
    id: string,
    actorId: string | undefined,
    patch: { hour?: number; dailyCharacters?: number },
    at = Date.now(),
  ): LearningPlan | undefined {
    const plan = this.plans.get(id);
    if (!plan || (actorId !== undefined && plan.creatorId !== actorId)) return undefined;
    const candidatePlans = new Map(
      [...this.plans].map(([planId, value]) => [planId, { ...value }]),
    );
    const updated = candidatePlans.get(id)!;
    if (patch.hour !== undefined) updated.hour = normalizeHour(patch.hour);
    if (patch.dailyCharacters !== undefined) {
      updated.dailyCharacters = normalizeDailyCharacters(patch.dailyCharacters);
    }
    updated.updatedAt = at;
    this.persist(candidatePlans, this.sources, this.sessions);
    this.plans = candidatePlans;
    return updated;
  }

  pause(id: string, actorId?: string, at = Date.now()): LearningPlan | undefined {
    const plan = this.plans.get(id);
    if (
      !plan || plan.status !== "active"
      || (actorId !== undefined && plan.creatorId !== actorId)
    ) return undefined;
    const candidatePlans = new Map(
      [...this.plans].map(([planId, value]) => [planId, { ...value }]),
    );
    const updated = candidatePlans.get(id)!;
    updated.status = "paused";
    updated.updatedAt = at;
    this.persist(candidatePlans, this.sources, this.sessions);
    this.plans = candidatePlans;
    return updated;
  }

  resume(id: string, actorId?: string, at = Date.now()): LearningPlan | undefined {
    const plan = this.plans.get(id);
    if (
      !plan || plan.status !== "paused"
      || (actorId !== undefined && plan.creatorId !== actorId)
    ) return undefined;
    const candidatePlans = new Map(
      [...this.plans].map(([planId, value]) => [planId, { ...value }]),
    );
    const updated = candidatePlans.get(id)!;
    updated.status = "active";
    updated.updatedAt = at;
    this.persist(candidatePlans, this.sources, this.sessions);
    this.plans = candidatePlans;
    return updated;
  }

  skipCurrent(
    planId: string,
    actorId: string,
    completedAt = Date.now(),
  ): LearningSession | undefined {
    const plan = this.plans.get(planId);
    const session = this.currentSession(planId);
    if (
      !plan || plan.creatorId !== actorId || !session
      || session.status !== "awaiting_reply" || !finite(completedAt)
    ) return undefined;

    const candidatePlans = new Map(
      [...this.plans].map(([id, value]) => [id, { ...value }]),
    );
    const candidateSessions = new Map(
      [...this.sessions].map(([id, value]) => [id, { ...value }]),
    );
    const updatedSession = candidateSessions.get(session.id)!;
    updatedSession.status = "skipped";
    updatedSession.completedAt = completedAt;
    const updatedPlan = candidatePlans.get(planId)!;
    updatedPlan.cursor = updatedSession.endOffset;
    updatedPlan.currentSessionId = undefined;
    updatedPlan.status = updatedPlan.cursor >= updatedPlan.sourceLength ? "completed" : "active";
    updatedPlan.updatedAt = completedAt;
    this.persist(candidatePlans, this.sources, candidateSessions);
    this.plans = candidatePlans;
    this.sessions = candidateSessions;
    return updatedSession;
  }

  remove(id: string, actorId?: string): boolean {
    const plan = this.plans.get(id);
    if (!plan || (actorId !== undefined && plan.creatorId !== actorId)) return false;
    return this.removePlanIds(new Set([id])) === 1;
  }

  removeBySpace(space: SpaceId): number {
    const ids = new Set(
      this.listBySpace(space).map((plan) => plan.id),
    );
    return this.removePlanIds(ids);
  }

  removeByRawIds(rawIds: Set<string>): number {
    if (rawIds.size === 0) return 0;
    const ids = new Set(
      this.list()
        .filter((plan) => this.source(plan.id)?.rawIds.some((id) => rawIds.has(id)))
        .map((plan) => plan.id),
    );
    return this.removePlanIds(ids);
  }

  private removePlanIds(ids: Set<string>): number {
    if (ids.size === 0) return 0;
    const candidatePlans = new Map(this.plans);
    const candidateSources = new Map(this.sources);
    const candidateSessions = new Map(this.sessions);
    for (const id of ids) {
      const plan = candidatePlans.get(id);
      if (!plan) continue;
      candidatePlans.delete(id);
      candidateSources.delete(plan.sourceId);
      for (const [sessionId, session] of candidateSessions) {
        if (session.planId === id) candidateSessions.delete(sessionId);
      }
    }
    this.persist(candidatePlans, candidateSources, candidateSessions);
    this.plans = candidatePlans;
    this.sources = candidateSources;
    this.sessions = candidateSessions;
    return ids.size;
  }

  exportBySpace(space: SpaceId): LearningArchive {
    const plans = this.listBySpace(space).map((plan) => ({ ...plan }));
    const planIds = new Set(plans.map((plan) => plan.id));
    const sourceIds = new Set(plans.map((plan) => plan.sourceId));
    return {
      plans,
      sources: [...this.sources.values()]
        .filter((source) => sourceIds.has(source.id))
        .map((source) => ({ ...source, rawIds: [...source.rawIds] })),
      sessions: [...this.sessions.values()]
        .filter((session) => planIds.has(session.planId))
        .sort((a, b) => a.sequence - b.sequence)
        .map((session) => ({ ...session })),
    };
  }

  restore(archive: LearningArchive): LearningPlan[] {
    const incomingPlanIds = new Set<string>();
    const incomingSourceIds = new Set<string>();
    const incomingSessionIds = new Set<string>();
    for (const source of archive.sources) {
      if (!validSource(source) || incomingSourceIds.has(source.id) || this.sources.has(source.id)) {
        throw new Error(`invalid or duplicate learning source: ${source.id}`);
      }
      incomingSourceIds.add(source.id);
    }
    for (const session of archive.sessions) {
      if (!validSession(session) || incomingSessionIds.has(session.id) || this.sessions.has(session.id)) {
        throw new Error(`invalid or duplicate learning session: ${session.id}`);
      }
      incomingSessionIds.add(session.id);
    }
    for (const plan of archive.plans) {
      if (
        !validPlan(plan) || incomingPlanIds.has(plan.id) || this.plans.has(plan.id)
        || !incomingSourceIds.has(plan.sourceId)
        || (plan.currentSessionId !== undefined && !incomingSessionIds.has(plan.currentSessionId))
      ) throw new Error(`invalid or duplicate learning plan: ${plan.id}`);
      incomingPlanIds.add(plan.id);
    }
    if (archive.sessions.some((session) => !incomingPlanIds.has(session.planId))) {
      throw new Error("learning session references an unknown plan");
    }
    if (archive.plans.length === 0) return [];

    const candidatePlans = new Map(this.plans);
    const candidateSources = new Map(this.sources);
    const candidateSessions = new Map(this.sessions);
    for (const source of archive.sources) {
      candidateSources.set(source.id, { ...source, rawIds: [...source.rawIds] });
    }
    for (const session of archive.sessions) {
      candidateSessions.set(session.id, { ...session });
    }
    const restored = archive.plans.map((plan) => {
      const copy = { ...plan };
      candidatePlans.set(copy.id, copy);
      return copy;
    });
    this.persist(candidatePlans, candidateSources, candidateSessions);
    this.plans = candidatePlans;
    this.sources = candidateSources;
    this.sessions = candidateSessions;
    return restored;
  }
}

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
export type LearningPlanMode = "reading" | "topic";
export type LearningRouteStepStatus = "pending" | "active" | "completed" | "skipped";
export type LearningMastery = "review" | "ready";
export const MAX_LEARNING_SOURCE_CHARACTERS = 2_000_000;

export interface LearningMaterial {
  title: string;
  rawIds: string[];
  messageId: string;
  startOffset: number;
  endOffset: number;
  createdAt: number;
}

export interface LearningSource {
  id: string;
  title: string;
  content: string;
  rawIds: string[];
  messageId: string;
  materials: LearningMaterial[];
  createdAt: number;
}

export interface LearningRouteStep {
  id: string;
  title: string;
  objective: string;
  status: LearningRouteStepStatus;
  attempts: number;
}

export interface LearningPlan {
  id: string;
  name: string;
  space: SpaceId;
  creatorId: string;
  chatId: string;
  mode: LearningPlanMode;
  topic?: string;
  route: LearningRouteStep[];
  routeIndex: number;
  adaptiveFocus?: string;
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

export interface TopicLearningPlanInput {
  name: string;
  topic: string;
  space: SpaceId;
  creatorId: string;
  chatId: string;
  route: { title: string; objective: string }[];
  hour?: number;
}

export interface AddLearningMaterialInput {
  title: string;
  content: string;
  rawIds: string[];
  messageId: string;
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
  routeStepId?: string;
  mastery?: LearningMastery;
  nextFocus?: string;
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
  routeStepId?: string;
  preparedAt: number;
}

export interface LearningArchive {
  plans: LearningPlan[];
  sources: LearningSource[];
  sessions: LearningSession[];
}

export function learningProgress(plan: LearningPlan): number {
  if (plan.mode === "topic") {
    if (plan.route.length === 0) return 0;
    return Math.min(100, Math.floor((plan.routeIndex / plan.route.length) * 100));
  }
  return Math.min(100, Math.floor((plan.cursor / plan.sourceLength) * 100));
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

function validMaterial(value: unknown, sourceLength: number): value is LearningMaterial {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const material = value as Partial<LearningMaterial>;
  return typeof material.title === "string" && material.title.length > 0
    && Array.isArray(material.rawIds) && material.rawIds.length > 0
    && material.rawIds.every((id) => typeof id === "string" && id.length > 0)
    && typeof material.messageId === "string" && material.messageId.length > 0
    && finite(material.startOffset) && Number.isInteger(material.startOffset)
    && finite(material.endOffset) && Number.isInteger(material.endOffset)
    && material.startOffset >= 0 && material.endOffset > material.startOffset
    && material.endOffset <= sourceLength
    && finite(material.createdAt);
}

function normalizeSource(value: unknown): LearningSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Partial<LearningSource>;
  if (
    typeof source.id !== "string" || source.id.length === 0
    || typeof source.title !== "string" || source.title.length === 0
    || typeof source.content !== "string" || source.content.length === 0
    || source.content.length > MAX_LEARNING_SOURCE_CHARACTERS
    || !Array.isArray(source.rawIds) || !source.rawIds.every((id) => typeof id === "string")
    || typeof source.messageId !== "string" || source.messageId.length === 0
    || !finite(source.createdAt)
  ) return undefined;
  const materials = source.materials === undefined
    ? source.rawIds.length > 0
      ? [{
          title: source.title,
          rawIds: [...source.rawIds],
          messageId: source.messageId,
          startOffset: 0,
          endOffset: source.content.length,
          createdAt: source.createdAt,
        }]
      : []
    : source.materials;
  if (
    !Array.isArray(materials)
    || !materials.every((material) => validMaterial(material, source.content!.length))
  ) return undefined;
  return {
    id: source.id,
    title: source.title,
    content: source.content,
    rawIds: [...source.rawIds],
    messageId: source.messageId,
    materials: materials.map((material) => ({ ...material, rawIds: [...material.rawIds] })),
    createdAt: source.createdAt,
  };
}

function validSource(value: unknown): value is LearningSource {
  return normalizeSource(value) !== undefined;
}

function validRouteStep(value: unknown): value is LearningRouteStep {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const step = value as Partial<LearningRouteStep>;
  return typeof step.id === "string" && step.id.length > 0
    && typeof step.title === "string" && step.title.length > 0
    && typeof step.objective === "string" && step.objective.length > 0
    && ["pending", "active", "completed", "skipped"].includes(step.status ?? "")
    && finite(step.attempts) && Number.isInteger(step.attempts) && step.attempts >= 0;
}

function normalizePlan(value: unknown): LearningPlan | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const original = value as Partial<LearningPlan>;
  const candidate = {
    ...original,
    mode: original.mode ?? "reading",
    route: original.route ?? [],
    routeIndex: original.routeIndex ?? 0,
  } as LearningPlan;
  return validPlan(candidate) ? candidate : undefined;
}

function validRouteState(plan: Partial<LearningPlan>): boolean {
  if (plan.mode === "reading") {
    return plan.route?.length === 0 && plan.routeIndex === 0 && plan.topic === undefined;
  }
  if (plan.mode !== "topic" || !plan.topic?.trim() || !plan.route || plan.route.length === 0) {
    return false;
  }
  if (plan.cursor !== 0 || plan.routeIndex === undefined) return false;
  for (const [index, step] of plan.route.entries()) {
    if (index < plan.routeIndex && !["completed", "skipped"].includes(step.status)) return false;
    if (index === plan.routeIndex && plan.routeIndex < plan.route.length && step.status !== "active") {
      return false;
    }
    if (index > plan.routeIndex && step.status !== "pending") return false;
  }
  return plan.routeIndex === plan.route.length
    ? plan.status === "completed"
    : plan.status !== "completed";
}

function validPlan(value: unknown): value is LearningPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<LearningPlan>;
  return typeof plan.id === "string" && plan.id.length > 0
    && typeof plan.name === "string" && plan.name.length > 0
    && typeof plan.space === "string" && isSpaceId(plan.space)
    && typeof plan.creatorId === "string" && plan.creatorId.length > 0
    && typeof plan.chatId === "string" && plan.chatId.length > 0
    && ["reading", "topic"].includes(plan.mode ?? "")
    && (plan.topic === undefined || typeof plan.topic === "string")
    && Array.isArray(plan.route) && plan.route.every(validRouteStep)
    && finite(plan.routeIndex) && Number.isInteger(plan.routeIndex)
    && plan.routeIndex >= 0 && plan.routeIndex <= plan.route.length
    && (plan.adaptiveFocus === undefined || typeof plan.adaptiveFocus === "string")
    && validRouteState(plan)
    && typeof plan.sourceId === "string" && plan.sourceId.length > 0
    && finite(plan.sourceLength) && Number.isInteger(plan.sourceLength) && plan.sourceLength > 0
    && finite(plan.hour) && Number.isInteger(plan.hour) && plan.hour >= 0 && plan.hour <= 23
    && finite(plan.dailyCharacters) && Number.isInteger(plan.dailyCharacters)
    && plan.dailyCharacters >= 500 && plan.dailyCharacters <= 8000
    && finite(plan.cursor) && Number.isInteger(plan.cursor)
    && plan.cursor >= 0 && plan.cursor <= plan.sourceLength
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
    && finite(session.sequence) && Number.isInteger(session.sequence) && session.sequence >= 1
    && finite(session.startOffset) && Number.isInteger(session.startOffset) && session.startOffset >= 0
    && finite(session.endOffset) && Number.isInteger(session.endOffset)
    && session.endOffset > session.startOffset
    && typeof session.sectionTitle === "string" && session.sectionTitle.length > 0
    && typeof session.excerpt === "string" && session.excerpt.length > 0
    && typeof session.guide === "string" && session.guide.length > 0
    && ["prepared", "awaiting_reply", "completed", "skipped"].includes(session.status ?? "")
    && (session.learnerReply === undefined || typeof session.learnerReply === "string")
    && (session.feedback === undefined || typeof session.feedback === "string")
    && (session.routeStepId === undefined || typeof session.routeStepId === "string")
    && (session.mastery === undefined || ["review", "ready"].includes(session.mastery))
    && (session.nextFocus === undefined || typeof session.nextFocus === "string")
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
        const normalized = normalizeSource(source);
        if (normalized?.id === id) this.sources.set(id, normalized);
      }
      for (const [id, session] of Object.entries(parsed.sessions ?? {})) {
        if (validSession(session) && session.id === id) this.sessions.set(id, { ...session });
      }
      for (const [id, plan] of Object.entries(parsed.plans ?? {})) {
        const normalized = normalizePlan(plan);
        if (
          normalized?.id === id
          && this.sources.get(normalized.sourceId)?.content.length === normalized.sourceLength
          && (!normalized.currentSessionId
            || this.sessions.get(normalized.currentSessionId)?.planId === normalized.id)
        ) {
          this.plans.set(id, normalized);
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
      || !sourceContent || sourceContent.length > MAX_LEARNING_SOURCE_CHARACTERS
      || !sourceMessageId || rawIds.length === 0
    ) {
      throw new Error("invalid learning plan input");
    }

    const source: LearningSource = {
      id: `learn_source_${randomUUID()}`,
      title: sourceTitle,
      content: sourceContent,
      rawIds,
      messageId: sourceMessageId,
      materials: [{
        title: sourceTitle,
        rawIds: [...rawIds],
        messageId: sourceMessageId,
        startOffset: 0,
        endOffset: sourceContent.length,
        createdAt: now,
      }],
      createdAt: now,
    };
    const plan: LearningPlan = {
      id: `learn_${randomUUID()}`,
      name,
      space: input.space,
      creatorId,
      chatId,
      mode: "reading",
      route: [],
      routeIndex: 0,
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

  createTopic(input: TopicLearningPlanInput, now = Date.now()): LearningPlan {
    const name = input.name.trim();
    const topic = input.topic.trim();
    const creatorId = input.creatorId.trim();
    const chatId = input.chatId.trim();
    const routeInput = input.route.map((step) => ({
      title: step.title.trim(),
      objective: step.objective.trim(),
    }));
    if (
      !name || !topic || topic.length > 200 || !isSpaceId(input.space)
      || !creatorId || !chatId || routeInput.length < 2 || routeInput.length > 12
      || routeInput.some((step) => !step.title || !step.objective)
    ) throw new Error("invalid topic learning plan input");

    const route: LearningRouteStep[] = routeInput.map((step, index) => ({
      id: `learn_step_${randomUUID()}`,
      ...step,
      status: index === 0 ? "active" : "pending",
      attempts: 0,
    }));
    const outline = [
      `# 主题学习路线：${topic}`,
      "",
      ...route.flatMap((step, index) => [
        `## ${index + 1}. ${step.title}`,
        step.objective,
        "",
      ]),
      "说明：以上是 Agent 生成的学习路线，不是外部事实来源。",
    ].join("\n").trim();
    const source: LearningSource = {
      id: `learn_source_${randomUUID()}`,
      title: `主题：${topic}`,
      content: outline,
      rawIds: [],
      messageId: `topic:${randomUUID()}`,
      materials: [],
      createdAt: now,
    };
    const plan: LearningPlan = {
      id: `learn_${randomUUID()}`,
      name,
      topic,
      space: input.space,
      creatorId,
      chatId,
      mode: "topic",
      route,
      routeIndex: 0,
      sourceId: source.id,
      sourceLength: source.content.length,
      hour: normalizeHour(input.hour),
      dailyCharacters: 3000,
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

  addMaterial(
    planId: string,
    actorId: string | undefined,
    input: AddLearningMaterialInput,
    now = Date.now(),
  ): LearningPlan | undefined {
    const plan = this.plans.get(planId);
    const source = plan ? this.sources.get(plan.sourceId) : undefined;
    if (!plan || !source || (actorId !== undefined && plan.creatorId !== actorId)) {
      return undefined;
    }
    const title = input.title.trim();
    const content = input.content.trim();
    const messageId = input.messageId.trim();
    const rawIds = [...new Set(input.rawIds.map((id) => id.trim()).filter(Boolean))];
    if (!title || !content || !messageId || rawIds.length === 0) {
      throw new Error("invalid learning material input");
    }
    if (source.materials.some((material) => material.messageId === messageId)) {
      throw new Error("这份学习材料已经添加过了");
    }
    const prefix = `\n\n---\n\n# 来源材料：${title}\n\n`;
    const combined = `${source.content}${prefix}${content}`;
    if (combined.length > MAX_LEARNING_SOURCE_CHARACTERS) {
      throw new Error(`学习材料总长度不能超过 ${MAX_LEARNING_SOURCE_CHARACTERS} 字符`);
    }
    const material: LearningMaterial = {
      title,
      rawIds,
      messageId,
      startOffset: source.content.length + prefix.length,
      endOffset: combined.length,
      createdAt: now,
    };
    const candidatePlans = new Map(
      [...this.plans].map(([id, value]) => [id, { ...value, route: value.route.map((step) => ({ ...step })) }]),
    );
    const candidateSources = new Map(
      [...this.sources].map(([id, value]) => [id, {
        ...value,
        rawIds: [...value.rawIds],
        materials: value.materials.map((item) => ({ ...item, rawIds: [...item.rawIds] })),
      }]),
    );
    const updatedSource = candidateSources.get(source.id)!;
    updatedSource.content = combined;
    updatedSource.rawIds = [...new Set([...updatedSource.rawIds, ...rawIds])];
    updatedSource.materials.push(material);
    const updatedPlan = candidatePlans.get(planId)!;
    updatedPlan.sourceLength = combined.length;
    updatedPlan.updatedAt = now;
    if (updatedPlan.mode === "reading" && updatedPlan.status === "completed") {
      updatedPlan.status = "active";
    }
    this.persist(candidatePlans, candidateSources, this.sessions);
    this.plans = candidatePlans;
    this.sources = candidateSources;
    return updatedPlan;
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
    const routeStepId = input.routeStepId?.trim();
    const activeRouteStep = plan.mode === "topic" ? plan.route[plan.routeIndex] : undefined;
    if (
      !sectionTitle || !excerpt || !guide || !finite(input.preparedAt)
      || !finite(input.startOffset) || !finite(input.endOffset)
      || input.startOffset < plan.cursor || input.endOffset <= input.startOffset
      || input.endOffset > plan.sourceLength
      || (plan.mode === "topic" && (!routeStepId || routeStepId !== activeRouteStep?.id))
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
      routeStepId,
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
    input: {
      learnerReply: string;
      feedback: string;
      mastery?: LearningMastery;
      nextFocus?: string;
      completedAt: number;
    },
  ): LearningSession | undefined {
    const session = this.sessions.get(sessionId);
    const learnerReply = input.learnerReply.trim();
    const feedback = input.feedback.trim();
    const plan = session ? this.plans.get(session.planId) : undefined;
    const nextFocus = input.nextFocus?.trim();
    if (
      !session || !plan || session.status !== "awaiting_reply" || !learnerReply || !feedback
      || !finite(input.completedAt)
      || (plan.mode === "topic" && (
        !["review", "ready"].includes(input.mastery ?? "") || !nextFocus
      ))
    ) return undefined;

    const candidatePlans = new Map(
      [...this.plans].map(([id, value]) => [
        id,
        { ...value, route: value.route.map((step) => ({ ...step })) },
      ]),
    );
    const candidateSessions = new Map(
      [...this.sessions].map(([id, value]) => [id, { ...value }]),
    );
    const updatedSession = candidateSessions.get(sessionId)!;
    updatedSession.status = "completed";
    updatedSession.learnerReply = learnerReply;
    updatedSession.feedback = feedback;
    updatedSession.mastery = input.mastery;
    updatedSession.nextFocus = nextFocus;
    updatedSession.completedAt = input.completedAt;
    const updatedPlan = candidatePlans.get(updatedSession.planId)!;
    advancePlan(updatedPlan, updatedSession, input.completedAt);
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
      [...this.plans].map(([id, value]) => [
        id,
        { ...value, route: value.route.map((step) => ({ ...step })) },
      ]),
    );
    const candidateSessions = new Map(
      [...this.sessions].map(([id, value]) => [id, { ...value }]),
    );
    const updatedSession = candidateSessions.get(session.id)!;
    updatedSession.status = "skipped";
    updatedSession.completedAt = completedAt;
    const updatedPlan = candidatePlans.get(planId)!;
    advancePlan(updatedPlan, updatedSession, completedAt);
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
    const plans = this.listBySpace(space).map((plan) => ({
      ...plan,
      route: plan.route.map((step) => ({ ...step })),
    }));
    const planIds = new Set(plans.map((plan) => plan.id));
    const sourceIds = new Set(plans.map((plan) => plan.sourceId));
    return {
      plans,
      sources: [...this.sources.values()]
        .filter((source) => sourceIds.has(source.id))
        .map((source) => ({
          ...source,
          rawIds: [...source.rawIds],
          materials: source.materials.map((material) => ({
            ...material,
            rawIds: [...material.rawIds],
          })),
        })),
      sessions: [...this.sessions.values()]
        .filter((session) => planIds.has(session.planId))
        .sort((a, b) => a.sequence - b.sequence)
        .map((session) => ({ ...session })),
    };
  }

  /** Validate graph integrity and global id conflicts without changing durable state. */
  assertCanRestore(archive: LearningArchive): void {
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
    const sourceById = new Map(archive.sources.map((source) => [source.id, source]));
    const sessionById = new Map(archive.sessions.map((session) => [session.id, session]));
    const referencedSourceIds = new Set<string>();
    for (const plan of archive.plans) {
      const source = sourceById.get(plan.sourceId)!;
      if (referencedSourceIds.has(plan.sourceId)) {
        throw new Error(`learning source is referenced by multiple plans: ${plan.sourceId}`);
      }
      referencedSourceIds.add(plan.sourceId);
      if (source.content.length !== plan.sourceLength) {
        throw new Error(`learning source length does not match plan: ${plan.id}`);
      }
      if (plan.currentSessionId) {
        const current = sessionById.get(plan.currentSessionId);
        if (current?.planId !== plan.id) {
          throw new Error(`learning current session does not belong to plan: ${plan.id}`);
        }
      }
    }
    if (archive.sources.some((source) => !referencedSourceIds.has(source.id))) {
      throw new Error("learning source is not referenced by a plan");
    }
    for (const session of archive.sessions) {
      const plan = archive.plans.find((candidate) => candidate.id === session.planId);
      if (!plan) throw new Error("learning session references an unknown plan");
      if (session.endOffset > plan.sourceLength) {
        throw new Error(`learning session exceeds source length: ${session.id}`);
      }
    }
  }

  restore(archive: LearningArchive): LearningPlan[] {
    this.assertCanRestore(archive);
    if (archive.plans.length === 0) return [];

    const candidatePlans = new Map(this.plans);
    const candidateSources = new Map(this.sources);
    const candidateSessions = new Map(this.sessions);
    for (const source of archive.sources) {
      candidateSources.set(source.id, {
        ...source,
        rawIds: [...source.rawIds],
        materials: source.materials.map((material) => ({
          ...material,
          rawIds: [...material.rawIds],
        })),
      });
    }
    for (const session of archive.sessions) {
      candidateSessions.set(session.id, { ...session });
    }
    const restored = archive.plans.map((plan) => {
      const copy = { ...plan, route: plan.route.map((step) => ({ ...step })) };
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

function advancePlan(plan: LearningPlan, session: LearningSession, completedAt: number): void {
  const wasPaused = plan.status === "paused";
  if (plan.mode === "topic") {
    const step = plan.route[plan.routeIndex];
    if (!step || step.id !== session.routeStepId) {
      throw new Error(`learning session route step does not match plan: ${session.id}`);
    }
    step.attempts += 1;
    plan.currentSessionId = undefined;
    plan.adaptiveFocus = session.nextFocus;
    if (session.status === "completed" && session.mastery === "review") {
      step.status = "active";
      plan.status = wasPaused ? "paused" : "active";
    } else {
      step.status = session.status === "skipped" ? "skipped" : "completed";
      plan.routeIndex += 1;
      const next = plan.route[plan.routeIndex];
      if (next) next.status = "active";
      plan.status = next ? (wasPaused ? "paused" : "active") : "completed";
    }
    plan.updatedAt = completedAt;
    return;
  }
  plan.cursor = session.endOffset;
  plan.currentSessionId = undefined;
  plan.status = plan.cursor >= plan.sourceLength ? "completed" : wasPaused ? "paused" : "active";
  plan.updatedAt = completedAt;
}

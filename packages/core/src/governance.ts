import {
  isSpaceId,
  type Attachment,
  type Page,
  type PageType,
  type RawRecord,
  type RawSource,
  type SpaceId,
} from "@homeagent/shared";
import {
  CODEX_REASONING_EFFORTS,
  isCliProvider,
  isCodexReasoningEffortSupported,
} from "@homeagent/llm";
import type { Agent } from "./agents.ts";
import { AGENT_PERMISSIONS } from "./agents.ts";
import { TASK_CADENCES, type Task } from "./tasks.ts";
import type { Reminder } from "./reminders.ts";
import type {
  LearningArchive,
  LearningPlan,
  LearningSession,
  LearningSource,
} from "./learning.ts";
import type { SpaceMeta } from "./types.ts";

export const SPACE_ARCHIVE_FORMAT = "homeagent.space" as const;
export const LEGACY_SPACE_ARCHIVE_FORMAT = "homebrain.space" as const;
export const LEGACY_SPACE_ARCHIVE_VERSION = 1 as const;
export const SPACE_ARCHIVE_VERSION = 2 as const;

export interface MessageRetractionRecord {
  chatId: string;
  messageId: string;
  originalAuthor: string;
  retractedBy: string;
  createdAt: number;
}

/** Portable, versioned backup for one complete knowledge space. */
export interface SpaceArchiveV1 {
  format: typeof SPACE_ARCHIVE_FORMAT;
  version: typeof LEGACY_SPACE_ARCHIVE_VERSION;
  exportedAt: number;
  space: SpaceMeta;
  agent?: Agent;
  purpose: string;
  schema: string;
  pages: Page[];
  raw: RawRecord[];
  retractions: MessageRetractionRecord[];
  tasks: Task[];
  reminders: Reminder[];
}

export interface SpaceArchiveV2 extends Omit<SpaceArchiveV1, "version"> {
  version: typeof SPACE_ARCHIVE_VERSION;
  learning: LearningArchive;
}

/** Current normalized archive shape returned by export and parsing. */
export type SpaceArchive = SpaceArchiveV2;

export interface SpaceDeleteResult {
  status: "deleted" | "not_found";
  space: SpaceMeta["id"];
  pagesDeleted: number;
  rawDeleted: number;
  tasksDeleted: number;
  remindersDeleted: number;
  learningPlansDeleted: number;
}

export interface RawRetentionReport {
  retentionDays: number;
  cutoff: number;
  deleted: number;
  bySpace: Record<string, number>;
}

const PAGE_TYPES: PageType[] = [
  "index",
  "overview",
  "log",
  "glossary",
  "entity",
  "concept",
  "source",
  "analysis",
];
const RAW_SOURCES: RawSource[] = ["message", "doc", "manual", "task", "learning"];
const ATTACHMENT_KINDS: Attachment["kind"][] = ["image", "pdf", "audio", "file"];

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function nonemptyText(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (parsed.length === 0) throw new Error(`${label} must not be empty`);
  return parsed;
}

function assertUnique<T>(items: T[], key: (item: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value] as string[];
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function reasoningEffort(value: unknown, model: string): Agent["reasoningEffort"] {
  if (value === undefined || value === "") return "";
  const effort = text(value, "agent.reasoningEffort") as Agent["reasoningEffort"];
  const valid = model
    ? isCodexReasoningEffortSupported(model, effort)
    : CODEX_REASONING_EFFORTS.includes(effort as (typeof CODEX_REASONING_EFFORTS)[number]);
  if (!valid) {
    throw new Error("agent.reasoningEffort is invalid");
  }
  return effort;
}

function safeSlug(value: unknown, label: string): string {
  const slug = text(value, label);
  const segments = slug.split("/");
  if (
    slug.length === 0 ||
    slug.length > 300 ||
    slug.startsWith("/") ||
    slug.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} is unsafe`);
  }
  return slug;
}

function parsePage(value: unknown, index: number): Page {
  const item = record(value, `pages[${index}]`);
  const type = text(item.type, `pages[${index}].type`) as PageType;
  if (!PAGE_TYPES.includes(type)) throw new Error(`pages[${index}].type is invalid`);
  return {
    slug: safeSlug(item.slug, `pages[${index}].slug`),
    type,
    title: text(item.title, `pages[${index}].title`),
    summary: text(item.summary, `pages[${index}].summary`),
    aliases: strings(item.aliases, `pages[${index}].aliases`),
    tags: strings(item.tags, `pages[${index}].tags`),
    sources: strings(item.sources, `pages[${index}].sources`),
    links: strings(item.links, `pages[${index}].links`),
    content: text(item.content, `pages[${index}].content`),
    updatedAt: finiteNumber(item.updatedAt, `pages[${index}].updatedAt`),
    contentHash: text(item.contentHash, `pages[${index}].contentHash`),
  };
}

function parseRaw(value: unknown, index: number, space: SpaceId): RawRecord {
  const item = record(value, `raw[${index}]`);
  const rawSpace = text(item.space, `raw[${index}].space`);
  if (rawSpace !== space) throw new Error(`raw[${index}].space does not match archive space`);
  const source = text(item.source, `raw[${index}].source`) as RawSource;
  if (!RAW_SOURCES.includes(source)) throw new Error(`raw[${index}].source is invalid`);
  if (!Array.isArray(item.attachments)) throw new Error(`raw[${index}].attachments must be an array`);
  const attachments = item.attachments.map((value, attachmentIndex) => {
    const attachment = record(value, `raw[${index}].attachments[${attachmentIndex}]`);
    const kind = text(attachment.kind, `raw[${index}].attachments[${attachmentIndex}].kind`) as Attachment["kind"];
    if (!ATTACHMENT_KINDS.includes(kind)) throw new Error(`raw[${index}].attachments[${attachmentIndex}].kind is invalid`);
    return {
      kind,
      ref: text(attachment.ref, `raw[${index}].attachments[${attachmentIndex}].ref`),
      name: optionalText(attachment.name, `raw[${index}].attachments[${attachmentIndex}].name`),
    };
  });
  return {
    id: nonemptyText(item.id, `raw[${index}].id`),
    space,
    source,
    author: optionalText(item.author, `raw[${index}].author`),
    chatId: optionalText(item.chatId, `raw[${index}].chatId`),
    messageId: optionalText(item.messageId, `raw[${index}].messageId`),
    content: text(item.content, `raw[${index}].content`),
    attachments,
    createdAt: finiteNumber(item.createdAt, `raw[${index}].createdAt`),
    ingested: boolean(item.ingested, `raw[${index}].ingested`),
  };
}

function parseAgent(value: unknown): Agent {
  const item = record(value, "agent");
  const provider = text(item.provider, "agent.provider");
  if (!isCliProvider(provider)) throw new Error("agent.provider is invalid");
  const permission = text(item.permission, "agent.permission") as Agent["permission"];
  if (!AGENT_PERMISSIONS.includes(permission)) throw new Error("agent.permission is invalid");
  const model = text(item.model, "agent.model");
  return {
    id: nonemptyText(item.id, "agent.id"),
    name: text(item.name, "agent.name"),
    instruction: text(item.instruction, "agent.instruction"),
    model,
    reasoningEffort: reasoningEffort(item.reasoningEffort, model),
    provider,
    visibility: optionalText(item.visibility, "agent.visibility"),
    workdir: optionalText(item.workdir, "agent.workdir"),
    permission,
    skills: strings(item.skills, "agent.skills"),
    createdAt: finiteNumber(item.createdAt, "agent.createdAt"),
    updatedAt: finiteNumber(item.updatedAt, "agent.updatedAt"),
  };
}

function parseTask(value: unknown, index: number, space: SpaceId): Task {
  const item = record(value, `tasks[${index}]`);
  if (item.space !== space) throw new Error(`tasks[${index}].space does not match archive space`);
  const cadence = text(item.cadence, `tasks[${index}].cadence`) as Task["cadence"];
  if (!TASK_CADENCES.includes(cadence)) throw new Error(`tasks[${index}].cadence is invalid`);
  const lastStatus = optionalText(item.lastStatus, `tasks[${index}].lastStatus`) as Task["lastStatus"];
  if (lastStatus && lastStatus !== "ok" && lastStatus !== "error") {
    throw new Error(`tasks[${index}].lastStatus is invalid`);
  }
  const hour = finiteNumber(item.hour, `tasks[${index}].hour`);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`tasks[${index}].hour is invalid`);
  }
  return {
    id: nonemptyText(item.id, `tasks[${index}].id`),
    name: text(item.name, `tasks[${index}].name`),
    space,
    topic: text(item.topic, `tasks[${index}].topic`),
    cadence,
    hour,
    enabled: boolean(item.enabled, `tasks[${index}].enabled`),
    notify: boolean(item.notify, `tasks[${index}].notify`),
    distillOnRun: boolean(item.distillOnRun, `tasks[${index}].distillOnRun`),
    lastRunAt: item.lastRunAt === undefined ? undefined : finiteNumber(item.lastRunAt, `tasks[${index}].lastRunAt`),
    lastStatus,
    lastError: optionalText(item.lastError, `tasks[${index}].lastError`),
    lastSummary: optionalText(item.lastSummary, `tasks[${index}].lastSummary`),
    createdAt: finiteNumber(item.createdAt, `tasks[${index}].createdAt`),
    updatedAt: finiteNumber(item.updatedAt, `tasks[${index}].updatedAt`),
  };
}

function parseReminder(value: unknown, index: number, space: SpaceId): Reminder {
  const item = record(value, `reminders[${index}]`);
  if (item.space !== space) {
    throw new Error(`reminders[${index}].space does not match archive space`);
  }
  const status = text(item.status, `reminders[${index}].status`) as Reminder["status"];
  if (!["scheduled", "completed", "cancelled"].includes(status)) {
    throw new Error(`reminders[${index}].status is invalid`);
  }
  const repeatEveryMs = item.repeatEveryMs === undefined
    ? undefined
    : finiteNumber(item.repeatEveryMs, `reminders[${index}].repeatEveryMs`);
  if (repeatEveryMs !== undefined && repeatEveryMs < 60_000) {
    throw new Error(`reminders[${index}].repeatEveryMs is invalid`);
  }
  const untilConfirmed = boolean(item.untilConfirmed, `reminders[${index}].untilConfirmed`);
  if (untilConfirmed && repeatEveryMs === undefined) {
    throw new Error(`reminders[${index}] requires repeatEveryMs`);
  }
  return {
    id: nonemptyText(item.id, `reminders[${index}].id`),
    title: nonemptyText(item.title, `reminders[${index}].title`),
    space,
    chatId: nonemptyText(item.chatId, `reminders[${index}].chatId`),
    creatorId: nonemptyText(item.creatorId, `reminders[${index}].creatorId`),
    triggerAt: finiteNumber(item.triggerAt, `reminders[${index}].triggerAt`),
    nextTriggerAt: finiteNumber(item.nextTriggerAt, `reminders[${index}].nextTriggerAt`),
    repeatEveryMs,
    untilConfirmed,
    status,
    sourceMessageId: optionalText(item.sourceMessageId, `reminders[${index}].sourceMessageId`),
    lastNotifiedAt: item.lastNotifiedAt === undefined
      ? undefined
      : finiteNumber(item.lastNotifiedAt, `reminders[${index}].lastNotifiedAt`),
    completedAt: item.completedAt === undefined
      ? undefined
      : finiteNumber(item.completedAt, `reminders[${index}].completedAt`),
    cancelledAt: item.cancelledAt === undefined
      ? undefined
      : finiteNumber(item.cancelledAt, `reminders[${index}].cancelledAt`),
    createdAt: finiteNumber(item.createdAt, `reminders[${index}].createdAt`),
    updatedAt: finiteNumber(item.updatedAt, `reminders[${index}].updatedAt`),
  };
}

function parseLearningSource(value: unknown, index: number): LearningSource {
  const item = record(value, `learning.sources[${index}]`);
  return {
    id: nonemptyText(item.id, `learning.sources[${index}].id`),
    title: nonemptyText(item.title, `learning.sources[${index}].title`),
    content: nonemptyText(item.content, `learning.sources[${index}].content`),
    rawIds: strings(item.rawIds, `learning.sources[${index}].rawIds`),
    messageId: nonemptyText(item.messageId, `learning.sources[${index}].messageId`),
    createdAt: finiteNumber(item.createdAt, `learning.sources[${index}].createdAt`),
  };
}

function parseLearningPlan(value: unknown, index: number, space: SpaceId): LearningPlan {
  const item = record(value, `learning.plans[${index}]`);
  if (item.space !== space) {
    throw new Error(`learning.plans[${index}].space does not match archive space`);
  }
  const sourceLength = finiteNumber(item.sourceLength, `learning.plans[${index}].sourceLength`);
  const hour = finiteNumber(item.hour, `learning.plans[${index}].hour`);
  const dailyCharacters = finiteNumber(
    item.dailyCharacters,
    `learning.plans[${index}].dailyCharacters`,
  );
  const cursor = finiteNumber(item.cursor, `learning.plans[${index}].cursor`);
  if (!Number.isInteger(sourceLength) || sourceLength <= 0) {
    throw new Error(`learning.plans[${index}].sourceLength is invalid`);
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`learning.plans[${index}].hour is invalid`);
  }
  if (!Number.isInteger(dailyCharacters) || dailyCharacters < 500 || dailyCharacters > 8000) {
    throw new Error(`learning.plans[${index}].dailyCharacters is invalid`);
  }
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > sourceLength) {
    throw new Error(`learning.plans[${index}].cursor is invalid`);
  }
  const status = text(item.status, `learning.plans[${index}].status`) as LearningPlan["status"];
  if (!["active", "paused", "completed"].includes(status)) {
    throw new Error(`learning.plans[${index}].status is invalid`);
  }
  return {
    id: nonemptyText(item.id, `learning.plans[${index}].id`),
    name: nonemptyText(item.name, `learning.plans[${index}].name`),
    space,
    creatorId: nonemptyText(item.creatorId, `learning.plans[${index}].creatorId`),
    chatId: nonemptyText(item.chatId, `learning.plans[${index}].chatId`),
    sourceId: nonemptyText(item.sourceId, `learning.plans[${index}].sourceId`),
    sourceLength,
    hour,
    dailyCharacters,
    cursor,
    status,
    currentSessionId: optionalText(
      item.currentSessionId,
      `learning.plans[${index}].currentSessionId`,
    ),
    lastDeliveredAt: item.lastDeliveredAt === undefined
      ? undefined
      : finiteNumber(item.lastDeliveredAt, `learning.plans[${index}].lastDeliveredAt`),
    createdAt: finiteNumber(item.createdAt, `learning.plans[${index}].createdAt`),
    updatedAt: finiteNumber(item.updatedAt, `learning.plans[${index}].updatedAt`),
  };
}

function parseLearningSession(value: unknown, index: number): LearningSession {
  const item = record(value, `learning.sessions[${index}]`);
  const sequence = finiteNumber(item.sequence, `learning.sessions[${index}].sequence`);
  const startOffset = finiteNumber(item.startOffset, `learning.sessions[${index}].startOffset`);
  const endOffset = finiteNumber(item.endOffset, `learning.sessions[${index}].endOffset`);
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`learning.sessions[${index}].sequence is invalid`);
  }
  if (
    !Number.isInteger(startOffset) || !Number.isInteger(endOffset)
    || startOffset < 0 || endOffset <= startOffset
  ) {
    throw new Error(`learning.sessions[${index}] offsets are invalid`);
  }
  const status = text(
    item.status,
    `learning.sessions[${index}].status`,
  ) as LearningSession["status"];
  if (!["prepared", "awaiting_reply", "completed", "skipped"].includes(status)) {
    throw new Error(`learning.sessions[${index}].status is invalid`);
  }
  return {
    id: nonemptyText(item.id, `learning.sessions[${index}].id`),
    planId: nonemptyText(item.planId, `learning.sessions[${index}].planId`),
    sequence,
    startOffset,
    endOffset,
    sectionTitle: nonemptyText(item.sectionTitle, `learning.sessions[${index}].sectionTitle`),
    excerpt: nonemptyText(item.excerpt, `learning.sessions[${index}].excerpt`),
    guide: nonemptyText(item.guide, `learning.sessions[${index}].guide`),
    status,
    learnerReply: optionalText(item.learnerReply, `learning.sessions[${index}].learnerReply`),
    feedback: optionalText(item.feedback, `learning.sessions[${index}].feedback`),
    preparedAt: finiteNumber(item.preparedAt, `learning.sessions[${index}].preparedAt`),
    deliveredAt: item.deliveredAt === undefined
      ? undefined
      : finiteNumber(item.deliveredAt, `learning.sessions[${index}].deliveredAt`),
    completedAt: item.completedAt === undefined
      ? undefined
      : finiteNumber(item.completedAt, `learning.sessions[${index}].completedAt`),
  };
}

function parseLearningArchive(
  value: unknown,
  version: number,
  space: SpaceId,
): LearningArchive {
  if (version === LEGACY_SPACE_ARCHIVE_VERSION) {
    return { plans: [], sources: [], sessions: [] };
  }
  const learning = record(value, "learning");
  if (
    !Array.isArray(learning.plans)
    || !Array.isArray(learning.sources)
    || !Array.isArray(learning.sessions)
  ) {
    throw new Error("learning collections must be arrays");
  }
  const plans = learning.plans.map((item, index) => parseLearningPlan(item, index, space));
  const sources = learning.sources.map(parseLearningSource);
  const sessions = learning.sessions.map(parseLearningSession);
  assertUnique(plans, (plan) => plan.id, "learning plan id");
  assertUnique(sources, (source) => source.id, "learning source id");
  assertUnique(sessions, (session) => session.id, "learning session id");
  assertUnique(sessions, (session) => `${session.planId}\0${session.sequence}`, "learning session sequence");
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  for (const plan of plans) {
    const source = sourceById.get(plan.sourceId);
    if (!source) throw new Error(`learning plan sourceId is unknown: ${plan.sourceId}`);
    if (plan.sourceLength !== source.content.length) {
      throw new Error(`learning plan sourceLength does not match source: ${plan.id}`);
    }
    if (plan.currentSessionId) {
      const session = sessionById.get(plan.currentSessionId);
      if (!session || session.planId !== plan.id) {
        throw new Error(`learning plan currentSessionId is invalid: ${plan.id}`);
      }
    }
  }
  for (const session of sessions) {
    const plan = planById.get(session.planId);
    if (!plan) throw new Error(`learning session planId is unknown: ${session.planId}`);
    if (session.endOffset > plan.sourceLength) {
      throw new Error(`learning session exceeds source length: ${session.id}`);
    }
  }
  return { plans, sources, sessions };
}

/** Validate and normalize untrusted JSON before any restore writes occur. */
export function parseSpaceArchive(value: unknown): SpaceArchive {
  const root = record(value, "archive");
  const version = root.version;
  if (
    (root.format !== SPACE_ARCHIVE_FORMAT && root.format !== LEGACY_SPACE_ARCHIVE_FORMAT)
    || (version !== LEGACY_SPACE_ARCHIVE_VERSION && version !== SPACE_ARCHIVE_VERSION)
  ) {
    throw new Error("unsupported space archive format or version");
  }
  const meta = record(root.space, "space");
  const id = text(meta.id, "space.id");
  if (!isSpaceId(id)) throw new Error("space.id is invalid");
  const space: SpaceMeta = {
    id,
    createdAt: finiteNumber(meta.createdAt, "space.createdAt"),
    lastDreamAt: meta.lastDreamAt === undefined ? undefined : finiteNumber(meta.lastDreamAt, "space.lastDreamAt"),
    chatId: optionalText(meta.chatId, "space.chatId"),
    name: optionalText(meta.name, "space.name"),
    agentId: optionalText(meta.agentId, "space.agentId"),
    replyInThread: meta.replyInThread === undefined ? undefined : boolean(meta.replyInThread, "space.replyInThread"),
    mentionsOnly: meta.mentionsOnly === undefined ? undefined : boolean(meta.mentionsOnly, "space.mentionsOnly"),
  };
  if (
    !Array.isArray(root.pages)
    || !Array.isArray(root.raw)
    || !Array.isArray(root.retractions)
    || !Array.isArray(root.tasks)
    || (root.reminders !== undefined && !Array.isArray(root.reminders))
  ) {
    throw new Error("archive collections must be arrays");
  }
  const agent = root.agent === undefined ? undefined : parseAgent(root.agent);
  if (agent && agent.id !== space.agentId) {
    throw new Error("agent.id does not match space.agentId");
  }
  const pages = root.pages.map(parsePage);
  const raw = root.raw.map((item, index) => parseRaw(item, index, id));
  const retractions = root.retractions.map((value, index) => {
    const item = record(value, `retractions[${index}]`);
    return {
      chatId: nonemptyText(item.chatId, `retractions[${index}].chatId`),
      messageId: nonemptyText(item.messageId, `retractions[${index}].messageId`),
      originalAuthor: text(item.originalAuthor, `retractions[${index}].originalAuthor`),
      retractedBy: text(item.retractedBy, `retractions[${index}].retractedBy`),
      createdAt: finiteNumber(item.createdAt, `retractions[${index}].createdAt`),
    };
  });
  const tasks = root.tasks.map((item, index) => parseTask(item, index, id));
  const reminders = (root.reminders ?? []).map(
    (item: unknown, index: number) => parseReminder(item, index, id),
  );
  assertUnique(pages, (page) => page.slug, "page slug");
  assertUnique(raw, (entry) => entry.id, "raw id");
  assertUnique(retractions, (entry) => `${entry.chatId}\0${entry.messageId}`, "retraction");
  assertUnique(tasks, (task) => task.id, "task id");
  assertUnique(reminders, (reminder) => reminder.id, "reminder id");
  const learning = parseLearningArchive(root.learning, version, id);
  return {
    format: SPACE_ARCHIVE_FORMAT,
    version: SPACE_ARCHIVE_VERSION,
    exportedAt: finiteNumber(root.exportedAt, "exportedAt"),
    space,
    agent,
    purpose: text(root.purpose, "purpose"),
    schema: text(root.schema, "schema"),
    pages,
    raw,
    retractions,
    tasks,
    reminders,
    learning,
  };
}

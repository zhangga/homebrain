import {
  isSpaceId,
  type Attachment,
  type Page,
  type PageType,
  type RawRecord,
  type RawSource,
  type SpaceId,
} from "@homebrain/shared";
import { isCliProvider, isCodexReasoningEffortSupported } from "@homebrain/llm";
import type { Agent } from "./agents.ts";
import { AGENT_PERMISSIONS } from "./agents.ts";
import { TASK_CADENCES, type Task } from "./tasks.ts";
import type { SpaceMeta } from "./types.ts";

export const SPACE_ARCHIVE_FORMAT = "homebrain.space" as const;
export const SPACE_ARCHIVE_VERSION = 1 as const;

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
  version: typeof SPACE_ARCHIVE_VERSION;
  exportedAt: number;
  space: SpaceMeta;
  agent?: Agent;
  purpose: string;
  schema: string;
  pages: Page[];
  raw: RawRecord[];
  retractions: MessageRetractionRecord[];
  tasks: Task[];
}

export type SpaceArchive = SpaceArchiveV1;

export interface SpaceDeleteResult {
  status: "deleted" | "not_found";
  space: SpaceMeta["id"];
  pagesDeleted: number;
  rawDeleted: number;
  tasksDeleted: number;
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
const RAW_SOURCES: RawSource[] = ["message", "doc", "manual", "task"];
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
  if (!isCodexReasoningEffortSupported(model || undefined, effort)) {
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

/** Validate and normalize untrusted JSON before any restore writes occur. */
export function parseSpaceArchive(value: unknown): SpaceArchive {
  const root = record(value, "archive");
  if (root.format !== SPACE_ARCHIVE_FORMAT || root.version !== SPACE_ARCHIVE_VERSION) {
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
  if (!Array.isArray(root.pages) || !Array.isArray(root.raw) || !Array.isArray(root.retractions) || !Array.isArray(root.tasks)) {
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
  assertUnique(pages, (page) => page.slug, "page slug");
  assertUnique(raw, (entry) => entry.id, "raw id");
  assertUnique(retractions, (entry) => `${entry.chatId}\0${entry.messageId}`, "retraction");
  assertUnique(tasks, (task) => task.id, "task id");
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
  };
}

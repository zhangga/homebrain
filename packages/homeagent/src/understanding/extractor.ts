import type { IncomingMessage } from "../connectors/types";
import type { LlmTextClient } from "../llm/types";
import { MEMORY_EXTRACTION_SYSTEM_PROMPT, buildExtractionUserPrompt } from "./prompts";

export interface ExtractedFact {
  text: string;
  tags?: string[];
  occurredAt?: string;
}

export interface MemoryExtractor {
  extract(input: { msg: IncomingMessage; text: string }): Promise<ExtractedFact[]>;
}

export interface LlmMemoryExtractorOptions {
  client: LlmTextClient;
}

/** Slice 1 的 Claude extractor 接入前，先用原文 passthrough 保持 runtime 可测。 */
export function createPassthroughExtractor(): MemoryExtractor {
  return {
    async extract({ msg, text }) {
      const normalized = text.trim();
      return withAttachmentTags(normalized ? [{ text: normalized }] : [], msg);
    },
  };
}

export function createLlmMemoryExtractor(opts: LlmMemoryExtractorOptions): MemoryExtractor {
  return {
    async extract({ msg, text }) {
      if (!shouldRunLlmExtraction(text)) return [];

      const output = await opts.client.generateText({
        system: MEMORY_EXTRACTION_SYSTEM_PROMPT,
        user: buildExtractionUserPrompt(msg, text),
      });
      return withAttachmentTags(normalizeFacts(parseFacts(output)), msg);
    },
  };
}

const TRIVIAL_MEMORY_MESSAGES = new Set([
  "ok",
  "okay",
  "嗯",
  "嗯嗯",
  "好",
  "好的",
  "可以",
  "收到",
  "辛苦了",
  "谢谢",
  "是",
  "是的",
  "对",
  "对的",
  "行",
]);

function shouldRunLlmExtraction(text: string): boolean {
  const normalized = normalizeTrivialReply(text);
  if (!normalized) return false;
  if (TRIVIAL_MEMORY_MESSAGES.has(normalized)) return false;
  if (/^哈{2,}$/.test(normalized)) return false;
  return true;
}

function normalizeTrivialReply(text: string): string {
  return text
    .trim()
    .replace(/^[\s。.!！?？~～、，,]+/, "")
    .replace(/[\s。.!！?？~～、，,]+$/, "")
    .toLowerCase();
}

function parseFacts(output: string): unknown {
  const text = stripJsonFence(output.trim());
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (isRecord(parsed) && Array.isArray(parsed.facts)) return parsed.facts;
    return [];
  } catch {
    throw new Error(`LLM extractor 输出非 JSON：${output.slice(0, 120)}`);
  }
}

function normalizeFacts(value: unknown): ExtractedFact[] {
  if (!Array.isArray(value)) return [];
  const facts: ExtractedFact[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    facts.push({
      text,
      tags: normalizeTags(item.tags),
      occurredAt: typeof item.occurredAt === "string" ? item.occurredAt : undefined,
    });
  }
  return facts;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "");
  return tags.length ? tags : undefined;
}

function withAttachmentTags(facts: ExtractedFact[], msg: IncomingMessage): ExtractedFact[] {
  const attachmentTags = buildAttachmentTags(msg.attachments);
  if (!attachmentTags.length) return facts;
  return facts.map((fact) => ({
    ...fact,
    tags: mergeTags(fact.tags, attachmentTags),
  }));
}

function buildAttachmentTags(attachments: IncomingMessage["attachments"]): string[] {
  if (!attachments?.length) return [];
  return mergeTags(["attachment"], attachments.map((attachment) => attachment.kind));
}

function mergeTags(existing: string[] | undefined, extra: string[]): string[] {
  const tags: string[] = [];
  for (const tag of [...(existing ?? []), ...extra]) {
    const normalized = tag.trim();
    if (normalized && !tags.includes(normalized)) tags.push(normalized);
  }
  return tags;
}

function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

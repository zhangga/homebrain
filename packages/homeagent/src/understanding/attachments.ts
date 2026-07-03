import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { IncomingAttachment, IncomingMessage } from "../connectors/types";
import type { LlmImageMediaType, LlmVisionClient } from "../llm/types";

export interface AttachmentTextExtractor {
  extractText(input: { msg: IncomingMessage; attachment: IncomingAttachment }): Promise<string | undefined>;
}

export interface LocalTextAttachmentExtractorOptions {
  rootDir?: string;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 16 * 1024;
const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".log"]);
const IMAGE_MEDIA_TYPES: Record<string, LlmImageMediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const IMAGE_OCR_SYSTEM_PROMPT = "你是家庭长期记忆助手的图片文字提取器。";
const IMAGE_OCR_USER_PROMPT =
  "请提取这张图片中适合写入家庭长期记忆的文字内容。只输出图片里的可读文字或关键信息；如果没有可读内容，只输出“无”。";

export function createLocalTextAttachmentExtractor(
  opts: LocalTextAttachmentExtractorOptions = {},
): AttachmentTextExtractor {
  const rootDir = opts.rootDir ?? process.cwd();
  const maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  return {
    async extractText({ attachment }) {
      if (!attachment.localPath || !isTextLikeAttachment(attachment)) return undefined;
      const filePath = resolveSafeLocalPath(rootDir, attachment.localPath);
      if (!filePath) return undefined;
      return normalizeExtractedText(await readFilePrefix(filePath, maxBytes));
    },
  };
}

export interface ClaudeImageAttachmentExtractorOptions {
  client: LlmVisionClient;
  rootDir?: string;
  maxBytes?: number;
}

export function createClaudeImageAttachmentExtractor(
  opts: ClaudeImageAttachmentExtractorOptions,
): AttachmentTextExtractor {
  const rootDir = opts.rootDir ?? process.cwd();
  const maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES);
  return {
    async extractText({ attachment }) {
      if (attachment.kind !== "image" || !attachment.localPath) return undefined;
      const mediaType = imageMediaType(attachment);
      if (!mediaType) return undefined;
      const filePath = resolveSafeLocalPath(rootDir, attachment.localPath);
      if (!filePath) return undefined;
      const buffer = await readWholeFileWithinLimit(filePath, maxBytes);
      if (!buffer) return undefined;
      return normalizeImageOcrText(
        await opts.client.generateTextFromImage({
          system: IMAGE_OCR_SYSTEM_PROMPT,
          prompt: IMAGE_OCR_USER_PROMPT,
          image: {
            mediaType,
            dataBase64: buffer.toString("base64"),
          },
        }),
      );
    },
  };
}

export function createCompositeAttachmentTextExtractor(
  extractors: AttachmentTextExtractor[],
): AttachmentTextExtractor {
  return {
    async extractText(input) {
      for (const extractor of extractors) {
        const text = normalizeExtractedText(await extractor.extractText(input));
        if (text) return text;
      }
      return undefined;
    },
  };
}

function isTextLikeAttachment(attachment: IncomingAttachment): boolean {
  const name = attachment.name ?? attachment.localPath ?? "";
  return TEXT_EXTENSIONS.has(extensionOf(name));
}

function imageMediaType(attachment: IncomingAttachment): LlmImageMediaType | undefined {
  const name = attachment.name ?? attachment.localPath ?? "";
  return IMAGE_MEDIA_TYPES[extensionOf(name)];
}

function extensionOf(path: string): string {
  const match = path.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function resolveSafeLocalPath(rootDir: string, localPath: string): string | undefined {
  const normalized = localPath.trim().replace(/\\/g, "/");
  if (!normalized || isAbsolute(normalized)) return undefined;
  if (normalized.split("/").some((part) => part === "..")) return undefined;
  return resolve(rootDir, normalized);
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<string | undefined> {
  try {
    const file = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

async function readWholeFileWithinLimit(filePath: string, maxBytes: number): Promise<Buffer | undefined> {
  try {
    const file = await open(filePath, "r");
    try {
      const stat = await file.stat();
      if (stat.size <= 0 || stat.size > maxBytes) return undefined;
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await file.read(buffer, 0, stat.size, 0);
      return bytesRead === stat.size ? buffer : undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

function normalizeExtractedText(text: string | undefined): string | undefined {
  const normalized = text?.trim();
  return normalized || undefined;
}

function normalizeImageOcrText(text: string | undefined): string | undefined {
  const normalized = normalizeExtractedText(text);
  if (!normalized) return undefined;
  return /^无[。.]?$/.test(normalized) ? undefined : normalized;
}

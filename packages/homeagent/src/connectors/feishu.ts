import type { Connector, IncomingMessage, OutgoingMessage } from "./types";

export type FeishuIdentity = "bot" | "user";
type IncomingAttachment = NonNullable<IncomingMessage["attachments"]>[number];

export interface FeishuConnectorOptions {
  eventKey: string;
  larkBin?: string;
  identity?: FeishuIdentity;
  botOpenId?: string;
  eventSource?: AsyncIterable<string>;
  eventSourceFactory?: () => AsyncIterable<string>;
  maxRestarts?: number;
  restartDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onEventSourceError?: (err: unknown, restartCount: number) => void;
  runCommand?: (argv: string[]) => Promise<void>;
  attachmentDownloadDir?: string;
}

interface FeishuMessageEvent {
  chat_id?: string;
  sender_id?: string;
  sender_name?: string;
  message_id?: string;
  message_type?: string;
  content?: unknown;
  create_time?: string | number;
  event?: FeishuMessageEvent | FeishuRawMessageEvent;
}

interface FeishuRawMessageEvent {
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
  };
  message?: {
    chat_id?: string;
    message_id?: string;
    message_type?: string;
    content?: unknown;
    create_time?: string | number;
  };
}

export function createFeishuConnector(opts: FeishuConnectorOptions): Connector {
  const larkBin = opts.larkBin ?? "lark-cli";
  const identity = opts.identity ?? "bot";
  const runCommand = opts.runCommand ?? runLarkCommand;
  const maxRestarts = opts.maxRestarts ?? 3;
  const restartDelayMs = opts.restartDelayMs ?? 1000;
  const sleep = opts.sleep ?? delay;
  const makeEventSource =
    opts.eventSourceFactory ??
    (opts.eventSource
      ? () => opts.eventSource!
      : () =>
          consumeFeishuEventLines({
            larkBin,
            eventKey: opts.eventKey,
            identity,
          }));

  return {
    name: "feishu",
    async *receiveMessages(): AsyncIterable<IncomingMessage> {
      let restarts = 0;
      while (true) {
        try {
          for await (const line of makeEventSource()) {
            const msg = normalizeFeishuEventLine(line, { botOpenId: opts.botOpenId });
            if (msg) {
              yield await downloadAttachmentsIfConfigured(msg, {
                larkBin,
                identity,
                runCommand,
                attachmentDownloadDir: opts.attachmentDownloadDir,
              });
            }
          }
          return;
        } catch (err) {
          if (restarts >= maxRestarts) throw err;
          restarts += 1;
          opts.onEventSourceError?.(err, restarts);
          if (restartDelayMs > 0) await sleep(restartDelayMs);
        }
      }
    },
    async sendMessage(msg: OutgoingMessage): Promise<void> {
      await runCommand([
        larkBin,
        "im",
        "+messages-send",
        "--chat-id",
        msg.channelId,
        "--text",
        msg.text,
        "--as",
        identity,
      ]);
    },
  };
}

export function normalizeFeishuEventLine(
  line: string,
  opts: { botOpenId?: string } = {},
): IncomingMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  let raw: FeishuMessageEvent;
  try {
    raw = JSON.parse(trimmed) as FeishuMessageEvent;
  } catch {
    return undefined;
  }

  const event = normalizeFeishuMessageEvent(raw.event ?? raw);
  if (!event.chat_id || !event.sender_id) return undefined;

  const parsed = parseFeishuContent(event.message_type, event.content);
  const mention = stripBotMention(parsed.text, opts.botOpenId);
  return {
    channelId: event.chat_id,
    senderId: event.sender_id,
    senderName: event.sender_name,
    text: mention.text,
    ...(parsed.attachments?.length ? { attachments: parsed.attachments } : {}),
    mentionsBot: mention.mentionsBot,
    raw,
    ts: parseTimestamp(event.create_time),
  };
}

function normalizeFeishuMessageEvent(event: FeishuMessageEvent | FeishuRawMessageEvent): FeishuMessageEvent {
  if (isRawFeishuMessageEvent(event)) {
    const senderId = event.sender?.sender_id;
    return {
      chat_id: event.message?.chat_id,
      message_id: event.message?.message_id,
      sender_id: senderId?.open_id ?? senderId?.user_id ?? senderId?.union_id,
      message_type: event.message?.message_type,
      content: event.message?.content,
      create_time: event.message?.create_time,
    };
  }
  return event;
}

function isRawFeishuMessageEvent(
  event: FeishuMessageEvent | FeishuRawMessageEvent,
): event is FeishuRawMessageEvent {
  return "message" in event || "sender" in event;
}

async function downloadAttachmentsIfConfigured(
  msg: IncomingMessage,
  opts: {
    larkBin: string;
    identity: FeishuIdentity;
    runCommand: (argv: string[]) => Promise<void>;
    attachmentDownloadDir?: string;
  },
): Promise<IncomingMessage> {
  if (!opts.attachmentDownloadDir || !msg.attachments?.length) return msg;
  const messageId = extractMessageId(msg.raw);
  if (!messageId) return msg;

  const attachments: IncomingAttachment[] = [];
  for (const attachment of msg.attachments) {
    if (!attachment.key) {
      attachments.push(attachment);
      continue;
    }

    const localPath = buildAttachmentOutputPath(opts.attachmentDownloadDir, messageId, attachment);
    await opts.runCommand([
      opts.larkBin,
      "im",
      "+messages-resources-download",
      "--message-id",
      messageId,
      "--file-key",
      attachment.key,
      "--type",
      attachment.kind,
      "--output",
      localPath,
      "--as",
      opts.identity,
    ]);
    attachments.push({ ...attachment, localPath });
  }

  return { ...msg, attachments };
}

function extractMessageId(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const direct = pickString(raw, ["message_id", "messageId"]);
  if (direct) return direct;

  const event = raw.event;
  if (!isRecord(event)) return undefined;
  const eventId = pickString(event, ["message_id", "messageId"]);
  if (eventId) return eventId;
  return isRecord(event.message) ? pickString(event.message, ["message_id", "messageId"]) : undefined;
}

function buildAttachmentOutputPath(
  downloadDir: string,
  messageId: string,
  attachment: IncomingAttachment,
): string {
  const baseDir = normalizeRelativeOutputDir(downloadDir);
  const messageDir = sanitizePathSegment(messageId);
  const fileName = sanitizePathSegment(attachment.name ?? attachment.key ?? attachment.kind);
  return [baseDir, messageDir, fileName].filter(Boolean).join("/");
}

function normalizeRelativeOutputDir(downloadDir: string): string {
  const normalized = downloadDir.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
    throw new Error("attachmentDownloadDir must be a safe relative path");
  }
  return normalized;
}

function sanitizePathSegment(raw: string): string {
  const sanitized = raw.trim().replace(/[\\/]/g, "_").replace(/\.\./g, "_");
  return sanitized && sanitized !== "." ? sanitized : "attachment";
}

function parseFeishuContent(
  messageType: string | undefined,
  content: unknown,
): { text: string; attachments?: IncomingMessage["attachments"] } {
  if (messageType === "image") {
    const payload = parseFeishuContentObject(content);
    const attachment = createAttachment("image", payload, ["image_key", "imageKey", "key"]);
    return {
      text: "",
      attachments: attachment ? [attachment] : undefined,
    };
  }

  if (messageType === "file") {
    const payload = parseFeishuContentObject(content);
    const attachment = createAttachment("file", payload, ["file_key", "fileKey", "key"], [
      "file_name",
      "fileName",
      "name",
    ]);
    return {
      text: "",
      attachments: attachment ? [attachment] : undefined,
    };
  }

  if (messageType === "post") {
    return parseFeishuPostContent(content);
  }

  return { text: parseFeishuText(content) };
}

function parseFeishuText(content: unknown): string {
  if (typeof content !== "string") return "";
  const trimmed = content.trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed) as { text?: unknown };
    if (typeof parsed.text === "string") return parsed.text.trim();
  } catch {
    // lark-cli event consume 的 content 常常已经是纯文本。
  }
  return trimmed;
}

function parseFeishuPostContent(content: unknown): {
  text: string;
  attachments?: IncomingMessage["attachments"];
} {
  const payload = parseFeishuContentObject(content);
  if (!payload) return { text: "" };

  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const lines = Array.isArray(payload.content) ? payload.content : [];
  const body = lines.map(formatPostLine).filter(Boolean).join("\n");
  const text = [title, body].filter(Boolean).join("\n").trim();
  const attachments = collectPostAttachments(lines);
  return {
    text,
    ...(attachments.length ? { attachments } : {}),
  };
}

function formatPostLine(line: unknown): string {
  if (!Array.isArray(line)) return "";
  return line.map(formatPostElement).join("").trim();
}

function formatPostElement(element: unknown): string {
  if (!isRecord(element)) return "";
  const tag = typeof element.tag === "string" ? element.tag : "";
  if (tag === "text") return typeof element.text === "string" ? element.text : "";
  if (tag === "at") {
    const userId = pickString(element, ["user_id", "userId"]);
    const userName = pickString(element, ["user_name", "userName", "name"]) ?? "";
    return userId ? `<at user_id="${userId}">${userName}</at>` : userName;
  }
  if (tag === "a") return typeof element.text === "string" ? element.text : "";
  return "";
}

function collectPostAttachments(lines: unknown[]): IncomingAttachment[] {
  const attachments: IncomingAttachment[] = [];
  for (const line of lines) {
    if (!Array.isArray(line)) continue;
    for (const element of line) {
      for (const attachment of collectPostElementAttachments(element)) {
        pushUniqueAttachment(attachments, attachment);
      }
    }
  }
  return attachments;
}

function collectPostElementAttachments(element: unknown): IncomingAttachment[] {
  if (!isRecord(element)) return [];
  const tag = typeof element.tag === "string" ? element.tag : "";
  const attachments: IncomingAttachment[] = [];

  if (tag === "img" || tag === "image") {
    const image = createAttachment("image", element, ["image_key", "imageKey", "img_key", "imgKey", "key"]);
    if (image) attachments.push(image);
  }

  if (tag === "media" || tag === "file") {
    const file = createAttachment("file", element, ["file_key", "fileKey", "key"], [
      "file_name",
      "fileName",
      "name",
    ]);
    const cover = createAttachment("image", element, ["image_key", "imageKey", "img_key", "imgKey"]);
    if (file) attachments.push(file);
    if (cover) attachments.push(cover);
  }

  return attachments;
}

function pushUniqueAttachment(attachments: IncomingAttachment[], next: IncomingAttachment): void {
  const exists = attachments.some(
    (attachment) =>
      attachment.kind === next.kind && attachment.key === next.key && attachment.url === next.url,
  );
  if (!exists) attachments.push(next);
}

function parseFeishuContentObject(content: unknown): Record<string, unknown> | undefined {
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(content) ? content : undefined;
}

function createAttachment(
  kind: IncomingAttachment["kind"],
  payload: Record<string, unknown> | undefined,
  keyNames: string[],
  nameNames: string[] = [],
): IncomingAttachment | undefined {
  const key = pickString(payload, keyNames);
  if (!key) return undefined;
  const url = pickString(payload, ["url", `${kind}_url`, `${kind}Url`]);
  const name = pickString(payload, nameNames);
  return {
    kind,
    key,
    ...(url ? { url } : {}),
    ...(name ? { name } : {}),
  };
}

function pickString(
  payload: Record<string, unknown> | undefined,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = payload?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripBotMention(
  text: string,
  botOpenId: string | undefined,
): { text: string; mentionsBot: boolean } {
  if (!botOpenId) return { text, mentionsBot: false };

  const mentionPattern = new RegExp(
    `<at\\s+user_id="${escapeRegExp(botOpenId)}">[^<]*</at>\\s*`,
    "g",
  );
  const stripped = text.replace(mentionPattern, "").trim();
  return {
    text: stripped,
    mentionsBot: stripped !== text.trim(),
  };
}

function parseTimestamp(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  if (!value) return Date.now();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runLarkCommand(argv: string[]): Promise<void> {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ]);
  if (exitCode !== 0) {
    throw new Error(`lark-cli failed (${exitCode}): ${stderr.trim()}`);
  }
}

async function* consumeFeishuEventLines(opts: {
  larkBin: string;
  eventKey: string;
  identity: FeishuIdentity;
}): AsyncIterable<string> {
  const proc = Bun.spawn(
    [opts.larkBin, "event", "consume", opts.eventKey, "--as", opts.identity],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    },
  );
  const stderr = proc.stderr ? readStreamText(proc.stderr) : Promise.resolve("");
  if (proc.stdout) {
    for await (const line of readStreamLines(proc.stdout)) yield line;
  }

  const [exitCode, stderrText] = await Promise.all([proc.exited, stderr]);
  if (exitCode !== 0) {
    throw new Error(`lark event consume failed (${exitCode}): ${stderrText.trim()}`);
  }
}

async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* readStreamLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, nl);
        buf = buf.slice(nl + 1);
      }
    }
  } finally {
    reader.releaseLock();
  }
  buf += decoder.decode();
  if (buf.trim()) yield buf;
}

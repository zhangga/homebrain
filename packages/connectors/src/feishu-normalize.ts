/**
 * Pure normalization of lark-cli event NDJSON into the connector's InboundEvent
 * envelope (plan §IV). Kept separate from the subprocess plumbing in feishu.ts
 * so the parsing rules are unit-testable without spawning anything.
 *
 * Field placement is per lark-cli's `event schema` (verified live):
 *   - im.message.receive_v1     -> fields at top level (jq_root_path ".")
 *   - im.chat.member.bot.added_v1 -> fields under ".event" (jq_root_path ".event")
 *
 * Mention detection (Q2 group @-gating): the rendered receive schema does NOT
 * expose a mentions array, and the pre-rendered `content` may or may not contain
 * the literal bot name. We therefore detect a bot mention from several defensive
 * signals, most precise first:
 *   1. a `mentions[]` array (feishu's raw field, often preserved) whose entry
 *      open_id matches the configured bot open_id, or whose name matches the
 *      configured bot name;
 *   2. the rendered content containing "@<botName>";
 *   3. when identity hints and structured mentions are both absent, a textual
 *      @mention token in the rendered content.
 * Operators set HOMEBRAIN_FEISHU_BOT_NAME / _OPEN_ID for precise gating; without
 * them we fall back to "any mention present" so the bot is not permanently mute.
 */
import type { BotAddedEvent, InboundMessage } from "./connector.ts";

export interface FeishuIdentity {
  botName?: string;
  botOpenId?: string;
}

interface MentionEntry {
  key?: string;
  name?: string;
  id?: { open_id?: string; union_id?: string; user_id?: string };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function extractMentions(obj: Record<string, unknown>): MentionEntry[] {
  // mentions may sit at top level or under a nested `message` object depending
  // on how lark-cli forwards the raw event.
  const candidates = [obj.mentions, (obj.message as Record<string, unknown> | undefined)?.mentions];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as MentionEntry[];
  }
  return [];
}

/** Decide whether the bot was mentioned, given identity hints. */
export function detectBotMention(
  obj: Record<string, unknown>,
  content: string,
  identity: FeishuIdentity,
): boolean {
  const mentions = extractMentions(obj);

  if (identity.botOpenId) {
    if (mentions.some((m) => m.id?.open_id === identity.botOpenId)) return true;
  }
  if (identity.botName) {
    if (mentions.some((m) => m.name === identity.botName)) return true;
    if (content.includes(`@${identity.botName}`)) return true;
  }
  // No precise identity configured: any mention is assumed to address the bot
  // (people @ the bot to ask it). This keeps a group-added bot responsive.
  if (!identity.botOpenId && !identity.botName && mentions.length > 0) return true;
  // lark-cli's flattened receive event can omit `mentions[]` while retaining
  // the rendered "@BotName" token. Require start/whitespace before @ so an
  // email address does not accidentally open the group reply gate.
  if (!identity.botOpenId && !identity.botName && /(?:^|\s)@\S+/u.test(content)) return true;

  return false;
}

/** Feishu docx/wiki links appearing in message text (for doc sync, Q8). */
export function extractDocLinks(content: string): string[] {
  const re = /https?:\/\/[^\s)]+\/(?:docx|wiki|docs)\/[A-Za-z0-9]+/g;
  const found = content.match(re) ?? [];
  return [...new Set(found)];
}

/**
 * Normalize a parsed receive_v1 JSON object into an InboundMessage, or null if
 * it is not a usable text message (e.g. missing ids).
 */
export function normalizeMessage(
  obj: Record<string, unknown>,
  identity: FeishuIdentity = {},
): InboundMessage | null {
  const chatId = asString(obj.chat_id);
  const messageId = asString(obj.message_id) ?? asString(obj.id);
  const eventId = asString(obj.event_id) ?? messageId;
  const senderId = asString(obj.sender_id) ?? "unknown";
  const chatTypeRaw = asString(obj.chat_type);
  const content = asString(obj.content) ?? "";
  if (!chatId || !messageId || !eventId) return null;

  const chatType = chatTypeRaw === "group" ? "group" : "p2p";
  const createdAt = Number(asString(obj.create_time) ?? asString(obj.timestamp) ?? Date.now());

  return {
    kind: "message",
    eventId,
    chatType,
    chatId,
    senderId,
    text: content,
    messageId,
    mentionsBot: chatType === "p2p" ? true : detectBotMention(obj, content, identity),
    docLinks: extractDocLinks(content),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
  };
}

/**
 * Normalize a bot.added event. The consume output nests fields under `.event`;
 * we accept either the already-unwrapped object or the full envelope.
 */
export function normalizeBotAdded(obj: Record<string, unknown>): BotAddedEvent | null {
  const inner = (obj.event as Record<string, unknown> | undefined) ?? obj;
  const chatId = asString(inner.chat_id);
  if (!chatId) return null;
  const eventId =
    asString((obj.header as Record<string, unknown> | undefined)?.event_id) ??
    asString(obj.event_id) ??
    `bot_added-${chatId}-${Date.now()}`;
  return {
    kind: "bot_added",
    eventId,
    chatId,
    createdAt: Date.now(),
  };
}

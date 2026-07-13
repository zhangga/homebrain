/**
 * The Connector abstraction (plan §I, §IV). A connector is a bidirectional
 * bridge between a messaging surface (feishu, or the cli for debugging) and the
 * orchestrator. It normalizes inbound platform events into a single envelope
 * shape and exposes an outbound reply/notice API. The orchestrator depends only
 * on these types, never on lark-cli — so the whole feishu surface is swappable
 * (plan R6: lark-cli breaking changes are absorbed in the feishu connector).
 */

/** Where a message came from — drives the reply gateway (Q2). */
export type ChatType = "p2p" | "group";

/**
 * A normalized inbound message. Both the cli connector and the feishu connector
 * produce exactly this shape from their native events.
 */
export interface InboundMessage {
  kind: "message";
  /** platform-unique id for dedup (feishu event_id / cli counter) */
  eventId: string;
  chatType: ChatType;
  chatId: string;
  /** sender open_id (feishu) or a stable cli user id */
  senderId: string;
  /** pre-rendered human-readable text of the message */
  text: string;
  /** message_id, needed to reply in-thread */
  messageId: string;
  /** true when the bot was @-mentioned (group gating, Q2) */
  mentionsBot: boolean;
  /** doc links found in the message (docx tokens/urls), for doc sync (Q8) */
  docLinks?: string[];
  /** epoch ms */
  createdAt: number;
}

/** A normalized "bot was added to a group" event (Q4/Q6). */
export interface BotAddedEvent {
  kind: "bot_added";
  eventId: string;
  chatId: string;
  createdAt: number;
}

export type InboundEvent = InboundMessage | BotAddedEvent;

/** How the orchestrator asks a connector to send a reply. */
export interface OutboundReply {
  chatId: string;
  /** reply target message id (in-thread for groups when supported) */
  replyToMessageId?: string;
  /** markdown body */
  markdown: string;
  /** group replies may thread */
  inThread?: boolean;
}

/** The source message a user replied to when issuing a control command. */
export interface ReplyTarget {
  messageId: string;
  senderId?: string;
}

/**
 * The connector surface the orchestrator consumes. `start` streams normalized
 * events to `onEvent` until `stop` is called. `reply`/`notice` send outbound.
 */
export interface Connector {
  readonly name: string;
  start(onEvent: (event: InboundEvent) => void | Promise<void>): Promise<void>;
  stop(): Promise<void>;
  reply(out: OutboundReply): Promise<void>;
  /** send a standalone message to a chat (e.g. group-added notice) */
  notice(chatId: string, markdown: string): Promise<void>;
  /** add a platform-native reaction while a response is being prepared */
  addReaction?(messageId: string, emojiType: string): Promise<string | undefined>;
  /** remove a previously-added platform-native reaction */
  removeReaction?(messageId: string, reactionId: string): Promise<void>;
  /** resolve the original message targeted by a reply/thread command */
  resolveReplyTarget?(messageId: string): Promise<ReplyTarget | undefined>;
}

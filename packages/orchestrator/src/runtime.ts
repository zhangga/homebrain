/**
 * Orchestrator runtime (plan §III). The single consumer that turns normalized
 * connector events into knowledge operations and replies. Flow per message:
 *
 *   1. Dedup by eventId (feishu can redeliver).
 *   2. Attribution (Q4/Q5): pick write space + read spaces.
 *   3. Reply gateway (Q2): apply static rules, then use an LLM to decide
 *      whether an unmentioned open group question deserves a proactive answer.
 *   4. Always capture the content (remember) — even unaddressed group messages.
 *   5. If responding: classify intent with deterministic prefilters + LLM and dispatch:
 *        question  -> engine.ask over the read spaces, reply with formatting
 *        command   -> handle simple built-ins ("别记这条" / "重新提炼")
 *        remember  -> acknowledge capture
 *        chitchat  -> a light canned reply
 *
 * bot_added events (Q4/Q6) create the team space and send a one-time notice.
 *
 * Events are processed one-at-a-time via a Serializer keyed globally, so the
 * runtime behaves as a single consumer queue (plan §III) while the engine's own
 * per-space serialization still applies underneath.
 */
import type { SpaceId } from "@homeagent/shared";
import { Serializer, logger } from "@homeagent/shared";
import type { KnowledgeEngine, LlmClient } from "@homeagent/core";
import type {
  Connector,
  DownloadedAttachment,
  InboundEvent,
  InboundMessage,
} from "@homeagent/connectors";
import { extractAttachmentText } from "./attachment-extractor.ts";
import { attribute } from "./attribution.ts";
import { gate } from "./gateway.ts";
import { decideGroupParticipation } from "./group-participation.ts";
import { classifyIntent, type Intent } from "./intent.ts";
import { formatAnswer } from "./format.ts";
import { GROUP_ADDED_NOTICE, coldStartNote, providerNotice } from "./messages.ts";
import { parseTaskCommand, handleTaskCommand } from "./task-commands.ts";
import {
  handleLearningAnswer,
  handleLearningCommand,
  learningCommandNeedsSource,
  parseLearningAnswer,
  parseLearningCommand,
} from "./learning-commands.ts";
import {
  REMINDER_TIME_CLARIFICATION,
  formatReminderTime,
  handleReminderMessage,
  needsReminderInference,
  parseReminderRequest,
  scheduleReminderDraft,
  type ReminderDraft,
} from "./reminder-commands.ts";
import { inferReminderRequest } from "./reminder-inference.ts";

const log = logger.child("orchestrator");
const RETRACTION_COMMANDS = new Set(["别记这条", "撤回这条", "删掉这条", "不要记这条"]);
const REMINDER_CONFIRMATION_TTL_MS = 15 * 60_000;
const GROUP_PARTICIPATION_TIMEOUT_MS = 30_000;

interface PendingReminderConfirmation {
  draft: ReminderDraft;
  sourceMessageId: string;
  expiresAt: number;
}

function reminderControlText(text: string): string {
  return text
    .trim()
    .replace(/^(?:@\S+\s*)+/u, "")
    .replace(/[。.!！]+$/u, "")
    .trim();
}

function isRetractionCommand(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/^(?:@\S+\s+)+/u, "")
    .replace(/[。.!！]+$/u, "")
    .trim();
  return RETRACTION_COMMANDS.has(normalized);
}

export interface RuntimeOptions {
  engine: KnowledgeEngine;
  connector: Connector;
  llm?: LlmClient;
  /** max eventIds remembered for dedup */
  dedupSize?: number;
  /**
   * Optional doc fetcher (Q8). When a message carries docx/wiki links, the
   * runtime fetches each as markdown and remembers it as a doc-sourced entry.
   * The feishu connector supplies this; the cli connector does not.
   */
  docFetcher?: (urlOrToken: string) => Promise<string | null>;
  /** Optional direct-message attachment boundary; defaults to the connector capability. */
  attachmentDownloader?: (messageId: string) => Promise<DownloadedAttachment[]>;
  /** Optional local extraction boundary; defaults to the built-in extractor. */
  attachmentExtractor?: (attachment: DownloadedAttachment) => Promise<string | null>;
}

export class Orchestrator {
  private engine: KnowledgeEngine;
  private connector: Connector;
  private llm?: LlmClient;
  private serializer = new Serializer();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private pendingReminderConfirmations = new Map<string, PendingReminderConfirmation>();
  private dedupSize: number;
  private docFetcher?: (urlOrToken: string) => Promise<string | null>;
  private attachmentDownloader?: (messageId: string) => Promise<DownloadedAttachment[]>;
  private attachmentExtractor: (attachment: DownloadedAttachment) => Promise<string | null>;

  constructor(opts: RuntimeOptions) {
    this.engine = opts.engine;
    this.connector = opts.connector;
    this.llm = opts.llm;
    this.dedupSize = opts.dedupSize ?? 5000;
    this.docFetcher = opts.docFetcher;
    this.attachmentDownloader = opts.attachmentDownloader
      ?? this.connector.downloadAttachments?.bind(this.connector);
    this.attachmentExtractor = opts.attachmentExtractor ?? extractAttachmentText;
  }

  async start(): Promise<void> {
    await this.connector.start((event) => this.enqueue(event));
  }

  async stop(): Promise<void> {
    await this.connector.stop();
    await this.serializer.drain("main");
  }

  /** Process one event. Exposed for tests; connectors call it via start(). */
  enqueue(event: InboundEvent): Promise<void> {
    return this.serializer.run("main", () => this.handle(event));
  }

  private markSeen(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > this.dedupSize) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
    return true;
  }

  private pendingReminderKey(msg: InboundMessage, space: SpaceId): string {
    return `${space}\u0000${msg.chatId}\u0000${msg.senderId}`;
  }

  private prunePendingReminderConfirmations(now: number): void {
    for (const [key, pending] of this.pendingReminderConfirmations) {
      if (pending.expiresAt <= now) this.pendingReminderConfirmations.delete(key);
    }
  }

  private handlePendingReminderControl(
    msg: InboundMessage,
    space: SpaceId,
    now: number,
  ): string | null {
    const control = reminderControlText(msg.text);
    if (!["确认", "确认创建", "取消", "取消创建"].includes(control)) {
      this.prunePendingReminderConfirmations(now);
      return null;
    }
    const key = this.pendingReminderKey(msg, space);
    const pending = this.pendingReminderConfirmations.get(key);
    if (!pending) return null;
    this.pendingReminderConfirmations.delete(key);
    if (pending.expiresAt <= now) {
      return "这次提醒确认已过期，没有创建提醒。请重新发送完整的提醒请求。";
    }
    if (control === "取消" || control === "取消创建") {
      return `已取消创建提醒：${pending.draft.title}`;
    }
    if (pending.draft.triggerAt <= now) {
      return "候选提醒时间已经过去，没有创建提醒。请重新发送完整的提醒请求。";
    }
    return scheduleReminderDraft(
      this.engine,
      {
        chatId: msg.chatId,
        senderId: msg.senderId,
        messageId: pending.sourceMessageId,
      },
      space,
      pending.draft,
      now,
    );
  }

  private async handle(event: InboundEvent): Promise<void> {
    if (!this.markSeen(event.eventId)) {
      log.debug("dropping duplicate event", { eventId: event.eventId });
      return;
    }
    if (event.kind === "bot_added") return this.handleBotAdded(event.chatId);
    return this.handleMessage(event);
  }

  private async handleBotAdded(chatId: string): Promise<void> {
    const space: SpaceId = `team/${chatId}`;
    this.engine.ensureSpace(space, { chatId });
    log.info("bot added to group; created team space", { space });
    await this.connector.notice(chatId, GROUP_ADDED_NOTICE);
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    const { writeSpace, readSpaces } = attribute(msg);
    const meta = this.engine.registry.get(writeSpace);

    // Task control commands (/task ...) are handled BEFORE capture/gate: they're
    // instructions, not knowledge, so they're never stored, and they always get
    // a reply (even in a group without an @-mention).
    const taskCmd = parseTaskCommand(msg.text);
    if (taskCmd) {
      return this.withThinking(msg, async () => {
        this.engine.ensureSpace(writeSpace, { chatId: msg.chatId });
        const reply = await handleTaskCommand(this.engine, writeSpace, taskCmd);
        await this.send(msg, reply);
      });
    }

    // Guided-learning controls are explicit instructions too. They bypass the
    // capture and group-mention gates, just like task controls. Creating a plan
    // binds to the original message the command replies to.
    const learningCmd = parseLearningCommand(msg.text);
    if (learningCmd) {
      return this.withThinking(msg, async () => {
        this.engine.ensureSpace(writeSpace, { chatId: msg.chatId });
        let sourceMessageId: string | undefined;
        if (learningCommandNeedsSource(learningCmd)) {
          try {
            sourceMessageId = (await this.connector.resolveReplyTarget?.(msg.messageId))?.messageId;
          } catch (err) {
            log.warn("learning source resolution failed", {
              messageId: msg.messageId,
              err: String(err),
            });
          }
        }
        const reply = await handleLearningCommand(this.engine, learningCmd, {
          space: writeSpace,
          chatId: msg.chatId,
          actorId: msg.senderId,
          sourceMessageId,
        });
        await this.send(msg, reply);
      });
    }

    // A staged model interpretation is scoped to this chat and sender. Explicit
    // confirmation/cancellation is a control message, so it bypasses group @ gating
    // and is never captured as knowledge.
    const pendingReminderReply = this.handlePendingReminderControl(msg, writeSpace, Date.now());
    if (pendingReminderReply) {
      return this.withThinking(msg, () => this.send(msg, pendingReminderReply));
    }

    let decision = gate(msg, { mentionsOnly: meta?.mentionsOnly });
    let proactiveQuestion = false;

    // Retraction is a deterministic control command. Handle it before capture
    // so the command itself never becomes knowledge.
    const retractionCommand = isRetractionCommand(msg.text);
    if (retractionCommand && msg.chatType === "group" && !msg.mentionsBot) {
      if (!decision.respond) return;
      return this.withThinking(msg, () => this.send(msg, "群聊中请回复原消息，并 @我 说「别记这条」。"));
    }
    if (decision.respond && retractionCommand) {
      return this.withThinking(msg, () => this.handleRetraction(msg, writeSpace));
    }

    let inputsCaptured = false;
    const captureInputs = async (): Promise<void> => {
      if (inputsCaptured) return;
      inputsCaptured = true;

      // Always capture (收录 != 应答).
      if (decision.capture && msg.text.trim() !== "") {
        await this.engine.remember({
          space: writeSpace,
          source: "message",
          author: msg.senderId,
          chatId: msg.chatId,
          messageId: msg.messageId,
          content: msg.text,
        });
      }

      if (
        decision.capture
        && msg.messageType
        && ["image", "file", "audio", "media"].includes(msg.messageType)
        && this.attachmentDownloader
      ) {
        await this.syncAttachments(msg, writeSpace);
      }

      // Doc sync (Q8): pull any docx/wiki links referenced in the message.
      if (this.docFetcher && msg.docLinks && msg.docLinks.length > 0) {
        await this.syncDocs(msg, writeSpace);
      }
    };

    if (!decision.respond && msg.chatType === "group" && !msg.mentionsBot) {
      // Persist first: a slow classifier must not put the message's durable
      // capture behind an external model call.
      await captureInputs();
      const participation = await decideGroupParticipation(
        () => this.llm ?? this.engine.llmClientForSpace(
          writeSpace,
          GROUP_PARTICIPATION_TIMEOUT_MS,
        ),
        msg.text,
      );
      if (participation.respond) {
        proactiveQuestion = true;
        decision = {
          ...decision,
          respond: true,
          reason: `proactive group answer (${participation.source}): ${participation.reason}`,
        };
      }
    }

    // Answers use an explicit prefix so an ordinary conversation cannot
    // accidentally advance a lesson. Like other controls, an answer is not
    // captured itself; the engine persists the structured learning record.
    const learningAnswer = decision.respond ? parseLearningAnswer(msg.text) : null;
    if (learningAnswer) {
      return this.withThinking(msg, async () => {
        this.engine.ensureSpace(writeSpace, { chatId: msg.chatId });
        try {
          const reply = await handleLearningAnswer(this.engine, learningAnswer, {
            space: writeSpace,
            chatId: msg.chatId,
            actorId: msg.senderId,
          });
          await this.send(msg, reply);
        } catch (err) {
          log.warn("learning feedback provider unavailable", {
            space: writeSpace,
            err: String(err),
          });
          await this.send(msg, providerNotice(err));
        }
      });
    }

    if (decision.respond) {
      const reminderNow = Date.now();
      const directDraft = parseReminderRequest(msg.text, reminderNow);
      const reminderReply = handleReminderMessage(this.engine, msg, writeSpace, reminderNow);
      if (reminderReply) {
        if (directDraft) {
          this.pendingReminderConfirmations.delete(this.pendingReminderKey(msg, writeSpace));
        }
        return this.withThinking(msg, () => this.send(msg, reminderReply));
      }
      if (needsReminderInference(msg.text)) {
        const pendingKey = this.pendingReminderKey(msg, writeSpace);
        // A new request always supersedes an older candidate, even if the new
        // model interpretation fails or remains unresolved.
        this.pendingReminderConfirmations.delete(pendingKey);
        return this.withThinking(msg, async () => {
          let draft: ReminderDraft | undefined;
          try {
            draft = await inferReminderRequest(
              this.llm ?? this.engine.llmClientForSpace(writeSpace),
              msg.text,
              reminderNow,
            );
          } catch (err) {
            log.warn("reminder inference provider unavailable", {
              space: writeSpace,
              err: String(err),
            });
            await this.send(msg, providerNotice(err));
            return;
          }
          if (!draft) {
            await this.send(msg, REMINDER_TIME_CLARIFICATION);
            return;
          }
          this.pendingReminderConfirmations.set(pendingKey, {
            draft,
            sourceMessageId: msg.messageId,
            expiresAt: Date.now() + REMINDER_CONFIRMATION_TTL_MS,
          });
          await this.send(msg, [
            "请确认以下理解：",
            `提醒内容：${draft.title}`,
            `提醒时间：${formatReminderTime(draft.triggerAt)}`,
            "请在 15 分钟内回复「确认」后创建，回复「取消」放弃。",
          ].join("\n"));
        });
      }
    }

    if (!decision.respond) {
      await captureInputs();
      log.debug("captured without responding", { space: writeSpace, reason: decision.reason });
      return;
    }

    return this.withThinking(msg, async () => {
      await captureInputs();
      let intent: Intent;
      if (proactiveQuestion) {
        intent = "question";
      } else {
        try {
          ({ intent } = await classifyIntent(
            () => this.llm ?? this.engine.llmClientForSpace(writeSpace),
            msg.text,
          ));
        } catch (err) {
          log.warn("intent provider unavailable; prompting to configure", {
            space: writeSpace,
            err: String(err),
          });
          await this.send(msg, providerNotice(err));
          return;
        }
      }
      log.debug("classified intent", { intent, chatType: msg.chatType });

      switch (intent) {
        case "question":
          return this.answer(msg, readSpaces, writeSpace);
        case "command":
          return this.runCommand(msg, writeSpace);
        case "remember":
          return this.send(msg, "好的，我记下了。");
        case "chitchat":
        default:
          return this.send(msg, "👋 我在。有需要随时问我，或把要记住的事告诉我。");
      }
    });
  }

  private async answer(msg: InboundMessage, readSpaces: SpaceId[], writeSpace: SpaceId): Promise<void> {
    // The engine picks the LLM client for the write space (its agent's CLI, or
    // the global default CLI). We still pass model/instruction as ask options so
    // the persona reaches synthesis; provider routing is the engine's job.
    const agent = this.engine.agentForSpace(writeSpace);
    let res;
    try {
      res = await this.engine.ask(readSpaces, msg.text, {
        model: agent?.model || undefined,
        instruction: agent?.instruction || undefined,
      });
    } catch (err) {
      // No runnable provider (unset agent + no usable default CLI), or the CLI
      // failed to answer. Tell the user to configure, rather than fail silently.
      log.warn("ask failed; prompting to configure a provider", { space: writeSpace, err: String(err) });
      await this.send(msg, providerNotice(err));
      return;
    }
    // Cold-start honesty (Q3): if general and the KB is essentially empty, add a
    // gentle nudge to feed knowledge.
    let text = formatAnswer(res);
    if (res.source === "general" && (await this.isColdStart(readSpaces))) {
      text = `${text}\n\n${coldStartNote()}`;
    }
    await this.send(msg, text);
  }

  private async isColdStart(spaces: SpaceId[]): Promise<boolean> {
    for (const s of spaces) {
      const pages = await this.engine.listPages(s);
      if (pages.some((p) => !["index", "overview", "log", "glossary"].includes(p.slug))) {
        return false;
      }
    }
    return true;
  }

  private async runCommand(msg: InboundMessage, writeSpace: SpaceId): Promise<void> {
    const t = msg.text;
    if (/重新提炼|重新整理|整理知识|dream/i.test(t)) {
      await this.send(msg, "开始重新提炼本空间知识，稍后完成。");
      void this.engine.runDreamCycle(writeSpace).catch((err) => log.error("manual dream failed", { err: String(err) }));
      return;
    }
    await this.send(msg, "收到指令。目前支持：『别记这条』撤回、『重新提炼』触发整理。");
  }

  private async handleRetraction(msg: InboundMessage, writeSpace: SpaceId): Promise<void> {
    let target;
    try {
      target = await this.connector.resolveReplyTarget?.(msg.messageId);
    } catch (err) {
      log.warn("reply target resolution failed", { messageId: msg.messageId, err: String(err) });
    }
    if (!target) {
      await this.send(msg, "请回复要撤回的那条原消息，并 @我 说「别记这条」。");
      return;
    }

    const retractionRequest = {
      chatId: msg.chatId,
      messageId: target.messageId,
      requestedBy: msg.senderId,
    };
    let result = await this.engine.retractMessage(writeSpace, retractionRequest);
    if (result.status === "forbidden" && msg.chatType === "group") {
      const requesterIsAdmin = await this.connector.isChatAdministrator?.(
        msg.chatId,
        msg.senderId,
      );
      if (requesterIsAdmin) {
        result = await this.engine.retractMessage(writeSpace, {
          ...retractionRequest,
          requesterIsAdmin: true,
        });
      }
    }
    if (result.status === "forbidden") {
      await this.send(msg, "这条消息不是你发送的；只有原作者、群主或群管理员可以撤回。");
      return;
    }
    if (result.status === "not_found") {
      await this.send(msg, "没有找到这条消息的收录记录；它可能尚未收录或已经撤回。");
      return;
    }
    if (result.status === "already_retracted") {
      await this.send(msg, "这条消息已经撤回过了，没有重复保留。");
      return;
    }

    const pageNote =
      result.affectedPages.length > 0
        ? `，并清理了 ${result.affectedPages.length} 个受影响的知识页`
        : "，原始记录已删除";
    let rebuildNote = "";
    if (result.requeuedSourceIds.length > 0) {
      try {
        const report = await this.engine.runDreamCycle(writeSpace, {
          rawIds: result.requeuedSourceIds,
        });
        const processedSourceIds = new Set(report.processedRawIds);
        const rebuiltAllSources = result.requeuedSourceIds.every((sourceId) =>
          processedSourceIds.has(sourceId),
        );
        rebuildNote =
          report.errors.length === 0 && rebuiltAllSources
            ? "；其余有效来源已重新提炼"
            : "；其余来源的自动重建未完全成功，请稍后重新提炼";
      } catch (err) {
        rebuildNote = "；其余来源的自动重建暂未完成，请稍后重新提炼";
        log.warn("post-retraction redistillation failed", {
          space: writeSpace,
          err: String(err),
        });
      }
    }
    await this.send(msg, `已撤回这条消息${pageNote}${rebuildNote}。`);
  }

  private async syncDocs(msg: InboundMessage, writeSpace: SpaceId): Promise<void> {
    for (const link of msg.docLinks ?? []) {
      try {
        const md = await this.docFetcher!(link);
        if (!md || md.trim() === "") continue;
        await this.engine.remember({
          space: writeSpace,
          source: "doc",
          author: msg.senderId,
          chatId: msg.chatId,
          messageId: msg.messageId,
          content: `# 来源文档：${link}\n\n${md}`,
        });
        log.info("synced doc into space", { space: writeSpace, link });
      } catch (err) {
        log.warn("doc sync failed", { link, err: String(err) });
      }
    }
  }

  private async syncAttachments(msg: InboundMessage, writeSpace: SpaceId): Promise<void> {
    let downloads: DownloadedAttachment[];
    try {
      downloads = await this.attachmentDownloader!(msg.messageId);
    } catch (err) {
      log.warn("attachment download failed", { messageId: msg.messageId, err: String(err) });
      return;
    }

    for (const download of downloads) {
      try {
        const extracted = await this.attachmentExtractor(download);
        if (!extracted?.trim()) continue;
        const name = download.attachment.name ?? download.attachment.ref;
        await this.engine.remember({
          space: writeSpace,
          source: "message",
          author: msg.senderId,
          chatId: msg.chatId,
          messageId: msg.messageId,
          content: `# 附件：${name}\n\n${extracted.trim()}`,
          attachments: [download.attachment],
          createdAt: msg.createdAt,
        });
      } catch (err) {
        log.warn("attachment extraction failed", { messageId: msg.messageId, err: String(err) });
      } finally {
        try {
          download.cleanup();
        } catch (cleanupErr) {
          log.warn("attachment cleanup failed", {
            messageId: msg.messageId,
            err: String(cleanupErr),
          });
        }
      }
    }
  }

  private async withThinking<T>(msg: InboundMessage, work: () => Promise<T>): Promise<T> {
    let reactionId: string | undefined;
    try {
      reactionId = await this.connector.addReaction?.(msg.messageId, "THINKING");
    } catch (err) {
      // Optional UX must not interfere with the actual answer path, including
      // connectors implemented outside this repository.
      log.warn("thinking reaction failed", { messageId: msg.messageId, err: String(err) });
    }

    try {
      return await work();
    } finally {
      if (reactionId) {
        try {
          await this.connector.removeReaction?.(msg.messageId, reactionId);
        } catch (err) {
          log.warn("thinking reaction cleanup failed", {
            messageId: msg.messageId,
            reactionId,
            err: String(err),
          });
        }
      }
    }
  }

  private async send(msg: InboundMessage, markdown: string): Promise<void> {
    // "Topic reply" (mew): per-space replyInThread override; defaults to
    // threading in groups and not in p2p.
    const meta = this.engine.registry.get(attribute(msg).writeSpace);
    const inThread = meta?.replyInThread ?? msg.chatType === "group";
    await this.connector.reply({
      chatId: msg.chatId,
      replyToMessageId: msg.messageId,
      markdown,
      inThread,
    });
  }
}

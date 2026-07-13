/**
 * Orchestrator runtime (plan §III). The single consumer that turns normalized
 * connector events into knowledge operations and replies. Flow per message:
 *
 *   1. Dedup by eventId (feishu can redeliver).
 *   2. Reply gateway (Q2): decide respond vs. capture-only.
 *   3. Attribution (Q4/Q5): pick write space + read spaces.
 *   4. Always capture the content (remember) — even unaddressed group messages.
 *   5. If responding: classify intent (LLM, not regex) and dispatch:
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
import type { SpaceId } from "@homebrain/shared";
import { Serializer, logger } from "@homebrain/shared";
import { gatewayClient, type KnowledgeEngine, type LlmClient } from "@homebrain/core";
import type { Connector, InboundEvent, InboundMessage } from "@homebrain/connectors";
import { attribute } from "./attribution.ts";
import { gate } from "./gateway.ts";
import { classifyIntent } from "./intent.ts";
import { formatAnswer } from "./format.ts";
import { GROUP_ADDED_NOTICE, NO_PROVIDER_NOTICE, coldStartNote } from "./messages.ts";
import { parseTaskCommand, handleTaskCommand } from "./task-commands.ts";

const log = logger.child("orchestrator");
const RETRACTION_RE = /别记|撤回|删掉这条|不要记/;

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
}

export class Orchestrator {
  private engine: KnowledgeEngine;
  private connector: Connector;
  private llm: LlmClient;
  private serializer = new Serializer();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private dedupSize: number;
  private docFetcher?: (urlOrToken: string) => Promise<string | null>;

  constructor(opts: RuntimeOptions) {
    this.engine = opts.engine;
    this.connector = opts.connector;
    this.llm = opts.llm ?? gatewayClient;
    this.dedupSize = opts.dedupSize ?? 5000;
    this.docFetcher = opts.docFetcher;
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

    const decision = gate(msg, { mentionsOnly: meta?.mentionsOnly });

    // Retraction is a deterministic control command. Handle it before capture
    // so the command itself never becomes knowledge.
    if (decision.respond && RETRACTION_RE.test(msg.text)) {
      return this.withThinking(msg, () => this.handleRetraction(msg, writeSpace));
    }

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

    // Doc sync (Q8): pull any docx/wiki links referenced in the message.
    if (this.docFetcher && msg.docLinks && msg.docLinks.length > 0) {
      await this.syncDocs(msg, writeSpace);
    }

    if (!decision.respond) {
      log.debug("captured without responding", { space: writeSpace, reason: decision.reason });
      return;
    }

    return this.withThinking(msg, async () => {
      const { intent } = await classifyIntent(this.llm, msg.text);
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
      await this.send(msg, NO_PROVIDER_NOTICE);
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

    const result = await this.engine.retractMessage(writeSpace, {
      chatId: msg.chatId,
      messageId: target.messageId,
      requestedBy: msg.senderId,
    });
    if (result.status === "forbidden") {
      await this.send(msg, "这条消息不是你发送的；目前只能撤回自己发送的消息。");
      return;
    }
    if (result.status === "not_found") {
      await this.send(msg, "没有找到这条消息的收录记录；它可能尚未收录或已经撤回。");
      return;
    }

    const pageNote =
      result.affectedPages.length > 0
        ? `，并清理了 ${result.affectedPages.length} 个受影响的知识页`
        : "，原始记录已删除";
    const rebuildNote = result.requeuedSources > 0 ? "；其余有效来源会重新提炼" : "";
    await this.send(msg, `已撤回这条消息${pageNote}${rebuildNote}。`);

    if (result.requeuedSources > 0) {
      void this.engine
        .runDreamCycle(writeSpace)
        .catch((err) => log.warn("post-retraction redistillation failed", { space: writeSpace, err: String(err) }));
    }
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

/**
 * Feishu connector (plan §IV, Slice 5). All lark-cli usage is confined to this
 * file (plan R6). It:
 *   - spawns `event consume im.message.receive_v1 --as bot` and
 *     `event consume im.chat.member.bot.added_v1 --as bot`, each as a long-lived
 *     subprocess;
 *   - blocks on stderr until the `[event] ready` marker before trusting stdout
 *     (lark-event subprocess contract);
 *   - parses NDJSON stdout, normalizes to InboundEvents, forwards to the handler;
 *   - restarts a crashed consumer with exponential backoff (plan R4);
 *   - stops with SIGTERM only (never kill -9, which leaks subscriptions);
 *   - sends replies/notices via `im +messages-reply --as bot`;
 *   - adds/removes native message reactions via `im reactions`;
 *   - fetches docx links via `docs +fetch --as user` for doc sync (Q8).
 */
import { config, logger } from "@homebrain/shared";
import type {
  Connector,
  ConnectorHealth,
  InboundEvent,
  OutboundReply,
  ReplyTarget,
} from "./connector.ts";
import {
  normalizeBotAdded,
  normalizeMessage,
  type FeishuIdentity,
} from "./feishu-normalize.ts";
import { bunSpawner, lines, type ProcHandle, type ProcSpawner } from "./process.ts";

const log = logger.child("feishu");

const MESSAGE_KEY = "im.message.receive_v1";
const BOT_ADDED_KEY = "im.chat.member.bot.added_v1";
const READY_RE = /\[event\]\s+ready\b/;

export interface FeishuConnectorOptions {
  larkBin?: string;
  identity?: FeishuIdentity;
  /** injected for tests; defaults to Bun.spawn */
  spawner?: ProcSpawner;
  /** base backoff ms for restart (doubles up to a cap) */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /**
   * Give up on a consumer that never reaches the ready marker after this many
   * consecutive attempts (a permanent config/scope error, e.g. an event that is
   * not enabled in the developer console). Healthy-then-crashed consumers are
   * always restarted regardless. Default 5.
   */
  maxNeverReady?: number;
  /** run a command and return its stdout (injected for tests) */
  runCommand?: (cmd: string[]) => Promise<string>;
}

interface Consumer {
  key: string;
  proc?: ProcHandle;
  stopped: boolean;
  attempts: number;
  /** consecutive failures to ever reach the ready marker */
  neverReady: number;
  state: "starting" | "ready" | "backoff" | "failed" | "stopped";
  lastReadyAt?: number;
  lastEventAt?: number;
  lastError?: string;
}

interface FetchedMessage {
  message_id?: string;
  parent_id?: string;
  root_id?: string;
  sender?: { id?: string };
}

export class FeishuConnector implements Connector {
  readonly name = "feishu";
  private larkBin: string;
  private identity: FeishuIdentity;
  private spawner: ProcSpawner;
  private backoffBaseMs: number;
  private backoffMaxMs: number;
  private maxNeverReady: number;
  private runCommand: (cmd: string[]) => Promise<string>;
  private handler?: (event: InboundEvent) => void | Promise<void>;
  private consumers: Consumer[] = [];
  private stopping = false;

  constructor(opts: FeishuConnectorOptions = {}) {
    this.larkBin = opts.larkBin ?? "lark-cli";
    this.identity = opts.identity ?? {
      // Bot identity is snapshotted at startup from config() (settings.json +
      // env). Editing it in the management backend takes effect on next restart.
      botName: config().feishuBotName,
      botOpenId: config().feishuBotOpenId,
    };
    this.spawner = opts.spawner ?? bunSpawner;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 60_000;
    this.maxNeverReady = opts.maxNeverReady ?? 5;
    this.runCommand = opts.runCommand ?? defaultRunCommand;
  }

  async start(onEvent: (event: InboundEvent) => void | Promise<void>): Promise<void> {
    this.handler = onEvent;
    this.stopping = false;
    this.consumers = [
      { key: MESSAGE_KEY, stopped: false, attempts: 0, neverReady: 0, state: "starting" },
      { key: BOT_ADDED_KEY, stopped: false, attempts: 0, neverReady: 0, state: "starting" },
    ];
    // Launch each consumer loop; do not await (they run for the connector's life).
    for (const c of this.consumers) void this.runConsumer(c);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const c of this.consumers) {
      c.stopped = true;
      c.state = "stopped";
      c.proc?.kill(); // SIGTERM
    }
  }

  health(): ConnectorHealth {
    const consumers = this.consumers.map((consumer) => ({
      key: consumer.key,
      state: consumer.state,
      attempts: consumer.attempts,
      lastReadyAt: consumer.lastReadyAt,
      lastEventAt: consumer.lastEventAt,
      lastError: consumer.lastError,
    }));
    const eventTimes = consumers
      .map((consumer) => consumer.lastEventAt)
      .filter((at): at is number => at !== undefined);
    return {
      name: this.name,
      ready: consumers.length > 0 && consumers.every((consumer) => consumer.state === "ready"),
      lastEventAt: eventTimes.length > 0 ? Math.max(...eventTimes) : undefined,
      consumers,
    };
  }

  // ---- inbound: consumer loop with ready-gating + backoff -----------------

  private async runConsumer(c: Consumer): Promise<void> {
    while (!c.stopped && !this.stopping) {
      c.state = "starting";
      const cmd = [this.larkBin, "event", "consume", c.key, "--as", "bot"];
      log.info("starting consumer", { key: c.key });
      let proc: ProcHandle;
      try {
        proc = this.spawner.spawn(cmd);
      } catch (err) {
        c.neverReady += 1;
        c.lastError = String(err).slice(-300);
        log.warn("consumer process failed to spawn", {
          key: c.key,
          neverReady: c.neverReady,
          err: c.lastError,
        });
        if (c.neverReady >= this.maxNeverReady) {
          c.state = "failed";
          log.error("giving up on consumer (process could not spawn)", { key: c.key });
          break;
        }
        await this.backoff(c);
        continue;
      }
      c.proc = proc;

      const { ready, stderrTail } = await this.awaitReady(proc, c.key);
      if (ready) {
        c.attempts = 0; // healthy start resets backoff
        c.neverReady = 0;
        c.state = "ready";
        c.lastReadyAt = Date.now();
        c.lastError = undefined;
        await this.pumpStdout(proc, c);
      } else {
        // Process ended before ready — a startup failure. Track separately from
        // post-ready crashes so a permanently-misconfigured event key (e.g. not
        // enabled in the console) stops retrying instead of looping forever.
        c.neverReady += 1;
        c.lastError = stderrTail.slice(-300) || "consumer exited before ready";
        log.warn("consumer exited before ready", {
          key: c.key,
          neverReady: c.neverReady,
          detail: stderrTail.slice(-300),
        });
        if (c.neverReady >= this.maxNeverReady) {
          c.state = "failed";
          log.error("giving up on consumer (never reached ready)", {
            key: c.key,
            hint: "check that the event is enabled in the developer console and the bot has the required scope",
          });
          break;
        }
      }

      if (c.stopped || this.stopping) break;
      // crashed / exited: exponential backoff before restart (plan R4)
      await this.backoff(c);
    }
    if (c.stopped || this.stopping) c.state = "stopped";
    log.info("consumer loop ended", { key: c.key });
  }

  private async backoff(c: Consumer): Promise<void> {
    c.attempts += 1;
    c.state = "backoff";
    const backoff = Math.min(this.backoffBaseMs * 2 ** (c.attempts - 1), this.backoffMaxMs);
    const jitter = Math.random() * Math.min(500, backoff);
    log.warn("consumer down; backing off", {
      key: c.key,
      attempts: c.attempts,
      backoffMs: Math.round(backoff + jitter),
    });
    await Bun.sleep(backoff + jitter);
  }

  /**
   * Block on stderr until the ready marker, or resolve not-ready if the process
   * exits first. Captures a tail of stderr for diagnostics.
   */
  private async awaitReady(
    proc: ProcHandle,
    key: string,
  ): Promise<{ ready: boolean; stderrTail: string }> {
    let ready = false;
    let stderrTail = "";
    const exitRace = proc.exited.then(() => "exited" as const);
    const readScan = (async () => {
      for await (const line of lines(proc.stderr)) {
        const trimmed = line.trim();
        if (trimmed) {
          stderrTail = (stderrTail + "\n" + trimmed).slice(-1000);
          log.debug("consumer stderr", { key, line: trimmed });
        }
        if (READY_RE.test(line)) {
          ready = true;
          return "ready" as const;
        }
      }
      return "eof" as const;
    })();
    const winner = await Promise.race([exitRace, readScan]);
    return { ready: ready || winner === "ready", stderrTail };
  }

  /** Read NDJSON from stdout, normalize, forward. Returns when stdout ends. */
  private async pumpStdout(proc: ProcHandle, c: Consumer): Promise<void> {
    try {
      for await (const line of lines(proc.stdout)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          log.debug("non-json stdout line ignored", { key: c.key });
          continue;
        }
        const event =
          c.key === MESSAGE_KEY
            ? normalizeMessage(obj, this.identity)
            : normalizeBotAdded(obj);
        if (!event) continue;
        c.lastEventAt = Date.now();
        try {
          await this.handler?.(event);
        } catch (err) {
          log.error("event handler threw", { key: c.key, err: String(err) });
        }
      }
    } catch (err) {
      c.lastError = String(err);
      log.warn("stdout pump error", { key: c.key, err: String(err) });
    }
    await proc.exited.catch(() => 0);
  }

  // ---- outbound -----------------------------------------------------------

  async reply(out: OutboundReply): Promise<void> {
    const cmd = [
      this.larkBin,
      "im",
      "+messages-reply",
      "--as",
      "bot",
      "--markdown",
      out.markdown,
    ];
    if (out.replyToMessageId) cmd.push("--message-id", out.replyToMessageId);
    if (out.inThread) cmd.push("--reply-in-thread");
    try {
      await this.runCommand(cmd);
    } catch (err) {
      log.error("reply failed", { err: String(err) });
    }
  }

  async notice(chatId: string, markdown: string): Promise<void> {
    // A notice is a standalone message to a chat (not a reply). Uses the
    // +messages-send shortcut with --chat-id.
    const cmd = [
      this.larkBin,
      "im",
      "+messages-send",
      "--as",
      "bot",
      "--chat-id",
      chatId,
      "--markdown",
      markdown,
    ];
    try {
      await this.runCommand(cmd);
    } catch (err) {
      log.error("notice failed", { err: String(err) });
    }
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    const cmd = [
      this.larkBin,
      "im",
      "reactions",
      "create",
      "--as",
      "bot",
      "--message-id",
      messageId,
      "--data",
      JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      "--json",
    ];
    try {
      const out = await this.runCommand(cmd);
      const parsed = JSON.parse(out) as Record<string, unknown>;
      const data = parsed.data as Record<string, unknown> | undefined;
      return typeof data?.reaction_id === "string" ? data.reaction_id : undefined;
    } catch (err) {
      // Reactions are only a progress hint; failure must never block the reply.
      log.warn("add reaction failed", { messageId, emojiType, err: String(err) });
      return undefined;
    }
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    const cmd = [
      this.larkBin,
      "im",
      "reactions",
      "delete",
      "--as",
      "bot",
      "--message-id",
      messageId,
      "--reaction-id",
      reactionId,
      "--json",
    ];
    try {
      await this.runCommand(cmd);
    } catch (err) {
      log.warn("remove reaction failed", { messageId, reactionId, err: String(err) });
    }
  }

  async resolveReplyTarget(messageId: string): Promise<ReplyTarget | undefined> {
    try {
      const current = await this.fetchMessage(messageId);
      const targetId = current?.parent_id ?? current?.root_id;
      if (!targetId || targetId === messageId) return undefined;
      const target = await this.fetchMessage(targetId);
      return {
        messageId: targetId,
        senderId: target?.sender?.id,
      };
    } catch (err) {
      log.warn("resolve reply target failed", { messageId, err: String(err) });
      return undefined;
    }
  }

  private async fetchMessage(messageId: string): Promise<FetchedMessage | undefined> {
    // The higher-level +messages-mget shortcut intentionally formats message
    // output and currently drops parent_id/root_id. Use the raw read endpoint
    // so reply relationships survive intact.
    const out = await this.runCommand([
      this.larkBin,
      "api",
      "GET",
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      "--as",
      "bot",
      "--params",
      JSON.stringify({ user_id_type: "open_id" }),
      "--json",
    ]);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const data = parsed.data as Record<string, unknown> | undefined;
    const items = data?.items;
    return Array.isArray(items) ? (items[0] as FetchedMessage | undefined) : undefined;
  }

  async isChatAdministrator(chatId: string, userId: string): Promise<boolean> {
    try {
      const out = await this.runCommand([
        this.larkBin,
        "im",
        "chats",
        "get",
        "--as",
        "bot",
        "--chat-id",
        chatId,
        "--user-id-type",
        "open_id",
        "--json",
      ]);
      const parsed = JSON.parse(out) as Record<string, unknown>;
      const data = parsed.data as Record<string, unknown> | undefined;
      const managers = Array.isArray(data?.user_manager_id_list)
        ? data.user_manager_id_list.map(String)
        : [];
      return data?.owner_id === userId || managers.includes(userId);
    } catch (err) {
      log.warn("chat administrator lookup failed", { chatId, userId, err: String(err) });
      return false;
    }
  }

  // ---- doc sync (Q8) ------------------------------------------------------

  /** Fetch a docx/wiki link as markdown (user identity). Returns null on error. */
  async fetchDoc(docUrlOrToken: string): Promise<string | null> {
    const cmd = [
      this.larkBin,
      "docs",
      "+fetch",
      "--doc",
      docUrlOrToken,
      "--doc-format",
      "markdown",
      "--as",
      "user",
      "--json",
    ];
    try {
      const out = await this.runCommand(cmd);
      // The CLI returns JSON; the markdown is under a content-ish field. Be
      // permissive about the exact key so a CLI shape tweak degrades gracefully.
      const parsed = JSON.parse(out) as Record<string, unknown>;
      const content =
        (parsed.markdown as string | undefined) ??
        (parsed.content as string | undefined) ??
        ((parsed.data as Record<string, unknown> | undefined)?.content as string | undefined);
      return content ?? null;
    } catch (err) {
      log.warn("doc fetch failed", { doc: docUrlOrToken, err: String(err) });
      return null;
    }
  }
}

/** Run a command to completion and return trimmed stdout; throws on non-zero. */
async function defaultRunCommand(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`command failed (${code}): ${stderr.slice(0, 500)}`);
  return stdout;
}

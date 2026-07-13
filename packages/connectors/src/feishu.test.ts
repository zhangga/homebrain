import { afterEach, describe, expect, test } from "bun:test";
import type { InboundEvent } from "./connector.ts";
import type { ProcHandle, ProcSpawner } from "./process.ts";
import { FeishuConnector } from "./feishu.ts";

/** A controllable fake process: push stdout/stderr lines, resolve exit at will. */
class FakeProc implements ProcHandle {
  private outCtl!: ReadableStreamDefaultController<Uint8Array>;
  private errCtl!: ReadableStreamDefaultController<Uint8Array>;
  private exitResolve!: (code: number) => void;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  killed = false;
  private enc = new TextEncoder();

  constructor() {
    this.stdout = streamFrom((c) => (this.outCtl = c));
    this.stderr = streamFrom((c) => (this.errCtl = c));
    this.exited = new Promise((res) => (this.exitResolve = res));
  }
  emitStdout(line: string): void {
    this.outCtl.enqueue(this.enc.encode(line + "\n"));
  }
  emitStderr(line: string): void {
    this.errCtl.enqueue(this.enc.encode(line + "\n"));
  }
  finish(code = 0): void {
    try {
      this.outCtl.close();
    } catch {}
    try {
      this.errCtl.close();
    } catch {}
    this.exitResolve(code);
  }
  kill(): void {
    this.killed = true;
    this.finish(0);
  }
}

function streamFrom(
  grab: (c: ReadableStreamDefaultController<Uint8Array>) => void,
): AsyncIterable<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      grab(controller);
    },
  });
  // ReadableStream is async-iterable in Bun.
  return stream as unknown as AsyncIterable<Uint8Array>;
}

class FakeSpawner implements ProcSpawner {
  procs: { cmd: string[]; proc: FakeProc }[] = [];
  private waiters: ((p: FakeProc) => void)[] = [];
  spawn(cmd: string[]): ProcHandle {
    const proc = new FakeProc();
    this.procs.push({ cmd, proc });
    const w = this.waiters.shift();
    if (w) w(proc);
    return proc;
  }
  /** wait until the Nth process (1-based) for a key substring is spawned */
  async waitForProc(keySubstring: string, index = 1): Promise<FakeProc> {
    for (let i = 0; i < 200; i++) {
      const matches = this.procs.filter((p) => p.cmd.some((a) => a.includes(keySubstring)));
      if (matches.length >= index) return matches[index - 1]!.proc;
      await Bun.sleep(5);
    }
    throw new Error(`process for ${keySubstring} #${index} never spawned`);
  }
}

let connector: FeishuConnector;

afterEach(async () => {
  await connector?.stop();
});

describe("FeishuConnector daemon (fake spawn)", () => {
  test("does not process stdout until the ready marker appears", async () => {
    const spawner = new FakeSpawner();
    const events: InboundEvent[] = [];
    connector = new FeishuConnector({ spawner, runCommand: async () => "{}" });
    await connector.start((e) => {
      events.push(e);
    });

    const proc = await spawner.waitForProc("im.message.receive_v1");
    // Emit a well-formed event on stdout BEFORE ready. The gating guarantee is
    // that nothing is processed while we are still waiting for the ready marker.
    proc.emitStdout(
      JSON.stringify({ chat_id: "oc_1", chat_type: "p2p", content: "early", message_id: "om_0", event_id: "e0", sender_id: "ou_a" }),
    );
    await Bun.sleep(30);
    expect(events.length).toBe(0); // still gated: no ready marker yet

    // Now signal ready; the pump starts and the message flows.
    proc.emitStderr("[event] ready event_key=im.message.receive_v1");
    await Bun.sleep(20);
    proc.emitStdout(
      JSON.stringify({ chat_id: "oc_1", chat_type: "p2p", content: "谁负责后端？", message_id: "om_1", event_id: "e1", sender_id: "ou_a" }),
    );
    await Bun.sleep(30);

    const msgs = events.filter((e) => e.kind === "message") as { text: string }[];
    // Post-ready the pump drains everything buffered, including the later message.
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs.some((m) => m.text === "谁负责后端？")).toBe(true);
  });

  test("normalizes a bot_added event from the added consumer", async () => {
    const spawner = new FakeSpawner();
    const events: InboundEvent[] = [];
    connector = new FeishuConnector({ spawner, runCommand: async () => "{}" });
    await connector.start((e) => {
      events.push(e);
    });

    const proc = await spawner.waitForProc("im.chat.member.bot.added_v1");
    proc.emitStderr("[event] ready event_key=im.chat.member.bot.added_v1");
    await Bun.sleep(20);
    proc.emitStdout(JSON.stringify({ header: { event_id: "evt_add" }, event: { chat_id: "oc_new" } }));
    await Bun.sleep(30);

    const added = events.filter((e) => e.kind === "bot_added");
    expect(added.length).toBe(1);
    expect((added[0] as { chatId: string }).chatId).toBe("oc_new");
  });

  test("restarts a crashed consumer with backoff", async () => {
    const spawner = new FakeSpawner();
    connector = new FeishuConnector({
      spawner,
      runCommand: async () => "{}",
      backoffBaseMs: 10,
      backoffMaxMs: 20,
    });
    await connector.start(() => {});

    const first = await spawner.waitForProc("im.message.receive_v1", 1);
    first.emitStderr("[event] ready event_key=im.message.receive_v1");
    await Bun.sleep(10);
    // crash it
    first.finish(1);
    // a second process for the same key should be spawned after backoff
    const second = await spawner.waitForProc("im.message.receive_v1", 2);
    expect(second).not.toBe(first);
  });

  test("gives up on a consumer that never reaches ready", async () => {
    const spawner = new FakeSpawner();
    connector = new FeishuConnector({
      spawner,
      runCommand: async () => "{}",
      backoffBaseMs: 2,
      backoffMaxMs: 4,
      maxNeverReady: 3,
    });
    await connector.start(() => {});

    // For the bot-added key, crash every process before ready. After
    // maxNeverReady attempts the loop should stop spawning new ones.
    for (let i = 1; i <= 3; i++) {
      const p = await spawner.waitForProc("im.chat.member.bot.added_v1", i);
      p.emitStderr('{"ok":false,"error":{"type":"missing_scope"}}');
      p.finish(3);
      await Bun.sleep(15);
    }
    await Bun.sleep(30);
    const count = spawner.procs.filter((p) =>
      p.cmd.some((a) => a.includes("im.chat.member.bot.added_v1")),
    ).length;
    // capped at maxNeverReady (3); should not keep spawning
    expect(count).toBeLessThanOrEqual(3);
  });

  test("stop() sends SIGTERM (kills) all consumers", async () => {
    const spawner = new FakeSpawner();
    connector = new FeishuConnector({ spawner, runCommand: async () => "{}" });
    await connector.start(() => {});
    const msg = await spawner.waitForProc("im.message.receive_v1");
    msg.emitStderr("[event] ready event_key=im.message.receive_v1");
    await Bun.sleep(10);
    await connector.stop();
    expect(msg.killed).toBe(true);
  });
});

describe("FeishuConnector outbound", () => {
  test("reply builds the correct lark-cli command", async () => {
    const spawner = new FakeSpawner();
    const commands: string[][] = [];
    connector = new FeishuConnector({
      spawner,
      runCommand: async (cmd) => {
        commands.push(cmd);
        return "{}";
      },
    });
    await connector.reply({
      chatId: "oc_1",
      replyToMessageId: "om_1",
      markdown: "hello",
      inThread: true,
    });
    const cmd = commands[0]!;
    expect(cmd).toContain("+messages-reply");
    expect(cmd).toContain("--message-id");
    expect(cmd).toContain("om_1");
    expect(cmd).toContain("--markdown");
    expect(cmd).toContain("hello");
    expect(cmd).toContain("--reply-in-thread");
    expect(cmd).toContain("--as");
    expect(cmd).toContain("bot");
  });

  test("notice uses +messages-send with chat-id", async () => {
    const spawner = new FakeSpawner();
    const commands: string[][] = [];
    connector = new FeishuConnector({
      spawner,
      runCommand: async (cmd) => {
        commands.push(cmd);
        return "{}";
      },
    });
    await connector.notice("oc_group", "欢迎语");
    const cmd = commands[0]!;
    expect(cmd).toContain("+messages-send");
    expect(cmd).toContain("--chat-id");
    expect(cmd).toContain("oc_group");
    expect(cmd).toContain("欢迎语");
  });

  test("adds and removes a native message reaction", async () => {
    const spawner = new FakeSpawner();
    const commands: string[][] = [];
    connector = new FeishuConnector({
      spawner,
      runCommand: async (cmd) => {
        commands.push(cmd);
        return cmd.includes("create")
          ? JSON.stringify({ ok: true, data: { reaction_id: "reaction_1" } })
          : JSON.stringify({ ok: true });
      },
    });

    const reactionId = await connector.addReaction("om_1", "THINKING");
    expect(reactionId).toBe("reaction_1");
    expect(commands[0]).toContain("reactions");
    expect(commands[0]).toContain("create");
    expect(commands[0]).toContain("om_1");
    expect(commands[0]!.join(" ")).toContain("THINKING");

    await connector.removeReaction("om_1", reactionId!);
    expect(commands[1]).toContain("reactions");
    expect(commands[1]).toContain("delete");
    expect(commands[1]).toContain("reaction_1");
  });

  test("resolves the original message from a quoted reply", async () => {
    const responses = [
      JSON.stringify({
        ok: true,
        data: { messages: [{ message_id: "om_command", parent_id: "om_source" }] },
      }),
      JSON.stringify({
        ok: true,
        data: {
          messages: [
            {
              message_id: "om_source",
              sender: { id: "ou_owner" },
            },
          ],
        },
      }),
    ];
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      runCommand: async () => responses.shift()!,
    });

    expect(await connector.resolveReplyTarget("om_command")).toEqual({
      messageId: "om_source",
      senderId: "ou_owner",
    });
  });

  test("resolves the thread root when the command is a topic reply", async () => {
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      runCommand: async () =>
        JSON.stringify({
          ok: true,
          data: {
            messages: [
              {
                message_id: "om_command",
                thread_id: "omt_1",
                thread_message_position: "1",
                thread_replies: [
                  {
                    message_id: "om_source",
                    thread_id: "omt_1",
                    thread_message_position: "-1",
                    sender: { id: "ou_owner" },
                  },
                  {
                    message_id: "om_command",
                    thread_id: "omt_1",
                    thread_message_position: "1",
                    sender: { id: "ou_owner" },
                  },
                ],
              },
            ],
          },
        }),
    });

    expect(await connector.resolveReplyTarget("om_command")).toEqual({
      messageId: "om_source",
      senderId: "ou_owner",
    });
  });

  test("fetchDoc parses markdown from CLI json", async () => {
    const spawner = new FakeSpawner();
    connector = new FeishuConnector({
      spawner,
      runCommand: async () => JSON.stringify({ markdown: "# Doc\n正文内容" }),
    });
    const md = await connector.fetchDoc("https://x.feishu.cn/docx/abc");
    expect(md).toContain("正文内容");
  });

  test("fetchDoc returns null on command failure", async () => {
    const spawner = new FakeSpawner();
    connector = new FeishuConnector({
      spawner,
      runCommand: async () => {
        throw new Error("boom");
      },
    });
    expect(await connector.fetchDoc("bad")).toBeNull();
  });
});

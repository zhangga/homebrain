import { describe, expect, test } from "bun:test";
import type { InboundEvent } from "./connector.ts";
import { CliConnector } from "./cli.ts";

describe("CliConnector (programmatic)", () => {
  test("sendP2P dispatches a p2p message that mentions the bot", async () => {
    const c = new CliConnector({ userId: "ou_me", p2pChatId: "oc_dm" });
    const events: InboundEvent[] = [];
    await c.start((e) => {
      events.push(e);
    });
    await c.sendP2P("你好");
    expect(events.length).toBe(1);
    const m = events[0] as Extract<InboundEvent, { kind: "message" }>;
    expect(m.chatType).toBe("p2p");
    expect(m.mentionsBot).toBe(true);
    expect(m.senderId).toBe("ou_me");
  });

  test("sendGroup carries the mention flag", async () => {
    const c = new CliConnector();
    const events: InboundEvent[] = [];
    await c.start((e) => { events.push(e); });
    await c.sendGroup("no mention", false);
    await c.sendGroup("@bot mention", true);
    const msgs = events as Extract<InboundEvent, { kind: "message" }>[];
    expect(msgs[0]!.mentionsBot).toBe(false);
    expect(msgs[1]!.mentionsBot).toBe(true);
    expect(msgs[0]!.chatType).toBe("group");
  });

  test("sendBotAdded dispatches a bot_added event", async () => {
    const c = new CliConnector({ groupChatId: "oc_g" });
    const events: InboundEvent[] = [];
    await c.start((e) => { events.push(e); });
    await c.sendBotAdded();
    expect(events[0]!.kind).toBe("bot_added");
  });

  test("reply and notice are captured", async () => {
    const c = new CliConnector();
    await c.start(() => {});
    await c.reply({ chatId: "oc_1", markdown: "answer" });
    await c.notice("oc_1", "welcome");
    expect(c.sent[0]!.markdown).toBe("answer");
    expect(c.notices[0]!.markdown).toBe("welcome");
  });

  test("inject forwards an arbitrary event", async () => {
    const c = new CliConnector();
    const events: InboundEvent[] = [];
    await c.start((e) => { events.push(e); });
    await c.inject({ kind: "bot_added", eventId: "x", chatId: "oc_z", createdAt: Date.now() });
    expect(events[0]!.kind).toBe("bot_added");
  });
});

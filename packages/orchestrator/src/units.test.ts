import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@homebrain/connectors";
import { attribute } from "./attribution.ts";
import { gate } from "./gateway.ts";
import { prefilterChitchat } from "./intent.ts";
import { formatAnswer } from "./format.ts";
import type { AskResult } from "@homebrain/shared";

function msg(over: Partial<InboundMessage>): InboundMessage {
  return {
    kind: "message",
    eventId: "e1",
    chatType: "group",
    chatId: "oc_1",
    senderId: "ou_a",
    text: "hi",
    messageId: "om_1",
    mentionsBot: false,
    createdAt: Date.now(),
    ...over,
  };
}

describe("attribution (Q4/Q5)", () => {
  test("group message -> team space; reads team ∪ personal", () => {
    const a = attribute(msg({ chatType: "group", chatId: "oc_1", senderId: "ou_a" }));
    expect(a.writeSpace).toBe("team/oc_1");
    expect(a.readSpaces).toEqual(["team/oc_1", "personal/ou_a"]);
  });

  test("p2p message -> personal space; reads personal only", () => {
    const a = attribute(msg({ chatType: "p2p", chatId: "oc_p", senderId: "ou_a" }));
    expect(a.writeSpace).toBe("personal/ou_a");
    expect(a.readSpaces).toEqual(["personal/ou_a"]);
  });
});

describe("reply gateway (Q2)", () => {
  test("p2p always responds", () => {
    const d = gate(msg({ chatType: "p2p", mentionsBot: false }));
    expect(d.respond).toBe(true);
    expect(d.capture).toBe(true);
  });

  test("group with mention responds", () => {
    const d = gate(msg({ chatType: "group", mentionsBot: true }));
    expect(d.respond).toBe(true);
  });

  test("group without mention captures but does not respond", () => {
    const d = gate(msg({ chatType: "group", mentionsBot: false }));
    expect(d.respond).toBe(false);
    expect(d.capture).toBe(true);
  });

  test("group with mentionsOnly=false responds to every message", () => {
    const d = gate(msg({ chatType: "group", mentionsBot: false }), { mentionsOnly: false });
    expect(d.respond).toBe(true);
    expect(d.capture).toBe(true);
  });

  test("mentionsOnly=false has no effect once already mentioned", () => {
    const d = gate(msg({ chatType: "group", mentionsBot: true }), { mentionsOnly: false });
    expect(d.respond).toBe(true);
  });
});

describe("chitchat prefilter", () => {
  test("greetings are prefiltered", () => {
    expect(prefilterChitchat("在吗")).toBe(true);
    expect(prefilterChitchat("你好！")).toBe(true);
    expect(prefilterChitchat("谢谢")).toBe(true);
    expect(prefilterChitchat("ok")).toBe(true);
  });

  test("substantive messages are not prefiltered", () => {
    expect(prefilterChitchat("谁负责后端服务？")).toBe(false);
    expect(prefilterChitchat("记住：发布流程是先灰度再全量")).toBe(false);
  });
});

describe("formatAnswer (Q1)", () => {
  test("knowledge answer lists citations", () => {
    const res: AskResult = {
      answer: "后端由 Alice 负责。",
      source: "knowledge",
      citations: [{ slug: "entities/alice", title: "Alice" }],
    };
    const md = formatAnswer(res);
    expect(md).toContain("Alice");
    expect(md).toContain("依据");
    expect(md).toContain("[[entities/alice|Alice]]");
  });

  test("general answer has no citation footer", () => {
    const res: AskResult = { answer: "通用回答。", source: "general", citations: [] };
    expect(formatAnswer(res)).toBe("通用回答。");
  });

  test("gaps are surfaced", () => {
    const res: AskResult = {
      answer: "部分回答。",
      source: "knowledge",
      citations: [{ slug: "a", title: "A" }],
      gaps: ["缺少上线时间"],
    };
    expect(formatAnswer(res)).toContain("尚缺");
  });
});

import { describe, expect, test } from "bun:test";
import {
  detectBotMention,
  extractDocLinks,
  normalizeBotAdded,
  normalizeMessage,
} from "./feishu-normalize.ts";

describe("normalizeMessage", () => {
  const base = {
    chat_id: "oc_1",
    chat_type: "group",
    content: "谁负责后端？",
    event_id: "evt_1",
    message_id: "om_1",
    sender_id: "ou_a",
    create_time: "1700000000000",
  };

  test("maps top-level fields into the envelope", () => {
    const m = normalizeMessage({ ...base });
    expect(m).not.toBeNull();
    expect(m!.chatId).toBe("oc_1");
    expect(m!.chatType).toBe("group");
    expect(m!.senderId).toBe("ou_a");
    expect(m!.messageId).toBe("om_1");
    expect(m!.eventId).toBe("evt_1");
    expect(m!.text).toBe("谁负责后端？");
  });

  test("p2p always counts as mentioning the bot", () => {
    const m = normalizeMessage({ ...base, chat_type: "p2p" });
    expect(m!.mentionsBot).toBe(true);
  });

  test("group without mention -> mentionsBot false", () => {
    const m = normalizeMessage({ ...base, chat_type: "group" }, { botName: "homebrain" });
    expect(m!.mentionsBot).toBe(false);
  });

  test("falls back to id when message_id missing", () => {
    const m = normalizeMessage({ ...base, message_id: undefined, id: "om_legacy" });
    expect(m!.messageId).toBe("om_legacy");
  });

  test("returns null when required ids missing", () => {
    expect(normalizeMessage({ content: "x" })).toBeNull();
    expect(normalizeMessage({ chat_id: "oc_1", content: "x" })).toBeNull();
  });
});

describe("detectBotMention", () => {
  test("matches by bot open_id in mentions array", () => {
    const obj = { mentions: [{ name: "homebrain", id: { open_id: "ou_bot" } }] };
    expect(detectBotMention(obj, "@homebrain 你好", { botOpenId: "ou_bot" })).toBe(true);
  });

  test("matches by bot name in mentions array", () => {
    const obj = { mentions: [{ name: "homebrain" }] };
    expect(detectBotMention(obj, "hi", { botName: "homebrain" })).toBe(true);
  });

  test("matches @name in content when no structured mention", () => {
    expect(detectBotMention({}, "@homebrain 谁负责后端", { botName: "homebrain" })).toBe(true);
  });

  test("no identity configured: any mention counts", () => {
    const obj = { mentions: [{ name: "someone" }] };
    expect(detectBotMention(obj, "hi", {})).toBe(true);
  });

  test("no identity configured: detects textual mention in flattened event", () => {
    expect(detectBotMention({}, "@小强Bot HOMEBRAIN-GROUP-ASK：1+1等于几？", {})).toBe(true);
  });

  test("no mention, no match -> false", () => {
    expect(detectBotMention({}, "普通消息", { botName: "homebrain" })).toBe(false);
  });

  test("reads mentions nested under message", () => {
    const obj = { message: { mentions: [{ id: { open_id: "ou_bot" } }] } };
    expect(detectBotMention(obj, "x", { botOpenId: "ou_bot" })).toBe(true);
  });
});

describe("extractDocLinks (Q8)", () => {
  test("finds docx/wiki links and dedupes", () => {
    const text =
      "见文档 https://x.feishu.cn/docx/abc123 和 https://x.feishu.cn/wiki/def456 还有 https://x.feishu.cn/docx/abc123";
    expect(extractDocLinks(text)).toEqual([
      "https://x.feishu.cn/docx/abc123",
      "https://x.feishu.cn/wiki/def456",
    ]);
  });

  test("no links -> empty", () => {
    expect(extractDocLinks("没有链接")).toEqual([]);
  });
});

describe("normalizeBotAdded", () => {
  test("reads chat_id from nested event envelope", () => {
    const obj = { header: { event_id: "evt_9" }, event: { chat_id: "oc_new" } };
    const e = normalizeBotAdded(obj);
    expect(e!.kind).toBe("bot_added");
    expect(e!.chatId).toBe("oc_new");
    expect(e!.eventId).toBe("evt_9");
  });

  test("accepts already-unwrapped object", () => {
    const e = normalizeBotAdded({ chat_id: "oc_x" });
    expect(e!.chatId).toBe("oc_x");
  });

  test("null when no chat_id", () => {
    expect(normalizeBotAdded({ event: {} })).toBeNull();
  });
});

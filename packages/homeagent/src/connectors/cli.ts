import type { Connector, IncomingMessage, OutgoingMessage } from "./types";

/**
 * 本地调试 connector：从 stdin 逐行读消息，回复打到 stdout。
 * 约定：以 '@bot ' 开头 = 提问（mentionsBot=true），否则 = 被动记录。
 * 不依赖飞书，用于 Slice 1 端到端打通。
 */
export interface CliConnectorOptions {
  channelId?: string;
  senderId?: string;
  senderName?: string;
  /** 注入输入流（测试用）；默认读 stdin。 */
  input?: AsyncIterable<string>;
}

export function createCliConnector(opts: CliConnectorOptions = {}): Connector {
  const channelId = opts.channelId ?? "cli";
  const senderId = opts.senderId ?? "local";
  const senderName = opts.senderName ?? "local";

  return {
    name: "cli",
    async *receiveMessages(): AsyncIterable<IncomingMessage> {
      const lines = opts.input ?? readStdinLines();
      for await (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        const mentionsBot = text.startsWith("@bot ");
        yield {
          channelId,
          senderId,
          senderName,
          text: mentionsBot ? text.slice("@bot ".length).trim() : text,
          mentionsBot,
          raw: line,
          ts: Date.now(),
        };
      }
    },
    async sendMessage(msg: OutgoingMessage): Promise<void> {
      console.log(`\n🤖 ${msg.text}\n`);
    },
  };
}

/** 把 stdin 字节流按行切成 AsyncIterable<string>。 */
async function* readStdinLines(): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
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

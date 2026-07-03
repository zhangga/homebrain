export interface IncomingAttachment {
  kind: "image" | "file";
  url?: string;
  key?: string;
  name?: string;
  localPath?: string;
  extractedText?: string;
}

/** 入站消息（平台无关）。各 connector 把平台事件 normalize 成它。 */
export interface IncomingMessage {
  channelId: string; // 群/会话 id
  senderId: string; // 平台用户 id（飞书 open_id / cli 用户名）
  senderName?: string; // 展示名（用于映射到 family slug）
  text?: string;
  attachments?: IncomingAttachment[];
  mentionsBot: boolean; // 是否 @ 了 bot（决定"提问"还是"被动记录"）
  raw: unknown; // 原始事件，调试用
  ts: number;
}

/** 出站消息（MVP 先纯文本 / markdown）。 */
export interface OutgoingMessage {
  channelId: string;
  text: string;
}

/**
 * 可插拔连接器：入站是 AsyncIterable（贴合流式事件），出站是幂等 sendMessage。
 * 平台细节全藏在 adapter 里（飞书 / CLI / 未来微信 / QQ）。
 */
export interface Connector {
  readonly name: string;
  receiveMessages(): AsyncIterable<IncomingMessage>;
  sendMessage(msg: OutgoingMessage): Promise<void>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { createClaudeImageAttachmentExtractor, createLocalTextAttachmentExtractor } from "./attachments";
import type { IncomingMessage } from "../connectors/types";

function message(): IncomingMessage {
  return {
    channelId: "cli",
    senderId: "local",
    mentionsBot: false,
    raw: {},
    ts: 1,
  };
}

test("attachment text extractor：读取安全相对路径里的文本附件", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "homeagent-attachments-"));
  try {
    await writeFile(join(rootDir, "note.txt"), " 明天带水彩笔\n记得签阅读单 ");
    const extractor = createLocalTextAttachmentExtractor({ rootDir, maxBytes: 1024 });

    const text = await extractor.extractText({
      msg: message(),
      attachment: { kind: "file", name: "note.txt", localPath: "note.txt" },
    });

    expect(text).toBe("明天带水彩笔\n记得签阅读单");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("attachment text extractor：跳过非文本附件和不安全路径", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "homeagent-attachments-"));
  try {
    await writeFile(join(rootDir, "notice.png"), "not real image");
    await writeFile(join(rootDir, "secret.txt"), "不要读到我");
    const extractor = createLocalTextAttachmentExtractor({ rootDir, maxBytes: 1024 });

    const imageText = await extractor.extractText({
      msg: message(),
      attachment: { kind: "image", name: "notice.png", localPath: "notice.png" },
    });
    const unsafeText = await extractor.extractText({
      msg: message(),
      attachment: { kind: "file", name: "secret.txt", localPath: "../secret.txt" },
    });

    expect(imageText).toBeUndefined();
    expect(unsafeText).toBeUndefined();
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("attachment image OCR extractor：读取本地图片并交给 Claude vision client", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "homeagent-attachments-"));
  try {
    await writeFile(join(rootDir, "notice.png"), "fake image bytes");
    const calls: Array<{
      mediaType: string;
      dataBase64: string;
      prompt: string;
    }> = [];
    const extractor = createClaudeImageAttachmentExtractor({
      rootDir,
      maxBytes: 1024,
      client: {
        async generateTextFromImage(input) {
          calls.push({
            mediaType: input.image.mediaType,
            dataBase64: input.image.dataBase64,
            prompt: input.prompt,
          });
          return "明天带水彩笔";
        },
      },
    });

    const text = await extractor.extractText({
      msg: message(),
      attachment: { kind: "image", name: "notice.png", localPath: "notice.png" },
    });

    expect(text).toBe("明天带水彩笔");
    expect(calls).toEqual([
      {
        mediaType: "image/png",
        dataBase64: Buffer.from("fake image bytes").toString("base64"),
        prompt: "请提取这张图片中适合写入家庭长期记忆的文字内容。只输出图片里的可读文字或关键信息；如果没有可读内容，只输出“无”。",
      },
    ]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("attachment image OCR extractor：图片没有可读内容时不返回占位文本", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "homeagent-attachments-"));
  try {
    await writeFile(join(rootDir, "empty.png"), "fake image bytes");
    const extractor = createClaudeImageAttachmentExtractor({
      rootDir,
      maxBytes: 1024,
      client: {
        async generateTextFromImage() {
          return "无";
        },
      },
    });

    const text = await extractor.extractText({
      msg: message(),
      attachment: { kind: "image", name: "empty.png", localPath: "empty.png" },
    });

    expect(text).toBeUndefined();
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

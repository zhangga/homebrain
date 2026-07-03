import { expect, test } from "bun:test";
import { createLlmMemoryExtractor, createPassthroughExtractor } from "./extractor";
import type { LlmTextClient } from "../llm/types";
import type { IncomingMessage } from "../connectors/types";

class FakeLlmClient implements LlmTextClient {
  readonly calls: Array<{ system: string; user: string }> = [];

  constructor(private readonly response: string) {}

  async generateText(input: { system: string; user: string }): Promise<string> {
    this.calls.push(input);
    return this.response;
  }
}

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channelId: "cli",
    senderId: "local",
    mentionsBot: false,
    raw: {},
    ts: 1,
    ...overrides,
  };
}

test("LLM extractor：解析 facts 对象并过滤空事实", async () => {
  const client = new FakeLlmClient(
    JSON.stringify({
      facts: [
        { text: "老师电话是 138", tags: ["school"], occurredAt: "2026-06-24" },
        { text: "   " },
      ],
    }),
  );
  const extractor = createLlmMemoryExtractor({ client });

  expect(await extractor.extract({ msg: message(), text: "老师电话 138" })).toEqual([
    { text: "老师电话是 138", tags: ["school"], occurredAt: "2026-06-24" },
  ]);
  expect(client.calls[0]!.system).toContain("JSON");
  expect(client.calls[0]!.user).toContain("老师电话 138");
});

test("passthrough extractor：附件消息自动补附件标签", async () => {
  const extractor = createPassthroughExtractor();

  expect(
    await extractor.extract({
      msg: message({
        attachments: [
          { kind: "image", key: "img_v3_homework" },
          { kind: "file", key: "file_v3_schedule" },
        ],
      }),
      text: "今天的作业拍给你\n收到图片附件：img_v3_homework\n收到文件附件：file_v3_schedule",
    }),
  ).toEqual([
    {
      text: "今天的作业拍给你\n收到图片附件：img_v3_homework\n收到文件附件：file_v3_schedule",
      tags: ["attachment", "image", "file"],
    },
  ]);
});

test("LLM extractor：附件消息合并附件标签", async () => {
  const client = new FakeLlmClient(
    JSON.stringify({
      facts: [{ text: "今天作业照片已收到", tags: ["school"] }],
    }),
  );
  const extractor = createLlmMemoryExtractor({ client });

  expect(
    await extractor.extract({
      msg: message({ attachments: [{ kind: "image", key: "img_v3_homework" }] }),
      text: "今天的作业拍给你\n收到图片附件：img_v3_homework",
    }),
  ).toEqual([
    { text: "今天作业照片已收到", tags: ["school", "attachment", "image"] },
  ]);
  expect(client.calls[0]!.user).toContain("attachments:");
  expect(client.calls[0]!.user).toContain("- image: img_v3_homework");
});

test("LLM extractor：短寒暄不调用 LLM", async () => {
  const client = new FakeLlmClient(JSON.stringify([{ text: "不应出现" }]));
  const extractor = createLlmMemoryExtractor({ client });

  for (const text of ["收到", "谢谢", "哈哈哈", "OK！"]) {
    expect(await extractor.extract({ msg: message(), text })).toEqual([]);
  }
  expect(client.calls).toEqual([]);
});

test("LLM extractor：兼容直接返回 JSON array", async () => {
  const client = new FakeLlmClient(JSON.stringify([{ text: "明天带泳衣", tags: ["reminder"] }]));
  const extractor = createLlmMemoryExtractor({ client });

  expect(await extractor.extract({ msg: message(), text: "明天带泳衣" })).toEqual([
    { text: "明天带泳衣", tags: ["reminder"] },
  ]);
});

test("LLM extractor：非 JSON 输出报错时包含片段", async () => {
  const extractor = createLlmMemoryExtractor({ client: new FakeLlmClient("我觉得这很重要") });

  await expect(extractor.extract({ msg: message(), text: "老师电话 138" })).rejects.toThrow(
    "LLM extractor 输出非 JSON",
  );
});

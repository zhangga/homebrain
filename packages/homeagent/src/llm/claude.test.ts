import { expect, test } from "bun:test";
import { createClaudeClient } from "./claude";

test("Claude client：发送 messages 请求并返回 text 内容", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = createClaudeClient({
    apiKey: "test-key",
    model: "claude-test",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "{\"facts\":[]}" }] }),
        { status: 200 },
      );
    },
  });

  expect(await client.generateText({ system: "system prompt", user: "user prompt" })).toBe(
    '{"facts":[]}',
  );
  expect(requests[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  expect(requests[0]!.init.method).toBe("POST");
  expect((requests[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
  expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
    model: "claude-test",
    max_tokens: 1024,
    system: "system prompt",
    messages: [{ role: "user", content: "user prompt" }],
  });
});

test("Claude client：发送图片 content block 并返回 OCR 文本", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = createClaudeClient({
    apiKey: "test-key",
    model: "claude-test",
    maxTokens: 128,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "明天带水彩笔" }] }), {
        status: 200,
      });
    },
  });

  const text = await client.generateTextFromImage({
    system: "只做 OCR",
    prompt: "请提取图片里的中文文字",
    image: {
      mediaType: "image/png",
      dataBase64: "aW1hZ2U=",
    },
  });

  expect(text).toBe("明天带水彩笔");
  expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
    model: "claude-test",
    max_tokens: 128,
    system: "只做 OCR",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aW1hZ2U=",
            },
          },
          { type: "text", text: "请提取图片里的中文文字" },
        ],
      },
    ],
  });
});

test("Claude client：错误响应包含状态码和响应片段", async () => {
  const client = createClaudeClient({
    apiKey: "test-key",
    fetch: async () => new Response("quota exceeded", { status: 429 }),
  });

  await expect(client.generateText({ system: "s", user: "u" })).rejects.toThrow(
    "Claude 请求失败 (HTTP 429): quota exceeded",
  );
});

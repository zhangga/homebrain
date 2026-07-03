import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { HomeagentConfig } from "../config";
import { createConfiguredLlmClient } from "./factory";

function config(overrides: Partial<HomeagentConfig> = {}): HomeagentConfig {
  return {
    connector: "cli",
    brainDir: "./.brain",
    gbrainBin: "gbrain",
    larkBin: "lark-cli",
    defaultSource: "default",
    memberDbPath: "./.homeagent.sqlite",
    taskDispatchIntervalMs: 24 * 60 * 60 * 1000,
    taskDispatchOnStart: false,
    briefingIntervalMs: 24 * 60 * 60 * 1000,
    briefingOnStart: false,
    weeklyIntervalMs: 7 * 24 * 60 * 60 * 1000,
    weeklyOnStart: false,
    onThisDayIntervalMs: 24 * 60 * 60 * 1000,
    onThisDayOnStart: false,
    profileRefreshEnabled: false,
    profileRefreshIntervalMs: 24 * 60 * 60 * 1000,
    profileRefreshOnStart: false,
    llmLogPath: "./.homeagent-llm.jsonl",
    llmMaxOutputTokensPerCall: 1024,
    imageOcrEnabled: false,
    imageOcrMaxBytes: 5 * 1024 * 1024,
    ...overrides,
  };
}

test("LLM factory：没有 Claude key 时不创建 client", () => {
  expect(createConfiguredLlmClient(config())).toBeUndefined();
});

test("LLM factory：创建带预算日志的 Claude client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homeagent-llm-factory-"));
  const logPath = join(dir, "llm.jsonl");
  const client = createConfiguredLlmClient(
    config({
      anthropicApiKey: "test-key",
      anthropicModel: "claude-test",
      llmLogPath: logPath,
      llmDailyBudgetUsd: 0.02,
      llmInputUsdPerMillionTokens: 1000,
      llmOutputUsdPerMillionTokens: 1000,
      llmMaxOutputTokensPerCall: 4,
    }),
    {
      fetch: async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "claude-test",
          max_tokens: 4,
        });
        return new Response(JSON.stringify({ content: [{ type: "text", text: "abcdefgh" }] }));
      },
      now: () => new Date("2026-06-25T10:00:00+08:00"),
    },
  );

  await expect(client?.generateText({ system: "1234", user: "1234" })).resolves.toBe("abcdefgh");

  const entries = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(entries[0]).toMatchObject({
    date: "2026-06-25",
    status: "completed",
    inputTokens: 2,
    outputTokens: 2,
  });
});

test("LLM factory：Claude vision 调用也复用预算日志", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homeagent-llm-factory-"));
  const logPath = join(dir, "llm.jsonl");
  const client = createConfiguredLlmClient(
    config({
      anthropicApiKey: "test-key",
      anthropicModel: "claude-test",
      llmLogPath: logPath,
      llmDailyBudgetUsd: 0.02,
      llmInputUsdPerMillionTokens: 1000,
      llmOutputUsdPerMillionTokens: 1000,
      llmMaxOutputTokensPerCall: 4,
    }),
    {
      fetch: async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "claude-test",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "YWJjZA==" },
                },
                { type: "text", text: "1234" },
              ],
            },
          ],
        });
        return new Response(JSON.stringify({ content: [{ type: "text", text: "明天带水彩笔" }] }));
      },
      now: () => new Date("2026-06-25T10:00:00+08:00"),
    },
  );

  await expect(
    client?.generateTextFromImage?.({
      system: "1234",
      prompt: "1234",
      image: { mediaType: "image/png", dataBase64: "YWJjZA==" },
    }),
  ).resolves.toBe("明天带水彩笔");

  const entries = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(entries[0]).toMatchObject({
    date: "2026-06-25",
    status: "completed",
    inputTokens: 4,
    outputTokens: 2,
  });
});

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createBudgetedLlmClient } from "./budget";
import type { LlmImageMediaType, LlmTextClient, LlmVisionClient } from "./types";

function fakeClient(response: string, calls: Array<{ system: string; user: string }>): LlmTextClient {
  return {
    async generateText(input) {
      calls.push(input);
      return response;
    },
  };
}

function fakeVisionClient(
  response: string,
  calls: Array<{
    system: string;
    prompt: string;
    mediaType: LlmImageMediaType;
    dataBase64: string;
  }>,
): LlmTextClient & LlmVisionClient {
  return {
    async generateText() {
      throw new Error("文本接口不应被调用");
    },
    async generateTextFromImage(input) {
      calls.push({
        system: input.system,
        prompt: input.prompt,
        mediaType: input.image.mediaType,
        dataBase64: input.image.dataBase64,
      });
      return response;
    },
  };
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("LLM budget：记录每次调用的估算 token 与成本", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homeagent-llm-budget-"));
  const logPath = join(dir, "llm.jsonl");
  const calls: Array<{ system: string; user: string }> = [];
  const client = createBudgetedLlmClient({
    client: fakeClient("abcdefgh", calls),
    logPath,
    dailyBudgetUsd: 0.02,
    pricing: {
      inputUsdPerMillionTokens: 1000,
      outputUsdPerMillionTokens: 1000,
      maxOutputTokensPerCall: 4,
    },
    now: () => new Date("2026-06-25T10:00:00+08:00"),
  });

  await expect(client.generateText({ system: "1234", user: "1234" })).resolves.toBe("abcdefgh");

  expect(calls).toHaveLength(1);
  const entries = await readJsonl(logPath);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    date: "2026-06-25",
    status: "completed",
    inputTokens: 2,
    outputTokens: 2,
    dailyBudgetUsd: 0.02,
  });
  expect(entries[0]!.estimatedCostUsd).toBeCloseTo(0.004);
});

test("LLM budget：超过当日预算时先写阻断日志且不调用底层模型", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homeagent-llm-budget-"));
  const logPath = join(dir, "llm.jsonl");
  await writeFile(
    logPath,
    JSON.stringify({
      date: "2026-06-25",
      status: "completed",
      estimatedCostUsd: 0.009,
    }) + "\n",
  );
  const calls: Array<{ system: string; user: string }> = [];
  const client = createBudgetedLlmClient({
    client: fakeClient("abcdefgh", calls),
    logPath,
    dailyBudgetUsd: 0.01,
    pricing: {
      inputUsdPerMillionTokens: 1000,
      outputUsdPerMillionTokens: 1000,
      maxOutputTokensPerCall: 4,
    },
    now: () => new Date("2026-06-25T10:00:00+08:00"),
  });

  await expect(client.generateText({ system: "1234", user: "1234" })).rejects.toThrow(
    "LLM 每日预算已用尽",
  );

  expect(calls).toEqual([]);
  const entries = await readJsonl(logPath);
  expect(entries).toHaveLength(2);
  expect(entries[1]).toMatchObject({
    date: "2026-06-25",
    status: "blocked",
    dailyBudgetUsd: 0.01,
  });
  expect(entries[1]!.dailySpentBeforeUsd).toBeCloseTo(0.009);
  expect(entries[1]!.requestedCostUsd).toBeCloseTo(0.006);
});

test("LLM budget：图片 OCR 调用同样写入预算日志", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homeagent-llm-budget-"));
  const logPath = join(dir, "llm.jsonl");
  const calls: Array<{
    system: string;
    prompt: string;
    mediaType: LlmImageMediaType;
    dataBase64: string;
  }> = [];
  const client = createBudgetedLlmClient({
    client: fakeVisionClient("明天带水彩笔", calls),
    logPath,
    dailyBudgetUsd: 0.1,
    pricing: {
      inputUsdPerMillionTokens: 1000,
      outputUsdPerMillionTokens: 1000,
      maxOutputTokensPerCall: 8,
    },
    now: () => new Date("2026-06-25T10:00:00+08:00"),
  });
  const generateTextFromImage = client.generateTextFromImage;
  expect(generateTextFromImage).toBeDefined();

  await expect(
    generateTextFromImage!({
      system: "1234",
      prompt: "1234",
      image: { mediaType: "image/png", dataBase64: "YWJjZA==" },
    }),
  ).resolves.toBe("明天带水彩笔");

  expect(calls).toEqual([
    {
      system: "1234",
      prompt: "1234",
      mediaType: "image/png",
      dataBase64: "YWJjZA==",
    },
  ]);
  const entries = await readJsonl(logPath);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    date: "2026-06-25",
    status: "completed",
    inputTokens: 4,
    outputTokens: 2,
    dailyBudgetUsd: 0.1,
  });
});

test("LLM budget：图片 OCR 超过当日预算时不调用底层 vision client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homeagent-llm-budget-"));
  const logPath = join(dir, "llm.jsonl");
  await writeFile(
    logPath,
    JSON.stringify({
      date: "2026-06-25",
      status: "completed",
      estimatedCostUsd: 0.014,
    }) + "\n",
  );
  const calls: Array<{
    system: string;
    prompt: string;
    mediaType: LlmImageMediaType;
    dataBase64: string;
  }> = [];
  const client = createBudgetedLlmClient({
    client: fakeVisionClient("不会返回", calls),
    logPath,
    dailyBudgetUsd: 0.015,
    pricing: {
      inputUsdPerMillionTokens: 1000,
      outputUsdPerMillionTokens: 1000,
      maxOutputTokensPerCall: 8,
    },
    now: () => new Date("2026-06-25T10:00:00+08:00"),
  });
  const generateTextFromImage = client.generateTextFromImage;
  expect(generateTextFromImage).toBeDefined();

  await expect(
    generateTextFromImage!({
      system: "1234",
      prompt: "1234",
      image: { mediaType: "image/png", dataBase64: "YWJjZA==" },
    }),
  ).rejects.toThrow("LLM 每日预算已用尽");

  expect(calls).toEqual([]);
  const entries = await readJsonl(logPath);
  expect(entries).toHaveLength(2);
  expect(entries[1]).toMatchObject({
    date: "2026-06-25",
    status: "blocked",
    dailyBudgetUsd: 0.015,
  });
  expect(entries[1]!.requestedCostUsd).toBeCloseTo(0.012);
});

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createMemoryExtractor } from "./extractorFactory";
import type { HomeagentConfig } from "../config";
import type { IncomingMessage } from "../connectors/types";

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

function message(): IncomingMessage {
  return {
    channelId: "cli",
    senderId: "local",
    mentionsBot: false,
    raw: {},
    ts: 1,
  };
}

test("extractor factory：没有 Claude key 时使用 passthrough extractor", async () => {
  const extractor = createMemoryExtractor(config());

  expect(await extractor.extract({ msg: message(), text: " 老师电话 138 " })).toEqual([
    { text: "老师电话 138" },
  ]);
});

test("extractor factory：有 Claude key 时创建带预算日志的 LLM extractor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homeagent-extractor-factory-"));
  const logPath = join(dir, "llm.jsonl");
  const requests: Array<{ body: unknown; headers: Record<string, string> }> = [];
  const extractor = createMemoryExtractor(
    config({
      anthropicApiKey: "test-key",
      anthropicModel: "claude-test",
      llmLogPath: logPath,
      llmInputUsdPerMillionTokens: 1000,
      llmOutputUsdPerMillionTokens: 1000,
      llmMaxOutputTokensPerCall: 4,
    }),
    {
      fetch: async (_url, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)),
          headers: init?.headers as Record<string, string>,
        });
        return new Response(JSON.stringify({ content: [{ type: "text", text: '{"facts":[{"text":"老师电话是 138"}]}' }] }));
      },
    },
  );

  expect(await extractor.extract({ msg: message(), text: "老师电话 138" })).toEqual([
    { text: "老师电话是 138" },
  ]);
  expect(requests[0]!.headers["x-api-key"]).toBe("test-key");
  expect(requests[0]!.body).toMatchObject({ model: "claude-test", max_tokens: 4 });
  const entries = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(entries[0]).toMatchObject({ status: "completed" });
});

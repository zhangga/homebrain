import { test, expect } from "bun:test";
import { loadConfig, checkRequired } from "./config";

test("loadConfig：默认值 + env 覆盖", () => {
  const cfg = loadConfig({
    HOMEBRAIN_DIR: "/tmp/brain",
    HOMEAGENT_CONNECTOR: "feishu",
    GBRAIN_SOURCE: "homebrain",
    GBRAIN_SOURCE_PATH: "/tmp/homebrain-pages",
    LARK_BIN: "lark-dev",
    ANTHROPIC_API_KEY: "sk-x",
    ANTHROPIC_MODEL: "claude-test",
    HOMEAGENT_LLM_LOG_PATH: "/tmp/homeagent-llm.jsonl",
    HOMEAGENT_LLM_DAILY_BUDGET_USD: "0.25",
    HOMEAGENT_LLM_INPUT_USD_PER_MILLION_TOKENS: "3",
    HOMEAGENT_LLM_OUTPUT_USD_PER_MILLION_TOKENS: "15",
    HOMEAGENT_LLM_MAX_OUTPUT_TOKENS: "2048",
    HOMEAGENT_TASK_CHANNEL_ID: "family",
    HOMEAGENT_TASK_DISPATCH_INTERVAL_MS: "60000",
    HOMEAGENT_TASK_DISPATCH_ON_START: "1",
    HOMEAGENT_BRIEFING_CHANNEL_ID: "family-briefing",
    HOMEAGENT_BRIEFING_INTERVAL_MS: "120000",
    HOMEAGENT_BRIEFING_ON_START: "true",
    HOMEAGENT_WEEKLY_CHANNEL_ID: "family-weekly",
    HOMEAGENT_WEEKLY_INTERVAL_MS: "604800000",
    HOMEAGENT_WEEKLY_ON_START: "yes",
    HOMEAGENT_ON_THIS_DAY_CHANNEL_ID: "family-memory",
    HOMEAGENT_ON_THIS_DAY_INTERVAL_MS: "86400000",
    HOMEAGENT_ON_THIS_DAY_ON_START: "1",
    HOMEAGENT_PROFILE_REFRESH_ENABLED: "1",
    HOMEAGENT_PROFILE_REFRESH_INTERVAL_MS: "3600000",
    HOMEAGENT_PROFILE_REFRESH_ON_START: "true",
    FEISHU_EVENT_KEY: "im.message.receive_v1",
    FEISHU_BOT_OPEN_ID: "ou_bot",
    FEISHU_ATTACHMENT_DOWNLOAD_DIR: ".homeagent/attachments",
    HOMEAGENT_ATTACHMENT_TEXT_MAX_BYTES: "4096",
    HOMEAGENT_IMAGE_OCR_ENABLED: "1",
    HOMEAGENT_IMAGE_OCR_MAX_BYTES: "2048",
  });
  expect(cfg.brainDir).toBe("/tmp/brain");
  expect(cfg.connector).toBe("feishu");
  expect(cfg.larkBin).toBe("lark-dev");
  expect(cfg.gbrainBin).toBe("gbrain");
  expect(cfg.defaultSource).toBe("homebrain");
  expect(cfg.sourcePath).toBe("/tmp/homebrain-pages");
  expect(cfg.memberDbPath).toBe("./.homeagent.sqlite");
  expect(cfg.anthropicApiKey).toBe("sk-x");
  expect(cfg.anthropicModel).toBe("claude-test");
  expect(cfg.llmLogPath).toBe("/tmp/homeagent-llm.jsonl");
  expect(cfg.llmDailyBudgetUsd).toBe(0.25);
  expect(cfg.llmInputUsdPerMillionTokens).toBe(3);
  expect(cfg.llmOutputUsdPerMillionTokens).toBe(15);
  expect(cfg.llmMaxOutputTokensPerCall).toBe(2048);
  expect(cfg.feishuEventKey).toBe("im.message.receive_v1");
  expect(cfg.feishuBotOpenId).toBe("ou_bot");
  expect(cfg.feishuAttachmentDownloadDir).toBe(".homeagent/attachments");
  expect(cfg.attachmentTextMaxBytes).toBe(4096);
  expect(cfg.imageOcrEnabled).toBe(true);
  expect(cfg.imageOcrMaxBytes).toBe(2048);
  expect(cfg.taskDispatchChannelId).toBe("family");
  expect(cfg.taskDispatchIntervalMs).toBe(60_000);
  expect(cfg.taskDispatchOnStart).toBe(true);
  expect(cfg.briefingChannelId).toBe("family-briefing");
  expect(cfg.briefingIntervalMs).toBe(120_000);
  expect(cfg.briefingOnStart).toBe(true);
  expect(cfg.weeklyChannelId).toBe("family-weekly");
  expect(cfg.weeklyIntervalMs).toBe(604_800_000);
  expect(cfg.weeklyOnStart).toBe(true);
  expect(cfg.onThisDayChannelId).toBe("family-memory");
  expect(cfg.onThisDayIntervalMs).toBe(86_400_000);
  expect(cfg.onThisDayOnStart).toBe(true);
  expect(cfg.profileRefreshEnabled).toBe(true);
  expect(cfg.profileRefreshIntervalMs).toBe(3_600_000);
  expect(cfg.profileRefreshOnStart).toBe(true);
});

test("loadConfig：成员映射 DB 路径可通过 env 覆盖", () => {
  const cfg = loadConfig({ HOMEAGENT_DB_PATH: "/tmp/homeagent.sqlite" });
  expect(cfg.connector).toBe("cli");
  expect(cfg.larkBin).toBe("lark-cli");
  expect(cfg.memberDbPath).toBe("/tmp/homeagent.sqlite");
  expect(cfg.llmLogPath).toBe("./.homeagent-llm.jsonl");
  expect(cfg.llmDailyBudgetUsd).toBeUndefined();
  expect(cfg.llmInputUsdPerMillionTokens).toBeUndefined();
  expect(cfg.llmOutputUsdPerMillionTokens).toBeUndefined();
  expect(cfg.llmMaxOutputTokensPerCall).toBe(1024);
  expect(cfg.imageOcrEnabled).toBe(false);
  expect(cfg.taskDispatchIntervalMs).toBe(24 * 60 * 60 * 1000);
  expect(cfg.taskDispatchOnStart).toBe(false);
  expect(cfg.briefingIntervalMs).toBe(24 * 60 * 60 * 1000);
  expect(cfg.briefingOnStart).toBe(false);
  expect(cfg.weeklyIntervalMs).toBe(7 * 24 * 60 * 60 * 1000);
  expect(cfg.weeklyOnStart).toBe(false);
  expect(cfg.onThisDayIntervalMs).toBe(24 * 60 * 60 * 1000);
  expect(cfg.onThisDayOnStart).toBe(false);
  expect(cfg.profileRefreshEnabled).toBe(false);
  expect(cfg.profileRefreshIntervalMs).toBe(24 * 60 * 60 * 1000);
  expect(cfg.profileRefreshOnStart).toBe(false);
});

test("checkRequired：报告缺失项", () => {
  const cfg = loadConfig({});
  expect(checkRequired(cfg, { llm: true })).toEqual(["ANTHROPIC_API_KEY"]);
  expect(checkRequired(cfg, {})).toEqual([]);
});

test("checkRequired：飞书 connector 需要 EventKey 和 bot open id", () => {
  expect(checkRequired(loadConfig({}), { feishu: true })).toEqual([
    "FEISHU_EVENT_KEY",
    "FEISHU_BOT_OPEN_ID",
  ]);
  expect(
    checkRequired(loadConfig({ FEISHU_EVENT_KEY: "im.message.receive_v1" }), {
      feishu: true,
    }),
  ).toEqual(["FEISHU_BOT_OPEN_ID"]);
  expect(
    checkRequired(loadConfig({ FEISHU_BOT_OPEN_ID: "ou_bot" }), {
      feishu: true,
    }),
  ).toEqual(["FEISHU_EVENT_KEY"]);
});

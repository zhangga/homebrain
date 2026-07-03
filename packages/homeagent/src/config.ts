export type HomeagentConnectorName = "cli" | "feishu";

export interface HomeagentConfig {
  connector: HomeagentConnectorName;
  brainDir: string;
  gbrainBin: string;
  larkBin: string;
  defaultSource: string;
  sourcePath?: string;
  memberDbPath: string;
  taskDispatchChannelId?: string;
  taskDispatchIntervalMs: number;
  taskDispatchOnStart: boolean;
  briefingChannelId?: string;
  briefingIntervalMs: number;
  briefingOnStart: boolean;
  weeklyChannelId?: string;
  weeklyIntervalMs: number;
  weeklyOnStart: boolean;
  onThisDayChannelId?: string;
  onThisDayIntervalMs: number;
  onThisDayOnStart: boolean;
  profileRefreshEnabled: boolean;
  profileRefreshIntervalMs: number;
  profileRefreshOnStart: boolean;
  anthropicApiKey?: string; // 编排层 LLM（抽取/问答/总结），Slice 1 起需要
  anthropicModel?: string; // Claude 模型；默认由 llm/claude.ts 控制
  llmLogPath: string;
  llmDailyBudgetUsd?: number;
  llmInputUsdPerMillionTokens?: number;
  llmOutputUsdPerMillionTokens?: number;
  llmMaxOutputTokensPerCall: number;
  feishuEventKey?: string; // Slice 2 才需要
  feishuBotOpenId?: string; // 用于识别并剥掉 @bot 标签
  feishuAttachmentDownloadDir?: string; // 配置后用 lark-cli 下载附件到本地相对路径
  attachmentTextMaxBytes?: number; // 本地文本附件抽取最多读取的字节数
  imageOcrEnabled: boolean; // 显式启用后才把本地图片发给 Claude Vision
  imageOcrMaxBytes: number;
}

const DEFAULT_TASK_DISPATCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BRIEFING_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ON_THIS_DAY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROFILE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LLM_MAX_OUTPUT_TOKENS_PER_CALL = 1024;
const DEFAULT_IMAGE_OCR_MAX_BYTES = 5 * 1024 * 1024;

/** 从 env 读取配置。MVP 本地优先：brainDir 默认 ./.brain，作为 GBRAIN_HOME。 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): HomeagentConfig {
  return {
    connector: parseConnector(env.HOMEAGENT_CONNECTOR),
    brainDir: env.HOMEBRAIN_DIR ?? "./.brain",
    gbrainBin: env.GBRAIN_BIN ?? "gbrain",
    larkBin: env.LARK_BIN ?? "lark-cli",
    defaultSource: env.GBRAIN_SOURCE ?? "default",
    sourcePath: env.GBRAIN_SOURCE_PATH || undefined,
    memberDbPath: env.HOMEAGENT_DB_PATH ?? "./.homeagent.sqlite",
    taskDispatchChannelId: env.HOMEAGENT_TASK_CHANNEL_ID || undefined,
    taskDispatchIntervalMs: parsePositiveInt(
      env.HOMEAGENT_TASK_DISPATCH_INTERVAL_MS,
      DEFAULT_TASK_DISPATCH_INTERVAL_MS,
    ),
    taskDispatchOnStart: parseBool(env.HOMEAGENT_TASK_DISPATCH_ON_START),
    briefingChannelId: env.HOMEAGENT_BRIEFING_CHANNEL_ID || undefined,
    briefingIntervalMs: parsePositiveInt(
      env.HOMEAGENT_BRIEFING_INTERVAL_MS,
      DEFAULT_BRIEFING_INTERVAL_MS,
    ),
    briefingOnStart: parseBool(env.HOMEAGENT_BRIEFING_ON_START),
    weeklyChannelId: env.HOMEAGENT_WEEKLY_CHANNEL_ID || undefined,
    weeklyIntervalMs: parsePositiveInt(
      env.HOMEAGENT_WEEKLY_INTERVAL_MS,
      DEFAULT_WEEKLY_INTERVAL_MS,
    ),
    weeklyOnStart: parseBool(env.HOMEAGENT_WEEKLY_ON_START),
    onThisDayChannelId: env.HOMEAGENT_ON_THIS_DAY_CHANNEL_ID || undefined,
    onThisDayIntervalMs: parsePositiveInt(
      env.HOMEAGENT_ON_THIS_DAY_INTERVAL_MS,
      DEFAULT_ON_THIS_DAY_INTERVAL_MS,
    ),
    onThisDayOnStart: parseBool(env.HOMEAGENT_ON_THIS_DAY_ON_START),
    profileRefreshEnabled: parseBool(env.HOMEAGENT_PROFILE_REFRESH_ENABLED),
    profileRefreshIntervalMs: parsePositiveInt(
      env.HOMEAGENT_PROFILE_REFRESH_INTERVAL_MS,
      DEFAULT_PROFILE_REFRESH_INTERVAL_MS,
    ),
    profileRefreshOnStart: parseBool(env.HOMEAGENT_PROFILE_REFRESH_ON_START),
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    anthropicModel: env.ANTHROPIC_MODEL || undefined,
    llmLogPath: env.HOMEAGENT_LLM_LOG_PATH || "./.homeagent-llm.jsonl",
    llmDailyBudgetUsd: parsePositiveFloat(env.HOMEAGENT_LLM_DAILY_BUDGET_USD),
    llmInputUsdPerMillionTokens: parsePositiveFloat(
      env.HOMEAGENT_LLM_INPUT_USD_PER_MILLION_TOKENS,
    ),
    llmOutputUsdPerMillionTokens: parsePositiveFloat(
      env.HOMEAGENT_LLM_OUTPUT_USD_PER_MILLION_TOKENS,
    ),
    llmMaxOutputTokensPerCall: parsePositiveInt(
      env.HOMEAGENT_LLM_MAX_OUTPUT_TOKENS,
      DEFAULT_LLM_MAX_OUTPUT_TOKENS_PER_CALL,
    ),
    feishuEventKey: env.FEISHU_EVENT_KEY || undefined,
    feishuBotOpenId: env.FEISHU_BOT_OPEN_ID || undefined,
    feishuAttachmentDownloadDir: env.FEISHU_ATTACHMENT_DOWNLOAD_DIR || undefined,
    attachmentTextMaxBytes: parseOptionalPositiveInt(env.HOMEAGENT_ATTACHMENT_TEXT_MAX_BYTES),
    imageOcrEnabled: parseBool(env.HOMEAGENT_IMAGE_OCR_ENABLED),
    imageOcrMaxBytes: parsePositiveInt(env.HOMEAGENT_IMAGE_OCR_MAX_BYTES, DEFAULT_IMAGE_OCR_MAX_BYTES),
  };
}

/** 校验某能力所需的 env，返回缺失项（供启动时 fail-fast / 友好提示）。 */
export function checkRequired(
  cfg: HomeagentConfig,
  need: { llm?: boolean; feishu?: boolean },
): string[] {
  const missing: string[] = [];
  if (need.llm && !cfg.anthropicApiKey) missing.push("ANTHROPIC_API_KEY");
  if (need.feishu && !cfg.feishuEventKey) missing.push("FEISHU_EVENT_KEY");
  if (need.feishu && !cfg.feishuBotOpenId) missing.push("FEISHU_BOT_OPEN_ID");
  return missing;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveFloat(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBool(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function parseConnector(value: string | undefined): HomeagentConnectorName {
  return value === "feishu" ? "feishu" : "cli";
}

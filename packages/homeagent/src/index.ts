import { createHomebrain } from "homebrain";
import { loadConfig, checkRequired } from "./config";
import { createCliConnector } from "./connectors/cli";
import { createFeishuConnector } from "./connectors/feishu";
import { createConfiguredLlmClient } from "./llm/factory";
import { createManagedProfileUpdater } from "./members/profiles";
import { createMemberResolver, createMemberStore } from "./members/store";
import { runRuntime } from "./runtime";
import { startHomeagentSchedulers } from "./scheduler";
import { createLlmTaskPlanner } from "./tasks/planner";
import { createTaskStore } from "./tasks/store";
import {
  createClaudeImageAttachmentExtractor,
  createCompositeAttachmentTextExtractor,
  createLocalTextAttachmentExtractor,
} from "./understanding/attachments";
import { createMemoryExtractor } from "./understanding/extractorFactory";

/**
 * homeagent 入口。
 * 现在能跑：CLI/飞书 connector + runtime 主循环 + 成员画像/画像刷新/任务 planner/任务 SQLite/任务暂停恢复 + 主动 scheduler。
 * 待接：飞书真实凭据闭环、复杂任务 planner 深化。
 */
async function main() {
  const cfg = loadConfig();
  const missingLlm = checkRequired(cfg, { llm: true });
  const missingFeishu = cfg.connector === "feishu" ? checkRequired(cfg, { feishu: true }) : [];
  if (missingFeishu.length) {
    throw new Error(`缺少 ${missingFeishu.join(", ")}，无法启动飞书 connector`);
  }

  console.error("== homeagent 启动 ==");
  console.error(`connector = ${cfg.connector}`);
  console.error(`brainDir  = ${cfg.brainDir}`);
  console.error(`gbrainBin = ${cfg.gbrainBin}`);
  console.error(`source    = ${cfg.defaultSource}`);
  if (cfg.sourcePath) console.error(`sourcePath= ${cfg.sourcePath}`);
  console.error(`memberDb  = ${cfg.memberDbPath}`);
  console.error(
    missingLlm.length
      ? `⚠️  缺少 ${missingLlm.join(", ")}：Claude 记忆抽取尚不可用（当前使用 passthrough extractor）`
      : "✅ ANTHROPIC_API_KEY 就绪",
  );
  console.error("输入文本=写入记忆；以 '@bot ' 开头=提问。Ctrl-D 结束。\n");

  const llmClient = createConfiguredLlmClient(cfg);
  const connector =
    cfg.connector === "feishu"
      ? createFeishuConnector({
          eventKey: cfg.feishuEventKey!,
          larkBin: cfg.larkBin,
          botOpenId: cfg.feishuBotOpenId,
          attachmentDownloadDir: cfg.feishuAttachmentDownloadDir,
        })
      : createCliConnector();
  const brain = createHomebrain({
    brainDir: cfg.brainDir,
    gbrainBin: cfg.gbrainBin,
    defaultSource: cfg.defaultSource,
    sourcePath: cfg.sourcePath,
  });
  const extractor = createMemoryExtractor(cfg, { client: llmClient });
  const attachmentExtractors = [
    createLocalTextAttachmentExtractor({
      maxBytes: cfg.attachmentTextMaxBytes,
    }),
  ];
  if (cfg.imageOcrEnabled && llmClient?.generateTextFromImage) {
    const imageOcrClient = {
      generateTextFromImage: llmClient.generateTextFromImage.bind(llmClient),
    };
    attachmentExtractors.push(
      createClaudeImageAttachmentExtractor({
        client: imageOcrClient,
        maxBytes: cfg.imageOcrMaxBytes,
      }),
    );
  } else if (cfg.imageOcrEnabled) {
    const reason = cfg.anthropicApiKey ? "当前 LLM client 不支持 vision" : "缺少 ANTHROPIC_API_KEY";
    console.error(`⚠️  HOMEAGENT_IMAGE_OCR_ENABLED 已开启，但${reason}；图片 OCR 不会启用`);
  }
  const attachmentTextExtractor = createCompositeAttachmentTextExtractor(attachmentExtractors);
  const taskPlanner = llmClient ? createLlmTaskPlanner({ client: llmClient }) : undefined;
  const memberStore = createMemberStore({ dbPath: cfg.memberDbPath });
  const profileUpdater = createManagedProfileUpdater({ brain });
  const taskStore = createTaskStore({ dbPath: cfg.memberDbPath });
  const schedulers = startHomeagentSchedulers({
    cfg,
    brain,
    connector,
    taskStore,
    memberStore,
    profileUpdater,
    onError(err) {
      console.error("scheduler error", err);
    },
  });

  try {
    await runRuntime({
      connector,
      brain,
      extractor,
      attachmentTextExtractor,
      resolveMember: createMemberResolver(memberStore, connector.name),
      profileUpdater,
      taskPlanner,
      taskStore,
    });
  } finally {
    schedulers.stop();
    taskStore.close();
    memberStore.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

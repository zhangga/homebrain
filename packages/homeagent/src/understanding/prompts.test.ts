import { expect, test } from "bun:test";
import type { IncomingMessage } from "../connectors/types";
import {
  MEMORY_EXTRACTION_SYSTEM_PROMPT,
  TASK_PLANNER_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
  buildPlannerUserPrompt,
  buildProfileRefreshQuestion,
} from "./prompts";

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channelId: "cli",
    senderId: "local",
    mentionsBot: false,
    raw: {},
    ts: Date.parse("2026-06-24T08:30:00.000Z"),
    ...overrides,
  };
}

test("prompts：记忆抽取 prompt 保留消息上下文并要求 JSON", () => {
  expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain("只返回 JSON");

  const prompt = buildExtractionUserPrompt(
    message({ senderId: "ou_123", senderName: "妈妈" }),
    "明天带泳衣",
  );

  expect(prompt).toContain("senderId: ou_123");
  expect(prompt).toContain("senderName: 妈妈");
  expect(prompt).toContain("timestamp: 2026-06-24T08:30:00.000Z");
  expect(prompt).toContain("明天带泳衣");
});

test("prompts：记忆抽取 prompt 带附件元数据", () => {
  const prompt = buildExtractionUserPrompt(
    message({
      attachments: [
        { kind: "image", key: "img_v3_homework" },
        {
          kind: "file",
          url: "https://example.test/schedule.pdf",
          name: "课表.pdf",
          localPath: ".homeagent/attachments/om_1/课表.pdf",
          extractedText: "周一美术课带水彩笔",
        },
      ],
    }),
    "今天的作业拍给你",
  );

  expect(prompt).toContain("attachments:");
  expect(prompt).toContain("- image: img_v3_homework");
  expect(prompt).toContain(
    "- file: 课表.pdf (https://example.test/schedule.pdf; local: .homeagent/attachments/om_1/课表.pdf; text: 周一美术课带水彩笔)",
  );
});

test("prompts：任务拆解 prompt 保留成员和起始日期上下文", () => {
  expect(TASK_PLANNER_SYSTEM_PROMPT).toContain("只返回 JSON");

  const prompt = buildPlannerUserPrompt({
    text: "我想一周内学完自然拼读",
    member: { slug: "kid" },
    startDate: "2026-06-24",
  });

  expect(prompt).toContain("memberSlug: kid");
  expect(prompt).toContain("startDate: 2026-06-24");
  expect(prompt).toContain("我想一周内学完自然拼读");
});

test("prompts：画像刷新 prompt 带成员上下文并约束可写入 USER.md 的事实行", () => {
  const prompt = buildProfileRefreshQuestion({
    date: "2026-06-24",
    member: {
      connector: "feishu",
      externalId: "ou_kid",
      slug: "kid",
      displayName: "小宝",
    },
  });

  expect(prompt).toContain("今天是 2026-06-24");
  expect(prompt).toContain("成员 slug: kid");
  expect(prompt).toContain("显示名: 小宝");
  expect(prompt).toContain("平台: feishu");
  expect(prompt).toContain("每行一条");
  expect(prompt).toContain("不要编号、项目符号、标题或解释");
  expect(prompt).toContain("不要复述聊天原文");
  expect(prompt).toContain("没有新事实，只输出“无”");
});

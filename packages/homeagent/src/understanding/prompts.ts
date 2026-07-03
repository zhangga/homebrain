import type { MemberRef } from "homebrain";
import type { IncomingMessage } from "../connectors/types";
import type { MemberRecord } from "../members/store";

export const MEMORY_EXTRACTION_SYSTEM_PROMPT = [
  "你是家庭长期记忆助手的事实抽取器。",
  "只抽取值得长期保存的事实、偏好、提醒、进展或家庭成员状态。",
  "只返回 JSON，不要 Markdown，不要解释。",
  'JSON 形状为 {"facts":[{"text":"...","tags":["..."],"occurredAt":"YYYY-MM-DD"}]}。',
  "如果没有值得保存的事实，返回 {\"facts\":[]}。",
].join("\n");

export function buildExtractionUserPrompt(msg: IncomingMessage, text: string): string {
  return [
    `senderId: ${msg.senderId}`,
    msg.senderName ? `senderName: ${msg.senderName}` : undefined,
    `timestamp: ${new Date(msg.ts).toISOString()}`,
    formatAttachments(msg),
    "",
    "message:",
    text,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function formatAttachments(msg: IncomingMessage): string | undefined {
  if (!msg.attachments?.length) return undefined;
  const lines = msg.attachments.map((attachment) => {
    const ref = formatAttachmentRef(attachment);
    return `- ${attachment.kind}: ${ref}`;
  });
  return ["attachments:", ...lines].join("\n");
}

function formatAttachmentRef(attachment: NonNullable<IncomingMessage["attachments"]>[number]): string {
  const ref = attachment.key ?? attachment.url;
  const extractedText = normalizeAttachmentText(attachment.extractedText);
  const detail = [
    ref,
    attachment.localPath ? `local: ${attachment.localPath}` : undefined,
    extractedText ? `text: ${extractedText}` : undefined,
  ].filter((value): value is string => !!value);
  if (attachment.name && detail.length) return `${attachment.name} (${detail.join("; ")})`;
  if (detail.length > 1) return `${detail[0]} (${detail.slice(1).join("; ")})`;
  return attachment.name ?? detail[0] ?? "unknown";
}

function normalizeAttachmentText(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

export const TASK_PLANNER_SYSTEM_PROMPT = [
  "你是家庭学习/阅读目标拆解器。",
  "把用户的自然语言目标拆成 deterministic planner 可用的最小参数。",
  "只返回 JSON，不要 Markdown，不要解释。",
  'JSON 形状为 {"title":"目标名","horizonDays":7,"totalUnits":14,"dailyPortions":[{"day":1,"unitFrom":1,"unitTo":2}]}。',
  "horizonDays 是计划天数；totalUnits 是可均摊的单元数，如章、课、页、练习组或阶段。",
  "dailyPortions 可选；用于休息日、先易后难等非均摊计划，day 从 1 开始。",
  "如果无法合理拆解，返回 null。",
].join("\n");

export function buildPlannerUserPrompt(input: {
  text: string;
  member: MemberRef;
  startDate: string;
}): string {
  return [
    `memberSlug: ${input.member.slug}`,
    `startDate: ${input.startDate}`,
    "",
    "goal:",
    input.text,
  ].join("\n");
}

export function buildProfileRefreshQuestion(input: {
  member: MemberRecord;
  date: string;
}): string {
  return [
    `今天是 ${input.date}。请根据最近的家庭记忆，为下面这位成员提炼需要写入 USER.md 的长期画像事实。`,
    "",
    `成员 slug: ${input.member.slug}`,
    input.member.displayName ? `显示名: ${input.member.displayName}` : undefined,
    `平台: ${input.member.connector}`,
    "",
    "输出规则：",
    "每行一条可长期保存的事实，直接写事实文本。",
    "优先保留稳定偏好、习惯、健康/过敏、学校/课程、家庭角色、长期目标和长期约束。",
    "不要编号、项目符号、标题或解释。",
    "不要复述聊天原文，不要写不确定推测，不要写一次性寒暄或短期情绪。",
    "没有新事实，只输出“无”。",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

import type { Homebrain, MemberRef } from "homebrain";
import type { Connector, IncomingAttachment, IncomingMessage } from "./connectors/types";
import type { AttachmentTextExtractor } from "./understanding/attachments";
import {
  createPassthroughExtractor,
  type MemoryExtractor,
} from "./understanding/extractor";
import type { MemberProfileUpdater } from "./members/profiles";
import type { TaskPlanner } from "./tasks/planner";
import type { TaskStore } from "./tasks/store";
import { routeIncomingMessage } from "./understanding/router";

export type RuntimeBrain = Pick<Homebrain, "ask" | "remember"> & Partial<Pick<Homebrain, "health">>;

export interface RuntimeOptions {
  connector: Connector;
  brain: RuntimeBrain;
  extractor?: MemoryExtractor;
  attachmentTextExtractor?: AttachmentTextExtractor;
  resolveMember?: (msg: IncomingMessage) => MemberRef;
  onError?: (input: { error: unknown; msg: IncomingMessage }) => void | Promise<void>;
  profileUpdater?: MemberProfileUpdater;
  taskPlanner?: TaskPlanner;
  taskStore?: Pick<TaskStore, "createGoal" | "recordFeedback"> &
    Partial<
      Pick<
        TaskStore,
        "planDailyPortions" | "recordLatestPortionFeedback" | "pauseLatestGoal" | "resumeLatestPausedGoal"
      >
    >;
}

/** 单消费者主循环：connector 消息流 -> router -> homebrain -> connector 回复。 */
export async function runRuntime(opts: RuntimeOptions): Promise<void> {
  await opts.connector.start?.();
  try {
    for await (const msg of opts.connector.receiveMessages()) {
      try {
        await handleIncomingMessage(opts, msg);
      } catch (error) {
        await reportMessageError(opts, msg, error);
      }
    }
  } finally {
    await opts.connector.stop?.();
  }
}

export async function handleIncomingMessage(
  opts: RuntimeOptions,
  msg: IncomingMessage,
): Promise<void> {
  const routedMsg = await enrichAttachmentText(opts, msg);
  const route = routeIncomingMessage(routedMsg);
  if (route.kind === "ignore") return;

  if (route.kind === "ask") {
    const result = await opts.brain.ask({ question: route.question });
    await opts.connector.sendMessage({ channelId: routedMsg.channelId, text: result.answer });
    return;
  }

  if (route.kind === "health") {
    if (!opts.brain.health) {
      await opts.connector.sendMessage({
        channelId: routedMsg.channelId,
        text: "健康检查不可用：当前 homebrain 未提供 health 接口。",
      });
      return;
    }
    const result = await opts.brain.health();
    await opts.connector.sendMessage({
      channelId: routedMsg.channelId,
      text: result.ok
        ? `健康检查通过${result.version ? `：${result.version}` : "。"}`
        : "健康检查失败，请查看运行日志。",
    });
    return;
  }

  if (route.kind === "task_goal") {
    const member = opts.resolveMember?.(routedMsg) ?? defaultMember(routedMsg);
    const startDate = route.startDate ?? dateFromMessage(routedMsg);
    const plannedGoal =
      route.totalUnits && route.horizonDays
        ? undefined
        : await opts.taskPlanner?.planGoal({
            text: route.text,
            member,
            startDate,
          });
    const title = route.title ?? plannedGoal?.title;
    const horizonDays = route.horizonDays ?? plannedGoal?.horizonDays;
    const totalUnits = route.totalUnits ?? plannedGoal?.totalUnits;
    const goal = opts.taskStore?.createGoal({
      memberSlug: member.slug,
      title,
      sourceText: route.text,
      horizonDays,
    });
    let plannedDays: number | undefined;
    if (goal && totalUnits && horizonDays && opts.taskStore?.planDailyPortions) {
      opts.taskStore.planDailyPortions({
        goalId: goal.id,
        startDate,
        totalUnits,
        days: horizonDays,
        ...(route.dailyPortions ?? plannedGoal?.dailyPortions
          ? { portions: route.dailyPortions ?? plannedGoal?.dailyPortions }
          : {}),
        ...(route.restWeekdays ? { restWeekdays: route.restWeekdays } : {}),
        ...(route.dateSpacingDays === undefined ? {} : { dateSpacingDays: route.dateSpacingDays }),
        ...(route.activeRestCycle === undefined ? {} : { activeRestCycle: route.activeRestCycle }),
      });
      plannedDays = route.dailyPortions?.length ?? plannedGoal?.dailyPortions?.length ?? horizonDays;
    }
    await opts.brain.remember({
      member,
      text: `学习目标：${route.text}`,
      tags: ["task", "goal"],
    });
    await opts.connector.sendMessage({
      channelId: routedMsg.channelId,
      text:
        plannedDays === undefined
          ? `已收到学习目标：${title ?? route.text}。后续会拆解成每日份额。`
          : `已收到学习目标：${title ?? route.text}。已生成 ${plannedDays} 天每日份额。`,
    });
    return;
  }

  if (route.kind === "task_feedback") {
    const member = opts.resolveMember?.(routedMsg) ?? defaultMember(routedMsg);
    const portionFeedback = opts.taskStore?.recordLatestPortionFeedback?.({
      memberSlug: member.slug,
      date: route.feedbackDate ?? dateFromMessage(routedMsg, route.dateOffsetDays),
      feedback: route.feedback,
      note: route.text,
      ...(route.targetTitle === undefined ? {} : { targetTitle: route.targetTitle }),
      ...(route.completedUnit === undefined ? {} : { completedUnit: route.completedUnit }),
      ...(route.completedRatio === undefined ? {} : { completedRatio: route.completedRatio }),
      ...(route.remainingUnits === undefined ? {} : { remainingUnits: route.remainingUnits }),
      ...(route.extraUnits === undefined ? {} : { extraUnits: route.extraUnits }),
      ...(route.deferDays === undefined ? {} : { deferDays: route.deferDays }),
    });
    opts.taskStore?.recordFeedback({
      memberSlug: member.slug,
      goalId: portionFeedback?.portion.goalId,
      feedback: route.feedback,
      note: route.text,
    });
    await opts.brain.remember({
      member,
      text: `任务反馈（${route.feedback}）：${route.text}`,
      tags: ["task", "feedback"],
    });
    await opts.connector.sendMessage({
      channelId: routedMsg.channelId,
      text: portionFeedback?.goalCompleted
        ? "已完成学习目标。真不错，目标我也标记为完成了。"
        : `已记录反馈：${formatFeedback(route.feedback)}。后续会据此调整份额。`,
    });
    return;
  }

  if (route.kind === "task_pause") {
    const member = opts.resolveMember?.(routedMsg) ?? defaultMember(routedMsg);
    const paused = opts.taskStore?.pauseLatestGoal?.({
      memberSlug: member.slug,
      ...(route.targetTitle === undefined ? {} : { targetTitle: route.targetTitle }),
    });
    await opts.brain.remember({
      member,
      text: paused ? `学习目标已暂停：${paused.title ?? paused.sourceText}` : `学习目标暂停请求：${route.text}`,
      tags: ["task", "pause"],
    });
    await opts.connector.sendMessage({
      channelId: routedMsg.channelId,
      text: paused
        ? `已暂停学习目标：${paused.title ?? paused.sourceText}。之后不会继续派发它的每日份额。`
        : "没有找到正在进行的学习目标可以暂停。",
    });
    return;
  }

  if (route.kind === "task_resume") {
    const member = opts.resolveMember?.(routedMsg) ?? defaultMember(routedMsg);
    const resumed = opts.taskStore?.resumeLatestPausedGoal?.({
      memberSlug: member.slug,
      date: dateFromMessage(routedMsg),
      ...(route.targetTitle === undefined ? {} : { targetTitle: route.targetTitle }),
    });
    await opts.brain.remember({
      member,
      text: resumed
        ? `学习目标已恢复：${resumed.title ?? resumed.sourceText}`
        : `学习目标恢复请求：${route.text}`,
      tags: ["task", "resume"],
    });
    await opts.connector.sendMessage({
      channelId: routedMsg.channelId,
      text: resumed
        ? `已恢复学习目标：${resumed.title ?? resumed.sourceText}。后续会从今天重新派发剩余份额。`
        : "没有找到暂停中的学习目标可以恢复。",
    });
    return;
  }

  const extractor = opts.extractor ?? createPassthroughExtractor();
  const member = opts.resolveMember?.(routedMsg) ?? defaultMember(routedMsg);
  const facts = await extractor.extract({ msg: routedMsg, text: route.text });
  for (const fact of facts) {
    await opts.brain.remember({
      member,
      text: fact.text,
      tags: fact.tags,
      occurredAt: fact.occurredAt,
    });
  }
  if (facts.length) {
    await opts.profileUpdater?.updateFromFacts({
      member,
      facts,
      updatedAt: new Date(routedMsg.ts).toISOString(),
    });
  }
}

async function enrichAttachmentText(opts: RuntimeOptions, msg: IncomingMessage): Promise<IncomingMessage> {
  if (!opts.attachmentTextExtractor || !msg.attachments?.length) return msg;

  const attachments: IncomingAttachment[] = [];
  for (const attachment of msg.attachments) {
    const existing = normalizeExtractedText(attachment.extractedText);
    if (existing) {
      attachments.push({ ...attachment, extractedText: existing });
      continue;
    }
    if (!attachment.localPath) {
      attachments.push(attachment);
      continue;
    }
    const extractedText = normalizeExtractedText(
      await opts.attachmentTextExtractor.extractText({ msg, attachment }),
    );
    attachments.push(extractedText ? { ...attachment, extractedText } : attachment);
  }

  return { ...msg, attachments };
}

function normalizeExtractedText(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

async function reportMessageError(
  opts: RuntimeOptions,
  msg: IncomingMessage,
  error: unknown,
): Promise<void> {
  if (opts.onError) {
    await opts.onError({ error, msg });
    return;
  }
  console.error(
    "runtime message error",
    { channelId: msg.channelId, senderId: msg.senderId, text: msg.text },
    error,
  );
}

function defaultMember(msg: IncomingMessage): MemberRef {
  return { slug: msg.senderId };
}

function formatFeedback(feedback: "done" | "partial" | "too_hard" | "skip"): string {
  if (feedback === "done") return "完成了";
  if (feedback === "partial") return "部分完成";
  if (feedback === "too_hard") return "太难了";
  return "跳过";
}

function dateFromMessage(msg: IncomingMessage, offsetDays = 0): string {
  const date = new Date(msg.ts);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

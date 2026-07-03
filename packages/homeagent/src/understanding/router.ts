import type { IncomingMessage } from "../connectors/types";
import type { ActiveRestCycle, Feedback, PlannedPortion } from "../tasks/model";

const POSITIVE_INTEGER_PATTERN = "[0-9]+|[零〇一二两三四五六七八九十百]+";
const TASK_UNIT_PATTERN = "(?:章|节|页|课|道题|个?题|练习组|单元|个?单词)";
const FEEDBACK_UNIT_PATTERN = "(?:章|节|页|课|单元|道题|个?题|练习组|组|个?词|个?单词)";
const TASK_ACTION_PATTERN = "(?:读|看|做|学|背|练|写|刷|复习|预习)";
const QUALITATIVE_RATIO_PATTERN = "(?:一?小半(?![年月天日])|一?(?:大半|多半)(?![年月天日]))";
const HALF_PLUS_RATIO_PATTERN = "一半\\s*(?:多(?:一)?点|多一点|多点|多一些|多(?![年月天日])|出头)";
const RATIO_FEEDBACK_PATTERN = `(?:${HALF_PLUS_RATIO_PATTERN}|一半|${QUALITATIVE_RATIO_PATTERN}|${POSITIVE_INTEGER_PATTERN}\\s*分之\\s*${POSITIVE_INTEGER_PATTERN}|百分之\\s*${POSITIVE_INTEGER_PATTERN}|\\d{1,2}\\s*%|${POSITIVE_INTEGER_PATTERN}\\s*成)`;
const STAGE_NOTE_PATTERN =
  "[，,、；;\\s]*(?:(?:安排|布置|计划|少一点|少点|少一些|少些|少做点|少做一点|少做一些|少做些|轻松点|轻松一点|简单点|简单一点|加量|加到|加至|增加到|增加至|提高到|提高至|改成|改为|换成|换为|调整为|调整到|调整成|多一点|多点|多一些|多些|多做点|多做一点|多做一些|多做些|冲刺|热身|先热身|重点|巩固|复习)[，,、；;\\s]*)?";
const STAGE_PER_DAY_PATTERN = "(?:(?:每\\s*天|每\\s*一\\s*天|每天|每日|每\\s*次|每次|一\\s*天|一天|各)\\s*)?";
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const WEEKDAY_MAP: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

export type MessageRoute =
  | { kind: "ask"; question: string }
  | { kind: "health"; text: string }
  | { kind: "remember"; text: string }
  | {
      kind: "task_goal";
      text: string;
      title?: string;
      horizonDays?: number;
      totalUnits?: number;
      dailyPortions?: PlannedPortion[];
      restWeekdays?: number[];
      dateSpacingDays?: number;
      activeRestCycle?: ActiveRestCycle;
      startDate?: string;
    }
  | { kind: "task_pause"; text: string; targetTitle?: string }
  | { kind: "task_resume"; text: string; targetTitle?: string }
  | {
      kind: "task_feedback";
      text: string;
      feedback: Feedback;
      targetTitle?: string;
      completedUnit?: number;
      completedRatio?: number;
      remainingUnits?: number;
      extraUnits?: number;
      deferDays?: number;
      dateOffsetDays?: number;
      feedbackDate?: string;
    }
  | { kind: "ignore"; reason: "empty_message" };

/** 纯路由：只根据平台无关消息决定进入问答、记忆或忽略路径。 */
export function routeIncomingMessage(msg: IncomingMessage): MessageRoute {
  const text = msg.text?.trim() ?? "";
  const attachmentText = formatAttachmentText(msg.attachments);
  if (msg.mentionsBot && !text && attachmentText) return { kind: "ask", question: attachmentText };
  if (!text && attachmentText) return { kind: "remember", text: attachmentText };
  if (!text) return { kind: "ignore", reason: "empty_message" };
  const taskGoal = detectTaskGoal(text, msg.ts);
  if (taskGoal) return taskGoal;
  const taskPause = detectTaskPause(text);
  if (taskPause) return taskPause;
  const taskResume = detectTaskResume(text);
  if (taskResume) return taskResume;
  const taskFeedback = detectTaskFeedback(text, msg.ts);
  if (taskFeedback) return taskFeedback;
  if (msg.mentionsBot && isHealthCommand(text)) return { kind: "health", text };
  if (msg.mentionsBot) return { kind: "ask", question: appendAttachmentText(text, attachmentText) };
  return { kind: "remember", text: appendAttachmentText(text, attachmentText) };
}

function isHealthCommand(text: string): boolean {
  return /^(?:health|status|健康检查|健康|状态|自检|检查状态)$/i.test(text);
}

function formatAttachmentText(attachments: IncomingMessage["attachments"]): string | undefined {
  const lines =
    attachments?.flatMap((attachment) => {
      const label = attachment.kind === "image" ? "图片" : "文件";
      const ref = formatAttachmentRef(attachment);
      const summary = ref ? `收到${label}附件：${ref}` : `收到${label}附件`;
      const extractedText = normalizeAttachmentText(attachment.extractedText);
      return extractedText ? [summary, `附件内容：${extractedText}`] : [summary];
    }) ?? [];
  return lines.length ? lines.join("\n") : undefined;
}

function formatAttachmentRef(attachment: NonNullable<IncomingMessage["attachments"]>[number]): string | undefined {
  const ref = attachment.key ?? attachment.url;
  const detail = [ref, attachment.localPath ? `local: ${attachment.localPath}` : undefined].filter(
    (value): value is string => !!value,
  );
  if (attachment.name && detail.length) return `${attachment.name} (${detail.join("; ")})`;
  if (detail.length > 1) return `${detail[0]} (${detail.slice(1).join("; ")})`;
  return attachment.name ?? detail[0];
}

function normalizeAttachmentText(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function appendAttachmentText(text: string, attachmentText: string | undefined): string {
  return attachmentText ? `${text}\n${attachmentText}` : text;
}

function detectTaskGoal(text: string, referenceTs: number): MessageRoute | undefined {
  const explicitDays = parseGoalDurationDays(text);
  const unitsMatch = text.match(new RegExp(`(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}`));
  const completionGoalIntent =
    /(我想|我要|计划|目标|准备).*(读完|看完|做完|练完|写完|刷完|背完|学完|完成)|^(目标|计划)[:：]/.test(
      text,
    );
  const arrangementGoalIntent = !!unitsMatch && /(?:安排|布置)/.test(text);
  const fixedDailyUnits = parseFixedDailyGoalUnits(text);
  const fixedDailyGoalIntent =
    !completionGoalIntent &&
    explicitDays !== undefined &&
    fixedDailyUnits !== undefined &&
    /(?:我想|我要|计划|目标|准备)|^(目标|计划)[:：]/.test(text);
  if (!completionGoalIntent && !fixedDailyGoalIntent && !arrangementGoalIntent) return undefined;

  const startDate = parseTaskStartDate(text, referenceTs);
  const deadlineDate = explicitDays === undefined ? parseGoalDeadlineDate(text, referenceTs) : undefined;
  const startDateForDeadline = startDate ?? dateKeyFromReference(referenceTs, 0);
  const deadlineDays = deadlineDate
    ? normalizePositiveDays(daysBetween(startDateForDeadline, deadlineDate) + 1)
    : undefined;
  const horizonDays = explicitDays ?? deadlineDays;
  const hasSeparateExplicitUnits =
    unitsMatch?.index !== undefined &&
    fixedDailyUnits !== undefined &&
    unitsMatch.index !== fixedDailyUnits.amountIndex;
  const shouldUseFixedDailyUnits =
    fixedDailyUnits !== undefined &&
    horizonDays !== undefined &&
    !hasSeparateExplicitUnits &&
    (fixedDailyGoalIntent || arrangementGoalIntent);
  const totalUnits =
    shouldUseFixedDailyUnits
      ? fixedDailyUnits.units * horizonDays
      : unitsMatch
        ? parsePositiveInteger(unitsMatch[1]!)
        : undefined;
  const explicitDailyPortions =
    horizonDays === undefined || totalUnits === undefined
      ? []
      : parseDailyPortionsWithBounds(text, { horizonDays, totalUnits });
  const inferredPlan =
    explicitDailyPortions.length || totalUnits === undefined || horizonDays !== undefined
      ? undefined
      : inferDailyPortionPlan(text, totalUnits);
  const dailyPortions = inferredPlan?.dailyPortions ?? explicitDailyPortions;
  const resolvedHorizonDays = inferredPlan?.horizonDays ?? horizonDays;
  const titleMatch = text.match(/《([^》]+)》/);
  const restWeekdays = parseRestWeekdays(text);
  const activeRestCycle = parseActiveRestCycle(text);
  const dateSpacingDays = activeRestCycle === undefined ? parseDateSpacingDays(text) : undefined;
  return {
    kind: "task_goal",
    text,
    title: titleMatch?.[1],
    horizonDays: resolvedHorizonDays,
    totalUnits,
    ...(dailyPortions.length ? { dailyPortions } : {}),
    ...(restWeekdays.length ? { restWeekdays } : {}),
    ...(dateSpacingDays === undefined ? {} : { dateSpacingDays }),
    ...(activeRestCycle === undefined ? {} : { activeRestCycle }),
    ...(startDate === undefined ? {} : { startDate }),
  };
}

function parseFixedDailyGoalUnits(text: string): { units: number; amountIndex: number } | undefined {
  const fixedDailyActionPattern = `(?:${TASK_ACTION_PATTERN}|安排|布置)`;
  const match = text.match(
    new RegExp(
      `(?:每\\s*天|每\\s*一\\s*天|每天|每日|一\\s*天|一天)\\s*(?:${fixedDailyActionPattern})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}`,
    ),
  );
  if (!match) return undefined;
  const units = parsePositiveInteger(match[1]!);
  if (units === undefined || match.index === undefined) return undefined;
  return { units, amountIndex: match.index + match[0].indexOf(match[1]!) };
}

function detectTaskPause(text: string): MessageRoute | undefined {
  const targetTitle = parseTargetTitle(text);
  const hasPauseIntent = /(暂停|先停|停一下|放一放|放一下|先放一放|先放一下|搁一搁|搁一下|先搁一下)/.test(text);
  if (
    !(hasPauseIntent && /(任务|目标|学习|阅读)/.test(text)) &&
    !/^(暂停|先停|停一下)$/.test(text) &&
    !(targetTitle && hasPauseIntent)
  ) {
    return undefined;
  }
  return { kind: "task_pause", text, ...(targetTitle === undefined ? {} : { targetTitle }) };
}

function detectTaskResume(text: string): MessageRoute | undefined {
  const targetTitle = parseTargetTitle(text);
  const hasResumeIntent = /(恢复|继续|重启|重新开始|继续做|接着做|接着学|捡起来|重新捡起来|再开始)/.test(text);
  if (
    !(hasResumeIntent && /(任务|目标|学习|阅读)/.test(text)) &&
    !/^(恢复|继续|重启|重新开始)$/.test(text) &&
    !(targetTitle && hasResumeIntent)
  ) {
    return undefined;
  }
  return { kind: "task_resume", text, ...(targetTitle === undefined ? {} : { targetTitle }) };
}

function detectTaskFeedback(text: string, referenceTs: number): MessageRoute | undefined {
  const feedback = classifyFeedback(text, referenceTs);
  if (!feedback) return undefined;
  const targetTitle = parseTargetTitle(text);
  const extraUnits = parseExtraUnits(text);
  const remainingUnits = parseRemainingUnits(text);
  const fullRatio = isFullRatioFeedback(text);
  const completedRatio =
    remainingUnits === undefined && extraUnits === undefined && !fullRatio ? parseCompletedRatio(text) : undefined;
  const completedUnit =
    remainingUnits === undefined && extraUnits === undefined && completedRatio === undefined && !fullRatio
      ? parseCompletedUnit(text)
      : undefined;
  const makeupTargetDate = parseMakeupTargetDate(text, referenceTs);
  const deferDays = parseDeferDays(text, referenceTs, makeupTargetDate);
  const dateOffsetDays = parseFeedbackDateOffsetDays(text);
  const feedbackDate = parseFeedbackDate(text, referenceTs, makeupTargetDate);
  return {
    kind: "task_feedback",
    text,
    feedback,
    ...(targetTitle === undefined ? {} : { targetTitle }),
    ...(completedUnit === undefined ? {} : { completedUnit }),
    ...(completedRatio === undefined ? {} : { completedRatio }),
    ...(remainingUnits === undefined ? {} : { remainingUnits }),
    ...(extraUnits === undefined ? {} : { extraUnits }),
    ...(deferDays === undefined ? {} : { deferDays }),
    ...(dateOffsetDays === undefined ? {} : { dateOffsetDays }),
    ...(feedbackDate === undefined ? {} : { feedbackDate }),
  };
}

function classifyFeedback(text: string, referenceTs: number): Feedback | undefined {
  if (/太难了|太难|难度太大/.test(text)) return "too_hard";
  if (parseExtraUnits(text) !== undefined) return "done";
  if (isFullRatioFeedback(text)) return "done";
  if (parseRemainingUnits(text) !== undefined) return "partial";
  if (parseCompletedRatio(text) !== undefined) return "partial";
  if (parseCompletedQuantityUnits(text) !== undefined) return "partial";
  if (parseContextualProgressEndpointUnit(text) !== undefined) return "partial";
  if (new RegExp(`(?:${TASK_ACTION_PATTERN}完|完成)(了|第|\\s*(?:${POSITIVE_INTEGER_PATTERN}))`).test(text)) {
    return "done";
  }
  if (isCasualDoneFeedback(text)) return "done";
  if (
    new RegExp(
      `(?:没|没有|未)\\s*${TASK_ACTION_PATTERN}完|(?:还)?(?:没|没有|未)\\s*完成|只.*${TASK_ACTION_PATTERN}|部分`,
    ).test(text)
  ) {
    return "partial";
  }
  if (parseMakeupDays(text, referenceTs) !== undefined) return "skip";
  if (parseShortLeaveDays(text) !== undefined) return "skip";
  if (isDatedShortLeaveFeedback(text)) return "skip";
  if (isWeekdayDatedSkipFeedback(text)) return "skip";
  if (isForgottenWorkFeedback(text)) return "skip";
  if (isNotStartedWorkFeedback(text)) return "skip";
  if (isMissedWorkFeedback(text)) return "skip";
  if (isUnavailableFeedback(text)) return "skip";
  if (/跳过|今天不做|今天休息|顺延|延期|推迟/.test(text)) return "skip";
  return undefined;
}

function isCasualDoneFeedback(text: string): boolean {
  if (!/(搞定|搞完|打卡|打完卡)/.test(text)) return false;
  return (
    parseTargetTitle(text) !== undefined ||
    /(?:今天|今晚|这次|本次|任务|目标|学习|阅读|作业)/.test(text)
  );
}

function isUnavailableFeedback(text: string): boolean {
  if (new RegExp(`(?:来不及|没时间|没有时间).*${TASK_ACTION_PATTERN}`).test(text)) return true;
  if (new RegExp(`(?:没来得及|没赶上|没顾(?:得)?上).*${TASK_ACTION_PATTERN}`).test(text)) return true;
  if (new RegExp(`不想\\s*${TASK_ACTION_PATTERN}`).test(text)) return true;
  if (isHealthUnavailableFeedback(text)) return true;
  if (isFutureUnavailableFeedback(text)) return true;
  if (/(?:今天|今晚|今天晚上|这次|本次).*(?:来不及|赶不及|赶不上)(?:了)?/.test(text)) return true;
  if (new RegExp(`(?:今天|今晚|今天晚上|这次|本次).*不\\s*${TASK_ACTION_PATTERN}(?:了)?`).test(text)) return true;
  if (/(?:今天|今晚|今天晚上|这次|本次).*(?:请假|停课)/.test(text)) return true;
  if (
    new RegExp(
      `(?:今天|今晚|今天晚上|这次|本次).*(?:没法|没办法|不方便)(?:继续)?\\s*(?:${TASK_ACTION_PATTERN}|完成|学习|任务)`,
    ).test(text)
  ) {
    return true;
  }
  if (/(?:今天|今晚|今天晚上|这次|本次).*(?:(?:没法|没办法)(?:继续)?|不太方便|不方便)(?:了)?[。！!]*$/.test(text)) {
    return true;
  }
  if (/(?:今天|今晚|今天晚上|这次|本次).*(?:完成不了|搞不定|任务搞不定)/.test(text)) return true;
  if (/(?:今天|今晚|今天晚上|这次|本次).*(?:太忙|忙不过来|作业太多|事情太多|事太多|太多事|状态不好|没状态|状态不行|不舒服|生病|发烧|头疼|头痛|肚子疼|肚子痛|胃疼|胃痛|嗓子疼|喉咙痛|咳嗽|牙疼|牙痛|没精神|没精力|没劲|提不起劲|有点累|累得不行|累坏了|太累|累了|太困|太晚|时间太晚|已经晚了|没空|临时有事|有事|有安排|抽不开身|顾不上)/.test(text)) {
    return true;
  }
  return new RegExp(`${TASK_ACTION_PATTERN}不(?:完(?:了)?|了|下去|动了)`).test(text);
}

function isFutureUnavailableFeedback(text: string): boolean {
  if (/(?:今天|今晚|今天晚上)/.test(text)) return false;
  return isFutureUnavailableFeedbackFor(text, "明天") || isFutureUnavailableFeedbackFor(text, "后天");
}

function isFutureUnavailableFeedbackFor(text: string, day: "明天" | "后天"): boolean {
  if (!text.includes(day)) return false;
  if (new RegExp(`${day}.*(?:来不及|赶不及|赶不上).*${TASK_ACTION_PATTERN}`).test(text)) return true;
  if (new RegExp(`${day}.*不\\s*${TASK_ACTION_PATTERN}(?:了)?`).test(text)) return true;
  if (
    new RegExp(`${day}.*(?:没法|没办法|不方便)(?:继续)?\\s*(?:${TASK_ACTION_PATTERN}|完成|学习|任务)`).test(
      text,
    )
  ) {
    return true;
  }
  if (new RegExp(`${day}.*(?:(?:没法|没办法)(?:继续)?|不太方便|不方便)(?:了)?[。！!]*$`).test(text)) {
    return true;
  }
  if (new RegExp(`${day}.*(?:完成不了|搞不定|任务搞不定)`).test(text)) return true;
  return new RegExp(
    `${day}.*(?:太忙|忙不过来|作业太多|事情太多|事太多|太多事|有事|有安排|没空|抽不开身|顾不上|状态不好|没状态|状态不行|不舒服|生病|感冒|发烧|头疼|头痛|肚子疼|肚子痛|胃疼|胃痛|嗓子疼|喉咙痛|咳嗽|牙疼|牙痛|没精神|没精力|没劲|提不起劲|有点累|累得不行|累坏了|太累|累了|太困|太晚|时间太晚|已经晚了)`,
  ).test(text);
}

function isHealthUnavailableFeedback(text: string): boolean {
  const hasTaskContext =
    /(?:今天|今晚|今天晚上|昨天|前天|这次|本次)/.test(text) || parseTargetTitle(text) !== undefined;
  if (!hasTaskContext) return false;
  return /(?:不舒服|难受|生病|感冒|发烧|头疼|头痛|肚子疼|肚子痛|胃疼|胃痛|拉肚子|腹泻|嗓子疼|喉咙痛|咳嗽|牙疼|牙痛)/.test(
    text,
  );
}

function isForgottenWorkFeedback(text: string): boolean {
  const hasTaskContext =
    /(?:今天|今晚|今天晚上|昨天|前天|这次|本次)/.test(text) || parseTargetTitle(text) !== undefined;
  if (!hasTaskContext) return false;

  const actionPattern = `(?:${TASK_ACTION_PATTERN}|完成(?:任务|作业|目标)?|任务|作业|学习)`;
  return new RegExp(`(?:忘(?:记)?(?:了)?|漏(?:了)?)\\s*${actionPattern}(?:了)?`).test(text);
}

function isNotStartedWorkFeedback(text: string): boolean {
  const hasTargetTitle = parseTargetTitle(text) !== undefined;
  const hasDateContext = /(?:今天|今晚|今天晚上|昨天|前天|这次|本次)/.test(text);
  const hasTaskWord = new RegExp(`${TASK_ACTION_PATTERN}|学习|任务|作业|动笔|碰`).test(text);
  if (!hasTargetTitle && !(hasDateContext && hasTaskWord)) return false;

  const actionPattern = `(?:${TASK_ACTION_PATTERN}|学习|任务|作业)?`;
  if (new RegExp(`(?:还)?(?:没|没有|未)\\s*(?:开始|动手)\\s*${actionPattern}`).test(text)) return true;
  return /(?:还)?(?:没|没有|未)\s*(?:动笔|碰(?:过)?)/.test(text);
}

function isMissedWorkFeedback(text: string): boolean {
  if (new RegExp(`(今天|今晚|昨天|前天|这次|本次).*(没|没有|未)${TASK_ACTION_PATTERN}(?!完)`).test(text)) {
    return true;
  }
  if (hasAbsoluteMissedWorkDate(text)) return true;
  return parseMissedWorkDays(text) !== undefined;
}

function isDatedShortLeaveFeedback(text: string): boolean {
  if (/(?:昨天|前天|明天|后天).*(?:请假|休息|停课)/.test(text)) return true;
  return /(?:\d{4}\s*(?:年|-|\/))?\s*\d{1,2}\s*(?:月|-|\/)\s*\d{1,2}\s*(?:日|号)?.*(?:请假|休息|停课)/.test(text);
}

function isWeekdayDatedSkipFeedback(text: string): boolean {
  const match = matchWeekdayFeedbackDate(text);
  return match ? hasSkipFeedbackIntent(match.tail) : false;
}

function hasAbsoluteMissedWorkDate(text: string): boolean {
  return new RegExp(
    `(?:\\d{4}\\s*(?:年|-|/))?\\s*\\d{1,2}\\s*(?:月|-|/)\\s*\\d{1,2}\\s*(?:日|号)?.*(?:没|没有|未)${TASK_ACTION_PATTERN}(?!完)`,
  ).test(text);
}

function parseCompletedUnit(text: string): number | undefined {
  const limitedQuantity = parseLimitedCompletedQuantityUnits(text);
  if (limitedQuantity !== undefined) return limitedQuantity;
  const contextualEndpointUnit = parseContextualProgressEndpointUnit(text);
  if (contextualEndpointUnit !== undefined) return contextualEndpointUnit;

  const match =
    text.match(new RegExp(`(?:只)?${TASK_ACTION_PATTERN}到\\s*第?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}?`)) ??
    text.match(
      new RegExp(`(?:${TASK_ACTION_PATTERN}完|完成)(?:了)?\\s*(?:大概|大约|约)?\\s*第?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}?`),
    ) ??
    text.match(new RegExp(`(?:只)?${TASK_ACTION_PATTERN}(?:了)?\\s*(?:大概|大约|约)?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${FEEDBACK_UNIT_PATTERN}`));
  if (!match) return undefined;
  return parsePositiveInteger(match[1]!);
}

function parseContextualProgressEndpointUnit(text: string): number | undefined {
  const contextPattern = "(?:今天|今晚|今天晚上|这次|本次|任务|作业|目标|学习|《[^》]+》)";
  if (!new RegExp(contextPattern).test(text)) return undefined;

  const match = text.match(
    new RegExp(
      `(?:${TASK_ACTION_PATTERN})到(?:了)?\\s*(?:大概|大约|约)?\\s*第?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*(?:${FEEDBACK_UNIT_PATTERN})?\\s*(?:左右|上下|附近)?(?=$|[了啦呀啊，,。；;\\s])`,
    ),
  );
  if (!match) return undefined;
  return parsePositiveInteger(match[1]!);
}

function parseCompletedQuantityUnits(text: string): number | undefined {
  const limitedQuantity = parseLimitedCompletedQuantityUnits(text);
  if (limitedQuantity !== undefined) return limitedQuantity;

  const match = text.match(
    new RegExp(
      `(?:完成|${TASK_ACTION_PATTERN})(?:了)?\\s*(?:大概|大约|约)?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${FEEDBACK_UNIT_PATTERN}`,
    ),
  );
  if (!match) return undefined;
  return parsePositiveInteger(match[1]!);
}

function parseLimitedCompletedQuantityUnits(text: string): number | undefined {
  const contextPattern = "(?:今天|今晚|今天晚上|这次|本次|任务|作业|目标|学习|《[^》]+》)";
  const limitPattern = "(?:最多只能|最多|顶多|只能|只够|只来得及|来得及)";
  const match = text.match(
    new RegExp(
      `${contextPattern}[^，,。；;]*${limitPattern}\\s*(?:${TASK_ACTION_PATTERN})?(?:了)?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${FEEDBACK_UNIT_PATTERN}`,
    ),
  );
  if (!match) return undefined;
  return parsePositiveInteger(match[1]!);
}

function parseCompletedRatio(text: string): number | undefined {
  const remainingRatio = parseRemainingRatio(text);
  if (remainingRatio !== undefined) return remainingRatio;

  const lowCompletionRatio = parseLowCompletionRatio(text);
  if (lowCompletionRatio !== undefined) return lowCompletionRatio;

  const nearCompletionRatio = parseNearCompletionRatio(text);
  if (nearCompletionRatio !== undefined) return nearCompletionRatio;

  const belowHalfRatio = parseBelowHalfRatio(text);
  if (belowHalfRatio !== undefined) return belowHalfRatio;

  const aboveHalfRatio = parseAboveHalfRatio(text);
  if (aboveHalfRatio !== undefined) return aboveHalfRatio;

  if (!new RegExp(`${TASK_ACTION_PATTERN}|完成`).test(text) && !isImplicitRatioFeedback(text)) {
    return undefined;
  }
  const qualitativeRatio = parseQualitativeRatio(text);
  if (qualitativeRatio !== undefined) return qualitativeRatio;

  if (new RegExp(HALF_PLUS_RATIO_PATTERN).test(text)) return 0.6;
  if (/一半/.test(text)) return 0.5;

  const fractionMatch = text.match(new RegExp(`(${POSITIVE_INTEGER_PATTERN})\\s*分之\\s*(${POSITIVE_INTEGER_PATTERN})`));
  if (fractionMatch) {
    return normalizeRatio(
      parsePositiveInteger(fractionMatch[2]!),
      parsePositiveInteger(fractionMatch[1]!),
    );
  }

  const chinesePercentMatch = text.match(new RegExp(`百分之\\s*(${POSITIVE_INTEGER_PATTERN})`));
  if (chinesePercentMatch) {
    return normalizeRatio(parsePositiveInteger(chinesePercentMatch[1]!), 100);
  }

  const numericPercentMatch = text.match(/(\d{1,2})\s*%/);
  if (numericPercentMatch) {
    return normalizeRatio(Number(numericPercentMatch[1]), 100);
  }

  const tenthMatch = text.match(new RegExp(`(${POSITIVE_INTEGER_PATTERN})\\s*成`));
  if (tenthMatch) {
    return normalizeRatio(parsePositiveInteger(tenthMatch[1]!), 10);
  }

  return undefined;
}

function parseRemainingRatio(text: string): number | undefined {
  const contextPattern = "(?:今天|今晚|今天晚上|这次|本次|任务|目标|作业|学习|《[^》]+》)";
  if (!new RegExp(contextPattern).test(text)) return undefined;
  const remainingPrefix = "(?:还差|只差|差|还剩|只剩|剩下|剩余)";
  if (new RegExp(`${remainingPrefix}\\s*一半(?![年月天日])`).test(text)) return 0.5;
  const fractionMatch = text.match(
    new RegExp(`${remainingPrefix}\\s*(${POSITIVE_INTEGER_PATTERN})\\s*分之\\s*(${POSITIVE_INTEGER_PATTERN})`),
  );
  if (fractionMatch) {
    const remainingRatio = normalizeRatio(
      parsePositiveInteger(fractionMatch[2]!),
      parsePositiveInteger(fractionMatch[1]!),
    );
    return remainingRatio === undefined ? undefined : 1 - remainingRatio;
  }
  const numericPercentMatch = text.match(new RegExp(`${remainingPrefix}\\s*(\\d{1,2})\\s*%`));
  if (numericPercentMatch) {
    const remainingRatio = normalizeRatio(Number(numericPercentMatch[1]), 100);
    return remainingRatio === undefined ? undefined : 1 - remainingRatio;
  }
  return undefined;
}

function parseBelowHalfRatio(text: string): number | undefined {
  const contextPattern = "(?:今天|今晚|今天晚上|这次|本次|任务|目标|作业|学习|《[^》]+》)";
  if (!new RegExp(contextPattern).test(text)) return undefined;
  if (
    /(?:(?:还)?(?:不|没|没有)到|不到)\s*一半(?![年月天日])|一半\s*不到(?![年月天日])|(?:还)?(?:没|没有|未)\s*过半|(?:还)?(?:没|没有|未)\s*超过\s*一半(?![年月天日])/.test(
      text,
    )
  ) {
    return 0.4;
  }
  if (/(?:(?:还)?(?:不|没|没有)到|不到)\s*50\s*%|50\s*%\s*不到/.test(text)) return 0.4;
  return undefined;
}

function parseAboveHalfRatio(text: string): number | undefined {
  const contextPattern = "(?:今天|今晚|今天晚上|这次|本次|任务|目标|作业|学习|《[^》]+》)";
  if (!new RegExp(contextPattern).test(text)) return undefined;
  return /(?:超过\s*一半|过半)(?![年月天日])/.test(text) ? 0.6 : undefined;
}

function parseLowCompletionRatio(text: string): number | undefined {
  if (new RegExp(`(?:一点|一点儿|一点点|一点点儿|完全|什么|都).*(?:没|没有|未)\\s*${TASK_ACTION_PATTERN}`).test(text)) {
    return undefined;
  }

  const contextPattern = "(?:今天|今晚|今天晚上|这次|本次|任务|作业|目标|学习|《[^》]+》)";
  if (new RegExp(`${contextPattern}.*(?:刚|才)\\s*开始\\s*(?:${TASK_ACTION_PATTERN}|学习|任务|作业)?`).test(text)) {
    return 0.1;
  }
  if (
    new RegExp(
      `${contextPattern}.*(?:只|才|刚)?\\s*(?:${TASK_ACTION_PATTERN}|完成)(?:了)?\\s*(?:一?点点儿?|一?点儿?|一小点|少量)`,
    ).test(text)
  ) {
    return 0.1;
  }
  if (
    new RegExp(
      `${contextPattern}.*(?:没|没有)\\s*${TASK_ACTION_PATTERN}\\s*(?:多少|几个|几道|几题|几页|几章|几个词|几个单词)`,
    ).test(text)
  ) {
    return 0.1;
  }
  if (
    new RegExp(
      `${contextPattern}.*(?:没|没有|未)\\s*(?:怎么|咋)\\s*${TASK_ACTION_PATTERN}(?:完)?`,
    ).test(text)
  ) {
    return 0.1;
  }
  if (
    new RegExp(
      `${contextPattern}.*(?:几乎|基本(?:上)?)\\s*(?:没|没有|未)\\s*${TASK_ACTION_PATTERN}(?:完)?`,
    ).test(text)
  ) {
    return 0.1;
  }
  return undefined;
}

function parseNearCompletionRatio(text: string): number | undefined {
  const contextPattern = "(?:今天|今晚|今天晚上|这次|本次|任务|作业|目标|学习|《[^》]+》)";
  const completionPattern = `(?:${TASK_ACTION_PATTERN}完|完成)`;
  const casualCompletionPattern = "(?:搞定|搞完|打完卡|打卡)";
  const nearCompletionPattern = `(?:${completionPattern}|${casualCompletionPattern})`;
  const tinyRemainderPattern = "(?:还剩|只剩|剩下)\\s*(?:一?点|一点点)";
  if (
    new RegExp(
      `${contextPattern}.*${tinyRemainderPattern}.*(?:(?:没|没有|未)\\s*${TASK_ACTION_PATTERN}(?:完)?|(?:就|快)?\\s*${nearCompletionPattern}(?:了)?)`,
    ).test(text)
  ) {
    return 0.9;
  }
  if (new RegExp(`${contextPattern}.*${tinyRemainderPattern}\\s*(?:了)?$`).test(text)) {
    return 0.9;
  }
  if (
    new RegExp(
      `${contextPattern}.*(?:快(?:要)?|马上|差(?:一)?点(?:就)?|差不多|基本(?:上)?).*${nearCompletionPattern}(?:了)?`,
    ).test(text)
  ) {
    return 0.9;
  }
  if (
    new RegExp(
      `${contextPattern}.*(?:还差|只差|差)\\s*(?:一?点|一点点)(?:\\s*(?:${completionPattern})(?:了)?)?$`,
    ).test(text)
  ) {
    return 0.9;
  }
  return undefined;
}

function parseQualitativeRatio(text: string): number | undefined {
  if (/一?小半(?![年月天日])/.test(text)) return 1 / 3;
  if (/一?(?:大半|多半)(?![年月天日])/.test(text)) return 0.75;
  return undefined;
}

function isImplicitRatioFeedback(text: string): boolean {
  const qualifier = "(?:差不多|大概|大约|约|已经|刚好|基本(?:上)?|差一点)?";
  const contextPattern = new RegExp(
    `^(?:今天|今晚|这次|本次|任务|目标|作业)\\s*${qualifier}\\s*${RATIO_FEEDBACK_PATTERN}\\s*(?:了)?$`,
  );
  if (contextPattern.test(text)) return true;
  return new RegExp(
    `^《[^》]+》\\s*(?:今天|今晚|这次|本次)?\\s*${qualifier}\\s*${RATIO_FEEDBACK_PATTERN}\\s*(?:了)?$`,
  ).test(text);
}

function isFullRatioFeedback(text: string): boolean {
  if (!hasFullRatio(text)) return false;
  if (new RegExp(`${TASK_ACTION_PATTERN}|完成`).test(text)) return true;

  const qualifier = "(?:差不多|大概|大约|约|已经|刚好|完全)?";
  const fullRatioPattern = fullRatioTextPattern();
  const contextPattern = new RegExp(
    `^(?:今天|今晚|这次|本次|任务|目标|作业)\\s*${qualifier}\\s*${fullRatioPattern}\\s*(?:了)?$`,
  );
  if (contextPattern.test(text)) return true;
  return new RegExp(
    `^《[^》]+》\\s*(?:今天|今晚|这次|本次)?\\s*${qualifier}\\s*${fullRatioPattern}\\s*(?:了)?$`,
  ).test(text);
}

function hasFullRatio(text: string): boolean {
  if (/100\s*%/.test(text)) return true;

  const chinesePercentMatch = text.match(new RegExp(`百分之?\\s*(${POSITIVE_INTEGER_PATTERN})`));
  if (chinesePercentMatch && parsePositiveInteger(chinesePercentMatch[1]!) === 100) return true;

  const tenthMatch = text.match(new RegExp(`(${POSITIVE_INTEGER_PATTERN})\\s*成`));
  return !!tenthMatch && parsePositiveInteger(tenthMatch[1]!) === 10;
}

function fullRatioTextPattern(): string {
  return `(?:100\\s*%|百分之?\\s*(?:${POSITIVE_INTEGER_PATTERN})|(?:${POSITIVE_INTEGER_PATTERN})\\s*成)`;
}

function normalizeRatio(numerator: number | undefined, denominator: number | undefined): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator <= 0) return undefined;
  const ratio = numerator / denominator;
  return ratio > 0 && ratio < 1 ? ratio : undefined;
}

function parseRemainingUnits(text: string): number | undefined {
  const match = text.match(
    new RegExp(
      `(?:少(?:读|看|做|学|背|写|练|刷)?(?:了)?|还差|差|还剩|还有|剩下|剩余|剩)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*(?:${FEEDBACK_UNIT_PATTERN}|(?=$|[，,。；;\\s]))`,
    ),
  );
  if (!match) return undefined;
  return parsePositiveInteger(match[1]!);
}

function parseExtraUnits(text: string): number | undefined {
  const match = text.match(
    new RegExp(
      `(?:(?<![最顶不半])多|额外|超额)\\s*(?:${TASK_ACTION_PATTERN})?(?:了)?\\s*(${POSITIVE_INTEGER_PATTERN})(?!\\s*(?:点|点儿|点点|点点儿|些))\\s*${FEEDBACK_UNIT_PATTERN}?`,
    ),
  );
  if (!match) return undefined;
  return parsePositiveInteger(match[1]!);
}

function parseTargetTitle(text: string): string | undefined {
  const title = text.match(/《([^》]+)》/)?.[1]?.trim();
  return title || undefined;
}

function parseDeferDays(
  text: string,
  referenceTs: number,
  makeupTargetDate = parseMakeupTargetDate(text, referenceTs),
): number | undefined {
  const match = text.match(new RegExp(`(?:顺延|延期|推迟)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天`));
  if (match) return parsePositiveInteger(match[1]!);
  const makeupDays = parseMakeupDays(text, referenceTs, makeupTargetDate);
  if (makeupDays !== undefined) return makeupDays;
  const shortLeaveDays = parseShortLeaveDays(text);
  if (shortLeaveDays !== undefined) return shortLeaveDays;
  return parseMissedWorkDays(text);
}

function parseMakeupDays(
  text: string,
  referenceTs: number,
  makeupTargetDate = parseMakeupTargetDate(text, referenceTs),
): number | undefined {
  if (/明天.*补|补.*明天/.test(text)) return 1;
  if (/后天.*补|补.*后天/.test(text)) return 2;
  if (new RegExp(`明天.*再\\s*(?:${TASK_ACTION_PATTERN}|完成|学习|任务)`).test(text)) return 1;
  if (new RegExp(`后天.*再\\s*(?:${TASK_ACTION_PATTERN}|完成|学习|任务)`).test(text)) return 2;
  if (new RegExp(`(?:歇|缓|休)(?:一|1)?\\s*天.*明天.*再\\s*(?:${TASK_ACTION_PATTERN})`).test(text)) {
    return 1;
  }
  if (new RegExp(`(?:歇|缓|休)(?:一|1)?\\s*天.*后天.*再\\s*(?:${TASK_ACTION_PATTERN})`).test(text)) {
    return 2;
  }
  if (makeupTargetDate !== undefined) {
    return normalizePositiveDays(daysBetween(dateKeyFromReference(referenceTs, 0), makeupTargetDate));
  }
  return undefined;
}

function parseShortLeaveDays(text: string): number | undefined {
  const spanMatch = text.match(
    new RegExp(`(?:这|最近|过去)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天.*(?:请假|休息|停课)`),
  );
  if (spanMatch) return parsePositiveInteger(spanMatch[1]!);

  const weekSpanMatch = text.match(
    new RegExp(
      `(?:这|本|上|最近|过去)\\s*(${POSITIVE_INTEGER_PATTERN})?\\s*(?:个)?\\s*(?:周|星期|礼拜)(?!\\s*[一二三四五六日天]).*(?:请假|休息|停课)`,
    ),
  );
  if (weekSpanMatch) return parseOptionalWeekCountDays(weekSpanMatch);

  const actionFirstMatch = text.match(
    new RegExp(`(?:请假|休息|停课)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天`),
  );
  if (actionFirstMatch) return parsePositiveInteger(actionFirstMatch[1]!);

  const weekActionFirstMatch = text.match(
    new RegExp(`(?:请假|休息|停课)\\s*(${POSITIVE_INTEGER_PATTERN})?\\s*(?:个)?\\s*(?:周|星期|礼拜)`),
  );
  if (weekActionFirstMatch) return parseOptionalWeekCountDays(weekActionFirstMatch);

  const splitLeaveMatch = text.match(
    new RegExp(`请\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天假`),
  );
  if (splitLeaveMatch) return parsePositiveInteger(splitLeaveMatch[1]!);

  const shortRestMatch = text.match(
    new RegExp(`(?:休|歇)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天`),
  );
  if (shortRestMatch) return parsePositiveInteger(shortRestMatch[1]!);

  const splitClassOffMatch = text.match(
    new RegExp(`停\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天课`),
  );
  if (splitClassOffMatch) return parsePositiveInteger(splitClassOffMatch[1]!);

  const weekSplitLeaveMatch = text.match(
    new RegExp(`请\\s*(${POSITIVE_INTEGER_PATTERN})?\\s*(?:个)?\\s*(?:周|星期|礼拜)假`),
  );
  if (weekSplitLeaveMatch) return parseOptionalWeekCountDays(weekSplitLeaveMatch);

  return undefined;
}

function parseOptionalWeekCountDays(match: RegExpMatchArray): number | undefined {
  const weeks = match[1] ? parsePositiveInteger(match[1]) : 1;
  return weeks === undefined ? undefined : weeks * 7;
}

function parseMissedWorkDays(text: string): number | undefined {
  const dayMatch = text.match(
    new RegExp(`(?:这|最近|过去)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天.*(?:没|没有|未)${TASK_ACTION_PATTERN}(?!完)`),
  );
  if (dayMatch) return parsePositiveInteger(dayMatch[1]!);

  const weekMatch = text.match(
    new RegExp(
      `(?:这|本|上|最近|过去)\\s*(${POSITIVE_INTEGER_PATTERN})?\\s*(?:个)?\\s*(?:周|星期|礼拜)(?!\\s*[一二三四五六日天]).*(?:没|没有|未)${TASK_ACTION_PATTERN}(?!完)`,
    ),
  );
  const weeks = weekMatch ? (weekMatch[1] ? parsePositiveInteger(weekMatch[1]) : 1) : undefined;
  return weeks === undefined ? undefined : weeks * 7;
}

function parseFeedbackDateOffsetDays(text: string): number | undefined {
  if (/前天/.test(text)) return -2;
  if (/昨天/.test(text)) return -1;
  if (!/(?:今天|今晚|今天晚上)/.test(text)) {
    if (/后天.*(?:请假|休息|停课)/.test(text) || isFutureUnavailableFeedbackFor(text, "后天")) return 2;
    if (/明天.*(?:请假|休息|停课)/.test(text) || isFutureUnavailableFeedbackFor(text, "明天")) return 1;
  }
  return undefined;
}

function parseGoalDurationDays(text: string): number | undefined {
  const dayPattern = new RegExp(`(${POSITIVE_INTEGER_PATTERN})\\s*天`, "g");
  for (const match of text.matchAll(dayPattern)) {
    const index = match.index ?? 0;
    const endIndex = index + match[0].length;
    if (isStageDurationMatch(text, index, endIndex)) continue;
    const days = parsePositiveInteger(match[1]!);
    if (days !== undefined) return days;
  }

  const weekPattern = new RegExp(
    `(${POSITIVE_INTEGER_PATTERN})\\s*(?:个)?\\s*(?:周|星期|礼拜)(?:内|以内|之内)?`,
    "g",
  );
  for (const match of text.matchAll(weekPattern)) {
    const index = match.index ?? 0;
    if (index > 0 && text[index - 1] === "每") continue;
    const weeks = parsePositiveInteger(match[1]!);
    if (weeks !== undefined) return weeks * 7;
  }
  return undefined;
}

function isStageDurationMatch(text: string, index: number, endIndex: number): boolean {
  const before = text.slice(Math.max(0, index - 16), index);
  const after = text.slice(endIndex);
  if (/(?:第|每|前|后|先|头|中间|中段|最后|末尾|剩下|剩余|余下|其余|接下来|前面|后面)\s*$/.test(before)) {
    return true;
  }
  if (
    new RegExp(
      `(?:前|后|先|头|中间|中段|最后|末尾|剩下|剩余|余下|其余|接下来|前面|后面)\\s*${TASK_ACTION_PATTERN}\\s*$`,
    ).test(before)
  ) {
    return true;
  }
  if (/(?<!周)(?<!星期)(?<!礼拜)一开始\s*$|(?:最开始|最初|起初)\s*$/.test(before)) {
    return true;
  }
  if (/(?:^|[，,、；;\s])开始\s*$/.test(before)) {
    return true;
  }
  if (/(?:前|后|先|头|中间|中段|最后|末尾|剩下|剩余|余下|其余|接下来|前面|后面|再|然后|接着|之后|后续)\s*(?:用|花)\s*$/.test(before)) {
    return true;
  }
  if (new RegExp(`^\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}`).test(after)) {
    return true;
  }
  return new RegExp(`(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}\\s*(?:${TASK_ACTION_PATTERN})?\\s*$`).test(
    before,
  );
}

function parseGoalDeadlineDate(text: string, referenceTs: number): string | undefined {
  const weekPeriodDate = parseWeekPeriodDeadlineDate(text, referenceTs);
  if (weekPeriodDate) return weekPeriodDate;

  const weekendDate = parseWeekendDeadlineDate(text, referenceTs);
  if (weekendDate) return weekendDate;

  const relativeWeekdayDate = parseNextWeekdayDeadlineDate(text, referenceTs);
  if (relativeWeekdayDate) return relativeWeekdayDate;

  const bareWeekdayDate = parseBareWeekdayDeadlineDate(text, referenceTs);
  if (bareWeekdayDate) return bareWeekdayDate;

  const bareWeekDate = parseBareWeekDeadlineDate(text, referenceTs);
  if (bareWeekDate) return bareWeekDate;

  const monthPeriodDate = parseMonthPeriodDeadlineDate(text, referenceTs);
  if (monthPeriodDate) return monthPeriodDate;

  const monthEndDate = parseMonthEndDeadlineDate(text, referenceTs);
  if (monthEndDate) return monthEndDate;

  const relativeMonthDayDate = parseRelativeMonthDayDeadlineDate(text, referenceTs);
  if (relativeMonthDayDate) return relativeMonthDayDate;

  const bareMonthDate = parseBareMonthDeadlineDate(text, referenceTs);
  if (bareMonthDate) return bareMonthDate;

  const datePattern = String.raw`(?:(\d{4})\s*(?:年|-|\/))?\s*(\d{1,2})\s*(?:月|-|\/)\s*(\d{1,2})\s*(?:日|号)?`;
  const match =
    text.match(new RegExp(`${datePattern}\\s*(?:前|之前|以前)`)) ??
    text.match(new RegExp(`(?:截止|截至|到)\\s*${datePattern}`));
  if (!match) return undefined;

  return resolveDateKeyOnOrAfterReference({
    explicitYear: match[1] ? Number(match[1]) : undefined,
    month: Number(match[2]),
    day: Number(match[3]),
    referenceTs,
  });
}

function parseMonthEndDeadlineDate(text: string, referenceTs: number): string | undefined {
  const match =
    text.match(/(下|本|这|这个)?月?底\s*(?:前|之前|以前)/) ??
    text.match(/(?:截止|截至|到)\s*(下|本|这|这个)?月?底/);
  if (!match) return undefined;

  const referenceDate = new Date(referenceTs);
  const monthOffset = match[1] === "下" ? 1 : 0;
  const lastDay = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + monthOffset + 1, 0));
  return formatDateKey(lastDay.getUTCFullYear(), lastDay.getUTCMonth() + 1, lastDay.getUTCDate());
}

function parseMonthPeriodDeadlineDate(text: string, referenceTs: number): string | undefined {
  const match = text.match(/(下个月|下月|本月|这个月|这月)\s*(?:内|以内|之内)/);
  if (!match) return undefined;

  const referenceDate = new Date(referenceTs);
  const monthOffset = match[1]!.startsWith("下") ? 1 : 0;
  const lastDay = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + monthOffset + 1, 0));
  return formatDateKey(lastDay.getUTCFullYear(), lastDay.getUTCMonth() + 1, lastDay.getUTCDate());
}

function parseBareMonthDeadlineDate(text: string, referenceTs: number): string | undefined {
  const actionPattern = `(?:${TASK_ACTION_PATTERN}\\s*完?|完成)`;
  const match = text.match(new RegExp(`(下个月|下月|本月|这个月|这月)\\s*${actionPattern}`));
  if (!match) return undefined;

  const referenceDate = new Date(referenceTs);
  const monthOffset = match[1]!.startsWith("下") ? 1 : 0;
  const lastDay = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + monthOffset + 1, 0));
  return formatDateKey(lastDay.getUTCFullYear(), lastDay.getUTCMonth() + 1, lastDay.getUTCDate());
}

function parseRelativeMonthDayDeadlineDate(text: string, referenceTs: number): string | undefined {
  const pattern = new RegExp(
    `(下个月|下月|本月|这个月|这月)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*(?:日|号)`,
  );
  const match =
    text.match(new RegExp(`${pattern.source}\\s*(?:前|之前|以前)`)) ??
    text.match(new RegExp(`(?:截止|截至|到)\\s*${pattern.source}`));
  if (!match) return undefined;
  return relativeMonthDayDateKey(match[1]!, match[2]!, referenceTs);
}

function parseBareWeekDeadlineDate(text: string, referenceTs: number): string | undefined {
  const actionPattern = `(?:${TASK_ACTION_PATTERN}\\s*完?|完成)`;
  const match = text.match(new RegExp(`(下(?:个)?|这(?:个)?|本)(周|星期|礼拜)\\s*${actionPattern}`));
  if (!match) return undefined;
  const weekText = match[1]!.startsWith("下") ? "下周" : "这周";
  return relativeWeekdayDateKey(weekText, "日", referenceTs);
}

function parseWeekPeriodDeadlineDate(text: string, referenceTs: number): string | undefined {
  const match = text.match(/(下(?:个)?|这(?:个)?|本)(周|星期|礼拜)\s*(?:内|以内|之内)/);
  if (!match) return undefined;
  const weekText = match[1]!.startsWith("下") ? "下周" : "这周";
  return relativeWeekdayDateKey(weekText, "日", referenceTs);
}

function parseWeekendDeadlineDate(text: string, referenceTs: number): string | undefined {
  const weekendPattern = String.raw`(下(?:个)?(?:周末|星期末|礼拜末)|这(?:个)?(?:周末|星期末|礼拜末)|本(?:周末|星期末|礼拜末))`;
  const match =
    text.match(new RegExp(`${weekendPattern}\\s*(?:前|之前|以前)`)) ??
    text.match(new RegExp(`(?:截止|截至|到)\\s*${weekendPattern}`));
  if (!match) return undefined;
  const weekText = match[1]!.startsWith("下") ? "下周" : "这周";
  return relativeWeekdayDateKey(weekText, "日", referenceTs);
}

function parseNextWeekdayDeadlineDate(text: string, referenceTs: number): string | undefined {
  const match =
    text.match(/(下周|下星期|下礼拜|这周|这星期|这礼拜|本周|本星期|本礼拜)\s*([一二三四五六日天])\s*(?:前|之前|以前)/) ??
    text.match(/(?:截止|截至|到)\s*(下周|下星期|下礼拜|这周|这星期|这礼拜|本周|本星期|本礼拜)\s*([一二三四五六日天])/);
  if (!match) return undefined;

  return relativeWeekdayDateKey(match[1]!, match[2]!, referenceTs);
}

function parseBareWeekdayDeadlineDate(text: string, referenceTs: number): string | undefined {
  const match =
    text.match(/(?<![下这本每])(?:周|星期|礼拜)\s*([一二三四五六日天])\s*(?:前|之前|以前)/) ??
    text.match(/(?:截止|截至|到)\s*(?<![下这本每])(?:周|星期|礼拜)\s*([一二三四五六日天])/);
  if (!match) return undefined;

  return relativeWeekdayDateKey("这周", match[1]!, referenceTs);
}

function parseTaskStartDate(text: string, referenceTs: number): string | undefined {
  const relativeOffset = parseTaskStartOffsetDays(text);
  if (relativeOffset !== undefined) {
    return dateKeyFromReference(referenceTs, relativeOffset);
  }
  return (
    parseNextWeekdayTaskStartDate(text, referenceTs) ??
    parseBareWeekdayTaskStartDate(text, referenceTs) ??
    parseRelativeMonthDayTaskStartDate(text, referenceTs) ??
    parseRelativePeriodTaskStartDate(text, referenceTs) ??
    parseAbsoluteTaskStartDate(text, referenceTs)
  );
}

function parseTaskStartOffsetDays(text: string): number | undefined {
  if (!/(?:开始|起|启动)/.test(text)) return undefined;
  if (/(?:从|自)?\s*今天\s*(?:开始|起|启动)/.test(text)) return 0;
  if (/(?:从|自)?\s*明天\s*(?:开始|起|启动)/.test(text)) return 1;
  if (/(?:从|自)?\s*后天\s*(?:开始|起|启动)/.test(text)) return 2;
  return undefined;
}

function parseAbsoluteTaskStartDate(text: string, referenceTs: number): string | undefined {
  const match = text.match(
    /(?:从|自)?\s*(?:(\d{4})\s*(?:年|-|\/))?\s*(\d{1,2})\s*(?:月|-|\/)\s*(\d{1,2})\s*(?:日|号)?\s*(?:开始|起|启动)/,
  );
  if (!match) return undefined;

  return resolveDateKeyOnOrAfterReference({
    explicitYear: match[1] ? Number(match[1]) : undefined,
    month: Number(match[2]),
    day: Number(match[3]),
    referenceTs,
  });
}

function parseRelativeMonthDayTaskStartDate(text: string, referenceTs: number): string | undefined {
  const match = text.match(
    new RegExp(
      `(?:从|自)?\\s*(下个月|下月|本月|这个月|这月)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*(?:日|号)\\s*(?:开始|起|启动)`,
    ),
  );
  if (!match) return undefined;
  return relativeMonthDayDateKey(match[1]!, match[2]!, referenceTs);
}

function parseRelativePeriodTaskStartDate(text: string, referenceTs: number): string | undefined {
  const weekMatch = text.match(
    /(?:从|自)?\s*(下周|下星期|下礼拜)\s*(?:开始|起|启动)/,
  );
  if (weekMatch) return relativeWeekdayDateKey(weekMatch[1]!, "一", referenceTs);

  const monthMatch = text.match(
    /(?:从|自)?\s*(下个月|下月)\s*(?:开始|起|启动)/,
  );
  if (monthMatch) return relativeMonthDayDateKey(monthMatch[1]!, "1", referenceTs);

  return undefined;
}

function parseNextWeekdayTaskStartDate(text: string, referenceTs: number): string | undefined {
  const match = text.match(
    /(?:从|自)?\s*(下周|下星期|下礼拜|这周|这星期|这礼拜|本周|本星期|本礼拜)\s*([一二三四五六日天])\s*(?:开始|起|启动)/,
  );
  if (!match) return undefined;

  return relativeWeekdayDateKey(match[1]!, match[2]!, referenceTs);
}

function parseBareWeekdayTaskStartDate(text: string, referenceTs: number): string | undefined {
  const match = text.match(/(?:从|自)?\s*(?<![下这本每])(?:周|星期|礼拜)\s*([一二三四五六日天])\s*(?:开始|起|启动)/);
  if (!match) return undefined;

  return relativeWeekdayDateKey("这周", match[1]!, referenceTs);
}

function relativeWeekdayDateKey(weekText: string, weekdayText: string, referenceTs: number): string | undefined {
  const targetWeekday = WEEKDAY_MAP[weekdayText];
  if (targetWeekday === undefined) return undefined;

  const referenceWeekday = new Date(referenceTs).getUTCDay();
  const referenceMondayOffset = -weekdayToMondayIndex(referenceWeekday);
  const daysUntilTargetWeekMonday = /^(?:下周|下星期|下礼拜)$/.test(weekText)
    ? referenceMondayOffset + 7
    : referenceMondayOffset;
  const targetOffset = weekdayToMondayIndex(targetWeekday);
  const dateKey = dateKeyFromReference(referenceTs, daysUntilTargetWeekMonday + targetOffset);
  return dateKey < dateKeyFromReference(referenceTs, 0) ? undefined : dateKey;
}

function weekdayToMondayIndex(weekday: number): number {
  return weekday === 0 ? 6 : weekday - 1;
}

function relativeMonthDayDateKey(monthText: string, dayText: string, referenceTs: number): string | undefined {
  const day = parsePositiveInteger(dayText);
  if (day === undefined) return undefined;

  const referenceDate = new Date(referenceTs);
  const monthOffset = monthText.startsWith("下") ? 1 : 0;
  const targetMonth = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + monthOffset, 1));
  const dateKey = formatValidDateKey(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, day);
  if (!dateKey) return undefined;
  return dateKey < dateKeyFromReference(referenceTs, 0) ? undefined : dateKey;
}

function parseExplicitDailyPortions(
  text: string,
  bounds: { horizonDays?: number; totalUnits?: number },
): PlannedPortion[] {
  const portions: PlannedPortion[] = [];
  let hasRange = false;
  const pattern = new RegExp(
    `第\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天\\s*(?:${TASK_ACTION_PATTERN})?(?:完|到)?\\s*第?\\s*(${POSITIVE_INTEGER_PATTERN})(?:\\s*(?:到|至|-|~)\\s*第?\\s*(${POSITIVE_INTEGER_PATTERN}))?\\s*${TASK_UNIT_PATTERN}?`,
    "g",
  );
  for (const match of text.matchAll(pattern)) {
    const day = parsePositiveInteger(match[1]!);
    const unitFrom = parsePositiveInteger(match[2]!);
    const rangeEndText = match[3];
    const unitTo = parsePositiveInteger(rangeEndText ?? match[2]!);
    if (day === undefined || unitFrom === undefined || unitTo === undefined) return [];
    if (rangeEndText) hasRange = true;
    portions.push({ day, unitFrom, unitTo });
  }

  if (!portions.length) return [];
  const amountPortions = buildExplicitAmountPortions(portions, hasRange, bounds);
  if (amountPortions.length) return amountPortions;

  const seenDays = new Set<number>();
  for (const portion of portions) {
    if (portion.unitTo < portion.unitFrom) return [];
    if (bounds.horizonDays !== undefined && portion.day > bounds.horizonDays) return [];
    if (bounds.totalUnits !== undefined && portion.unitTo > bounds.totalUnits) return [];
    if (seenDays.has(portion.day)) return [];
    seenDays.add(portion.day);
  }
  return portions.sort((a, b) => a.day - b.day);
}

function buildExplicitAmountPortions(
  portions: PlannedPortion[],
  hasRange: boolean,
  bounds: { horizonDays?: number; totalUnits?: number },
): PlannedPortion[] {
  if (hasRange || bounds.horizonDays === undefined || bounds.totalUnits === undefined) return [];
  if (portions.length !== bounds.horizonDays) return [];
  const sorted = [...portions].sort((a, b) => a.day - b.day);
  if (sorted.some((portion, index) => portion.day !== index + 1 || portion.unitFrom !== portion.unitTo)) {
    return [];
  }
  const totalAmount = sorted.reduce((sum, portion) => sum + portion.unitFrom, 0);
  if (totalAmount !== bounds.totalUnits) return [];

  const amountPortions: PlannedPortion[] = [];
  let unitFrom = 1;
  for (const portion of sorted) {
    const unitTo = unitFrom + portion.unitFrom - 1;
    amountPortions.push({ day: portion.day, unitFrom, unitTo });
    unitFrom = unitTo + 1;
  }
  return amountPortions;
}

function parseDailyPortionsWithBounds(
  text: string,
  bounds: { horizonDays: number; totalUnits: number },
): PlannedPortion[] {
  const stagedDailyPortions = parseStagedDailyPortions(text, bounds);
  return stagedDailyPortions.length ? stagedDailyPortions : parseExplicitDailyPortions(text, bounds);
}

function inferDailyPortionPlan(
  text: string,
  totalUnits: number,
): { horizonDays: number; dailyPortions: PlannedPortion[] } | undefined {
  for (let horizonDays = 1; horizonDays <= 365; horizonDays++) {
    const dailyPortions = parseDailyPortionsWithBounds(text, { horizonDays, totalUnits });
    if (dailyPortions.length) return { horizonDays, dailyPortions };
  }
  return undefined;
}

function parseStagedDailyPortions(
  text: string,
  bounds: { horizonDays?: number; totalUnits?: number },
): PlannedPortion[] {
  if (bounds.horizonDays === undefined || bounds.totalUnits === undefined) return [];
  const checkedBounds = { horizonDays: bounds.horizonDays, totalUnits: bounds.totalUnits };
  const listedPortions = parseListedDailyPortions(text, checkedBounds);
  if (listedPortions.length) return listedPortions;

  const namedStagePortions = parseNamedStageDailyPortions(text, checkedBounds);
  if (namedStagePortions.length) return namedStagePortions;

  const rangedPortions = parseRangedStageDailyPortions(text, checkedBounds);
  if (rangedPortions.length) return rangedPortions;

  const halfStagePortions = parseHalfStageDailyPortions(text, checkedBounds);
  if (halfStagePortions.length) return halfStagePortions;

  const startDayStagePortions = parseStartDayStageDailyPortions(text, checkedBounds);
  if (startDayStagePortions.length) return startDayStagePortions;

  const threeStagePortions = parseThreeStageDailyPortions(text, checkedBounds);
  if (threeStagePortions.length) return threeStagePortions;
  if (/(?:中间|中段|中间阶段|中间几天)/.test(text)) return [];

  const remainingStagePortions = parseRemainingStageDailyPortions(text, checkedBounds);
  if (remainingStagePortions.length) return remainingStagePortions;

  const sequentialStagePortions = parseSequentialStageDailyPortions(text, checkedBounds);
  if (sequentialStagePortions.length) return sequentialStagePortions;

  const pattern = new RegExp(
    `(前|后)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}`,
    "g",
  );
  const stages: Partial<Record<"前" | "后", { days: number; unitsPerDay: number }>> = {};
  for (const match of text.matchAll(pattern)) {
    const position = match[1] as "前" | "后";
    if (stages[position]) return [];
    const days = parsePositiveInteger(match[2]!);
    const unitsPerDay = parsePositiveInteger(match[3]!);
    if (days === undefined || unitsPerDay === undefined) return [];
    stages[position] = { days, unitsPerDay };
  }

  const front = stages.前;
  const back = stages.后;
  if (!front || !back) return [];
  if (front.days + back.days !== checkedBounds.horizonDays) return [];
  if (front.days * front.unitsPerDay + back.days * back.unitsPerDay !== checkedBounds.totalUnits) {
    return [];
  }

  const portions: PlannedPortion[] = [];
  let unitFrom = 1;
  for (const stage of [front, back]) {
    for (let index = 0; index < stage.days; index++) {
      const unitTo = unitFrom + stage.unitsPerDay - 1;
      portions.push({ day: portions.length + 1, unitFrom, unitTo });
      unitFrom = unitTo + 1;
    }
  }
  return portions;
}

function parseListedDailyPortions(
  text: string,
  bounds: { horizonDays: number; totalUnits: number },
): PlannedPortion[] {
  const listMatch = text.match(
    new RegExp(
      `(?:(?:每天|每日)(?:分别|依次)?|(?:依次|分别)(?:每天|每日)|(?:每天|每日)\\s*(?:${TASK_ACTION_PATTERN})?)\\s*(.+)$`,
    ),
  );
  if (!listMatch) return [];
  const tail = listMatch[1]!;
  const amountPattern = new RegExp(
    `(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*(?:${TASK_UNIT_PATTERN}|个)?`,
    "g",
  );
  const amounts: number[] = [];
  for (const match of tail.matchAll(amountPattern)) {
    const amount = parsePositiveInteger(match[1]!);
    if (amount === undefined) return [];
    amounts.push(amount);
  }

  if (amounts.length !== bounds.horizonDays) return [];
  if (amounts.reduce((sum, amount) => sum + amount, 0) !== bounds.totalUnits) return [];

  const portions: PlannedPortion[] = [];
  let unitFrom = 1;
  amounts.forEach((amount, index) => {
    const unitTo = unitFrom + amount - 1;
    portions.push({ day: index + 1, unitFrom, unitTo });
    unitFrom = unitTo + 1;
  });
  return portions;
}

function parseNamedStageDailyPortions(
  text: string,
  bounds: { horizonDays: number; totalUnits: number },
): PlannedPortion[] {
  const daysFirstPattern = new RegExp(
    `(?:第\\s*(${POSITIVE_INTEGER_PATTERN})\\s*阶段|阶段\\s*(${POSITIVE_INTEGER_PATTERN}))\\s*(?:安排|计划)?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}`,
    "g",
  );
  const unitsFirstPattern = new RegExp(
    `(?:第\\s*(${POSITIVE_INTEGER_PATTERN})\\s*阶段|阶段\\s*(${POSITIVE_INTEGER_PATTERN}))\\s*(?:安排|计划)?\\s*${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}\\s*(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天`,
    "g",
  );
  const stages: Array<{ order: number; days: number; unitsPerDay: number }> = [];
  for (const match of text.matchAll(daysFirstPattern)) {
    const order = parsePositiveInteger(match[1] ?? match[2]!);
    const days = parsePositiveInteger(match[3]!);
    const unitsPerDay = parsePositiveInteger(match[4]!);
    if (order === undefined || days === undefined || unitsPerDay === undefined) return [];
    stages.push({ order, days, unitsPerDay });
  }
  for (const match of text.matchAll(unitsFirstPattern)) {
    const order = parsePositiveInteger(match[1] ?? match[2]!);
    const unitsPerDay = parsePositiveInteger(match[3]!);
    const days = parsePositiveInteger(match[4]!);
    if (order === undefined || days === undefined || unitsPerDay === undefined) return [];
    stages.push({ order, days, unitsPerDay });
  }
  if (!stages.length) return [];

  const sorted = stages.sort((a, b) => a.order - b.order);
  const seenOrders = new Set<number>();
  let expectedOrder = 1;
  let totalDays = 0;
  let totalUnits = 0;
  for (const stage of sorted) {
    if (seenOrders.has(stage.order) || stage.order !== expectedOrder) return [];
    seenOrders.add(stage.order);
    expectedOrder++;
    totalDays += stage.days;
    totalUnits += stage.days * stage.unitsPerDay;
  }
  if (totalDays !== bounds.horizonDays || totalUnits !== bounds.totalUnits) return [];

  const portions: PlannedPortion[] = [];
  let unitFrom = 1;
  for (const stage of sorted) {
    for (let index = 0; index < stage.days; index++) {
      const unitTo = unitFrom + stage.unitsPerDay - 1;
      portions.push({ day: portions.length + 1, unitFrom, unitTo });
      unitFrom = unitTo + 1;
    }
  }
  return portions;
}

function parseRemainingStageDailyPortions(
  text: string,
  bounds: { horizonDays: number; totalUnits: number },
): PlannedPortion[] {
  const pattern = new RegExp(
    `(前|后|先|头|前面|一开始|最开始|最初|起初|开始)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}.*?(?:剩下|剩余|余下|其余|之后|以后|后面|后续|接下来|最后面|最后|末尾)(?:的)?\\s*(?:(${POSITIVE_INTEGER_PATTERN})\\s*天)?${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}`,
  );
  const match = text.match(pattern);
  if (!match) return [];

  const position = match[1] === "后" ? "后" : "前";
  const stageDays = parsePositiveInteger(match[2]!);
  const stageUnitsPerDay = parsePositiveInteger(match[3]!);
  const explicitRemainingDays = match[4] ? parsePositiveInteger(match[4]) : undefined;
  const remainingUnitsPerDay = parsePositiveInteger(match[5]!);
  if (stageDays === undefined || stageUnitsPerDay === undefined || remainingUnitsPerDay === undefined) {
    return [];
  }
  const remainingDays = bounds.horizonDays - stageDays;
  if (remainingDays <= 0) return [];
  if (explicitRemainingDays !== undefined && explicitRemainingDays !== remainingDays) return [];
  const totalUnits = stageDays * stageUnitsPerDay + remainingDays * remainingUnitsPerDay;
  if (totalUnits !== bounds.totalUnits) return [];

  const frontAmounts =
    position === "前"
      ? [
          ...Array(stageDays).fill(stageUnitsPerDay),
          ...Array(remainingDays).fill(remainingUnitsPerDay),
        ]
      : [
          ...Array(remainingDays).fill(remainingUnitsPerDay),
          ...Array(stageDays).fill(stageUnitsPerDay),
        ];

  const portions: PlannedPortion[] = [];
  let unitFrom = 1;
  frontAmounts.forEach((amount, index) => {
    const unitTo = unitFrom + amount - 1;
    portions.push({ day: index + 1, unitFrom, unitTo });
    unitFrom = unitTo + 1;
  });
  return portions;
}

function parseStartDayStageDailyPortions(
  text: string,
  bounds: { horizonDays: number; totalUnits: number },
): PlannedPortion[] {
  const pattern = new RegExp(
    `(前|先|头|前面|一开始|最开始|最初|起初|开始)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}.*?(?:从\\s*)?第\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天\\s*(?:开始|起|以后|之后|往后|后)${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}`,
  );
  const match = text.match(pattern);
  if (!match) return [];

  const firstDays = parsePositiveInteger(match[2]!);
  const firstUnitsPerDay = parsePositiveInteger(match[3]!);
  const secondStartDay = parsePositiveInteger(match[4]!);
  const secondUnitsPerDay = parsePositiveInteger(match[5]!);
  if (
    firstDays === undefined ||
    firstUnitsPerDay === undefined ||
    secondStartDay === undefined ||
    secondUnitsPerDay === undefined
  ) {
    return [];
  }
  if (secondStartDay !== firstDays + 1) return [];
  const secondDays = bounds.horizonDays - firstDays;
  if (secondDays <= 0) return [];
  if (firstDays * firstUnitsPerDay + secondDays * secondUnitsPerDay !== bounds.totalUnits) {
    return [];
  }

  const portions: PlannedPortion[] = [];
  let unitFrom = 1;
  for (const unitsPerDay of [
    ...Array(firstDays).fill(firstUnitsPerDay),
    ...Array(secondDays).fill(secondUnitsPerDay),
  ]) {
    const unitTo = unitFrom + unitsPerDay - 1;
    portions.push({ day: portions.length + 1, unitFrom, unitTo });
    unitFrom = unitTo + 1;
  }
  return portions;
}

function parseThreeStageDailyPortions(
  text: string,
  bounds: { horizonDays: number; totalUnits: number },
): PlannedPortion[] {
  const pattern = new RegExp(
    `(?:前|先|头|前面|一开始|最开始|最初|起初|开始)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}.*?(?:中间|中段|中间阶段|中间几天)\\s*(?:(${POSITIVE_INTEGER_PATTERN})\\s*天)?${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}.*?(?:最后面|最后|末尾|后面)\\s*(?:(${POSITIVE_INTEGER_PATTERN})\\s*天)?${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}`,
  );
  const match = text.match(pattern);
  if (!match) return [];

  const frontDays = parsePositiveInteger(match[1]!);
  const frontUnitsPerDay = parsePositiveInteger(match[2]!);
  const explicitMiddleDays = match[3] ? parsePositiveInteger(match[3]) : undefined;
  const middleUnitsPerDay = parsePositiveInteger(match[4]!);
  const explicitBackDays = match[5] ? parsePositiveInteger(match[5]) : undefined;
  const backUnitsPerDay = parsePositiveInteger(match[6]!);
  if (
    frontDays === undefined ||
    frontUnitsPerDay === undefined ||
    middleUnitsPerDay === undefined ||
    backUnitsPerDay === undefined
  ) {
    return [];
  }
  const remainingDays = bounds.horizonDays - frontDays;
  if (remainingDays <= 1) return [];
  const inferredStageDays =
    explicitMiddleDays === undefined && explicitBackDays === undefined
      ? inferTwoStageDays({
          remainingDays,
          remainingUnits:
            bounds.totalUnits -
            frontDays * frontUnitsPerDay,
          middleUnitsPerDay,
          backUnitsPerDay,
        })
      : undefined;
  if (explicitMiddleDays === undefined && explicitBackDays === undefined && !inferredStageDays) return [];
  const middleDays =
    explicitMiddleDays ?? inferredStageDays?.middleDays ?? remainingDays - explicitBackDays!;
  const backDays = explicitBackDays ?? inferredStageDays?.backDays ?? remainingDays - explicitMiddleDays!;
  if (middleDays <= 0 || backDays <= 0 || middleDays + backDays !== remainingDays) return [];
  const stages = [
    { days: frontDays, unitsPerDay: frontUnitsPerDay },
    { days: middleDays, unitsPerDay: middleUnitsPerDay },
    { days: backDays, unitsPerDay: backUnitsPerDay },
  ];
  const checkedStages = stages;
  if (checkedStages.reduce((sum, stage) => sum + stage.days, 0) !== bounds.horizonDays) return [];
  if (
    checkedStages.reduce((sum, stage) => sum + stage.days * stage.unitsPerDay, 0) !==
    bounds.totalUnits
  ) {
    return [];
  }

  const portions: PlannedPortion[] = [];
  let unitFrom = 1;
  for (const stage of checkedStages) {
    for (let index = 0; index < stage.days; index++) {
      const unitTo = unitFrom + stage.unitsPerDay - 1;
      portions.push({ day: portions.length + 1, unitFrom, unitTo });
      unitFrom = unitTo + 1;
    }
  }
  return portions;
}

function inferTwoStageDays(input: {
  remainingDays: number;
  remainingUnits: number;
  middleUnitsPerDay: number;
  backUnitsPerDay: number;
}): { middleDays: number; backDays: number } | undefined {
  const delta = input.middleUnitsPerDay - input.backUnitsPerDay;
  if (delta === 0) return undefined;
  const middleNumerator = input.remainingUnits - input.remainingDays * input.backUnitsPerDay;
  if (middleNumerator % delta !== 0) return undefined;
  const middleDays = middleNumerator / delta;
  const backDays = input.remainingDays - middleDays;
  if (!Number.isInteger(middleDays) || middleDays <= 0 || backDays <= 0) return undefined;
  return { middleDays, backDays };
}

function parseSequentialStageDailyPortions(
  text: string,
  bounds: { horizonDays: number; totalUnits: number },
): PlannedPortion[] {
  const unitsFirstPattern = new RegExp(
    `(?:先|一开始|最开始|开始)\\s*${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}\\s*(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天.*?(?:再|然后|接着|之后|后面|后续)\\s*${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}\\s*(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天`,
  );
  const unitsFirstMatch = text.match(unitsFirstPattern);
  const unitsThenMarkerPattern = new RegExp(
    `${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}\\s*(?:先|一开始|最开始|开始)\\s*(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天.*?(?:再|然后|接着|之后|后面|后续)\\s*${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}\\s*(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天`,
  );
  const unitsThenMarkerMatch = unitsFirstMatch ? undefined : text.match(unitsThenMarkerPattern);
  const daysFirstPattern = new RegExp(
    `(?:先|一开始|最开始|开始)\\s*${STAGE_NOTE_PATTERN}(?:用|花)?\\s*(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天\\s*(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}.*?(?:再|然后|接着|之后|后面|后续)\\s*${STAGE_NOTE_PATTERN}(?:用|花)?\\s*(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天\\s*(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}`,
  );
  const daysFirstMatch = unitsFirstMatch || unitsThenMarkerMatch ? undefined : text.match(daysFirstPattern);
  const match = unitsFirstMatch ?? unitsThenMarkerMatch ?? daysFirstMatch;
  if (!match) return [];

  const isUnitsFirst = !!unitsFirstMatch || !!unitsThenMarkerMatch;
  const firstDays = parsePositiveInteger(isUnitsFirst ? match[2]! : match[1]!);
  const firstUnitsPerDay = parsePositiveInteger(isUnitsFirst ? match[1]! : match[2]!);
  const secondDays = parsePositiveInteger(isUnitsFirst ? match[4]! : match[3]!);
  const secondUnitsPerDay = parsePositiveInteger(isUnitsFirst ? match[3]! : match[4]!);
  if (
    firstDays === undefined ||
    firstUnitsPerDay === undefined ||
    secondDays === undefined ||
    secondUnitsPerDay === undefined
  ) {
    return [];
  }
  if (firstDays + secondDays !== bounds.horizonDays) return [];
  if (firstDays * firstUnitsPerDay + secondDays * secondUnitsPerDay !== bounds.totalUnits) {
    return [];
  }

  const portions: PlannedPortion[] = [];
  let unitFrom = 1;
  for (const stage of [
    { days: firstDays, unitsPerDay: firstUnitsPerDay },
    { days: secondDays, unitsPerDay: secondUnitsPerDay },
  ]) {
    for (let index = 0; index < stage.days; index++) {
      const unitTo = unitFrom + stage.unitsPerDay - 1;
      portions.push({ day: portions.length + 1, unitFrom, unitTo });
      unitFrom = unitTo + 1;
    }
  }
  return portions;
}

function parseHalfStageDailyPortions(
  text: string,
  bounds: { horizonDays: number; totalUnits: number },
): PlannedPortion[] {
  if (bounds.horizonDays % 2 !== 0) return [];
  const pattern = new RegExp(
    `(?:前半段|上半段|前半程|上半程)${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}.*?(?:后半段|下半段|后半程|下半程)${STAGE_NOTE_PATTERN}${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}`,
  );
  const match = text.match(pattern);
  if (!match) return [];

  const frontUnitsPerDay = parsePositiveInteger(match[1]!);
  const backUnitsPerDay = parsePositiveInteger(match[2]!);
  if (frontUnitsPerDay === undefined || backUnitsPerDay === undefined) return [];

  const halfDays = bounds.horizonDays / 2;
  if (halfDays * frontUnitsPerDay + halfDays * backUnitsPerDay !== bounds.totalUnits) return [];

  const portions: PlannedPortion[] = [];
  let unitFrom = 1;
  for (const unitsPerDay of [
    ...Array(halfDays).fill(frontUnitsPerDay),
    ...Array(halfDays).fill(backUnitsPerDay),
  ]) {
    const unitTo = unitFrom + unitsPerDay - 1;
    portions.push({ day: portions.length + 1, unitFrom, unitTo });
    unitFrom = unitTo + 1;
  }
  return portions;
}

function parseRangedStageDailyPortions(
  text: string,
  bounds: { horizonDays: number; totalUnits: number },
): PlannedPortion[] {
  const pattern = new RegExp(
    `第?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*(?:天)?\\s*(到|至|-|—|–|~|～|、|，|,|和|及)\\s*第?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天\\s*${STAGE_PER_DAY_PATTERN}(?:${TASK_ACTION_PATTERN})?\\s*(${POSITIVE_INTEGER_PATTERN})\\s*${TASK_UNIT_PATTERN}`,
    "g",
  );
  const stages: Array<{ dayFrom: number; dayTo: number; unitsPerDay: number }> = [];
  for (const match of text.matchAll(pattern)) {
    const dayFrom = parsePositiveInteger(match[1]!);
    const separator = match[2]!;
    const dayTo = parsePositiveInteger(match[3]!);
    const unitsPerDay = parsePositiveInteger(match[4]!);
    if (
      dayFrom === undefined ||
      dayTo === undefined ||
      unitsPerDay === undefined ||
      dayFrom > dayTo ||
      dayTo > bounds.horizonDays
    ) {
      return [];
    }
    if (!isRangeSeparator(separator) && dayTo !== dayFrom + 1) return [];
    stages.push({ dayFrom, dayTo, unitsPerDay });
  }

  if (!stages.length) return [];
  const sorted = stages.sort((a, b) => a.dayFrom - b.dayFrom);
  let expectedDay = 1;
  let plannedUnits = 0;
  for (const stage of sorted) {
    if (stage.dayFrom !== expectedDay) return [];
    plannedUnits += (stage.dayTo - stage.dayFrom + 1) * stage.unitsPerDay;
    expectedDay = stage.dayTo + 1;
  }
  if (expectedDay !== bounds.horizonDays + 1 || plannedUnits !== bounds.totalUnits) return [];

  const portions: PlannedPortion[] = [];
  let unitFrom = 1;
  for (const stage of sorted) {
    for (let day = stage.dayFrom; day <= stage.dayTo; day++) {
      const unitTo = unitFrom + stage.unitsPerDay - 1;
      portions.push({ day, unitFrom, unitTo });
      unitFrom = unitTo + 1;
    }
  }
  return portions;
}

function isRangeSeparator(separator: string): boolean {
  return ["到", "至", "-", "—", "–", "~", "～"].includes(separator);
}

function parseAbsoluteFeedbackDate(text: string, referenceTs: number): string | undefined {
  const match = text.match(
    /(?:^|[^\d])(?:(\d{4})\s*(?:年|-|\/))?\s*(\d{1,2})\s*(?:月|-|\/)\s*(\d{1,2})\s*(?:日|号)?/,
  );
  if (!match) return undefined;

  const referenceDate = new Date(referenceTs);
  const explicitYear = match[1] ? Number(match[1]) : undefined;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const referenceYear = referenceDate.getUTCFullYear();
  const referenceDateKey = formatDateKey(
    referenceYear,
    referenceDate.getUTCMonth() + 1,
    referenceDate.getUTCDate(),
  );
  let year = explicitYear ?? referenceYear;
  let dateKey = formatValidDateKey(year, month, day);
  if (!dateKey) return undefined;

  if (explicitYear === undefined && dateKey > referenceDateKey) {
    year -= 1;
    dateKey = formatValidDateKey(year, month, day);
  }
  return dateKey;
}

function parseFeedbackDate(
  text: string,
  referenceTs: number,
  makeupTargetDate: string | undefined,
): string | undefined {
  const absoluteDate = parseAbsoluteFeedbackDate(text, referenceTs);
  if (absoluteDate !== undefined && absoluteDate !== makeupTargetDate) return absoluteDate;

  const weekdayDate = parseWeekdayFeedbackDate(text, referenceTs);
  if (weekdayDate !== undefined && weekdayDate !== makeupTargetDate) return weekdayDate;

  return undefined;
}

function parseWeekdayFeedbackDate(text: string, referenceTs: number): string | undefined {
  const match = matchWeekdayFeedbackDate(text);
  if (!match) return undefined;
  return feedbackWeekdayDateKey(match.weekText, match.weekdayText, referenceTs);
}

function parseMakeupTargetDate(text: string, referenceTs: number): string | undefined {
  const weekdayMatch = matchWeekdayFeedbackDate(text);
  if (weekdayMatch && !weekdayMatch.weekText.startsWith("上") && hasMakeupIntent(weekdayMatch.tail)) {
    return relativeWeekdayDateKey(weekdayMatch.weekText, weekdayMatch.weekdayText, referenceTs);
  }

  const relativeMonthDayMatch = text.match(
    new RegExp(
      `(下个月|下月|本月|这个月|这月)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*(?:日|号)\\s*${makeupIntentPattern()}`,
    ),
  );
  if (relativeMonthDayMatch) {
    return relativeMonthDayDateKey(relativeMonthDayMatch[1]!, relativeMonthDayMatch[2]!, referenceTs);
  }

  const datePattern = String.raw`(?:(\d{4})\s*(?:年|-|\/))?\s*(\d{1,2})\s*(?:月|-|\/)\s*(\d{1,2})\s*(?:日|号)?`;
  const absoluteMatch = text.match(new RegExp(`${datePattern}\\s*${makeupIntentPattern()}`));
  if (!absoluteMatch) return undefined;
  return resolveDateKeyOnOrAfterReference({
    explicitYear: absoluteMatch[1] ? Number(absoluteMatch[1]) : undefined,
    month: Number(absoluteMatch[2]),
    day: Number(absoluteMatch[3]),
    referenceTs,
  });
}

function hasMakeupIntent(text: string): boolean {
  return new RegExp(`^\\s*${makeupIntentPattern()}`).test(text);
}

function makeupIntentPattern(): string {
  const makeupAction = "补(?:做|读|看|学|背|练|写|刷|完|课)?";
  return `(?:${makeupAction}|(?:再|继续|接着)\\s*(?:${makeupAction}|${TASK_ACTION_PATTERN}|完成|学习|任务))`;
}

function matchWeekdayFeedbackDate(
  text: string,
): { weekText: string; weekdayText: string; tail: string } | undefined {
  const explicitMatch = text.match(
    /(上周|上星期|上礼拜|下周|下星期|下礼拜|这周|这星期|这礼拜|本周|本星期|本礼拜)\s*([一二三四五六日天])/,
  );
  if (explicitMatch) {
    const endIndex = (explicitMatch.index ?? 0) + explicitMatch[0].length;
    return { weekText: explicitMatch[1]!, weekdayText: explicitMatch[2]!, tail: text.slice(endIndex) };
  }

  const bareMatch = text.match(/(?<![上下这本每])(?:周|星期|礼拜)\s*([一二三四五六日天])/);
  if (!bareMatch) return undefined;
  const endIndex = (bareMatch.index ?? 0) + bareMatch[0].length;
  return { weekText: "这周", weekdayText: bareMatch[1]!, tail: text.slice(endIndex) };
}

function hasSkipFeedbackIntent(text: string): boolean {
  if (/(?:请假|休息|停课)/.test(text)) return true;
  const actionPattern = `(?:${TASK_ACTION_PATTERN}|完成(?:任务|作业|目标)?|任务|作业|学习)`;
  if (new RegExp(`(?:忘(?:记)?(?:了)?|漏(?:了)?)\\s*${actionPattern}(?:了)?`).test(text)) return true;
  if (new RegExp(`(?:没|没有|未)\\s*${TASK_ACTION_PATTERN}(?!完)`).test(text)) return true;
  if (new RegExp(`(?:还)?(?:没|没有|未)\\s*(?:开始|动手)\\s*(?:${TASK_ACTION_PATTERN}|学习|任务|作业)?`).test(text)) {
    return true;
  }
  if (/(?:还)?(?:没|没有|未)\s*(?:动笔|碰(?:过)?)/.test(text)) return true;
  if (new RegExp(`(?:来不及|赶不及|赶不上).*${TASK_ACTION_PATTERN}`).test(text)) return true;
  if (new RegExp(`不\\s*${TASK_ACTION_PATTERN}(?:了)?`).test(text)) return true;
  if (new RegExp(`(?:没法|没办法|不方便)(?:继续)?\\s*(?:${TASK_ACTION_PATTERN}|完成|学习|任务)`).test(text)) {
    return true;
  }
  if (/(?:(?:没法|没办法)(?:继续)?|不太方便|不方便)(?:了)?[。！!]*$/.test(text)) return true;
  if (/(?:完成不了|搞不定|任务搞不定)/.test(text)) return true;
  return /(?:太忙|忙不过来|作业太多|事情太多|事太多|太多事|有事|有安排|没空|抽不开身|顾不上|状态不好|没状态|状态不行|不舒服|生病|感冒|发烧|头疼|头痛|肚子疼|肚子痛|胃疼|胃痛|嗓子疼|喉咙痛|咳嗽|牙疼|牙痛|没精神|没精力|没劲|提不起劲|有点累|累得不行|累坏了|太累|累了|太困|太晚|时间太晚|已经晚了)/.test(
    text,
  );
}

function feedbackWeekdayDateKey(weekText: string, weekdayText: string, referenceTs: number): string | undefined {
  const targetWeekday = WEEKDAY_MAP[weekdayText];
  if (targetWeekday === undefined) return undefined;

  const referenceWeekday = new Date(referenceTs).getUTCDay();
  const referenceMondayOffset = -weekdayToMondayIndex(referenceWeekday);
  let weekOffset = 0;
  if (/^(?:上周|上星期|上礼拜)$/.test(weekText)) weekOffset = -7;
  if (/^(?:下周|下星期|下礼拜)$/.test(weekText)) weekOffset = 7;
  const targetOffset = weekdayToMondayIndex(targetWeekday);
  return dateKeyFromReference(referenceTs, referenceMondayOffset + weekOffset + targetOffset);
}

function formatValidDateKey(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return formatDateKey(year, month, day);
}

function formatDateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysBetween(from: string, to: string): number {
  const fromTime = Date.parse(`${from}T00:00:00.000Z`);
  const toTime = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toTime - fromTime) / 86_400_000);
}

function normalizePositiveDays(days: number): number | undefined {
  return Number.isInteger(days) && days > 0 ? days : undefined;
}

function dateKeyFromReference(referenceTs: number, offsetDays: number): string {
  const date = new Date(referenceTs);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function resolveDateKeyOnOrAfterReference(input: {
  explicitYear?: number;
  month: number;
  day: number;
  referenceTs: number;
}): string | undefined {
  const referenceDate = new Date(input.referenceTs);
  const referenceYear = referenceDate.getUTCFullYear();
  const referenceDateKey = formatDateKey(
    referenceYear,
    referenceDate.getUTCMonth() + 1,
    referenceDate.getUTCDate(),
  );
  let year = input.explicitYear ?? referenceYear;
  let dateKey = formatValidDateKey(year, input.month, input.day);
  if (!dateKey) return undefined;

  if (input.explicitYear === undefined && dateKey < referenceDateKey) {
    year += 1;
    dateKey = formatValidDateKey(year, input.month, input.day);
  }
  if (!dateKey || dateKey < referenceDateKey) return undefined;
  return dateKey;
}

function parsePositiveInteger(raw: string): number | undefined {
  const value = /^\d+$/.test(raw) ? Number(raw) : chinesePositiveInteger(raw);
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function chinesePositiveInteger(raw: string): number | undefined {
  const normalized = raw.replace(/^[零〇]+/, "");
  if (normalized !== raw) {
    return normalized ? chinesePositiveInteger(normalized) : 0;
  }

  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (raw in digits) return digits[raw];

  const hundredParts = raw.split("百");
  if (hundredParts.length > 2) return undefined;
  if (hundredParts.length === 2) {
    const hundreds = hundredParts[0] ? digits[hundredParts[0]!] : 1;
    const rest = hundredParts[1] ? chinesePositiveInteger(hundredParts[1]!) : 0;
    if (!hundreds || rest === undefined || rest >= 100) return undefined;
    return hundreds * 100 + rest;
  }

  const tenParts = raw.split("十");
  if (tenParts.length !== 2) return undefined;
  const tens = tenParts[0] ? digits[tenParts[0]!] : 1;
  const ones = tenParts[1] ? digits[tenParts[1]!] : 0;
  if (!tens || ones === undefined || ones >= 10) return undefined;
  return tens * 10 + ones;
}

function parseRestWeekdays(text: string): number[] {
  const activeWeekdays = parseActiveWeekdays(text);
  if (activeWeekdays.length) {
    const active = new Set(activeWeekdays);
    return ALL_WEEKDAYS.filter((day) => !active.has(day));
  }

  if (!/(休息|不学|不做|跳过|暂停|停一天)/.test(text)) return [];
  const weekdays = new Set<number>();

  if (/周末|星期末|礼拜末/.test(text)) {
    weekdays.add(0);
    weekdays.add(6);
  }

  if (/工作日|平日/.test(text)) {
    [1, 2, 3, 4, 5].forEach((day) => weekdays.add(day));
  }

  for (const day of parseWeekdayMentions(text)) weekdays.add(day);

  return [...weekdays].sort((a, b) => a - b);
}

function parseDateSpacingDays(text: string): number | undefined {
  if (new RegExp(`(?:${TASK_ACTION_PATTERN}|上)\\s*(?:一|1)\\s*天?\\s*(?:休|歇|停)\\s*(?:一|1)\\s*天?`).test(text)) {
    return 2;
  }
  if (new RegExp(`(?:一|1)\\s*天?\\s*(?:${TASK_ACTION_PATTERN}|上)\\s*(?:一|1)\\s*天?\\s*(?:休|歇|停)`).test(text)) {
    return 2;
  }

  const everyOtherDaysMatch = text.match(
    new RegExp(`每?隔\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天\\s*(?:${TASK_ACTION_PATTERN})?\\s*(?:一次|一回|一遍)?`),
  );
  const everyOtherDays = everyOtherDaysMatch ? parsePositiveInteger(everyOtherDaysMatch[1]!) : undefined;
  if (everyOtherDays !== undefined) return everyOtherDays + 1;

  const everyDaysMatch = text.match(
    new RegExp(`每\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天\\s*(?:${TASK_ACTION_PATTERN})?\\s*(?:一次|一回|一遍)`),
  );
  const everyDays = everyDaysMatch ? parsePositiveInteger(everyDaysMatch[1]!) : undefined;
  if (everyDays !== undefined && everyDays > 1) return everyDays;

  const bareEveryDaysMatch = text.match(
    new RegExp(`(?:^|[，,、。；;\\s])(${POSITIVE_INTEGER_PATTERN})\\s*天\\s*(?:${TASK_ACTION_PATTERN})?\\s*(?:一次|一回|一遍)`),
  );
  const bareEveryDays = bareEveryDaysMatch ? parsePositiveInteger(bareEveryDaysMatch[1]!) : undefined;
  if (bareEveryDays !== undefined && bareEveryDays > 1) return bareEveryDays;

  return /每?隔\s*一?\s*天/.test(text) ? 2 : undefined;
}

function parseActiveRestCycle(text: string): ActiveRestCycle | undefined {
  const match = text.match(
    new RegExp(
      `(?:${TASK_ACTION_PATTERN}|上)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天?\\s*(?:休|歇|停)\\s*(${POSITIVE_INTEGER_PATTERN})\\s*天?`,
    ),
  );
  if (!match) return undefined;
  const activeDays = parsePositiveInteger(match[1]!);
  const restDays = parsePositiveInteger(match[2]!);
  if (activeDays === undefined || restDays === undefined) return undefined;
  if (activeDays === 1 && restDays === 1) return undefined;
  return { activeDays, restDays };
}

function parseActiveWeekdays(text: string): number[] {
  const mentionedWeekdays = parseWeekdayMentions(text);
  const hasExplicitActiveCue = /(只在|仅在|固定在|每周|每星期|每礼拜|逢)/.test(text);
  const hasBareWeekdayActionCue =
    mentionedWeekdays.length > 1 &&
    new RegExp(`(?:周|星期|礼拜)[一二三四五六日天、，,和及\\s到至\\-~]*(?:${TASK_ACTION_PATTERN})`).test(
      text,
    );
  if (!hasExplicitActiveCue && !hasBareWeekdayActionCue) return [];
  if (/(休息|不学|不做|跳过|暂停|停一天)/.test(text) && !/(只在|仅在|固定在)/.test(text)) {
    return [];
  }
  if (!new RegExp(TASK_ACTION_PATTERN).test(text)) return [];

  const weekdays = new Set<number>();
  if (/工作日|平日/.test(text)) {
    [1, 2, 3, 4, 5].forEach((day) => weekdays.add(day));
  }
  if (/周末|星期末|礼拜末/.test(text)) {
    weekdays.add(0);
    weekdays.add(6);
  }
  for (const day of mentionedWeekdays) weekdays.add(day);
  return [...weekdays].sort((a, b) => a - b);
}

function parseWeekdayMentions(text: string): number[] {
  const weekdays = new Set<number>();
  for (const match of text.matchAll(
    /(?:每)?(?:周|星期|礼拜)([一二三四五六日天])\s*(?:到|至|-|~)\s*(?:(?:周|星期|礼拜))?([一二三四五六日天])/g,
  )) {
    const from = WEEKDAY_MAP[match[1]!];
    const to = WEEKDAY_MAP[match[2]!];
    if (from === undefined || to === undefined) continue;
    if (from <= to) {
      for (let day = from; day <= to; day++) weekdays.add(day);
    } else {
      for (let day = from; day <= 6; day++) weekdays.add(day);
      for (let day = 0; day <= to; day++) weekdays.add(day);
    }
  }

  for (const match of text.matchAll(/(?:每)?(?:周|星期|礼拜)([一二三四五六日天、，,和及]+)/g)) {
    for (const char of match[1]!) {
      const weekday = WEEKDAY_MAP[char];
      if (weekday !== undefined) weekdays.add(weekday);
    }
  }
  return [...weekdays].sort((a, b) => a - b);
}

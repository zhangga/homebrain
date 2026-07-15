/** Explicit chat controls for durable guided-learning plans. */
import { learningProgress, type KnowledgeEngine, type LearningPlan } from "@homeagent/core";
import type { SpaceId } from "@homeagent/shared";
import { LEARNING_HELP } from "./messages.ts";

export interface LearningCommand {
  verb: "list" | "new" | "topic" | "add" | "route"
    | "pause" | "resume" | "skip" | "delete" | "help";
  arg: string;
}

export interface LearningCommandContext {
  space: SpaceId;
  chatId: string;
  actorId: string;
  sourceMessageId?: string;
}

export function learningCommandNeedsSource(command: LearningCommand): boolean {
  return command.verb === "new" || command.verb === "add";
}

function withoutMentions(text: string): string {
  return text.trim().replace(/^(?:@\S+\s*)+/u, "").trim();
}

export function parseLearningCommand(text: string): LearningCommand | null {
  const match = withoutMentions(text).match(/^\/learn(?:ing)?\b\s*(.*)$/isu);
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (!rest) return { verb: "list", arg: "" };
  const separator = rest.search(/\s/u);
  const keyword = (separator < 0 ? rest : rest.slice(0, separator)).toLowerCase();
  const arg = separator < 0 ? "" : rest.slice(separator + 1).trim();
  const verbs: Record<string, LearningCommand["verb"]> = {
    list: "list",
    列表: "list",
    new: "new",
    新建: "new",
    创建: "new",
    topic: "topic",
    主题: "topic",
    add: "add",
    source: "add",
    材料: "add",
    route: "route",
    路线: "route",
    pause: "pause",
    暂停: "pause",
    resume: "resume",
    继续: "resume",
    恢复: "resume",
    skip: "skip",
    跳过: "skip",
    delete: "delete",
    删除: "delete",
    help: "help",
    帮助: "help",
  };
  const verb = verbs[keyword];
  return verb ? { verb, arg } : { verb: "help", arg: "" };
}

export function parseLearningAnswer(text: string): string | null {
  const match = withoutMentions(text).match(/^学习回答\s*[：:]\s*(.+)$/isu);
  const answer = match?.[1]?.trim();
  return answer || null;
}

function ownedPlans(engine: KnowledgeEngine, context: LearningCommandContext): LearningPlan[] {
  return engine.learning.listBySpace(context.space)
    .filter((plan) => plan.creatorId === context.actorId);
}

function findPlan(plans: LearningPlan[], query: string): LearningPlan | undefined {
  const index = Number(query);
  if (Number.isInteger(index) && index >= 1 && index <= plans.length) return plans[index - 1];
  const normalized = query.toLocaleLowerCase();
  return plans.find((plan) => plan.name.toLocaleLowerCase() === normalized);
}

function statusLabel(plan: LearningPlan): string {
  if (plan.status === "paused") return "已暂停";
  if (plan.status === "completed") return "已完成";
  return engineProgress(plan) === 100 ? "已完成" : "进行中";
}

function engineProgress(plan: LearningPlan): number {
  return learningProgress(plan);
}

function routeStatusIcon(status: LearningPlan["route"][number]["status"]): string {
  if (status === "active") return "▶️";
  if (status === "completed") return "✅";
  if (status === "skipped") return "⏭️";
  return "○";
}

export async function handleLearningCommand(
  engine: KnowledgeEngine,
  command: LearningCommand,
  context: LearningCommandContext,
): Promise<string> {
  if (command.verb === "help") return LEARNING_HELP;
  const plans = ownedPlans(engine, context);
  if (command.verb === "list") {
    if (plans.length === 0) {
      return "还没有学习计划。可发送 `/learn topic <主题>` 创建主题路线，或回复材料后发送 `/learn new <名称>`。";
    }
    return [
      "我的学习计划：",
      ...plans.map((plan, index) =>
        `${index + 1}. ${plan.name} · ${plan.mode === "topic" ? "主题" : "材料"}学习 · ${statusLabel(plan)} · ${engineProgress(plan)}% · 每天 ${plan.hour}:00`
      ),
    ].join("\n");
  }

  if (command.verb === "topic") {
    const topic = command.arg.trim();
    if (!topic) return "请指定学习主题：`/learn topic <主题>`。";
    try {
      const plan = await engine.createTopicLearningPlan({
        space: context.space,
        chatId: context.chatId,
        creatorId: context.actorId,
        topic,
      });
      return `✅ 已创建主题学习计划「${plan.name}」，共 ${plan.route.length} 个步骤，默认每天 8:00 推送一课。发送 \`/learn route ${plan.name}\` 查看路线。`;
    } catch (error) {
      return `创建主题学习计划失败：${String(error).replace(/^Error:\s*/u, "")}`;
    }
  }

  if (command.verb === "new") {
    const name = command.arg.trim();
    if (!name) return "请指定书名：`/learn new <书名>`。";
    if (!context.sourceMessageId) {
      return "请回复包含书籍附件或飞书文档的原消息，再发送 /learn new <书名>。";
    }
    try {
      engine.createLearningPlanFromMessage({
        space: context.space,
        chatId: context.chatId,
        messageId: context.sourceMessageId,
        creatorId: context.actorId,
        name,
      });
      return `✅ 已创建学习计划「${name}」，默认每天 8:00 推送一课。发送 \`/learn\` 可查看进度。`;
    } catch (error) {
      return `创建学习计划失败：${String(error).replace(/^Error:\s*/u, "")}`;
    }
  }

  const query = command.arg.trim();
  if (!query) return `请指定计划名称或序号。\n\n${LEARNING_HELP}`;
  const target = findPlan(plans, query);
  if (!target) return `没找到你的学习计划「${query}」。发送 \`/learn\` 查看列表。`;

  if (command.verb === "route") {
    if (target.mode !== "topic") return `学习计划「${target.name}」是材料阅读计划，没有主题路线。`;
    return [
      `学习路线「${target.name}」：`,
      ...target.route.map((step) =>
        `${routeStatusIcon(step.status)} ${step.title} — ${step.objective}${step.attempts > 0 ? `（已学习 ${step.attempts} 次）` : ""}`
      ),
      target.adaptiveFocus ? `\n下一课重点：${target.adaptiveFocus}` : "",
    ].filter(Boolean).join("\n");
  }
  if (command.verb === "add") {
    if (!context.sourceMessageId) {
      return `请回复要添加的附件、文章或飞书文档，再发送 /learn add ${target.name}。`;
    }
    try {
      engine.addLearningMaterialFromMessage(
        target.id,
        context.actorId,
        context.sourceMessageId,
      );
      const source = engine.learning.source(target.id);
      const material = source?.materials.at(-1);
      return `✅ 已添加材料「${material?.title ?? "学习材料"}」到「${target.name}」，目前共 ${source?.materials.length ?? 0} 份。`;
    } catch (error) {
      return `添加学习材料失败：${String(error).replace(/^Error:\s*/u, "")}`;
    }
  }

  if (command.verb === "pause") {
    return engine.learning.pause(target.id, context.actorId)
      ? `⏸️ 已暂停学习计划「${target.name}」。`
      : `学习计划「${target.name}」当前无法暂停。`;
  }
  if (command.verb === "resume") {
    return engine.learning.resume(target.id, context.actorId)
      ? `▶️ 已恢复学习计划「${target.name}」。`
      : `学习计划「${target.name}」当前无法恢复。`;
  }
  if (command.verb === "skip") {
    return engine.learning.skipCurrent(target.id, context.actorId)
      ? `⏭️ 已跳过学习计划「${target.name}」的当前课程，进度已推进。`
      : `学习计划「${target.name}」当前没有等待处理的课程。`;
  }
  return engine.learning.remove(target.id, context.actorId)
    ? `🗑️ 已删除学习计划「${target.name}」。`
    : `学习计划「${target.name}」删除失败。`;
}

export async function handleLearningAnswer(
  engine: KnowledgeEngine,
  answer: string,
  context: Omit<LearningCommandContext, "sourceMessageId">,
): Promise<string> {
  const awaiting = ownedPlans(engine, context)
    .filter((plan) => engine.learning.currentSession(plan.id)?.status === "awaiting_reply");
  if (awaiting.length === 0) return "当前没有等待你回答的学习课程。";
  if (awaiting.length > 1) {
    return `有多个课程正在等待回答，请先用 \`/learn skip <名称>\` 处理到只剩一个：${awaiting.map((plan) => plan.name).join("、")}`;
  }
  const target = awaiting[0]!;
  const result = await engine.answerLearningSession(target.id, context.actorId, answer);
  const completion = result.plan.status === "completed"
    ? result.plan.mode === "topic"
      ? "\n\n🎉 这个主题的学习路线已完成。"
      : "\n\n🎉 这本书的计划已完成。"
    : result.session.mastery === "review"
      ? `\n\n🔁 下一课将继续当前步骤，重点补强：${result.session.nextFocus}`
      : "";
  return `✅ 已记录「${target.name}」第 ${result.session.sequence} 课。\n\n${result.feedback}${completion}`;
}

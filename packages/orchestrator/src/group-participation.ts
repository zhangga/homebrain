import type { LlmClient } from "@homeagent/core";
import { config, logger } from "@homeagent/shared";
import { prefilterQuestion } from "./intent.ts";

const log = logger.child("group-participation");

export interface GroupParticipationDecision {
  respond: boolean;
  reason: string;
  source: "model" | "guard" | "fallback";
}

export type GroupParticipationClientResolver = () => LlmClient;

const PARTICIPATION_SCHEMA = {
  type: "object",
  properties: {
    respond: {
      type: "boolean",
      description: "whether the assistant should proactively answer this unmentioned group message",
    },
    reason: {
      type: "string",
      description: "a brief reason for the decision",
    },
  },
  required: ["respond", "reason"],
} as const;

function validate(raw: unknown): { respond: boolean; reason: string } {
  const value = raw as Record<string, unknown>;
  if (typeof value?.respond !== "boolean") {
    throw new Error("group participation decision missing respond");
  }
  return {
    respond: value.respond,
    reason: typeof value.reason === "string" ? value.reason.trim() : "",
  };
}

function addressedToAnotherMember(text: string): boolean {
  return /^@\S+\s+/u.test(text.trim());
}

export async function decideGroupParticipation(
  resolveClient: GroupParticipationClientResolver,
  text: string,
): Promise<GroupParticipationDecision> {
  if (addressedToAnotherMember(text)) {
    return {
      respond: false,
      reason: "消息明确 @ 了其他群成员",
      source: "guard",
    };
  }

  try {
    const client = resolveClient();
    const { value } = await client.completeJSON({
      model: config().modelFast,
      system: [
        "你负责判断一个没有 @ 机器人的群聊消息，机器人是否应该主动参与。",
        "只有当消息是在向整个群提出真实的信息、解释、建议或解决问题的请求，而且机器人直接回答会有帮助时，respond 才为 true。",
        "以下情况必须为 false：普通陈述、闲聊、感叹、抱怨、自言自语、反问、引用别人的问题、明显是在问某个被 @ 或点名的人、以及需要明确叫机器人执行的管理命令。",
        "拿不准时返回 false，避免打扰群聊。",
      ].join("\n"),
      prompt: `判断下面这条群消息是否值得机器人主动回答：\n"""\n${text.trim()}\n"""`,
      schema: PARTICIPATION_SCHEMA as unknown as Record<string, unknown>,
      validate,
      maxTokens: 128,
      purpose: "classify",
    });
    return {
      respond: value.respond,
      reason: value.reason,
      source: "model",
    };
  } catch (err) {
    const respond = prefilterQuestion(text);
    log.warn("group participation classification failed; using deterministic fallback", {
      respond,
      err: String(err),
    });
    return {
      respond,
      reason: respond ? "明显疑问句的本地回退" : "无法可靠判断为群体提问",
      source: "fallback",
    };
  }
}

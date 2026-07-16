/**
 * Intent classification (plan §III, "规避正则": no giant-regex router — use an
 * LLM classifier). A two-stage design keeps cost down (plan R5):
 *
 *   1. A cheap deterministic pre-filter catches short greetings / pure chit-chat
 *      so we never spend a model call on "在吗" / "哈哈" / "谢谢".
 *   2. Everything else goes to the fast model (haiku) which returns a structured
 *      intent: question | remember | command | chitchat.
 *
 * The classifier is injected an LlmClient (from core) so it is unit-testable
 * offline with a fake.
 */
import { config, logger } from "@homeagent/shared";
import type { LlmClient } from "@homeagent/core";

const log = logger.child("intent");

export type Intent = "question" | "remember" | "command" | "chitchat";

export interface Classification {
  intent: Intent;
  /** true when the deterministic pre-filter decided, skipping the model */
  prefiltered: boolean;
}

/** Lazily resolves the space-scoped client after the no-model prefilter. */
export type IntentClientResolver = () => LlmClient;

/** Short pure-greeting / acknowledgement phrases that never need a model call. */
const GREETINGS = new Set([
  "在吗", "在么", "你好", "您好", "hello", "hi", "hey", "在不在",
  "哈哈", "哈哈哈", "呵呵", "嘿", "早", "早上好", "晚安", "谢谢", "谢了",
  "thanks", "thank you", "ok", "okay", "好的", "收到", "👍", "666",
]);

const QUESTION_PREFIXES = [
  "谁", "什么", "哪里", "哪儿", "哪个", "哪些", "哪位",
  "哪家", "哪天", "哪种", "哪条", "哪本", "哪件", "哪次",
  "怎么", "怎样", "如何", "为什么", "为何", "多少",
  "几点", "几号", "几时", "几个", "几位", "几岁", "几年", "几天",
  "何时", "什么时候", "是否", "有没有", "有没", "能否", "可否",
  "是不是", "要不要", "该不该",
];

const QUESTION_SUFFIXES = [
  "是谁", "是什么", "叫什么", "什么意思", "在哪", "在哪里", "在哪儿",
  "怎么回事", "怎么样", "怎么办", "有多少", "多少个",
];

const ENGLISH_QUESTION_PREFIXES = [
  "who ", "what ", "where ", "when ", "why ", "how ",
  "is ", "are ", "am ", "was ", "were ",
  "do ", "does ", "did ", "can ", "could ", "would ", "should ",
];

/** Remove one or more rendered @mentions from the start of a message. */
export function normalizeIntentText(text: string): string {
  let normalized = text.trim();
  while (/^@\S+\s+/u.test(normalized)) {
    normalized = normalized.replace(/^@\S+\s+/u, "").trimStart();
  }
  return normalized;
}

/**
 * Questions with explicit punctuation or stable interrogative forms do not
 * need an LLM classifier. This also provides a safe fallback when the local
 * CLI times out or returns malformed JSON.
 */
export function prefilterQuestion(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (/[?？]/u.test(normalized)) return true;

  const compact = normalized
    .toLowerCase()
    .replace(/[!！。.~～,，、\s]+$/gu, "")
    .trim();
  if (!compact) return false;
  if (QUESTION_PREFIXES.some((prefix) => compact.startsWith(prefix))) return true;
  if (QUESTION_SUFFIXES.some((suffix) => compact.endsWith(suffix))) return true;
  if (compact.endsWith("吗")) return true;
  return ENGLISH_QUESTION_PREFIXES.some((prefix) => compact.startsWith(prefix));
}

/** A message is a trivial greeting if it's very short and matches a greeting. */
export function prefilterChitchat(text: string): boolean {
  const t = normalizeIntentText(text)
    .toLowerCase()
    .replace(/[!！。.~～?？,，\s]+$/g, "");
  if (t.length === 0) return true;
  if (GREETINGS.has(t)) return true;
  // very short and no CJK "content" word and no question mark -> likely chit-chat
  if (t.length <= 2 && !/[?？]/.test(text)) return true;
  return false;
}

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["question", "remember", "command", "chitchat"],
      description:
        "question: asking for info, including Chinese questions without a question mark like '小贝儿是谁'; remember: stating a fact to store; command: an instruction like '别记这条'/'重新提炼'; chitchat: greetings/smalltalk",
    },
  },
  required: ["intent"],
} as const;

function validate(raw: unknown): { intent: Intent } {
  const o = raw as Record<string, unknown>;
  const intent = o?.intent as Intent;
  if (!["question", "remember", "command", "chitchat"].includes(intent)) {
    return { intent: "chitchat" };
  }
  return { intent };
}

export async function classifyIntent(resolveClient: IntentClientResolver, text: string): Promise<Classification> {
  const normalized = normalizeIntentText(text);
  if (prefilterQuestion(normalized)) return { intent: "question", prefiltered: true };
  if (prefilterChitchat(normalized)) return { intent: "chitchat", prefiltered: true };
  // Resolve outside the classifier-failure fallback: missing configuration must
  // reach the runtime so it can give actionable setup guidance.
  const client = resolveClient();
  try {
    const { value } = await client.completeJSON<{ intent: Intent }>({
      model: config().modelFast,
      system: "你是意图分类器，严格按 schema 返回单一 intent。",
      prompt: `将下面这条消息分类：\n"""\n${normalized}\n"""`,
      schema: CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
      validate,
      maxTokens: 64,
      purpose: "classify",
    });
    return { intent: value.intent, prefiltered: false };
  } catch (err) {
    const fallback: Intent = prefilterQuestion(normalized) ? "question" : "remember";
    log.warn("intent classification failed; using deterministic fallback", {
      fallback,
      err: String(err),
    });
    return { intent: fallback, prefiltered: false };
  }
}

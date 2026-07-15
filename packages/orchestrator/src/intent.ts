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
import { config } from "@homeagent/shared";
import type { LlmClient } from "@homeagent/core";

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

/** A message is a trivial greeting if it's very short and matches a greeting. */
export function prefilterChitchat(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!！。.~～?？,，\s]+$/g, "");
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
        "question: asking for info; remember: stating a fact to store; command: an instruction like '别记这条'/'重新提炼'; chitchat: greetings/smalltalk",
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
  if (prefilterChitchat(text)) return { intent: "chitchat", prefiltered: true };
  // Resolve outside the classifier-failure fallback: missing configuration must
  // reach the runtime so it can give actionable setup guidance.
  const client = resolveClient();
  try {
    const { value } = await client.completeJSON<{ intent: Intent }>({
      model: config().modelFast,
      system: "你是意图分类器，严格按 schema 返回单一 intent。",
      prompt: `将下面这条消息分类：\n"""\n${text}\n"""`,
      schema: CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
      validate,
      maxTokens: 64,
      purpose: "classify",
    });
    return { intent: value.intent, prefiltered: false };
  } catch {
    // On classifier failure, treat a message with a question mark as a question,
    // otherwise as something to remember — never drop the message.
    return { intent: /[?？]/.test(text) ? "question" : "remember", prefiltered: false };
  }
}

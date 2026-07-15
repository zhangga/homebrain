/**
 * Live gateway integration test. Skipped unless HOMEAGENT_LIVE=1 so the default
 * `bun test` stays offline/deterministic. Run with:
 *   HOMEAGENT_LIVE=1 bun test packages/llm/src/gateway.live.test.ts
 */
import { describe, expect, test } from "bun:test";
import { brandedEnv } from "@homeagent/shared";
import { complete, completeJSON, ping } from "./gateway.ts";

const LIVE = brandedEnv(process.env, "LIVE") === "1";
const maybe = LIVE ? describe : describe.skip;

maybe("gateway (live)", () => {
  test("ping returns true", async () => {
    expect(await ping("claude-haiku-4-5-20251001")).toBe(true);
  }, 30000);

  test("complete returns text and usage", async () => {
    const r = await complete({
      model: "claude-haiku-4-5-20251001",
      prompt: "Say the word: hello",
      maxTokens: 16,
      purpose: "other",
    });
    expect(r.text.toLowerCase()).toContain("hello");
    expect(r.inputTokens).toBeGreaterThan(0);
    expect(r.costUsd).toBeGreaterThanOrEqual(0);
  }, 30000);

  test("completeJSON returns structured data despite gateway name mangling", async () => {
    const { value } = await completeJSON<{ intent: string }>({
      model: "claude-haiku-4-5-20251001",
      prompt: "Classify this message: '这个群里谁负责后端？'",
      schema: {
        type: "object",
        properties: {
          intent: { type: "string", enum: ["question", "remember", "command", "chitchat"] },
        },
        required: ["intent"],
      },
      purpose: "classify",
    });
    expect(["question", "remember", "command", "chitchat"]).toContain(value.intent);
  }, 30000);
});

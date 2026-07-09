import { describe, expect, test } from "bun:test";
import { extractJson, makeCliClient } from "./cli-client.ts";

describe("extractJson", () => {
  test("parses a bare JSON object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  test("strips a ```json fenced block", () => {
    const out = "here you go:\n```json\n{\"ok\":true}\n```\nthanks";
    expect(extractJson(out)).toEqual({ ok: true });
  });

  test("recovers the outermost object amid surrounding prose", () => {
    const out = 'Sure! {"slugs":["a"],"relevant":true} — done';
    expect(extractJson(out)).toEqual({ slugs: ["a"], relevant: true });
  });

  test("throws when no JSON is present", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("makeCliClient", () => {
  test("complete() returns the CLI stdout as text and folds system into prompt", async () => {
    let seen = "";
    const cli = makeCliClient("claude", "sonnet", async (_id, input) => {
      seen = input.prompt;
      return "  hello world  ";
    });
    const r = await cli.complete({ prompt: "hi", system: "你是海盗" });
    expect(r.text).toBe("hello world");
    expect(seen).toContain("你是海盗"); // system folded into the prompt
    expect(seen).toContain("hi");
  });

  test("completeJSON() appends a schema instruction, parses, and validates", async () => {
    let seen = "";
    const cli = makeCliClient("trae-cli", "", async (_id, input) => {
      seen = input.prompt;
      return '```json\n{"intent":"question"}\n```';
    });
    const { value } = await cli.completeJSON<{ intent: string }>({
      prompt: "classify this",
      schema: { type: "object", properties: { intent: { type: "string" } } },
      validate: (raw) => raw as { intent: string },
    });
    expect(value.intent).toBe("question");
    expect(seen).toContain("JSON Schema"); // strict-JSON instruction was appended
  });

  test("completeJSON() throws a clear error on unparseable output", async () => {
    const cli = makeCliClient("codex", "", async () => "not json at all");
    await expect(
      cli.completeJSON({ prompt: "x", schema: { type: "object" } }),
    ).rejects.toThrow(/did not return parseable JSON/);
  });

  test("model precedence: opts.model wins, else the client's default", async () => {
    let usedModel: string | undefined;
    const cli = makeCliClient("claude", "sonnet", async (_id, input) => {
      usedModel = input.model;
      return "ok";
    });
    await cli.complete({ prompt: "a" });
    expect(usedModel).toBe("sonnet");
    await cli.complete({ prompt: "a", model: "opus" });
    expect(usedModel).toBe("opus");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./agents.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-agents-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("AgentStore", () => {
  test("create assigns an id, defaults, and persists to agents.json", () => {
    const store = new AgentStore(dir);
    const a = store.create({ name: "知识助手", instruction: "简洁作答", model: "claude-sonnet-5" });
    expect(a.id).toMatch(/^agent_/);
    expect(a.name).toBe("知识助手");
    expect(a.provider).toBe("claude");
    expect(a.visibility).toBe("Team");

    const path = join(dir, "config", "agents.json");
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.agents[a.id].instruction).toBe("简洁作答");
  });

  test("blank name falls back to a placeholder; blank model stays empty", () => {
    const store = new AgentStore(dir);
    const a = store.create({ name: "   ", model: "  " });
    expect(a.name).toBe("未命名 Agent");
    expect(a.model).toBe("");
  });

  test("Codex reasoning effort is normalized and survives a reload", () => {
    const store = new AgentStore(dir);
    const agent = store.create({
      name: "深度助手",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });

    expect(agent.reasoningEffort).toBe("high");
    expect(new AgentStore(dir).get(agent.id)?.reasoningEffort).toBe("high");
    expect(store.create({ name: "无效配置", reasoningEffort: "extreme" }).reasoningEffort).toBe("");
  });

  test("reserved task-execution fields: defaults, parsing, and update", () => {
    const store = new AgentStore(dir);
    const a = store.create({ name: "runner", skills: "code-review, web-search\nsummarize" });
    // permission defaults to the safest tier
    expect(a.permission).toBe("read-only");
    expect(a.workdir).toBeUndefined();
    // skills parse from comma/newline-separated text
    expect(a.skills).toEqual(["code-review", "web-search", "summarize"]);

    const up = store.update(a.id, { permission: "write", workdir: " ~/proj ", skills: ["x"] });
    expect(up?.permission).toBe("write");
    expect(up?.workdir).toBe("~/proj");
    expect(up?.skills).toEqual(["x"]);

    // unknown permission normalizes back to read-only
    expect(store.create({ name: "z", permission: "root" }).permission).toBe("read-only");
  });

  test("provider defaults to the default CLI; unknown normalizes to it; known CLI is kept", () => {
    const store = new AgentStore(dir);
    expect(store.create({ name: "a" }).provider).toBe("claude");
    expect(store.create({ name: "b", provider: "totally-unknown" }).provider).toBe("claude");
    // "gateway" is no longer a selectable provider -> normalized to default CLI
    expect(store.create({ name: "g", provider: "gateway" }).provider).toBe("claude");
    expect(store.create({ name: "c", provider: "claude" }).provider).toBe("claude");
    expect(store.create({ name: "d", provider: "trae-cli" }).provider).toBe("trae-cli");
  });

  test("update patches only provided fields", () => {
    const store = new AgentStore(dir);
    const a = store.create({ name: "A", instruction: "old", model: "m1" });
    const updated = store.update(a.id, { instruction: "new" });
    expect(updated?.instruction).toBe("new");
    expect(updated?.name).toBe("A");
    expect(updated?.model).toBe("m1");
  });

  test("update returns undefined for unknown id", () => {
    const store = new AgentStore(dir);
    expect(store.update("agent_missing", { name: "x" })).toBeUndefined();
  });

  test("changes survive a reload (new store over the same dir)", () => {
    const store = new AgentStore(dir);
    const a = store.create({ name: "Persisted", model: "" });
    const reopened = new AgentStore(dir);
    expect(reopened.get(a.id)?.name).toBe("Persisted");
    expect(reopened.list().length).toBe(1);
  });

  test("legacy gateway agents migrate to the default CLI on load and are rewritten", () => {
    const path = join(dir, "config", "agents.json");
    require("node:fs").mkdirSync(join(dir, "config"), { recursive: true });
    // Simulate an older file that still records provider: "gateway".
    require("node:fs").writeFileSync(
      path,
      JSON.stringify({
        agents: {
          agent_old: {
            id: "agent_old",
            name: "旧助手",
            instruction: "",
            model: "",
            provider: "gateway",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
      "utf8",
    );
    const store = new AgentStore(dir);
    expect(store.get("agent_old")?.provider).toBe("claude");
    // migration is persisted back to disk (no more "gateway")
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.agents.agent_old.provider).toBe("claude");
  });

  test("the GPT-5.6 alias is migrated to the explicit Sol model id", () => {
    const path = join(dir, "config", "agents.json");
    require("node:fs").mkdirSync(join(dir, "config"), { recursive: true });
    require("node:fs").writeFileSync(
      path,
      JSON.stringify({
        agents: {
          agent_sol: {
            id: "agent_sol",
            name: "旧 Sol 助手",
            instruction: "",
            model: "gpt-5.6",
            provider: "codex",
            permission: "read-only",
            skills: [],
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
      "utf8",
    );

    const store = new AgentStore(dir);
    expect(store.get("agent_sol")?.model).toBe("gpt-5.6-sol");
    expect(JSON.parse(readFileSync(path, "utf8")).agents.agent_sol.model).toBe("gpt-5.6-sol");
  });

  test("remove deletes and persists", () => {
    const store = new AgentStore(dir);
    const a = store.create({ name: "Temp" });
    expect(store.remove(a.id)).toBe(true);
    expect(store.has(a.id)).toBe(false);
    const reopened = new AgentStore(dir);
    expect(reopened.has(a.id)).toBe(false);
  });

  test("list is stable-sorted by creation time", () => {
    const store = new AgentStore(dir);
    const first = store.create({ name: "first" });
    const second = store.create({ name: "second" });
    const ids = store.list().map((a) => a.id);
    expect(ids).toEqual([first.id, second.id]);
  });
});

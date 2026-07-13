import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSONOptions } from "@homebrain/llm";
import { resetConfig } from "@homebrain/shared";
import { KnowledgeEngine, FakeLlm } from "@homebrain/core";
import { CliConnector, type Connector } from "@homebrain/connectors";
import { Orchestrator } from "./runtime.ts";

let dir: string;
let engine: KnowledgeEngine;
let connector: CliConnector;
let orch: Orchestrator;
let fake: FakeLlm;

/**
 * One fake serves classification, routing, and synthesis by inspecting each
 * call's schema/prompt: classification schema has `intent`; routing has
 * `relevant`; synthesis has `grounded`.
 */
function makeFake(): FakeLlm {
  const f = new FakeLlm();
  f.onJSON((call: JSONOptions<unknown>) => {
    const props = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
    if ("intent" in props) {
      const prompt = String(call.prompt ?? "");
      // classify by content, mimicking what haiku would return
      if (/重新提炼|重新整理|别记|撤回/.test(prompt)) return { intent: "command" };
      if (/[?？]/.test(prompt)) return { intent: "question" };
      if (/记住|记下/.test(prompt)) return { intent: "remember" };
      return { intent: "chitchat" };
    }
    if ("relevant" in props) {
      // route: pick the alice page when the question mentions 后端
      const prompt = String(call.prompt ?? "");
      if (/后端/.test(prompt)) return { slugs: ["entities/alice"], relevant: true };
      return { slugs: [], relevant: false };
    }
    if ("grounded" in props) {
      return {
        answer: "后端由 [[entities/alice|Alice]] 负责。",
        grounded: true,
        usedSlugs: ["entities/alice"],
        gaps: [],
      };
    }
    throw new Error("unexpected schema");
  });
  f.onText(() => "这不在知识库记录中，以下是我的一般性回答：暂无更多信息。");
  return f;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-orch-"));
  process.env.HOMEBRAIN_DATA_DIR = dir;
  resetConfig();
  fake = makeFake();
  engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
  connector = new CliConnector({ groupChatId: "oc_team", p2pChatId: "oc_dm", userId: "ou_me" });
  orch = new Orchestrator({ engine, connector, llm: fake });
});

afterEach(async () => {
  await orch.stop();
  engine.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEBRAIN_DATA_DIR;
  resetConfig();
});

describe("orchestrator trunk (cli connector, no feishu)", () => {
  test("bot added creates team space and sends one-time notice", async () => {
    await orch.start();
    await connector.sendBotAdded();
    expect(connector.notices.length).toBe(1);
    expect(connector.notices[0]!.markdown).toContain("别记这条");
    expect(engine.registry.has("team/oc_team")).toBe(true);
  });

  test("unaddressed group message is captured but gets no reply (Q2)", async () => {
    await orch.start();
    await connector.sendGroup("Alice 负责后端服务，主导架构。", false);
    expect(connector.sent.length).toBe(0); // no reply
    // captured into team space
    const pending = engine.registry.store("team/oc_team").index().countRaw(true);
    expect(pending).toBe(1);
  });

  test("@-mentioned group question answers from knowledge with citations", async () => {
    // seed a page directly so ask has something to route to
    await engine.upsertPage("team/oc_team", {
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "后端负责人",
      aliases: [],
      tags: [],
      sources: [],
      links: [],
      content: "# Alice\nAlice 负责后端服务。\n",
      updatedAt: Date.now(),
      contentHash: "h",
    });
    await orch.start();
    await connector.sendGroup("谁负责后端服务？", true);
    expect(connector.sent.length).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("Alice");
    expect(connector.sent[0]!.markdown).toContain("依据");
    expect(connector.sent[0]!.inThread).toBe(true);
  });

  test("p2p message always gets a reply and is captured to personal space", async () => {
    await orch.start();
    await connector.sendP2P("记住：我们的发布流程是先灰度再全量。");
    expect(connector.sent.length).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("记下");
    expect(engine.registry.has("personal/ou_me")).toBe(true);
    expect(engine.registry.store("personal/ou_me").index().countRaw(true)).toBe(1);
  });

  test("replying 别记这条 retracts the source and does not capture the command", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({
      messageId: "om_cli-1",
      senderId: "ou_me",
    });

    await orch.start();
    await connector.sendGroup("本群测试代号是北极星", false);
    await connector.sendGroup("@小强Bot 别记这条", true);

    expect(connector.sent.at(-1)?.markdown).toContain("已撤回");
    await connector.sendGroup("@小强Bot 别记这条", true);
    expect(connector.sent.at(-1)?.markdown).toContain("已经撤回过了");
    expect(
      await engine.retractMessage("team/oc_team", {
        chatId: "oc_team",
        messageId: "om_cli-1",
        requestedBy: "ou_me",
      }),
    ).toEqual({ status: "already_retracted", affectedPages: [], requeuedSources: 0 });
    expect((await engine.runDreamCycle("team/oc_team")).examined).toBe(0);
  });

  test("retraction without a reply target gives actionable guidance", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => undefined;

    await orch.start();
    await connector.sendGroup("别记这条", true);

    expect(connector.sent.at(-1)?.markdown).toContain("请回复要撤回的那条原消息");
    expect((await engine.runDreamCycle("team/oc_team")).examined).toBe(0);
  });

  test("a question containing 撤回 is not mistaken for a retraction command", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => {
      throw new Error("should not resolve a reply target for a normal question");
    };

    await orch.start();
    await connector.sendGroup("怎么撤回知识？", true);

    expect(connector.sent.at(-1)?.markdown).not.toContain("请回复要撤回的那条原消息");
    expect((await engine.runDreamCycle("team/oc_team")).examined).toBe(1);
  });

  test("retraction refuses to remove another user's message", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({ messageId: "om_other", senderId: "ou_other" });

    await orch.start();
    await connector.inject({
      kind: "message",
      eventId: "evt_other",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_other",
      text: "别人的知识",
      messageId: "om_other",
      mentionsBot: false,
      createdAt: Date.now(),
    });
    await connector.sendGroup("别记这条", true);

    expect(connector.sent.at(-1)?.markdown).toContain("只有原作者、群主或群管理员可以撤回");
    expect(
      await engine.retractMessage("team/oc_team", {
        chatId: "oc_team",
        messageId: "om_other",
        requestedBy: "ou_other",
      }),
    ).toEqual({ status: "retracted", affectedPages: [], requeuedSources: 0 });
    expect((await engine.runDreamCycle("team/oc_team")).examined).toBe(0);
  });

  test("group administrator can retract another user's message", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({ messageId: "om_other", senderId: "ou_other" });
    reactive.isChatAdministrator = async () => true;

    await orch.start();
    await connector.inject({
      kind: "message",
      eventId: "evt_other",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_other",
      text: "群管理员可以治理的知识",
      messageId: "om_other",
      mentionsBot: false,
      createdAt: Date.now(),
    });
    await connector.sendGroup("别记这条", true);

    expect(connector.sent.at(-1)?.markdown).toContain("已撤回");
    expect(
      await engine.retractMessage("team/oc_team", {
        chatId: "oc_team",
        messageId: "om_other",
        requestedBy: "ou_other",
      }),
    ).toEqual({ status: "already_retracted", affectedPages: [], requeuedSources: 0 });
  });

  test("retraction finishes rebuilding affected knowledge before confirming", async () => {
    const removedId = await engine.remember({
      space: "team/oc_team",
      source: "message",
      author: "ou_me",
      chatId: "oc_team",
      messageId: "om_remove",
      content: "项目代号是北极星",
    });
    const survivingId = await engine.remember({
      space: "team/oc_team",
      source: "message",
      author: "ou_me",
      chatId: "oc_team",
      messageId: "om_keep",
      content: "项目负责人是 Alice",
    });
    engine.registry.store("team/oc_team").index().markIngested([removedId, survivingId]);
    await engine.upsertPage("team/oc_team", {
      slug: "concepts/project-facts",
      type: "concept",
      title: "项目信息",
      summary: "项目代号与负责人",
      aliases: [],
      tags: [],
      sources: [removedId, survivingId],
      links: [],
      content: "# 项目信息\n项目代号是北极星，负责人是 Alice。\n",
      updatedAt: Date.now(),
      contentHash: "before-retraction",
    });
    fake.onJSON((call) => {
      const props = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("operations" in props) {
        return {
          operations: [
            {
              type: "concept",
              name: "project-facts",
              title: "项目信息",
              rawIds: [survivingId],
            },
          ],
          skippedRawIds: [],
        };
      }
      return {
        title: "项目信息",
        summary: "项目负责人",
        aliases: [],
        tags: [],
        links: [],
        content: "# 项目信息\n项目负责人是 Alice。",
      };
    });
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({ messageId: "om_remove", senderId: "ou_me" });

    await orch.start();
    await connector.sendGroup("别记这条", true);

    expect(connector.sent.at(-1)?.markdown).toContain("已重新提炼");
    const rebuilt = await engine.getPage("team/oc_team", "concepts/project-facts");
    expect(rebuilt?.content).toContain("Alice");
    expect(rebuilt?.content).not.toContain("北极星");
  });

  test("shows a transient thinking reaction only for messages that get a reply", async () => {
    const events: string[] = [];
    const reactive = connector as CliConnector & Connector;
    const originalReply = connector.reply.bind(connector);
    reactive.addReaction = async (messageId, emojiType) => {
      events.push(`add:${messageId}:${emojiType}`);
      return "reaction_1";
    };
    reactive.removeReaction = async (messageId, reactionId) => {
      events.push(`remove:${messageId}:${reactionId}`);
    };
    reactive.reply = async (out) => {
      events.push("reply");
      await originalReply(out);
    };

    await orch.start();
    await connector.sendP2P("在吗");
    expect(events).toEqual([
      "add:om_cli-1:THINKING",
      "reply",
      "remove:om_cli-1:reaction_1",
    ]);

    events.length = 0;
    await connector.sendGroup("这条只需要收录", false);
    expect(events).toEqual([]);
  });

  test("cold-start question appends honest nudge (Q3)", async () => {
    await orch.start();
    // no pages exist -> ask returns general; runtime appends cold-start note
    await connector.sendP2P("公司年会是什么时候？");
    expect(connector.sent.length).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("知识库还是空的");
  });

  test("command '重新提炼' triggers a dream cycle", async () => {
    // seed one raw so the dream cycle has something (and won't call LLM on empty)
    await engine.remember({ space: "personal/ou_me", source: "message", content: "x" });
    // queue an analyze result for the triggered dream cycle
    fake.queueJSON({ operations: [], skippedRawIds: [] });
    await orch.start();
    await connector.sendP2P("帮我重新提炼一下知识");
    expect(connector.sent[0]!.markdown).toContain("重新提炼");
  });

  test("duplicate eventId is dropped", async () => {
    await orch.start();
    const dup = {
      kind: "message" as const,
      eventId: "dup-1",
      chatType: "p2p" as const,
      chatId: "oc_dm",
      senderId: "ou_me",
      text: "在吗",
      messageId: "om_x",
      mentionsBot: true,
      createdAt: Date.now(),
    };
    await orch.enqueue(dup);
    await orch.enqueue(dup);
    // only one reply for the greeting
    expect(connector.sent.length).toBe(1);
  });

  test("doc links are fetched and remembered as doc entries (Q8)", async () => {
    const fetched: string[] = [];
    const orch2 = new Orchestrator({
      engine,
      connector,
      llm: fake,
      docFetcher: async (link) => {
        fetched.push(link);
        return "# 发布流程\n先灰度再全量。";
      },
    });
    await orch2.start();
    await connector.inject({
      kind: "message",
      eventId: "doc-1",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_me",
      text: "见文档 https://x.feishu.cn/docx/abc123",
      messageId: "om_doc",
      mentionsBot: false,
      docLinks: ["https://x.feishu.cn/docx/abc123"],
      createdAt: Date.now(),
    });
    expect(fetched).toEqual(["https://x.feishu.cn/docx/abc123"]);
    // one message raw + one doc raw captured in the team space
    const raws = engine.registry.store("team/oc_team").index().listRaw({});
    expect(raws.some((r) => r.source === "doc")).toBe(true);
    await orch2.stop();
  });

  test("group with mentionsOnly=false answers an unaddressed question", async () => {
    // seed a page + the team space, then flip the group to respond-to-all
    await engine.upsertPage("team/oc_team", {
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "后端负责人",
      aliases: [],
      tags: [],
      sources: [],
      links: [],
      content: "# Alice\nAlice 负责后端服务。\n",
      updatedAt: Date.now(),
      contentHash: "h",
    });
    engine.registry.updateMeta("team/oc_team", { mentionsOnly: false });
    await orch.start();
    // NOT @-mentioned, but the group is set to respond to all messages
    await connector.sendGroup("谁负责后端服务？", false);
    expect(connector.sent.length).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("Alice");
  });

  test("assigned agent routes through its CLI provider, passing its instruction", async () => {
    // No injected llm: the engine must build a CLI-backed client from the
    // agent's provider. The injected runner returns JSON for route/synth (the
    // CLI client asks for JSON) and records the prompt to prove the persona
    // reached it.
    let sawInstruction = false;
    const cliEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_id, input) => {
        if (/像海盗一样说话/.test(input.prompt)) sawInstruction = true;
        if (/JSON Schema/.test(input.prompt) && /relevant/.test(input.prompt)) {
          return JSON.stringify({ slugs: ["entities/alice"], relevant: true });
        }
        if (/JSON Schema/.test(input.prompt) && /grounded/.test(input.prompt)) {
          return JSON.stringify({
            answer: "后端由 [[entities/alice|Alice]] 负责。",
            grounded: true,
            usedSlugs: ["entities/alice"],
            gaps: [],
          });
        }
        // intent classification (also JSON) -> a question
        if (/JSON Schema/.test(input.prompt) && /intent/.test(input.prompt)) {
          return JSON.stringify({ intent: "question" });
        }
        return "ok";
      },
    });
    await cliEngine.upsertPage("team/oc_team", {
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "后端负责人",
      aliases: [],
      tags: [],
      sources: [],
      links: [],
      content: "# Alice\nAlice 负责后端服务。\n",
      updatedAt: Date.now(),
      contentHash: "h",
    });
    const agent = cliEngine.agents.create({ name: "海盗", instruction: "像海盗一样说话，Arrr。", model: "", provider: "claude" });
    cliEngine.registry.updateMeta("team/oc_team", { agentId: agent.id });
    const cliConnector = new CliConnector({ groupChatId: "oc_team", p2pChatId: "oc_dm", userId: "ou_me" });
    // The orchestrator's intent classifier uses its own llm; give it the fake.
    const cliOrch = new Orchestrator({ engine: cliEngine, connector: cliConnector, llm: fake });
    await cliOrch.start();
    await cliConnector.sendGroup("谁负责后端服务？", true);
    expect(cliConnector.sent[0]!.markdown).toContain("Alice");
    expect(sawInstruction).toBe(true);
    await cliOrch.stop();
    cliEngine.close();
  });

  test("/task new is handled as a control command: creates a task, not captured, replies", async () => {
    await orch.start();
    // group message WITHOUT @-mention — control commands still respond + are not stored
    await connector.sendGroup("/task new 大模型 Agent 进展", false);
    expect(connector.sent.length).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("已创建");
    // a task now exists in the team space
    const tasks = engine.tasks.list().filter((t) => t.space === "team/oc_team");
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.topic).toBe("大模型 Agent 进展");
    // the control message was NOT captured as knowledge
    expect(engine.registry.store("team/oc_team").index().countRaw()).toBe(0);
  });

  test("/task list replies without creating anything", async () => {
    await orch.start();
    await connector.sendP2P("/task");
    expect(connector.sent.length).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("还没有任务");
    expect(engine.tasks.list().length).toBe(0);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import { parseSpaceArchive, type SpaceArchive } from "./governance.ts";

const SPACE: SpaceId = "team/oc_governance";
const dirs: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), label));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("space data governance", () => {
  test("a versioned export restores the complete space into a fresh data directory", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("hb-export-") });
    source.ensureSpace(SPACE, { chatId: "oc_governance" });
    const agent = source.agents.create({
      name: "治理助手",
      instruction: "只依据空间知识回答",
      provider: "codex",
    });
    source.registry.updateMeta(SPACE, { name: "治理群", agentId: agent.id });
    await source.updateSpaceRules(
      SPACE,
      { purpose: "# 治理目标\n\n保留可验证的团队事实。" },
      "local-admin",
    );
    const rawId = await source.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_governance",
      messageId: "om_keep",
      content: "项目代号是北极星",
      createdAt: 1_700_000_000_000,
    });
    const page: Page = {
      slug: "concepts/project-code",
      type: "concept",
      title: "项目代号",
      summary: "项目代号是北极星",
      aliases: [],
      tags: ["project"],
      sources: [rawId],
      links: [],
      content: "# 项目代号\n\n北极星。",
      updatedAt: 1_700_000_100_000,
      contentHash: "hash-project-code",
    };
    await source.upsertPage(SPACE, page);
    // Markdown is authoritative; simulate a missing/stale rebuildable index.
    source.registry.store(SPACE).index().deletePage(page.slug);
    source.tasks.create({ name: "每日报告", space: SPACE, topic: "项目进展" });
    source.reminders.create({
      title: "提交每日报告",
      space: SPACE,
      chatId: "oc_governance",
      creatorId: "ou_owner",
      triggerAt: 1_800_000_000_000,
    });
    const learningPlan = source.learning.create({
      name: "读《原则》",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "principles.md",
      sourceContent: "# 第一章\n\n项目原则正文",
      sourceRawIds: [rawId],
      sourceMessageId: "om_keep",
    }, 1_700_000_200_000);
    const learningSession = source.learning.prepareSession(learningPlan.id, {
      startOffset: 0,
      endOffset: learningPlan.sourceLength,
      sectionTitle: "第一章",
      excerpt: "# 第一章\n\n项目原则正文",
      guide: "## 今日目标\n理解原则",
      preparedAt: 1_700_000_300_000,
    })!;
    source.learning.markDelivered(learningSession.id, 1_700_000_400_000);
    await source.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_governance",
      messageId: "om_retracted",
      content: "不应保留",
    });
    await source.retractMessage(SPACE, {
      chatId: "oc_governance",
      messageId: "om_retracted",
      requestedBy: "ou_owner",
    });

    const archive = await source.exportSpace(SPACE);
    expect(archive).toEqual(
      expect.objectContaining({
        format: "homeagent.space",
        version: 4,
        space: expect.objectContaining({ id: SPACE, name: "治理群", agentId: agent.id }),
        agent: expect.objectContaining({ id: agent.id, name: "治理助手" }),
        pages: [expect.objectContaining({ slug: page.slug, title: page.title })],
        raw: [expect.objectContaining({ id: rawId, messageId: "om_keep" })],
        retractions: [
          expect.objectContaining({ chatId: "oc_governance", messageId: "om_retracted" }),
        ],
        tasks: [expect.objectContaining({ name: "每日报告", space: SPACE })],
        reminders: [expect.objectContaining({ title: "提交每日报告", space: SPACE })],
        learning: {
          plans: [expect.objectContaining({ id: learningPlan.id, name: "读《原则》" })],
          sources: [expect.objectContaining({ title: "principles.md", rawIds: [rawId] })],
          sessions: [expect.objectContaining({ id: learningSession.id, status: "awaiting_reply" })],
        },
        governanceAudit: [
          expect.objectContaining({
            action: "rules_updated",
            actor: "local-admin",
            target: "purpose",
          }),
        ],
      }),
    );
    source.close();

    const restored = new KnowledgeEngine({ dataDir: tempDir("hb-restore-") });
    await restored.restoreSpace(archive);
    expect(await restored.getPage(SPACE, page.slug)).toEqual(archive.pages[0]!);
    expect(restored.registry.get(SPACE)).toEqual(archive.space);
    expect(restored.agentForSpace(SPACE)).toEqual(archive.agent);
    expect(restored.tasks.list()).toEqual(archive.tasks);
    expect(restored.reminders.list()).toEqual(archive.reminders);
    expect(restored.learning.exportBySpace(SPACE)).toEqual(archive.learning);
    const roundTrip = await restored.exportSpace(SPACE);
    expect(roundTrip.raw).toEqual(archive.raw);
    expect(roundTrip.retractions).toEqual(archive.retractions);
    expect(roundTrip.reminders).toEqual(archive.reminders);
    expect(roundTrip.learning).toEqual(archive.learning);
    expect(roundTrip.governanceAudit).toEqual(archive.governanceAudit);
    restored.close();
  });

  test("accepts a pre-rename archive and normalizes its format", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-legacy-archive-") });
    engine.ensureSpace(SPACE, { chatId: "oc_governance" });
    const archive = await engine.exportSpace(SPACE);
    engine.close();

    const parsed = parseSpaceArchive({ ...archive, format: "homebrain.space" });

    expect(parsed.format).toBe("homeagent.space");
    expect(parsed.space.id).toBe(SPACE);
  });

  test("accepts version 1 archives by supplying an empty learning graph", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-v1-archive-") });
    engine.ensureSpace(SPACE);
    const archive = await engine.exportSpace(SPACE);
    engine.close();

    const {
      learning: _learning,
      governanceAudit: _governanceAudit,
      ...withoutLearning
    } = archive;
    const parsed = parseSpaceArchive({ ...withoutLearning, version: 1 });

    expect(parsed.version).toBe(4);
    expect(parsed.learning).toEqual({ plans: [], sources: [], sessions: [] });
    expect(parsed.governanceAudit).toEqual([]);
  });

  test("accepts version 2 reading archives and normalizes their learning fields", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-v2-archive-") });
    engine.ensureSpace(SPACE);
    const plan = engine.learning.create({
      name: "读原则",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "principles.md",
      sourceContent: "原则正文",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    }, 10);
    const archive = JSON.parse(JSON.stringify(await engine.exportSpace(SPACE))) as Record<string, any>;
    engine.close();
    archive.version = 2;
    delete archive.governanceAudit;
    delete archive.learning.plans[0].mode;
    delete archive.learning.plans[0].topic;
    delete archive.learning.plans[0].route;
    delete archive.learning.plans[0].routeIndex;
    delete archive.learning.plans[0].adaptiveFocus;
    delete archive.learning.sources[0].materials;

    const parsed = parseSpaceArchive(archive);

    expect(parsed.version).toBe(4);
    expect(parsed.learning.plans[0]).toEqual(expect.objectContaining({
      id: plan.id,
      mode: "reading",
      route: [],
      routeIndex: 0,
    }));
    expect(parsed.learning.sources[0]?.materials).toEqual([
      expect.objectContaining({ title: "principles.md", rawIds: ["raw_book"] }),
    ]);
  });

  test("version 3 archives preserve topic routes and material provenance", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-v3-topic-source-") });
    source.ensureSpace(SPACE, { chatId: "oc_governance" });
    const plan = source.learning.createTopic({
      name: "学习 Rust",
      topic: "Rust 异步编程",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      route: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    }, 100);
    source.learning.addMaterial(plan.id, "ou_owner", {
      title: "Async Book",
      content: "Future 只有在 poll 时推进。",
      rawIds: ["raw_async"],
      messageId: "om_async",
    }, 101);

    const archive = JSON.parse(JSON.stringify(await source.exportSpace(SPACE))) as Record<string, any>;
    archive.version = 3;
    delete archive.governanceAudit;
    source.close();

    const target = new KnowledgeEngine({ dataDir: tempDir("ha-v3-topic-target-") });
    await target.restoreSpace(archive);
    expect(target.learning.get(plan.id)).toEqual(expect.objectContaining({
      mode: "topic",
      topic: "Rust 异步编程",
      route: expect.arrayContaining([expect.objectContaining({ title: "Future" })]),
    }));
    expect(target.learning.source(plan.id)?.materials).toEqual([
      expect.objectContaining({ title: "Async Book", rawIds: ["raw_async"] }),
    ]);
    expect((await target.exportSpace(SPACE)).version).toBe(4);
    target.close();
  });

  test("deleting a space removes its knowledge and tasks but keeps shared agents", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-delete-") });
    engine.ensureSpace(SPACE, { chatId: "oc_governance" });
    const agent = engine.agents.create({ name: "共享助手", provider: "codex" });
    engine.registry.updateMeta(SPACE, { agentId: agent.id });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      content: "将被删除",
    });
    await engine.upsertPage(SPACE, {
      slug: "concepts/deleted",
      type: "concept",
      title: "待删除",
      summary: "待删除",
      aliases: [],
      tags: [],
      sources: [rawId],
      links: [],
      content: "# 待删除",
      updatedAt: 1,
      contentHash: "deleted",
    });
    engine.tasks.create({ name: "空间任务", space: SPACE, topic: "x" });
    engine.reminders.create({
      title: "空间提醒",
      space: SPACE,
      chatId: "oc_governance",
      creatorId: "ou_owner",
      triggerAt: Date.now() + 3600_000,
    });
    const learningPlan = engine.learning.create({
      name: "空间学习",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "book.md",
      sourceContent: "书籍正文",
      sourceRawIds: [rawId],
      sourceMessageId: "om_book",
    });
    const backup = await engine.exportSpace(SPACE);

    expect(await engine.deleteSpace(SPACE)).toEqual({
      status: "deleted",
      space: SPACE,
      pagesDeleted: 1,
      rawDeleted: 1,
      tasksDeleted: 1,
      remindersDeleted: 1,
      learningPlansDeleted: 1,
    });
    expect(engine.registry.has(SPACE)).toBe(false);
    expect(await engine.getPage(SPACE, "concepts/deleted")).toBeNull();
    expect(engine.tasks.list()).toEqual([]);
    expect(engine.reminders.list()).toEqual([]);
    expect(engine.learning.get(learningPlan.id)).toBeUndefined();
    expect(engine.agents.has(agent.id)).toBe(true);
    expect(await engine.deleteSpace(SPACE)).toEqual({
      status: "not_found",
      space: SPACE,
      pagesDeleted: 0,
      rawDeleted: 0,
      tasksDeleted: 0,
      remindersDeleted: 0,
      learningPlansDeleted: 0,
    });

    await engine.restoreSpace(backup);
    expect(await engine.getPage(SPACE, "concepts/deleted")).not.toBeNull();
    expect(engine.tasks.list()).toEqual(backup.tasks);
    expect(engine.reminders.list()).toEqual(backup.reminders);
    expect(engine.learning.exportBySpace(SPACE)).toEqual(backup.learning);
    engine.close();
  });

  test("raw retention deletes only expired ingested messages", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-retention-") });
    const now = 1_800_000_000_000;
    const day = 86_400_000;
    const raw = [
      { id: "old-ingested", source: "message", createdAt: now - 40 * day, ingested: true },
      { id: "old-pending", source: "message", createdAt: now - 40 * day, ingested: false },
      { id: "recent-ingested", source: "message", createdAt: now - 5 * day, ingested: true },
      { id: "old-doc", source: "doc", createdAt: now - 40 * day, ingested: true },
    ].map((record) => ({
      ...record,
      space: SPACE,
      content: record.id,
      attachments: [],
    })) as SpaceArchive["raw"];
    await engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now - 50 * day },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw,
      retractions: [],
      tasks: [],
    });

    expect(await engine.pruneRawMessages(30, now)).toEqual({
      retentionDays: 30,
      cutoff: now - 30 * day,
      deleted: 1,
      bySpace: { [SPACE]: 1 },
    });
    const remaining = await engine.exportSpace(SPACE);
    expect(remaining.raw.map((record) => record.id).sort()).toEqual([
      "old-doc",
      "old-pending",
      "recent-ingested",
    ]);
    expect((await engine.pruneRawMessages(0, now)).deleted).toBe(0);
    engine.close();
  });

  test("raw retention preserves provenance needed to authorize later source retraction", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-learning-retention-") });
    const now = 1_800_000_000_000;
    const rawId = "old-learning-source";
    await engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now - 50 * 86_400_000 },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [{
        id: rawId,
        space: SPACE,
        source: "message",
        author: "ou_owner",
        chatId: "oc_governance",
        messageId: "om_book",
        content: "book content",
        attachments: [],
        createdAt: now - 40 * 86_400_000,
        ingested: true,
      }],
      retractions: [],
      tasks: [],
    });
    const plan = engine.learning.create({
      name: "retained",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "book.md",
      sourceContent: "book content",
      sourceRawIds: [rawId],
      sourceMessageId: "om_book",
    });

    expect((await engine.pruneRawMessages(30, now)).deleted).toBe(0);
    expect(engine.registry.store(SPACE).index().getRaw(rawId)).not.toBeNull();
    expect((await engine.retractMessage(SPACE, {
      chatId: "oc_governance",
      messageId: "om_book",
      requestedBy: "ou_owner",
    })).status).toBe("retracted");
    expect(engine.learning.get(plan.id)).toBeUndefined();
    engine.close();
  });

  test("restore rejects duplicate archive identities before creating a space", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-duplicate-restore-") });
    const now = Date.now();
    const raw = {
      id: "duplicate",
      space: SPACE,
      source: "message" as const,
      content: "duplicate",
      attachments: [],
      createdAt: now,
      ingested: true,
    };

    await expect(engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [raw, raw],
      retractions: [],
      tasks: [],
    })).rejects.toThrow("duplicate raw id");
    expect(engine.registry.has(SPACE)).toBe(false);
    engine.close();
  });

  test("restore rejects space ids that could collide on disk", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-space-collision-") });
    const existing: SpaceId = "team/a_b";
    engine.ensureSpace(existing);
    const now = Date.now();

    await expect(engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: "team/a/b", createdAt: now },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [],
      retractions: [],
      tasks: [],
    })).rejects.toThrow("storage path conflicts");
    expect(engine.registry.has(existing)).toBe(true);
    expect(engine.registry.has("team/a/b" as SpaceId)).toBe(false);
    engine.close();
  });

  test("an unusual but valid existing space id can round-trip when its storage is unique", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-unusual-space-") });
    const unusual = "team/a.b+c" as SpaceId;
    engine.ensureSpace(unusual);
    const archive = await engine.exportSpace(unusual);

    await engine.deleteSpace(unusual);
    await engine.restoreSpace(archive);

    expect(engine.registry.has(unusual)).toBe(true);
    engine.close();
  });

  test("restore preflight rejects task id conflicts without leaving a partial space", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-conflict-restore-") });
    const other: SpaceId = "team/other";
    engine.ensureSpace(other);
    const task = engine.tasks.create({ name: "existing", space: other, topic: "topic" })!;
    const now = Date.now();

    await expect(engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [],
      retractions: [],
      tasks: [{ ...task, space: SPACE }],
    })).rejects.toThrow("task id already exists");
    expect(engine.registry.has(SPACE)).toBe(false);
    expect(engine.tasks.get(task.id)?.space).toBe(other);
    engine.close();
  });

  test("restore preserves a dangling archived agent binding", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-dangling-agent-") });
    engine.ensureSpace(SPACE);
    engine.registry.updateMeta(SPACE, { agentId: "agent_missing" });
    const archive = await engine.exportSpace(SPACE);
    expect(archive.agent).toBeUndefined();

    await engine.deleteSpace(SPACE);
    await engine.restoreSpace(archive);

    expect(engine.registry.get(SPACE)?.agentId).toBe("agent_missing");
    engine.close();
  });

  test("failed workspace deletion restores linked tasks", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-delete-rollback-") });
    engine.ensureSpace(SPACE);
    const task = engine.tasks.create({ name: "keep", space: SPACE, topic: "topic" })!;
    const learningPlan = engine.learning.create({
      name: "keep learning",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "book.md",
      sourceContent: "book content",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    });
    engine.registry.remove = () => {
      throw new Error("workspace removal failed");
    };

    await expect(engine.deleteSpace(SPACE)).rejects.toThrow("workspace removal failed");

    expect(engine.registry.has(SPACE)).toBe(true);
    expect(engine.tasks.get(task.id)).toEqual(task);
    expect(engine.learning.get(learningPlan.id)).toEqual(learningPlan);
    engine.close();
  });

  test("retracting the source message removes learning snapshots derived from it", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-learning-retraction-") });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_governance",
      messageId: "om_book",
      content: "# 附件：book.md\n\n书籍正文",
    });
    const plan = engine.createLearningPlanFromMessage({
      space: SPACE,
      chatId: "oc_governance",
      messageId: "om_book",
      creatorId: "ou_owner",
      name: "读书",
    });

    await engine.retractMessage(SPACE, {
      chatId: "oc_governance",
      messageId: "om_book",
      requestedBy: "ou_owner",
    });

    expect(engine.learning.get(plan.id)).toBeUndefined();
    expect(engine.registry.store(SPACE).index().getRaw(rawId)).toBeNull();
    engine.close();
  });

  test("restore validates the complete learning graph before creating a space", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-learning-invalid-source-") });
    source.ensureSpace(SPACE);
    source.learning.create({
      name: "invalid",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "book.md",
      sourceContent: "book content",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    });
    const archive = await source.exportSpace(SPACE);
    source.close();
    archive.learning.plans[0] = { ...archive.learning.plans[0]!, sourceId: "missing" };
    const target = new KnowledgeEngine({ dataDir: tempDir("ha-learning-invalid-target-") });

    await expect(target.restoreSpace(archive)).rejects.toThrow("learning plan sourceId");
    expect(target.registry.has(SPACE)).toBe(false);
    expect(target.learning.list()).toEqual([]);
    target.close();
  });

  test("restore rejects an oversized learning source before creating a space", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-learning-large-source-") });
    source.ensureSpace(SPACE);
    source.learning.create({
      name: "large",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "book.md",
      sourceContent: "x",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    });
    const archive = await source.exportSpace(SPACE);
    source.close();
    archive.learning.sources[0] = {
      ...archive.learning.sources[0]!,
      content: "x".repeat(2_000_001),
    };
    archive.learning.plans[0] = {
      ...archive.learning.plans[0]!,
      sourceLength: 2_000_001,
    };
    const target = new KnowledgeEngine({ dataDir: tempDir("ha-learning-large-target-") });

    await expect(target.restoreSpace(archive)).rejects.toThrow("exceeds 2000000 characters");
    expect(target.registry.has(SPACE)).toBe(false);
    target.close();
  });

  test("restore rejects task hours outside the scheduler domain", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-task-hour-") });
    const now = Date.now();
    await expect(engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [],
      retractions: [],
      tasks: [{
        id: "task_invalid_hour",
        name: "invalid",
        space: SPACE,
        topic: "topic",
        cadence: "daily",
        hour: 24,
        enabled: true,
        notify: false,
        distillOnRun: true,
        createdAt: now,
        updatedAt: now,
      }],
    })).rejects.toThrow("tasks[0].hour is invalid");
    expect(engine.registry.has(SPACE)).toBe(false);
    engine.close();
  });

  test("restore rejects an embedded agent that is not bound to the space", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-unbound-agent-") });
    const agent = engine.agents.create({ name: "unbound", provider: "codex" });
    engine.agents.remove(agent.id);
    const now = Date.now();

    await expect(engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now },
      agent,
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [],
      retractions: [],
      tasks: [],
    })).rejects.toThrow("agent.id does not match space.agentId");
    expect(engine.agents.has(agent.id)).toBe(false);
    expect(engine.registry.has(SPACE)).toBe(false);
    engine.close();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import { FakeLlm } from "./testing.ts";
import { writeQuarantineRecord } from "./quarantine.ts";

const SPACE: SpaceId = "team/oc_knowledge_governance";

let dir: string;
let engine: KnowledgeEngine;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-knowledge-governance-"));
  engine = new KnowledgeEngine({ dataDir: dir });
  engine.ensureSpace(SPACE);
});

afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("knowledge governance", () => {
  test("updates space rules and records who changed them", async () => {
    const snapshot = await engine.updateSpaceRules(
      SPACE,
      {
        purpose: "# 团队目标\n\n只沉淀产品决策与负责人。",
        schema: "# 知识规则\n\n- entity: 负责人\n- analysis: 产品决策",
      },
      "local-admin",
    );

    expect(snapshot.purpose).toContain("只沉淀产品决策");
    expect(snapshot.schema).toContain("产品决策");
    expect(snapshot.audit).toEqual([
      expect.objectContaining({
        space: SPACE,
        action: "rules_updated",
        actor: "local-admin",
        target: "purpose,schema",
        status: "succeeded",
      }),
    ]);
  });

  test("resets one rule without overwriting the other rule", async () => {
    await engine.updateSpaceRules(
      SPACE,
      {
        purpose: "# 自定义目标\n\n只记录发布决策。",
        schema: "# 自定义规则\n\n- analysis: 发布决策",
      },
      "local-admin",
    );

    const snapshot = await engine.resetSpaceRule(SPACE, "purpose", "local-admin");

    expect(snapshot.purpose).toContain("这是一个 homeagent 知识空间");
    expect(snapshot.schema).toContain("analysis: 发布决策");
    expect(snapshot.audit.at(-1)).toEqual(
      expect.objectContaining({
        action: "rule_reset",
        target: "purpose",
        actor: "local-admin",
      }),
    );
  });

  test("shows a raw record with every knowledge page derived from it", async () => {
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      content: "Alice 负责支付系统。",
    });
    await engine.upsertPage(SPACE, {
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "支付系统负责人",
      aliases: [],
      tags: ["team"],
      sources: [rawId],
      links: [],
      content: "# Alice\n\nAlice 负责支付系统。\n",
      updatedAt: 1_700_000_000_000,
      contentHash: "alice-hash",
    });

    const detail = await engine.getRawGovernanceDetail(SPACE, rawId);

    expect(detail?.raw).toEqual(
      expect.objectContaining({ id: rawId, author: "ou_owner", content: "Alice 负责支付系统。" }),
    );
    expect(detail?.pages).toEqual([
      expect.objectContaining({ slug: "entities/alice", title: "Alice" }),
    ]);
    expect(await engine.getRawGovernanceDetail(SPACE, "missing")).toBeNull();
  });

  test("redistills only the selected raw record and audits the result", async () => {
    const fake = new FakeLlm();
    const governed = new KnowledgeEngine({
      dataDir: join(dir, "redistill"),
      llm: fake,
    });
    governed.ensureSpace(SPACE);
    const selectedId = await governed.remember({
      space: SPACE,
      source: "message",
      content: "支付系统负责人是 Alice。",
    });
    const unrelatedId = await governed.remember({
      space: SPACE,
      source: "message",
      content: "这条记录本次不应参与提炼。",
    });
    governed.registry.store(SPACE).index().markIngested([selectedId]);
    fake.queueJSON({
      operations: [
        {
          type: "entity",
          name: "alice",
          title: "Alice",
          rawIds: [selectedId],
        },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({
      title: "Alice",
      summary: "支付系统负责人",
      aliases: [],
      tags: ["team"],
      links: [],
      content: "# Alice\n\nAlice 负责支付系统。",
    });

    const report = await governed.redistillRaw(SPACE, selectedId, "local-admin");

    expect(report.examined).toBe(1);
    expect(report.processedRawIds).toEqual([selectedId]);
    expect(governed.registry.store(SPACE).index().getRaw(unrelatedId)?.ingested).toBe(false);
    expect((await governed.getSpaceGovernance(SPACE)).audit.at(-1)).toEqual(
      expect.objectContaining({
        action: "raw_redistilled",
        target: selectedId,
        rawIds: [selectedId],
        pageSlugs: ["entities/alice"],
        status: "succeeded",
      }),
    );
    governed.close();
  });

  test("deletes a derived knowledge page without deleting its raw evidence", async () => {
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      content: "项目代号是北极星。",
    });
    engine.registry.store(SPACE).index().markIngested([rawId]);
    await engine.upsertPage(SPACE, {
      slug: "concepts/project-code",
      type: "concept",
      title: "项目代号",
      summary: "项目代号是北极星",
      aliases: [],
      tags: ["project"],
      sources: [rawId],
      links: [],
      content: "# 项目代号\n\n北极星。\n",
      updatedAt: 1_700_000_000_000,
      contentHash: "project-code-hash",
    });

    const result = await engine.deleteKnowledgePage(
      SPACE,
      "concepts/project-code",
      "local-admin",
    );

    expect(result).toEqual({
      status: "deleted",
      slug: "concepts/project-code",
      rawIds: [rawId],
    });
    expect(await engine.getPage(SPACE, "concepts/project-code")).toBeNull();
    expect(engine.registry.store(SPACE).index().getRaw(rawId)).not.toBeNull();
    expect((await engine.getSpaceGovernance(SPACE)).audit.at(-1)).toEqual(
      expect.objectContaining({
        action: "page_deleted",
        target: "concepts/project-code",
        rawIds: [rawId],
        pageSlugs: ["concepts/project-code"],
      }),
    );
  });

  test("regenerates the same knowledge page from all of its sources", async () => {
    const fake = new FakeLlm();
    const governed = new KnowledgeEngine({
      dataDir: join(dir, "regenerate"),
      llm: fake,
    });
    governed.ensureSpace(SPACE);
    const rawId = await governed.remember({
      space: SPACE,
      source: "message",
      content: "Alice 负责支付系统。",
    });
    governed.registry.store(SPACE).index().markIngested([rawId]);
    await governed.upsertPage(SPACE, {
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "旧摘要",
      aliases: [],
      tags: [],
      sources: [rawId],
      links: [],
      content: "# Alice\n\n旧内容。\n",
      updatedAt: 1_700_000_000_000,
      contentHash: "old-hash",
    });
    fake.queueJSON({
      title: "Alice",
      summary: "支付系统负责人",
      aliases: [],
      tags: ["team"],
      links: [],
      content: "# Alice\n\nAlice 负责支付系统。",
    });

    const result = await governed.regenerateKnowledgePage(
      SPACE,
      "entities/alice",
      "local-admin",
    );

    expect(result.status).toBe("regenerated");
    expect(result.page?.slug).toBe("entities/alice");
    expect(result.page?.sources).toEqual([rawId]);
    expect(result.page?.content).toContain("负责支付系统");
    expect((await governed.getSpaceGovernance(SPACE)).audit.at(-1)).toEqual(
      expect.objectContaining({
        action: "page_regenerated",
        target: "entities/alice",
        status: "succeeded",
        rawIds: [rawId],
      }),
    );
    governed.close();
  });

  test("regenerating a page preserves quarantines backed by other raw sources", async () => {
    const fake = new FakeLlm();
    const governed = new KnowledgeEngine({
      dataDir: join(dir, "regenerate-with-unrelated-quarantine"),
      llm: fake,
    });
    governed.ensureSpace(SPACE);
    const pageRawId = await governed.remember({
      space: SPACE,
      source: "message",
      content: "Alice 负责支付系统。",
    });
    const quarantinedRawId = await governed.remember({
      space: SPACE,
      source: "message",
      content: "Alice 同时负责另一条尚未恢复的事实。",
    });
    governed.registry.store(SPACE).index().markIngested([pageRawId, quarantinedRawId]);
    await governed.upsertPage(SPACE, {
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "支付系统负责人",
      aliases: [],
      tags: [],
      sources: [pageRawId],
      links: [],
      content: "# Alice\n\nAlice 负责支付系统。\n",
      updatedAt: 1_700_000_000_000,
      contentHash: "alice-old",
    });
    writeQuarantineRecord(governed.registry.store(SPACE), {
      slug: "entities/alice",
      error: "另一批来源生成失败",
      rawIds: [quarantinedRawId],
      createdAt: 1_700_000_100_000,
    });
    fake.queueJSON({
      title: "Alice",
      summary: "支付系统负责人",
      aliases: [],
      tags: [],
      links: [],
      content: "# Alice\n\nAlice 负责支付系统。",
    });

    expect(
      (await governed.regenerateKnowledgePage(SPACE, "entities/alice", "local-admin")).status,
    ).toBe("regenerated");
    expect(await governed.listQuarantines(SPACE)).toEqual([
      expect.objectContaining({ slug: "entities/alice", rawIds: [quarantinedRawId] }),
    ]);
    governed.close();
  });

  test("persists a correction as manual evidence before regenerating the page", async () => {
    const fake = new FakeLlm();
    const governed = new KnowledgeEngine({
      dataDir: join(dir, "correction"),
      llm: fake,
    });
    governed.ensureSpace(SPACE);
    const originalRawId = await governed.remember({
      space: SPACE,
      source: "message",
      content: "支付系统负责人是 Alice。",
    });
    governed.registry.store(SPACE).index().markIngested([originalRawId]);
    await governed.upsertPage(SPACE, {
      slug: "concepts/payment-owner",
      type: "concept",
      title: "支付系统负责人",
      summary: "Alice 负责支付系统",
      aliases: [],
      tags: [],
      sources: [originalRawId],
      links: [],
      content: "# 支付系统负责人\n\nAlice 负责支付系统。\n",
      updatedAt: 1_700_000_000_000,
      contentHash: "old-payment-owner",
    });
    fake.queueJSON({
      title: "支付系统负责人",
      summary: "Bob 负责支付系统",
      aliases: [],
      tags: [],
      links: [],
      content: "# 支付系统负责人\n\nBob 负责支付系统，Alice 已不再负责。",
    });

    const result = await governed.submitKnowledgeCorrection(
      SPACE,
      "concepts/payment-owner",
      "负责人已经改为 Bob；Alice 不再负责支付系统。",
      "local-admin",
    );

    expect(result.status).toBe("regenerated");
    expect(result.rawId).toBeString();
    const correctionRaw = governed.registry.store(SPACE).index().getRaw(result.rawId!);
    expect(correctionRaw).toEqual(
      expect.objectContaining({
        source: "manual",
        author: "local-admin",
        ingested: true,
      }),
    );
    expect(correctionRaw?.content).toContain("负责人已经改为 Bob");
    expect(result.page?.sources).toEqual([originalRawId, result.rawId!]);
    expect(result.page?.content).toContain("Bob 负责支付系统");
    expect((await governed.getSpaceGovernance(SPACE)).audit.at(-1)).toEqual(
      expect.objectContaining({
        action: "correction_submitted",
        target: "concepts/payment-owner",
        rawIds: [originalRawId, result.rawId!],
        status: "succeeded",
      }),
    );
    governed.close();
  });

  test("corrects an old page even after its original raw body was pruned", async () => {
    const fake = new FakeLlm();
    const governed = new KnowledgeEngine({
      dataDir: join(dir, "correction-after-retention"),
      llm: fake,
    });
    governed.ensureSpace(SPACE);
    await governed.upsertPage(SPACE, {
      slug: "concepts/legacy-owner",
      type: "concept",
      title: "旧项目负责人",
      summary: "Alice 负责旧项目",
      aliases: [],
      tags: [],
      sources: ["pruned-raw-id"],
      links: [],
      content: "# 旧项目负责人\n\nAlice 负责旧项目。\n",
      updatedAt: 1_700_000_000_000,
      contentHash: "legacy-owner",
    });
    fake.queueJSON({
      title: "旧项目负责人",
      summary: "Bob 负责旧项目",
      aliases: [],
      tags: [],
      links: [],
      content: "# 旧项目负责人\n\nBob 负责旧项目。",
    });

    const result = await governed.submitKnowledgeCorrection(
      SPACE,
      "concepts/legacy-owner",
      "负责人已经改为 Bob。",
      "local-admin",
    );

    expect(result.status).toBe("regenerated");
    expect(result.page?.content).toContain("Bob 负责旧项目");
    expect(result.page?.sources).toEqual(["pruned-raw-id", result.rawId!]);
    expect(governed.registry.store(SPACE).index().getRaw(result.rawId!)?.ingested).toBe(true);
    governed.close();
  });

  test("keeps the old page when correction regeneration fails", async () => {
    const fake = new FakeLlm();
    const governed = new KnowledgeEngine({
      dataDir: join(dir, "failed-correction"),
      llm: fake,
    });
    governed.ensureSpace(SPACE);
    const originalRawId = await governed.remember({
      space: SPACE,
      source: "message",
      content: "项目代号是北极星。",
    });
    governed.registry.store(SPACE).index().markIngested([originalRawId]);
    await governed.upsertPage(SPACE, {
      slug: "concepts/project-code",
      type: "concept",
      title: "项目代号",
      summary: "北极星",
      aliases: [],
      tags: [],
      sources: [originalRawId],
      links: [],
      content: "# 项目代号\n\n北极星。\n",
      updatedAt: 1_700_000_000_000,
      contentHash: "old-project-code",
    });
    fake.queueJSON({ title: "项目代号", summary: "", content: "   " });

    const result = await governed.submitKnowledgeCorrection(
      SPACE,
      "concepts/project-code",
      "项目代号已经改为南十字星。",
      "local-admin",
    );

    expect(result.status).toBe("failed");
    expect((await governed.getPage(SPACE, "concepts/project-code"))?.content).toContain("北极星");
    expect(governed.registry.store(SPACE).index().getRaw(result.rawId!)?.ingested).toBe(true);
    expect(await governed.listQuarantines(SPACE)).toEqual([
      expect.objectContaining({
        slug: "concepts/project-code",
        rawIds: expect.arrayContaining([originalRawId, result.rawId!]),
      }),
    ]);
    expect((await governed.listQuarantines(SPACE))[0]?.rawIds).toHaveLength(2);
    expect((await governed.getSpaceGovernance(SPACE)).audit.at(-1)?.status).toBe("failed");
    governed.close();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSONOptions } from "@homeagent/llm";
import type { Page, SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import { FakeLlm } from "./testing.ts";

const SPACE: SpaceId = "team/oc_retrieval";
let dir: string;
let engines: KnowledgeEngine[];

function page(slug: string, title: string, content: string): Page {
  return {
    slug,
    type: "entity",
    title,
    summary: content,
    aliases: [],
    tags: [],
    sources: [],
    links: [],
    content,
    updatedAt: Date.now(),
    contentHash: `hash-${slug}`,
  };
}

function semanticFixture() {
  return {
    async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      return texts.map((text) => {
        if (text === "线上故障该找哪位？" || text.includes("Alice 负责后端服务")) {
          return [1, 0];
        }
        if (text.includes("本周菜单是番茄炒蛋")) return [0, 1];
        return [0, 0];
      });
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "homeagent-retrieval-"));
  engines = [];
});

afterEach(() => {
  for (const engine of engines) engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("hybrid retrieval experiment", () => {
  test("recalls a semantic-only page while default search remains FTS", async () => {
    const engine = new KnowledgeEngine({
      dataDir: dir,
      embeddingProvider: semanticFixture(),
    });
    engines.push(engine);
    await engine.upsertPage(
      SPACE,
      page("entities/alice", "Alice", "Alice 负责后端服务"),
    );
    await engine.upsertPage(
      SPACE,
      page("concepts/menu", "菜单", "本周菜单是番茄炒蛋"),
    );

    expect(await engine.search([SPACE], "线上故障该找哪位？")).toEqual([]);
    expect(
      (await engine.search(
        [SPACE],
        "线上故障该找哪位？",
        { retrieval: "hybrid" },
      )).map((hit) => hit.slug),
    ).toContain("entities/alice");
  });

  test("preserves the strongest lexical hit against a poor semantic ranking", async () => {
    const query = "后端";
    const engine = new KnowledgeEngine({
      dataDir: dir,
      embeddingProvider: {
        async embed(texts) {
          return texts.map((text) => {
            if (text === query || text.includes("本周菜单")) return [1, 0];
            if (text.includes("Alice 负责后端服务")) return [-1, 0];
            return [0, 0];
          });
        },
      },
    });
    engines.push(engine);
    await engine.upsertPage(
      SPACE,
      page("entities/alice", "Alice", "Alice 负责后端服务"),
    );
    await engine.upsertPage(
      SPACE,
      page("concepts/menu", "菜单", "本周菜单是番茄炒蛋"),
    );

    expect(
      (await engine.search(
        [SPACE],
        query,
        { limit: 1, retrieval: "hybrid" },
      )).map((hit) => hit.slug),
    ).toEqual(["entities/alice"]);
  });

  test("falls back to the existing FTS result when embedding fails", async () => {
    const engine = new KnowledgeEngine({
      dataDir: dir,
      embeddingProvider: {
        async embed() {
          throw new Error("embedding provider unavailable");
        },
      },
    });
    engines.push(engine);
    await engine.upsertPage(
      SPACE,
      page("entities/alice", "Alice", "Alice 负责后端服务"),
    );

    expect(
      (await engine.search(
        [SPACE],
        "后端",
        { retrieval: "hybrid" },
      )).map((hit) => hit.slug),
    ).toEqual(["entities/alice"]);
  });

  test("bounds embedding provider batches during the first semantic search", async () => {
    let largestBatch = 0;
    const engine = new KnowledgeEngine({
      dataDir: dir,
      embeddingProvider: {
        async embed(texts) {
          largestBatch = Math.max(largestBatch, texts.length);
          return texts.map(() => [1, 0]);
        },
      },
    });
    engines.push(engine);
    for (let index = 0; index < 40; index += 1) {
      await engine.upsertPage(
        SPACE,
        page(
          `concepts/batch-${index}`,
          `Batch ${index}`,
          `批量向量化边界 ${index}`,
        ),
      );
    }

    expect(
      await engine.search([SPACE], "批量边界", { retrieval: "hybrid" }),
    ).toHaveLength(10);
    expect(largestBatch).toBeLessThanOrEqual(32);
  });

  test("bounds total semantic candidates on a large first search", async () => {
    let embeddedDocuments = 0;
    const query = "没有词面重叠的查询";
    const engine = new KnowledgeEngine({
      dataDir: dir,
      embeddingProvider: {
        async embed(texts) {
          embeddedDocuments += texts.filter((text) => text !== query).length;
          return texts.map(() => [1, 0]);
        },
      },
    });
    engines.push(engine);
    const store = engine.registry.ensure(SPACE);
    for (let index = 0; index < 2_055; index += 1) {
      store.index().upsertPage(
        page(
          `concepts/large-${index}`,
          `Large ${index}`,
          `大规模语义候选 ${index}`,
        ),
      );
    }

    await engine.search([SPACE], query, { retrieval: "hybrid" });

    expect(embeddedDocuments).toBe(2_048);
  });

  test("uses hybrid fallback when LLM routing fails", async () => {
    const llm = new FakeLlm();
    llm.onJSON((call: JSONOptions<unknown>) => {
      const properties =
        (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("relevant" in properties) throw new Error("route provider unavailable");
      return {
        answer: "线上故障可以联系 Alice。",
        grounded: true,
        usedSlugs: ["entities/alice"],
        gaps: [],
      };
    });
    const engine = new KnowledgeEngine({
      dataDir: dir,
      llm,
      embeddingProvider: semanticFixture(),
    });
    engines.push(engine);
    await engine.upsertPage(
      SPACE,
      page("entities/alice", "Alice", "Alice 负责后端服务"),
    );

    const answer = await engine.ask(
      [SPACE],
      "线上故障该找哪位？",
      { knowledgeOnly: true, retrieval: "hybrid" },
    );

    expect(answer.source).toBe("knowledge");
    expect(answer.citations).toEqual([{ slug: "entities/alice", title: "Alice" }]);
  });

  test("keeps space and slug identity in hybrid ask fallback", async () => {
    const wrongSpace: SpaceId = "team/oc_wrong";
    const rightSpace: SpaceId = "team/oc_right";
    const query = "线上故障该找哪位？";
    const llm = new FakeLlm();
    llm.onJSON((call: JSONOptions<unknown>) => {
      const properties =
        (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("relevant" in properties) throw new Error("route provider unavailable");
      const contaminated = String(call.prompt).includes("错误负责人");
      return {
        answer: contaminated ? "" : "线上故障可以联系 Alice。",
        grounded: !contaminated,
        usedSlugs: contaminated ? [] : ["entities/owner"],
        gaps: contaminated ? ["加载了错误空间的同名页面"] : [],
      };
    });
    const engine = new KnowledgeEngine({
      dataDir: dir,
      llm,
      embeddingProvider: {
        async embed(texts) {
          return texts.map((text) => {
            if (text === query || text.includes("正确负责人")) return [1, 0];
            if (text.includes("错误负责人")) return [-1, 0];
            return [0, 1];
          });
        },
      },
    });
    engines.push(engine);
    await engine.upsertPage(
      wrongSpace,
      page("entities/owner", "错误页", "错误负责人是 Bob"),
    );
    await engine.upsertPage(
      rightSpace,
      page("entities/owner", "Alice", "正确负责人是 Alice"),
    );
    for (let index = 0; index < 5; index += 1) {
      await engine.upsertPage(
        wrongSpace,
        page(`concepts/noise-${index}`, `Noise ${index}`, `无关菜单记录 ${index}`),
      );
    }

    const answer = await engine.ask(
      [wrongSpace, rightSpace],
      query,
      { knowledgeOnly: true, retrieval: "hybrid" },
    );

    expect(answer.source).toBe("knowledge");
    expect(answer.citations).toEqual([{ slug: "entities/owner", title: "Alice" }]);
  });

  test("adds semantic candidates to a large ask catalog only when opted in", async () => {
    const llm = new FakeLlm();
    llm.onJSON((call: JSONOptions<unknown>) => {
      const properties =
        (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("relevant" in properties) {
        return { slugs: ["entities/alice"], relevant: true };
      }
      return {
        answer: "线上故障可以联系 Alice。",
        grounded: true,
        usedSlugs: ["entities/alice"],
        gaps: [],
      };
    });
    const engine = new KnowledgeEngine({
      dataDir: dir,
      llm,
      embeddingProvider: semanticFixture(),
    });
    engines.push(engine);
    for (let index = 0; index < 61; index += 1) {
      await engine.upsertPage(
        SPACE,
        page(
          `concepts/note-${index}`,
          `Note ${index}`,
          `本周菜单是番茄炒蛋，第 ${index} 条日常记录`,
        ),
      );
    }
    await engine.upsertPage(
      SPACE,
      page("entities/alice", "Alice", "Alice 负责后端服务"),
    );

    expect(
      (await engine.ask(
        [SPACE],
        "线上故障该找哪位？",
        { knowledgeOnly: true },
      )).source,
    ).toBe("general");

    const answer = await engine.ask(
      [SPACE],
      "线上故障该找哪位？",
      { knowledgeOnly: true, retrieval: "hybrid" },
    );
    expect(answer.source).toBe("knowledge");
    expect(answer.citations).toEqual([{ slug: "entities/alice", title: "Alice" }]);
  });
});

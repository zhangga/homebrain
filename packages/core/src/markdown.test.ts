import { describe, expect, test } from "bun:test";
import { markdownToPage, pageToMarkdown } from "./markdown.ts";
import type { Page } from "@homebrain/shared";

function samplePage(overrides: Partial<Page> = {}): Page {
  return {
    slug: "entities/alice",
    type: "entity",
    title: "Alice",
    summary: "后端负责人：主导服务端架构。",
    aliases: ["爱丽丝", "Alice Zhang"],
    tags: ["team", "backend"],
    sources: ["raw-1", "raw-2"],
    links: ["concepts/backend"],
    content: "# Alice\n\nAlice 负责 [[concepts/backend|后端]] 服务。\n",
    updatedAt: 1_700_000_000_000,
    contentHash: "abc123",
    ...overrides,
  };
}

describe("markdown roundtrip", () => {
  test("page -> markdown -> page is lossless", () => {
    const page = samplePage();
    const md = pageToMarkdown(page);
    const back = markdownToPage(md);
    expect(back).toEqual(page);
  });

  test("markdown has a frontmatter block", () => {
    const md = pageToMarkdown(samplePage());
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("\n---\n");
    expect(md).toContain("slug: entities/alice");
  });

  test("empty arrays roundtrip", () => {
    const page = samplePage({ aliases: [], tags: [], sources: [], links: [] });
    const back = markdownToPage(pageToMarkdown(page));
    expect(back.aliases).toEqual([]);
    expect(back.links).toEqual([]);
  });

  test("values with colons and special chars survive", () => {
    const page = samplePage({
      title: "Q: what: is this?",
      summary: "包含 # 号 与 : 冒号 的 摘要",
    });
    const back = markdownToPage(pageToMarkdown(page));
    expect(back.title).toBe("Q: what: is this?");
    expect(back.summary).toBe("包含 # 号 与 : 冒号 的 摘要");
  });

  test("throws on missing frontmatter", () => {
    expect(() => markdownToPage("no frontmatter here")).toThrow();
  });
});

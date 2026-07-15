import { describe, expect, test } from "bun:test";
import { cleanLearningSource, nextLearningSegment } from "./learning-content.ts";

describe("learning content", () => {
  test("removes an ingestion wrapper but preserves the book heading", () => {
    const source = "# 附件：book.md\r\n\r\n# 第一章 出发\r\n\r\n第一段。\r\n\r\n第二段。";

    expect(cleanLearningSource(source)).toBe("# 第一章 出发\n\n第一段。\n\n第二段。");
  });

  test("ends a lesson at a paragraph boundary near the requested size", () => {
    const first = `# 第一章\n\n${"甲".repeat(150)}\n\n${"乙".repeat(80)}`;
    const source = `${first}\n\n# 第二章\n\n${"丙".repeat(150)}`;

    const lesson = nextLearningSegment(source, 0, 120);

    expect(lesson).not.toBeNull();
    expect(lesson!.startOffset).toBe(0);
    expect(lesson!.endOffset).toBeGreaterThanOrEqual(120);
    expect(lesson!.endOffset).toBeLessThanOrEqual(240);
    expect(lesson!.text).toBe(`# 第一章\n\n${"甲".repeat(150)}`);
    expect(lesson!.title).toBe("第一章");
  });

  test("continues from the exact previous offset without overlap", () => {
    const source = "# 一\n\n第一段。\n\n第二段。\n\n# 二\n\n第三段。";

    const first = nextLearningSegment(source, 0, 12)!;
    const second = nextLearningSegment(source, first.endOffset, 12)!;

    expect(second.startOffset).toBe(first.endOffset);
    expect(first.text).not.toContain("# 二");
    expect(second.text.startsWith("# 二")).toBe(true);
  });

  test("uses the nearest preceding heading when a lesson starts mid-section", () => {
    const source = `# 第一章\n\n${"甲".repeat(80)}\n\n${"乙".repeat(80)}`;
    const first = nextLearningSegment(source, 0, 60)!;

    expect(nextLearningSegment(source, first.endOffset, 60)?.title).toBe("第一章");
  });

  test("returns null after all non-whitespace content is consumed", () => {
    expect(nextLearningSegment("短文  \n", 2, 100)).toBeNull();
  });
});

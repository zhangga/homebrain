export interface LearningSegment {
  startOffset: number;
  endOffset: number;
  title: string;
  text: string;
}

const INGESTION_WRAPPER = /^# (?:附件|来源文档)：[^\n]+\n+/u;
const HEADING = /^#{1,3}\s+(.+)$/gm;

/** Remove transport metadata while keeping the source's own structure intact. */
export function cleanLearningSource(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(INGESTION_WRAPPER, "")
    .trim();
}

function titleAt(source: string, startOffset: number): string {
  const current = source.slice(startOffset).match(/^#{1,3}\s+([^\n]+)/u)?.[1]?.trim();
  if (current) return current;

  const headings = [...source.slice(0, startOffset).matchAll(HEADING)];
  return headings.at(-1)?.[1]?.trim() || "今日阅读";
}

function skipWhitespace(source: string, offset: number): number {
  let result = offset;
  while (result < source.length && /\s/u.test(source[result]!)) result += 1;
  return result;
}

/**
 * Select the next contiguous source range. The persisted end offset includes
 * inter-paragraph whitespace, so feeding it back as the next cursor neither
 * repeats nor skips meaningful content.
 */
export function nextLearningSegment(
  source: string,
  cursor: number,
  targetCharacters: number,
): LearningSegment | null {
  const boundedCursor = Math.max(0, Math.min(source.length, Math.trunc(cursor)));
  const startOffset = skipWhitespace(source, boundedCursor);
  if (startOffset >= source.length) return null;

  const targetSize = Math.max(1, Math.trunc(targetCharacters));
  const targetEnd = Math.min(source.length, startOffset + targetSize);
  const hardEnd = Math.min(source.length, startOffset + targetSize * 2);
  let endOffset = hardEnd;

  if (targetEnd < source.length) {
    const tail = source.slice(targetEnd, hardEnd);
    const paragraph = tail.match(/\n(?:[ \t]*\n)+[ \t]*/u);
    const heading = tail.match(/\n(?=#{1,3}\s)/u);
    const boundaries = [
      paragraph?.index === undefined
        ? undefined
        : skipWhitespace(source, targetEnd + paragraph.index + paragraph[0].length),
      heading?.index === undefined ? undefined : targetEnd + heading.index + 1,
    ].filter((offset): offset is number => offset !== undefined);
    if (boundaries.length > 0) endOffset = Math.min(...boundaries);
  }

  const text = source.slice(startOffset, endOffset).trim();
  if (!text) return null;
  return {
    startOffset,
    endOffset,
    title: titleAt(source, startOffset),
    text,
  };
}

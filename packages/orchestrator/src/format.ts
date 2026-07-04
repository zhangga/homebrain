/**
 * Render an AskResult into the markdown a connector will send. Encodes the
 * source distinction (plan Q1): grounded answers list their citations; general
 * fallback answers are already self-flagged by the ask pipeline. We keep the
 * formatting minimal and feishu-friendly (markdown reply).
 */
import type { AskResult } from "@homebrain/shared";

export function formatAnswer(res: AskResult): string {
  const parts: string[] = [res.answer.trim()];

  if (res.source === "knowledge" && res.citations.length > 0) {
    const list = res.citations.map((c) => `[[${c.slug}|${c.title}]]`).join("、");
    parts.push("", `— 依据：${list}`);
  }

  if (res.gaps && res.gaps.length > 0) {
    parts.push("", `（尚缺：${res.gaps.join("；")}）`);
  }

  return parts.join("\n");
}

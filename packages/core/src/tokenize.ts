/**
 * CJK-aware bigram tokenizer for full-text search (plan R1: Chinese retrieval).
 *
 * Why not SQLite's `trigram` tokenizer? It requires queries of >= 3 characters,
 * so the most common Chinese queries — two-character words like 后端 / 服务 /
 * 前端 — match nothing. Empirically verified against bun:sqlite 3.53. We instead
 * store a pre-tokenized projection using the default (unicode61) tokenizer and
 * do the CJK segmentation ourselves:
 *
 *   - Runs of CJK characters become overlapping bigrams (后端服务 -> 后端 端服 服务),
 *     with a single-char fallback so isolated CJK chars stay findable.
 *   - Runs of ASCII letters/digits are kept whole and lowercased (word-level).
 *   - Everything else is a separator.
 *
 * The same function tokenizes both stored text and queries, guaranteeing the
 * query terms line up with stored tokens. Queries OR their terms so recall is
 * high and bm25 ranks documents matching more terms higher.
 */

// CJK Unified Ideographs + common extensions, plus CJK punctuation-adjacent
// ranges are treated as CJK. We keep this focused on characters that carry
// meaning as ideographs.
const CJK_RE =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

function isCjk(ch: string): boolean {
  return CJK_RE.test(ch);
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch);
}

/**
 * Segment text into search tokens: CJK bigrams + ascii words. Returns unique-ish
 * ordered tokens (duplicates preserved for term frequency in the stored text).
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const chars = [...text.toLowerCase()];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (isCjk(ch)) {
      // collect the CJK run
      const start = i;
      while (i < chars.length && isCjk(chars[i]!)) i++;
      const run = chars.slice(start, i);
      if (run.length === 1) {
        tokens.push(run[0]!);
      } else {
        for (let j = 0; j + 1 < run.length; j++) {
          tokens.push(run[j]! + run[j + 1]!);
        }
      }
    } else if (isWordChar(ch)) {
      const start = i;
      while (i < chars.length && isWordChar(chars[i]!)) i++;
      tokens.push(chars.slice(start, i).join(""));
    } else {
      i++; // separator
    }
  }
  return tokens;
}

/** The space-joined string stored in the FTS column. */
export function toSearchText(text: string): string {
  return tokenize(text).join(" ");
}

/**
 * Build an FTS5 MATCH expression from a free-text query. Terms are OR'd and
 * each is double-quoted so FTS5 treats it as a literal (never as a syntax
 * operator). Returns null when the query has no usable tokens.
 */
export function toMatchQuery(query: string): string | null {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

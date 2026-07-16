/**
 * Opt-in hybrid retrieval experiment.
 *
 * FTS remains the default and authoritative fallback. When an embedding
 * provider is explicitly injected, semantic ranking contributes additional
 * recall and reciprocal-rank fusion combines both rankings.
 */
import type { Hit, Page, PageRef, SpaceId } from "@homeagent/shared";
import { logger } from "@homeagent/shared";
import type { SpaceStore } from "./space.ts";
import type { RetrievalStrategy } from "./types.ts";

const log = logger.child("retrieval");
const DOCUMENT_TEXT_LIMIT = 8_000;
const DOCUMENT_CACHE_LIMIT = 2_048;
const SEMANTIC_CANDIDATE_LIMIT = 2_048;
const EMBEDDING_BATCH_SIZE = 32;
const RRF_K = 60;
const SEMANTIC_WEIGHT = 1;

export interface EmbeddingProvider {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface LocatedSearchHit {
  space: SpaceId;
  store: SpaceStore;
  ref: PageRef;
  hit: Hit;
}

interface LocatedPage {
  space: SpaceId;
  store: SpaceStore;
  page: Page;
  ref: PageRef;
}

function locatedKey(space: SpaceId, slug: string): string {
  return `${space}\u0000${slug}`;
}

function cacheKey(candidate: LocatedPage): string {
  return `${locatedKey(candidate.space, candidate.page.slug)}\u0000${candidate.page.contentHash}`;
}

function pageRef(page: Page): PageRef {
  return {
    slug: page.slug,
    type: page.type,
    title: page.title,
    summary: page.summary,
    aliases: page.aliases,
    tags: page.tags,
  };
}

/** Stable, bounded input for document embeddings. */
export function pageEmbeddingText(page: Page): string {
  return [
    page.title,
    page.summary,
    page.aliases.join(" "),
    page.tags.join(" "),
    page.content,
  ].filter(Boolean).join("\n").slice(0, DOCUMENT_TEXT_LIMIT);
}

function finiteVector(raw: readonly number[], expectedDimension?: number): number[] {
  if (raw.length === 0) throw new Error("embedding vector must not be empty");
  if (expectedDimension !== undefined && raw.length !== expectedDimension) {
    throw new Error(
      `embedding dimension mismatch: expected ${expectedDimension}, got ${raw.length}`,
    );
  }
  const vector = Array.from(raw, Number);
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error("embedding vector contains a non-finite value");
  }
  return vector;
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function snippet(page: Page): string {
  return (page.summary || page.content)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
}

function listLocatedPages(
  stores: SpaceStore[],
  excludeSlugs: ReadonlySet<string>,
): LocatedPage[] {
  const perStoreLimit = Math.max(
    1,
    Math.ceil(SEMANTIC_CANDIDATE_LIMIT / Math.max(1, stores.length)),
  );
  const pagesByStore = stores.map((store) => ({
    store,
    pages: store.index().allPages(perStoreLimit)
      .filter((page) => !excludeSlugs.has(page.slug)),
  }));
  const candidates: LocatedPage[] = [];
  for (let pageIndex = 0; candidates.length < SEMANTIC_CANDIDATE_LIMIT; pageIndex += 1) {
    let found = false;
    for (const entry of pagesByStore) {
      const page = entry.pages[pageIndex];
      if (!page) continue;
      found = true;
      candidates.push({
        space: entry.store.space,
        store: entry.store,
        page,
        ref: pageRef(page),
      });
      if (candidates.length >= SEMANTIC_CANDIDATE_LIMIT) break;
    }
    if (!found) break;
  }
  return candidates;
}

export class EmbeddingSearch {
  private readonly cache = new Map<string, number[]>();

  constructor(private readonly provider: EmbeddingProvider) {}

  private cached(key: string): number[] | undefined {
    const vector = this.cache.get(key);
    if (!vector) return undefined;
    this.cache.delete(key);
    this.cache.set(key, vector);
    return vector;
  }

  private remember(key: string, vector: number[]): void {
    this.cache.delete(key);
    this.cache.set(key, vector);
    while (this.cache.size > DOCUMENT_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  async search(
    stores: SpaceStore[],
    query: string,
    limit: number,
    excludeSlugs: ReadonlySet<string> = new Set(),
  ): Promise<LocatedSearchHit[]> {
    const candidates = listLocatedPages(stores, excludeSlugs);
    if (candidates.length === 0 || limit <= 0) return [];

    const currentVectors = new Map<string, number[]>();
    const missing: LocatedPage[] = [];
    for (const candidate of candidates) {
      const key = cacheKey(candidate);
      const vector = this.cached(key);
      if (vector) currentVectors.set(key, vector);
      else missing.push(candidate);
    }
    const firstMissing = missing.slice(0, EMBEDDING_BATCH_SIZE - 1);
    const firstInputs = [
      query,
      ...firstMissing.map((candidate) => pageEmbeddingText(candidate.page)),
    ];
    const firstVectors = await this.provider.embed(firstInputs);
    if (firstVectors.length !== firstInputs.length) {
      throw new Error(
        `embedding provider returned ${firstVectors.length} vectors for ${firstInputs.length} inputs`,
      );
    }

    const queryVector = finiteVector(firstVectors[0]!);
    for (const [index, candidate] of firstMissing.entries()) {
      const vector = finiteVector(firstVectors[index + 1]!, queryVector.length);
      const key = cacheKey(candidate);
      currentVectors.set(key, vector);
      this.remember(key, vector);
    }
    for (
      let offset = firstMissing.length;
      offset < missing.length;
      offset += EMBEDDING_BATCH_SIZE
    ) {
      const batch = missing.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const inputs = batch.map((candidate) => pageEmbeddingText(candidate.page));
      const rawVectors = await this.provider.embed(inputs);
      if (rawVectors.length !== inputs.length) {
        throw new Error(
          `embedding provider returned ${rawVectors.length} vectors for ${inputs.length} inputs`,
        );
      }
      for (const [index, candidate] of batch.entries()) {
        const vector = finiteVector(rawVectors[index]!, queryVector.length);
        const key = cacheKey(candidate);
        currentVectors.set(key, vector);
        this.remember(key, vector);
      }
    }

    const ranked = candidates.map((candidate) => {
      const vector = currentVectors.get(cacheKey(candidate));
      if (!vector) throw new Error(`embedding cache missing ${candidate.page.slug}`);
      if (vector.length !== queryVector.length) {
        throw new Error(
          `embedding dimension mismatch: expected ${queryVector.length}, got ${vector.length}`,
        );
      }
      return {
        candidate,
        similarity: cosineSimilarity(queryVector, vector),
      };
    }).filter(({ similarity }) => similarity > 0)
      .sort((left, right) =>
      right.similarity - left.similarity
      || left.candidate.page.slug.localeCompare(right.candidate.page.slug)
      );

    return ranked.slice(0, limit).map(({ candidate, similarity }) => ({
      space: candidate.space,
      store: candidate.store,
      ref: candidate.ref,
      hit: {
        slug: candidate.page.slug,
        title: candidate.page.title,
        type: candidate.page.type,
        snippet: snippet(candidate.page),
        score: 1 - similarity,
      },
    }));
  }
}

function ftsHits(
  stores: SpaceStore[],
  query: string,
  limit: number,
  excludeSlugs: ReadonlySet<string>,
): LocatedSearchHit[] {
  const located: LocatedSearchHit[] = [];
  for (const store of stores) {
    const refs = new Map(store.index().listPages().map((ref) => [ref.slug, ref]));
    for (const hit of store.index().search(query, limit)) {
      if (excludeSlugs.has(hit.slug)) continue;
      const ref = refs.get(hit.slug);
      if (!ref) continue;
      located.push({ space: store.space, store, ref, hit });
    }
  }
  located.sort((left, right) => left.hit.score - right.hit.score);
  return located.slice(0, limit);
}

function fuseRankings(
  lexical: LocatedSearchHit[],
  semantic: LocatedSearchHit[],
  limit: number,
): LocatedSearchHit[] {
  const combined = new Map<string, {
    candidate: LocatedSearchHit;
    fused: number;
    lexicalRank?: number;
    semanticRank?: number;
  }>();

  lexical.forEach((candidate, index) => {
    const key = locatedKey(candidate.space, candidate.hit.slug);
    combined.set(key, {
      candidate,
      fused: 1 / (RRF_K + index + 1),
      lexicalRank: index,
    });
  });
  semantic.forEach((candidate, index) => {
    const key = locatedKey(candidate.space, candidate.hit.slug);
    const existing = combined.get(key);
    const contribution = SEMANTIC_WEIGHT / (RRF_K + index + 1);
    if (existing) {
      existing.fused += contribution;
      existing.semanticRank = index;
    } else {
      combined.set(key, {
        candidate,
        fused: contribution,
        semanticRank: index,
      });
    }
  });

  return [...combined.values()]
    .sort((left, right) =>
      right.fused - left.fused
      || (left.lexicalRank ?? Number.MAX_SAFE_INTEGER)
        - (right.lexicalRank ?? Number.MAX_SAFE_INTEGER)
      || (left.semanticRank ?? Number.MAX_SAFE_INTEGER)
        - (right.semanticRank ?? Number.MAX_SAFE_INTEGER)
    )
    .slice(0, limit)
    .map(({ candidate, fused }) => ({
      ...candidate,
      hit: { ...candidate.hit, score: 1 / fused },
    }));
}

export async function retrieveHits(
  stores: SpaceStore[],
  query: string,
  opts: {
    limit: number;
    retrieval: RetrievalStrategy;
    embeddingSearch?: EmbeddingSearch;
    excludeSlugs?: ReadonlySet<string>;
  },
): Promise<LocatedSearchHit[]> {
  const excludeSlugs = opts.excludeSlugs ?? new Set<string>();
  const lexical = ftsHits(stores, query, opts.limit, excludeSlugs);
  if (opts.retrieval !== "hybrid" || !opts.embeddingSearch) return lexical;

  try {
    const semantic = await opts.embeddingSearch.search(
      stores,
      query,
      opts.limit,
      excludeSlugs,
    );
    return fuseRankings(lexical, semantic, opts.limit);
  } catch (err) {
    log.warn("semantic retrieval failed, falling back to FTS", { err: String(err) });
    return lexical;
  }
}

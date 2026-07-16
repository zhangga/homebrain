import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FakeLlm,
  KnowledgeEngine,
  normalizeTopicLearningRoute,
  type GroupParticipationLevel,
} from "@homeagent/core";
import {
  decideGroupParticipation,
  interpretConversation,
  type ConversationDisposition,
} from "@homeagent/orchestrator";
import type { Page, PageType, SpaceId } from "@homeagent/shared";

export type EvaluationCategory = "retrieval" | "routing" | "proactive" | "learning";
export type RetrievalRecommendation =
  | "keep_fts"
  | "consider_hybrid_retrieval"
  | "validate_embedding_provider"
  | "insufficient_data";

interface RetrievalCase {
  id: string;
  question: string;
  queryEmbedding: number[];
  pages: Array<{
    slug: string;
    type: PageType;
    title: string;
    summary: string;
    aliases: string[];
    content: string;
    embedding: number[];
  }>;
  routeSlugs: string[];
  relevant: boolean;
  answer: string;
  usedSlugs: string[];
  expectedSource: "knowledge" | "general";
  expectedCitations: string[];
}

interface RoutingCase {
  id: string;
  text: string;
  expectedDisposition: ConversationDisposition;
}

interface ProactiveCase {
  id: string;
  text: string;
  level: GroupParticipationLevel;
  scores?: {
    participationScore: number;
    disruptionRisk: number;
    reason: string;
  };
  modelFailure?: boolean;
  expectedRespond: boolean;
  expectedSource: "model" | "guard" | "fallback";
}

interface LearningCase {
  id: string;
  topic: string;
  route: Array<{ title: string; objective: string }>;
  expectedAccepted: boolean;
}

interface EvaluationDataset {
  retrieval: RetrievalCase[];
  routing: RoutingCase[];
  proactive: ProactiveCase[];
  learning: LearningCase[];
}

export interface EvaluationCaseResult {
  id: string;
  passed: boolean;
  checks: Record<string, boolean>;
  detail?: string;
}

export interface EvaluationCategoryResult {
  category: EvaluationCategory;
  passed: number;
  total: number;
  rate: number;
  cases: EvaluationCaseResult[];
}

export interface RetrievalMetrics {
  caseCount: number;
  pipelineAccuracy: number;
  citationAccuracy: number;
  ftsCoverage: number;
  hybridCoverage: number;
  hybridLift: number;
}

export interface QualityEvaluationReport {
  generatedAt: number;
  overall: {
    passed: boolean;
    passedCases: number;
    totalCases: number;
    rate: number;
  };
  categories: EvaluationCategoryResult[];
  retrieval: RetrievalMetrics;
  recommendation: {
    decision: RetrievalRecommendation;
    reasons: string[];
  };
}

function rate(passed: number, total: number): number {
  return total === 0 ? 0 : passed / total;
}

function category(
  name: EvaluationCategory,
  cases: EvaluationCaseResult[],
): EvaluationCategoryResult {
  const passed = cases.filter((item) => item.passed).length;
  return { category: name, passed, total: cases.length, rate: rate(passed, cases.length), cases };
}

function page(input: RetrievalCase["pages"][number]): Page {
  const { embedding: _embedding, ...pageInput } = input;
  return {
    ...pageInput,
    tags: ["evaluation"],
    sources: ["evaluation"],
    links: [],
    updatedAt: 1,
    contentHash: `evaluation-${input.slug}`,
  };
}

async function evaluateRetrievalCases(
  cases: RetrievalCase[],
  root: string,
): Promise<{ result: EvaluationCategoryResult; metrics: RetrievalMetrics }> {
  const results: EvaluationCaseResult[] = [];
  let pipelinePassed = 0;
  let citationsPassed = 0;
  let ftsPassed = 0;
  let hybridPassed = 0;
  for (const [index, item] of cases.entries()) {
    const fake = new FakeLlm();
    fake.onJSON((call) => {
      const properties = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("relevant" in properties) {
        return { slugs: item.routeSlugs, relevant: item.relevant };
      }
      return {
        answer: item.answer,
        grounded: item.expectedSource === "knowledge",
        usedSlugs: item.usedSlugs,
        gaps: [],
      };
    });
    fake.onText(() => item.answer);
    const engine = new KnowledgeEngine({
      dataDir: join(root, `retrieval-${index}`),
      llm: fake,
      embeddingProvider: {
        async embed(texts) {
          return texts.map((text) => {
            if (text === item.question) return item.queryEmbedding;
            const candidate = item.pages.find((page) => text.includes(page.content));
            if (!candidate) {
              throw new Error(`evaluation embedding fixture missing for ${text.slice(0, 80)}`);
            }
            return candidate.embedding;
          });
        },
      },
    });
    const space = `team/evaluation_${index}` as SpaceId;
    for (const candidate of item.pages) await engine.upsertPage(space, page(candidate));
    try {
      const answer = await engine.ask([space], item.question);
      const actualCitations = answer.citations.map((citation) => citation.slug);
      const pipelineCorrect = answer.source === item.expectedSource;
      const citationCorrect =
        actualCitations.length === item.expectedCitations.length
        && actualCitations.every((slug, citationIndex) =>
          slug === item.expectedCitations[citationIndex]
        );
      const hits = await engine.search([space], item.question, { limit: 10 });
      const hitSlugs = new Set(hits.map((hit) => hit.slug));
      const ftsCovered = item.expectedCitations.every((slug) => hitSlugs.has(slug));
      const hybridHits = await engine.search(
        [space],
        item.question,
        { limit: 10, retrieval: "hybrid" },
      );
      const hybridSlugs = new Set(hybridHits.map((hit) => hit.slug));
      const hybridCovered =
        item.expectedCitations.every((slug) => hybridSlugs.has(slug));
      if (pipelineCorrect) pipelinePassed += 1;
      if (citationCorrect) citationsPassed += 1;
      if (ftsCovered) ftsPassed += 1;
      if (hybridCovered) hybridPassed += 1;
      results.push({
        id: item.id,
        passed: pipelineCorrect && citationCorrect,
        checks: { pipelineCorrect, citationCorrect, ftsCovered, hybridCovered },
        detail: [
          `source=${answer.source}`,
          `citations=${actualCitations.join(",")}`,
          `fts=${[...hitSlugs].join(",")}`,
          `hybrid=${[...hybridSlugs].join(",")}`,
        ].join("; "),
      });
    } catch (err) {
      results.push({
        id: item.id,
        passed: false,
        checks: {
          pipelineCorrect: false,
          citationCorrect: false,
          ftsCovered: false,
          hybridCovered: false,
        },
        detail: String(err),
      });
    } finally {
      engine.close();
    }
  }
  const ftsCoverage = rate(ftsPassed, cases.length);
  const hybridCoverage = rate(hybridPassed, cases.length);
  return {
    result: category("retrieval", results),
    metrics: {
      caseCount: cases.length,
      pipelineAccuracy: rate(pipelinePassed, cases.length),
      citationAccuracy: rate(citationsPassed, cases.length),
      ftsCoverage,
      hybridCoverage,
      hybridLift: hybridCoverage - ftsCoverage,
    },
  };
}

function evaluateRoutingCases(cases: RoutingCase[]): EvaluationCategoryResult {
  return category("routing", cases.map((item) => {
    const actual = interpretConversation(item.text).disposition;
    const dispositionCorrect = actual === item.expectedDisposition;
    return {
      id: item.id,
      passed: dispositionCorrect,
      checks: { dispositionCorrect },
      detail: `expected=${item.expectedDisposition}; actual=${actual}`,
    };
  }));
}

async function evaluateProactiveCases(cases: ProactiveCase[]): Promise<EvaluationCategoryResult> {
  const results: EvaluationCaseResult[] = [];
  for (const item of cases) {
    const fake = new FakeLlm();
    if (item.modelFailure) {
      fake.onJSON(() => {
        throw new Error("evaluation provider unavailable");
      });
    } else {
      fake.queueJSON(item.scores);
    }
    const decision = await decideGroupParticipation(() => fake, item.text, item.level);
    const responseCorrect = decision.respond === item.expectedRespond;
    const sourceCorrect = decision.source === item.expectedSource;
    results.push({
      id: item.id,
      passed: responseCorrect && sourceCorrect,
      checks: { responseCorrect, sourceCorrect },
      detail: `respond=${decision.respond}; source=${decision.source}`,
    });
  }
  return category("proactive", results);
}

function evaluateLearningCases(
  cases: LearningCase[],
): EvaluationCategoryResult {
  const results = cases.map((item) => {
    const accepted = normalizeTopicLearningRoute(item.route) !== undefined;
    const acceptanceCorrect = accepted === item.expectedAccepted;
    return {
      id: item.id,
      passed: acceptanceCorrect,
      checks: { acceptanceCorrect },
      detail: `expectedAccepted=${item.expectedAccepted}; accepted=${accepted}`,
    };
  });
  return category("learning", results);
}

export function recommendRetrieval(metrics: RetrievalMetrics): {
  decision: RetrievalRecommendation;
  reasons: string[];
} {
  if (metrics.caseCount < 3) {
    return {
      decision: "insufficient_data",
      reasons: ["检索样本少于 3 条，暂不足以判断是否引入 embedding 或混合检索"],
    };
  }
  if (metrics.pipelineAccuracy < 0.9 || metrics.citationAccuracy < 0.9) {
    return {
      decision: "keep_fts",
      reasons: [
        "当前主要问题在路由、回答落地或引用正确性，先修复质量链路再评估检索架构",
        `pipeline=${metrics.pipelineAccuracy.toFixed(2)}, citations=${metrics.citationAccuracy.toFixed(2)}`,
      ],
    };
  }
  if (metrics.ftsCoverage < 0.85) {
    if (metrics.hybridCoverage >= 0.85 && metrics.hybridLift > 0) {
      return {
        decision: "validate_embedding_provider",
        reasons: [
          "固定向量夹具证明混合召回链路可以补足当前 FTS 的语义缺口",
          [
            `ftsCoverage=${metrics.ftsCoverage.toFixed(2)}`,
            `hybridCoverage=${metrics.hybridCoverage.toFixed(2)}`,
            `lift=${metrics.hybridLift.toFixed(2)}`,
            "启用前仍需用真实本地或明确授权的 embedding provider 做基准验证",
          ].join("，"),
        ],
      };
    }
    if (metrics.hybridLift <= 0) {
      return {
        decision: "keep_fts",
        reasons: [
          "确定性混合检索没有带来召回提升，当前不应增加生产检索复杂度",
          `ftsCoverage=${metrics.ftsCoverage.toFixed(2)}, hybridCoverage=${metrics.hybridCoverage.toFixed(2)}`,
        ],
      };
    }
    return {
      decision: "consider_hybrid_retrieval",
      reasons: [
        "混合召回已有正向提升，但仍未达到 85% 的固定评测阈值",
        `ftsCoverage=${metrics.ftsCoverage.toFixed(2)}, hybridCoverage=${metrics.hybridCoverage.toFixed(2)}`,
      ],
    };
  }
  return {
    decision: "keep_fts",
    reasons: [
      "现有 FTS、路由和引用在固定评测集上达到阶段二阈值",
      [
        `ftsCoverage=${metrics.ftsCoverage.toFixed(2)}`,
        `hybridCoverage=${metrics.hybridCoverage.toFixed(2)}`,
        `citations=${metrics.citationAccuracy.toFixed(2)}`,
      ].join(", "),
    ],
  };
}

export function buildQualityEvaluationReport(
  categories: EvaluationCategoryResult[],
  retrieval: RetrievalMetrics,
  generatedAt = Date.now(),
): QualityEvaluationReport {
  const passedCases = categories.reduce((sum, item) => sum + item.passed, 0);
  const totalCases = categories.reduce((sum, item) => sum + item.total, 0);
  const requiredCategories = new Set<EvaluationCategory>([
    "retrieval",
    "routing",
    "proactive",
    "learning",
  ]);
  const categoryMap = new Map(categories.map((item) => [item.category, item]));
  const passed =
    [...requiredCategories].every((name) => categoryMap.get(name)?.rate === 1)
    && totalCases > 0;
  return {
    generatedAt,
    overall: {
      passed,
      passedCases,
      totalCases,
      rate: rate(passedCases, totalCases),
    },
    categories,
    retrieval,
    recommendation: recommendRetrieval(retrieval),
  };
}

export async function runQualityEvaluation(
  datasetPath = resolve(import.meta.dir, "../quality/evaluation-cases.json"),
): Promise<QualityEvaluationReport> {
  const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as EvaluationDataset;
  const root = mkdtempSync(join(tmpdir(), "homeagent-quality-evaluation-"));
  try {
    const retrieval = await evaluateRetrievalCases(dataset.retrieval, root);
    const categories = [
      retrieval.result,
      evaluateRoutingCases(dataset.routing),
      await evaluateProactiveCases(dataset.proactive),
      evaluateLearningCases(dataset.learning),
    ];
    return buildQualityEvaluationReport(categories, retrieval.metrics);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function summary(report: QualityEvaluationReport): string {
  const categories = report.categories
    .map((item) => `${item.category} ${item.passed}/${item.total}`)
    .join("，");
  return [
    `AI 质量评测：${report.overall.passedCases}/${report.overall.totalCases} 通过（${categories}）`,
    `检索决策：${report.recommendation.decision}`,
    ...report.recommendation.reasons,
  ].join("\n");
}

if (import.meta.main) {
  try {
    const report = await runQualityEvaluation();
    console.log(summary(report));
    console.log(JSON.stringify(report));
    if (!report.overall.passed) process.exitCode = 1;
  } catch (err) {
    console.error(`evaluate:quality: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

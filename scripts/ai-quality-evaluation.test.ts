import { describe, expect, test } from "bun:test";
import {
  buildQualityEvaluationReport,
  recommendRetrieval,
  runQualityEvaluation,
  type EvaluationCategoryResult,
} from "./ai-quality-evaluation.ts";

function passingCategory(
  category: EvaluationCategoryResult["category"],
): EvaluationCategoryResult {
  return {
    category,
    passed: 1,
    total: 1,
    rate: 1,
    cases: [{ id: `${category}-case`, passed: true, checks: { correct: true } }],
  };
}

describe("AI quality evaluation", () => {
  test("runs the repository dataset across all stage-two categories", async () => {
    const report = await runQualityEvaluation();
    expect(report.overall.passed).toBe(true);
    expect(report.categories.map((item) => item.category)).toEqual([
      "retrieval",
      "routing",
      "proactive",
      "learning",
    ]);
    expect(report.retrieval.ftsCoverage).toBe(0.75);
    expect(report.retrieval.hybridCoverage).toBe(1);
    expect(report.retrieval.hybridLift).toBe(0.25);
    expect(report.recommendation.decision).toBe("validate_embedding_provider");
  });

  test("recommends provider validation only when deterministic hybrid recall improves", () => {
    expect(recommendRetrieval({
      caseCount: 8,
      pipelineAccuracy: 1,
      citationAccuracy: 1,
      ftsCoverage: 0.75,
      hybridCoverage: 1,
      hybridLift: 0.25,
    }).decision).toBe("validate_embedding_provider");
    expect(recommendRetrieval({
      caseCount: 8,
      pipelineAccuracy: 0.75,
      citationAccuracy: 0.75,
      ftsCoverage: 0.5,
      hybridCoverage: 1,
      hybridLift: 0.5,
    }).decision).toBe("keep_fts");
    expect(recommendRetrieval({
      caseCount: 8,
      pipelineAccuracy: 1,
      citationAccuracy: 1,
      ftsCoverage: 0.75,
      hybridCoverage: 0.75,
      hybridLift: 0,
    }).decision).toBe("keep_fts");
    expect(recommendRetrieval({
      caseCount: 2,
      pipelineAccuracy: 1,
      citationAccuracy: 1,
      ftsCoverage: 0.5,
      hybridCoverage: 1,
      hybridLift: 0.5,
    }).decision).toBe("insufficient_data");
  });

  test("requires every quality category to pass", () => {
    const categories = [
      passingCategory("retrieval"),
      passingCategory("routing"),
      passingCategory("proactive"),
      {
        category: "learning",
        passed: 0,
        total: 1,
        rate: 0,
        cases: [{ id: "learning-case", passed: false, checks: { correct: false } }],
      },
    ] satisfies EvaluationCategoryResult[];
    const report = buildQualityEvaluationReport(categories, {
      caseCount: 3,
      pipelineAccuracy: 1,
      citationAccuracy: 1,
      ftsCoverage: 1,
      hybridCoverage: 1,
      hybridLift: 0,
    }, 1000);
    expect(report.overall).toEqual({
      passed: false,
      passedCases: 3,
      totalCases: 4,
      rate: 0.75,
    });
    expect(report.generatedAt).toBe(1000);
  });
});

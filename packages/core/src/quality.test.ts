import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QualityStore } from "./quality.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-quality-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("QualityStore", () => {
  test("persists successful and failed answer traces across restarts", () => {
    const dir = tempDir();
    const store = new QualityStore(dir);
    const success = store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "谁负责后端？",
      outcome: "succeeded",
      source: "knowledge",
      answer: "Alice 负责后端。",
      citations: [{ slug: "entities/alice", title: "Alice" }],
      latencyMs: 125,
      createdAt: 1000,
    });
    const failure = store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "服务为什么超时？",
      outcome: "failed",
      error: "provider unavailable",
      citations: [],
      latencyMs: 250,
      createdAt: 2000,
    });

    const restarted = new QualityStore(dir);
    expect(restarted.trace(success.id)).toEqual(success);
    expect(restarted.trace(failure.id)).toEqual(failure);
  });

  test("accepts one validated feedback record per trace", () => {
    const store = new QualityStore(tempDir());
    const trace = store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "谁负责后端？",
      outcome: "succeeded",
      source: "knowledge",
      answer: "Alice 负责后端。",
      citations: [{ slug: "entities/alice", title: "Alice" }],
      latencyMs: 10,
    });

    expect(store.recordFeedback(trace.id, "helpful", "回答准确", 2000)).toEqual(
      expect.objectContaining({
        traceId: trace.id,
        kind: "helpful",
        note: "回答准确",
        createdAt: 2000,
      }),
    );
    expect(store.recordFeedback(trace.id, "unhelpful")).toBeUndefined();
    expect(store.recordFeedback("answer_missing", "helpful")).toBeUndefined();
    expect(store.recordFeedback(trace.id, "unknown" as never)).toBeUndefined();
  });

  test("snapshot exposes aggregates without leaking stored content", () => {
    const store = new QualityStore(tempDir());
    const helpful = store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "private question",
      outcome: "succeeded",
      source: "knowledge",
      answer: "private answer",
      citations: [{ slug: "private-page", title: "Private Page" }],
      latencyMs: 100,
      createdAt: 1000,
    });
    store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "failed private question",
      outcome: "timed_out",
      error: "private timeout detail",
      citations: [],
      latencyMs: 500,
      createdAt: 2000,
    });
    store.recordFeedback(helpful.id, "helpful", "private note", 3000);

    const snapshot = store.snapshot();
    expect(snapshot).toEqual({
      answers: {
        total: 2,
        succeeded: 1,
        failed: 0,
        timedOut: 1,
        knowledge: 1,
        general: 0,
        averageLatencyMs: 300,
        maxLatencyMs: 500,
      },
      feedback: {
        total: 1,
        helpful: 1,
        unhelpful: 0,
        citationError: 0,
        helpfulRate: 1,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });
});

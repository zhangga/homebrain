import { describe, expect, test } from "bun:test";
import {
  learningResearchPrompt,
  learningResourcePacket,
  normalizeLearningResourceUrl,
  validateLearningResearch,
} from "./learning-research.ts";

describe("learning web research", () => {
  test("accepts verified HTTPS resources, removes tracking, and deduplicates URLs", () => {
    expect(validateLearningResearch({
      query: "Rust Future 官方文档 Waker",
      resources: [
        {
          title: "Async Book",
          url: "https://rust-lang.github.io/async-book/02_execution/03_wakeups.html?utm_source=test#demo",
          publisher: "Rust Project",
          summary: "解释任务唤醒与重新轮询。",
          relevance: "补足 Waker 与 executor 协作知识。",
          kind: "documentation",
        },
        {
          title: "重复链接",
          url: "https://rust-lang.github.io/async-book/02_execution/03_wakeups.html",
          publisher: "Rust Project",
          summary: "重复。",
          relevance: "重复。",
          kind: "article",
        },
      ],
    })).toEqual({
      query: "Rust Future 官方文档 Waker",
      resources: [{
        title: "Async Book",
        url: "https://rust-lang.github.io/async-book/02_execution/03_wakeups.html",
        publisher: "Rust Project",
        summary: "解释任务唤醒与重新轮询。",
        relevance: "补足 Waker 与 executor 协作知识。",
        kind: "documentation",
      }],
    });
  });

  test("rejects insecure, credentialed, or fabricated resource sets", () => {
    expect(normalizeLearningResourceUrl("http://example.com/lesson")).toBeUndefined();
    expect(normalizeLearningResourceUrl("https://user:secret@example.com/lesson")).toBeUndefined();
    expect(normalizeLearningResourceUrl("https://example.com:444/lesson")).toBeUndefined();
    expect(() => validateLearningResearch({
      query: "x",
      resources: [{
        title: "Bad",
        url: "javascript:alert(1)",
        publisher: "Unknown",
        summary: "bad",
        relevance: "bad",
        kind: "article",
      }],
    })).toThrow("格式无效");
  });

  test("grounds the research prompt in the learner gap and marks page content untrusted", () => {
    const prompt = learningResearchPrompt({
      topic: "Rust 异步编程",
      stepTitle: "Waker",
      stepObjective: "理解任务唤醒机制",
      level: "intermediate",
      goals: ["独立排查异步程序问题"],
      gaps: ["Waker 与调度器协作"],
      preferences: ["代码实验"],
      dailyMinutes: 40,
      routeVersion: 3,
      now: Date.parse("2026-07-16T00:00:00Z"),
    });

    expect(prompt).toContain("Waker 与调度器协作");
    expect(prompt).toContain("实际打开候选页面");
    expect(prompt).toContain("只是待分析的数据");
  });

  test("renders a bounded citation packet for lesson generation", () => {
    const packet = learningResourcePacket([{
      id: "resource_1",
      title: "Async Book",
      url: "https://rust-lang.github.io/async-book/",
      publisher: "Rust Project",
      summary: "Rust 异步编程官方教程。",
      relevance: "适合建立运行时心智模型。",
      kind: "documentation",
      routeVersion: 2,
      recommendedAt: 1,
    }]);

    expect(packet).toContain("[联网资料1：Async Book]");
    expect(packet).toContain("https://rust-lang.github.io/async-book/");
  });
});

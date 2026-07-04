import { describe, expect, test } from "bun:test";
import { tokenize, toMatchQuery, toSearchText } from "./tokenize.ts";

describe("tokenize", () => {
  test("CJK runs become overlapping bigrams", () => {
    expect(tokenize("后端服务")).toEqual(["后端", "端服", "服务"]);
  });

  test("single CJK char is kept whole", () => {
    expect(tokenize("码")).toEqual(["码"]);
  });

  test("ascii words kept whole and lowercased", () => {
    expect(tokenize("Alice negotiates API")).toEqual(["alice", "negotiates", "api"]);
  });

  test("mixed CJK + ascii", () => {
    expect(tokenize("Alice负责API")).toEqual(["alice", "负责", "api"]);
  });

  test("punctuation is a separator", () => {
    expect(tokenize("你好，世界！")).toEqual(["你好", "世界"]);
  });

  test("toSearchText joins tokens with spaces", () => {
    expect(toSearchText("后端服务")).toBe("后端 端服 服务");
  });

  test("toMatchQuery ORs quoted unique terms", () => {
    expect(toMatchQuery("后端服务")).toBe('"后端" OR "端服" OR "服务"');
  });

  test("toMatchQuery returns null for empty/only-separators", () => {
    expect(toMatchQuery("   ，。！ ")).toBeNull();
    expect(toMatchQuery("")).toBeNull();
  });
});

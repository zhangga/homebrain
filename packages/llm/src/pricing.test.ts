import { describe, expect, test } from "bun:test";
import { priceFor, estimateCost } from "./pricing.ts";

describe("pricing", () => {
  test("matches known model families by substring", () => {
    expect(priceFor("claude-haiku-4-5-20251001").inPerM).toBe(1.0);
    expect(priceFor("claude-sonnet-5").inPerM).toBe(3.0);
    expect(priceFor("claude-opus-4-8").outPerM).toBe(75.0);
  });

  test("falls back for unknown models instead of throwing", () => {
    const p = priceFor("some-future-model");
    expect(p.inPerM).toBeGreaterThan(0);
    expect(p.outPerM).toBeGreaterThan(0);
  });

  test("estimateCost combines input and output", () => {
    // sonnet: 3/M in, 15/M out
    const cost = estimateCost("claude-sonnet-5", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18.0, 5);
  });
});

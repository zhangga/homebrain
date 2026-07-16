import { expect, test } from "bun:test";
import { complete, completeJSON } from "./gateway.ts";

test("legacy gateway never silently ignores local image inputs", async () => {
  await expect(
    complete({
      prompt: "分析图片",
      images: [{ path: "/tmp/dinner.png" }],
    }),
  ).rejects.toThrow("does not support image inputs");

  await expect(
    completeJSON({
      prompt: "分析图片",
      images: [{ path: "/tmp/dinner.png" }],
      schema: { type: "object" },
    }),
  ).rejects.toThrow("does not support image inputs");
});

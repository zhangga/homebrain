import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createMacOSBuildPlan } from "./build-macos-app.ts";

describe("macOS app build plan", () => {
  test("contains the immutable runtime layout", () => {
    const root = "/repo";
    const plan = createMacOSBuildPlan({ repoRoot: root, target: "arm64" });
    expect(plan.appPath).toBe(join(root, "dist", "Homebrain.app"));
    expect(plan.outputs).toEqual([
      "Homebrain.app/Contents/Info.plist",
      "Homebrain.app/Contents/MacOS/homebrain",
      "Homebrain.app/Contents/Resources/app/homebrain.js",
      "Homebrain.app/Contents/Resources/bin/bun",
      "Homebrain.app/Contents/Resources/bin/lark-cli",
      "Homebrain.app/Contents/Resources/bin/attachment-extract",
      "Homebrain.app/Contents/Resources/LICENSE",
      "Homebrain.app/Contents/Resources/THIRD_PARTY_NOTICES.md",
    ]);
    expect(plan.larkAsset).toBe("lark-cli-1.0.69-darwin-arm64.tar.gz");
  });

  test("maps Intel builds to upstream amd64 artifacts", () => {
    const plan = createMacOSBuildPlan({ repoRoot: "/repo", target: "x64" });
    expect(plan.bunTarget).toBe("bun-darwin-x64");
    expect(plan.larkAsset).toContain("darwin-amd64");
  });
});

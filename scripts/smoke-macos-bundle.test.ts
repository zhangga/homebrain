import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectMacOSBundle } from "./smoke-macos-bundle.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("macOS bundle smoke preflight", () => {
  test("requires the launcher, runtime, app code, lark CLI, and attachment helper", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-bundle-"));
    dirs.push(root);
    const app = join(root, "HomeAgent.app");
    for (const dir of ["Contents/MacOS", "Contents/Resources/app", "Contents/Resources/bin"]) {
      mkdirSync(join(app, dir), { recursive: true });
    }
    for (const file of [
      "Contents/Info.plist",
      "Contents/MacOS/homeagent",
      "Contents/Resources/app/homeagent.js",
      "Contents/Resources/bin/bun",
      "Contents/Resources/bin/lark-cli",
      "Contents/Resources/bin/attachment-extract",
    ]) writeFileSync(join(app, file), file);
    expect(inspectMacOSBundle(app).files).toHaveLength(6);
    rmSync(join(app, "Contents/Resources/bin/lark-cli"));
    expect(() => inspectMacOSBundle(app)).toThrow("missing");
  });
});

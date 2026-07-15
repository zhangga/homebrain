import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateManifest } from "./write-update-manifest.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("update manifest", () => {
  test("hashes both architecture artifacts and emits HTTPS release URLs", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-manifest-"));
    dirs.push(dir);
    const arm64 = join(dir, "arm64.dmg");
    const x64 = join(dir, "x64.dmg");
    writeFileSync(arm64, "arm");
    writeFileSync(x64, "intel");
    const manifest = createUpdateManifest({
      version: "0.1.0-beta.1",
      repository: "zhangga/homebrain",
      arm64Path: arm64,
      x64Path: x64,
    });
    expect(manifest.artifacts.arm64.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.artifacts.x64.url).toBe(
      "https://github.com/zhangga/homebrain/releases/download/v0.1.0-beta.1/Homebrain-0.1.0-beta.1-macos-x64.dmg",
    );
  });

  test("rejects unsafe repository and version values", () => {
    expect(() => createUpdateManifest({
      version: "../bad",
      repository: "attacker.example/x",
      arm64Path: "/missing",
      x64Path: "/missing",
    })).toThrow();
  });
});

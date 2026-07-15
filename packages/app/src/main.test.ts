import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUsableManagedExecutable, selectAppCommand } from "./main.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("compiled app command dispatch", () => {
  test("double-click defaults to desktop while source start defaults to serve", () => {
    expect(selectAppCommand([], true)).toBe("desktop");
    expect(selectAppCommand([], false)).toBe("serve");
  });

  test("supports stable compiled subcommands", () => {
    expect(selectAppCommand(["serve"], true)).toBe("serve");
    expect(selectAppCommand(["desktop"], true)).toBe("desktop");
    expect(selectAppCommand(["service", "status"], true)).toBe("service");
    expect(selectAppCommand(["doctor", "--json"], true)).toBe("doctor");
    expect(selectAppCommand(["wat"], true)).toBe("unknown");
  });

  test("treats empty or non-executable managed provider files as damaged", () => {
    const dir = mkdtempSync(join(tmpdir(), "homebrain-managed-bin-"));
    temporary.push(dir);
    const binary = join(dir, "codex");
    writeFileSync(binary, "");
    chmodSync(binary, 0o755);
    expect(isUsableManagedExecutable(binary)).toBeFalse();
    writeFileSync(binary, "binary");
    chmodSync(binary, 0o644);
    expect(isUsableManagedExecutable(binary)).toBeFalse();
    chmodSync(binary, 0o755);
    expect(isUsableManagedExecutable(binary)).toBeTrue();
  });
});

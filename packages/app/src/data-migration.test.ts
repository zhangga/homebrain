import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import {
  confirmDataMigration,
  nodeMigrationFileSystem,
  planDataMigration,
  prepareLegacyDataMigration,
} from "./data-migration.ts";

describe("legacy data migration", () => {
  let root: string;
  let homeDir: string;
  let sourceDir: string;
  let destinationDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "homeagent-migration-test-"));
    homeDir = join(root, "home");
    sourceDir = join(homeDir, "Library", "Application Support", "Homebrain");
    destinationDir = join(
      homeDir,
      "Library",
      "Application Support",
      "HomeAgent",
    );
    mkdirSync(join(sourceDir, "spaces", "family"), { recursive: true });
    writeFileSync(join(sourceDir, "spaces", "family", "memory.txt"), "北极星", "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("requests confirmation only when legacy data exists and the destination is empty", () => {
    expect(planDataMigration({ homeDir, destinationDir })).toEqual({
      state: "needs-confirmation",
      source: sourceDir,
      destination: destinationDir,
    });

    rmSync(sourceDir, { recursive: true, force: true });
    expect(planDataMigration({ homeDir, destinationDir }).state).toBe("not-needed");
  });

  test("falls back to the older source-install data directory", () => {
    rmSync(sourceDir, { recursive: true, force: true });
    const sourceInstall = join(homeDir, "Applications", "homebrain", "data");
    mkdirSync(sourceInstall, { recursive: true });
    writeFileSync(join(sourceInstall, "memory.txt"), "旧数据", "utf8");

    expect(planDataMigration({ homeDir, destinationDir })).toEqual({
      state: "needs-confirmation",
      source: sourceInstall,
      destination: destinationDir,
    });
  });

  test("rejects a non-empty destination without changing either tree", () => {
    mkdirSync(destinationDir, { recursive: true });
    writeFileSync(join(destinationDir, "existing.db"), "active", "utf8");

    const plan = planDataMigration({ homeDir, destinationDir });
    expect(plan.state).toBe("rejected");
    expect(plan.reason).toBe("destination-not-empty");
    expect(() => confirmDataMigration({ homeDir, destinationDir })).toThrow(
      "migration destination is not empty",
    );
    expect(readFileSync(join(destinationDir, "existing.db"), "utf8")).toBe("active");
    expect(readFileSync(join(sourceDir, "spaces", "family", "memory.txt"), "utf8")).toBe(
      "北极星",
    );
  });

  test("rejects overlapping source, destination, and non-sibling staging paths", () => {
    const overlappingDestination = join(sourceDir, "new-data");
    expect(
      planDataMigration({ homeDir, sourceDir, destinationDir: overlappingDestination }),
    ).toMatchObject({ state: "rejected", reason: "paths-overlap" });

    const outsideStaging = join(root, "unrelated", "staging");
    expect(() =>
      confirmDataMigration({
        homeDir,
        destinationDir,
        stagingDir: outsideStaging,
      }),
    ).toThrow("migration staging directory must be a sibling of the destination");
    expect(existsSync(outsideStaging)).toBeFalse();
  });

  test("copies through a synced sibling staging directory and atomically records completion", () => {
    mkdirSync(destinationDir, { recursive: true });
    const stagingDir = join(dirname(destinationDir), ".HomeAgent.migration-test");
    const synced: string[] = [];
    const fileSystem = {
      ...nodeMigrationFileSystem,
      syncPath(path: string) {
        synced.push(path);
        nodeMigrationFileSystem.syncPath(path);
      },
    };

    const result = confirmDataMigration({
      homeDir,
      destinationDir,
      stagingDir,
      now: () => 1_784_000_000_000,
      fileSystem,
    });

    expect(result).toEqual({
      state: "completed",
      source: sourceDir,
      destination: destinationDir,
      recordPath: join(destinationDir, "migration-v2.json"),
    });
    expect(readFileSync(join(destinationDir, "spaces", "family", "memory.txt"), "utf8")).toBe(
      "北极星",
    );
    expect(readFileSync(join(sourceDir, "spaces", "family", "memory.txt"), "utf8")).toBe(
      "北极星",
    );
    expect(existsSync(stagingDir)).toBeFalse();
    expect(JSON.parse(readFileSync(result.recordPath, "utf8"))).toEqual({
      source: sourceDir,
      destination: destinationDir,
      time: "2026-07-14T03:33:20.000Z",
      result: "completed",
    });
    expect(synced).toContain(join(stagingDir, "spaces", "family", "memory.txt"));
    expect(synced).toContain(join(stagingDir, "migration-v2.json"));
    expect(synced).toContain(stagingDir);
    expect(synced).toContain(dirname(destinationDir));
  });

  test("prompts before first packaged launch and preserves a cancelled migration", async () => {
    let promptArgv: string[] | undefined;
    let legacyServiceRetired = false;
    const continued = await prepareLegacyDataMigration({
      homeDir,
      destinationDir,
      runner: async (argv) => {
        promptArgv = argv;
        return { code: 0, stdout: "button returned:迁移", stderr: "" };
      },
      beforeCopy: () => {
        expect(existsSync(destinationDir)).toBeFalse();
        legacyServiceRetired = true;
      },
    });
    expect(continued).toBe("continue");
    expect(legacyServiceRetired).toBeTrue();
    expect(promptArgv?.slice(0, 2)).toEqual(["/usr/bin/osascript", "-e"]);
    expect(readFileSync(join(destinationDir, "spaces", "family", "memory.txt"), "utf8")).toBe(
      "北极星",
    );

    rmSync(destinationDir, { recursive: true, force: true });
    const exited = await prepareLegacyDataMigration({
      homeDir,
      destinationDir,
      runner: async () => ({ code: 1, stdout: "", stderr: "User canceled" }),
      beforeCopy: () => {
        throw new Error("cancelled migration must not retire the old service");
      },
    });
    expect(exited).toBe("exit");
    expect(existsSync(destinationDir)).toBeFalse();
    expect(existsSync(sourceDir)).toBeTrue();
  });
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveRuntimePaths } from "./runtime-paths.ts";

describe("resolveRuntimePaths", () => {
  test("resolves mutable data and bundled executables outside the repository", () => {
    const home = "/Users/example";
    const paths = resolveRuntimePaths({
      execPath: "/Applications/Homebrain.app/Contents/MacOS/homebrain",
      homeDir: home,
      env: {},
    });

    expect(paths).toEqual({
      bundled: true,
      appRoot: "/Applications/Homebrain.app",
      resourceDir: "/Applications/Homebrain.app/Contents/Resources",
      dataDir: join(home, "Library", "Application Support", "Homebrain"),
      logDir: join(home, "Library", "Logs", "Homebrain"),
      larkBin: "/Applications/Homebrain.app/Contents/Resources/bin/lark-cli",
      attachmentHelper:
        "/Applications/Homebrain.app/Contents/Resources/bin/attachment-extract",
    });
  });

  test("recognizes the native launcher marker after it execs the bundled Bun runtime", () => {
    const paths = resolveRuntimePaths({
      execPath: "/Applications/Homebrain.app/Contents/Resources/bin/bun",
      homeDir: "/Users/example",
      env: { HOMEBRAIN_BUNDLED_APP_ROOT: "/Applications/Homebrain.app" },
    });

    expect(paths.bundled).toBe(true);
    expect(paths.appRoot).toBe("/Applications/Homebrain.app");
    expect(paths.larkBin).toBe("/Applications/Homebrain.app/Contents/Resources/bin/lark-cli");
  });

  test("keeps source mode repository-local while honoring executable and data overrides", () => {
    const paths = resolveRuntimePaths({
      execPath: "/opt/bun/bin/bun",
      homeDir: "/Users/example",
      repoRoot: "/work/homebrain",
      env: {
        HOMEBRAIN_DATA_DIR: "/var/tmp/homebrain-data",
        HOMEBRAIN_LARK_BIN: "/opt/lark/bin/lark-cli",
      },
    });

    expect(paths).toEqual({
      bundled: false,
      appRoot: "/work/homebrain",
      resourceDir: "/work/homebrain/packages/orchestrator/src",
      dataDir: "/var/tmp/homebrain-data",
      logDir: "/var/tmp/homebrain-data/logs",
      larkBin: "/opt/lark/bin/lark-cli",
      attachmentHelper: undefined,
    });
  });
});

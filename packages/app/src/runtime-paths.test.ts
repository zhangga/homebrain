import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveRuntimePaths } from "./runtime-paths.ts";

describe("resolveRuntimePaths", () => {
  test("resolves mutable data and bundled executables outside the repository", () => {
    const home = "/Users/example";
    const paths = resolveRuntimePaths({
      execPath: "/Applications/HomeAgent.app/Contents/MacOS/homeagent",
      homeDir: home,
      env: {},
    });

    expect(paths).toEqual({
      bundled: true,
      appRoot: "/Applications/HomeAgent.app",
      resourceDir: "/Applications/HomeAgent.app/Contents/Resources",
      dataDir: join(home, "Library", "Application Support", "HomeAgent"),
      logDir: join(home, "Library", "Logs", "HomeAgent"),
      larkBin: "/Applications/HomeAgent.app/Contents/Resources/bin/lark-cli",
      attachmentHelper:
        "/Applications/HomeAgent.app/Contents/Resources/bin/attachment-extract",
    });
  });

  test("recognizes the native launcher marker after it execs the bundled Bun runtime", () => {
    const paths = resolveRuntimePaths({
      execPath: "/Applications/HomeAgent.app/Contents/Resources/bin/bun",
      homeDir: "/Users/example",
      env: { HOMEAGENT_BUNDLED_APP_ROOT: "/Applications/HomeAgent.app" },
    });

    expect(paths.bundled).toBe(true);
    expect(paths.appRoot).toBe("/Applications/HomeAgent.app");
    expect(paths.larkBin).toBe("/Applications/HomeAgent.app/Contents/Resources/bin/lark-cli");
  });

  test("keeps source mode repository-local while honoring executable and data overrides", () => {
    const paths = resolveRuntimePaths({
      execPath: "/opt/bun/bin/bun",
      homeDir: "/Users/example",
      repoRoot: "/work/homeagent",
      env: {
        HOMEAGENT_DATA_DIR: "/var/tmp/homeagent-data",
        HOMEAGENT_LARK_BIN: "/opt/lark/bin/lark-cli",
      },
    });

    expect(paths).toEqual({
      bundled: false,
      appRoot: "/work/homeagent",
      resourceDir: "/work/homeagent/packages/orchestrator/src",
      dataDir: "/var/tmp/homeagent-data",
      logDir: "/var/tmp/homeagent-data/logs",
      larkBin: "/opt/lark/bin/lark-cli",
      attachmentHelper: undefined,
    });
  });

  test("accepts pre-rename runtime overrides", () => {
    const paths = resolveRuntimePaths({
      execPath: "/opt/bun/bin/bun",
      homeDir: "/Users/example",
      repoRoot: "/work/homeagent",
      env: {
        HOMEBRAIN_DATA_DIR: "/var/tmp/legacy-data",
        HOMEBRAIN_LOG_DIR: "/var/tmp/legacy-logs",
        HOMEBRAIN_LARK_BIN: "/opt/legacy/lark-cli",
      },
    });

    expect(paths.dataDir).toBe("/var/tmp/legacy-data");
    expect(paths.logDir).toBe("/var/tmp/legacy-logs");
    expect(paths.larkBin).toBe("/opt/legacy/lark-cli");
  });
});

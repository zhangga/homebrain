import { expect, test } from "bun:test";
import {
  createBunGbrainRunner,
  createGbrainCliContract,
  formatGbrainError,
  type GbrainCliResult,
  type GbrainRun,
} from "./gbrainCli";

function fakeRunner(
  handler: (args: string[], input?: string) => GbrainCliResult | Promise<GbrainCliResult>,
): GbrainRun {
  return (args, input) => Promise.resolve(handler(args, input));
}

test("captureText sends capture command with source and parses JSON", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args, input) => {
      calls.push({ args, input });
      return { ok: true, stdout: '{"id":"mem_1"}', stderr: "", exitCode: 0 };
    }),
  });

  expect(await cli.captureText("老师电话 138")).toEqual({ id: "mem_1" });
  expect(calls).toEqual([
    { args: ["capture", "老师电话 138", "--source", "default", "--json"], input: undefined },
  ]);
});

test("query returns answer and defaults missing citations to empty array", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args) => {
      expect(args).toEqual(["query", "老师电话是多少"]);
      return {
        ok: true,
        stdout: "[2.3333] inbox/2026-06-24-d47e405f -- # 老师电话是 138\n\n老师电话是 138\n",
        stderr: "",
        exitCode: 0,
      };
    }),
  });

  expect(await cli.query("老师电话是多少")).toEqual({
    answer: "[2.3333] inbox/2026-06-24-d47e405f -- # 老师电话是 138\n\n老师电话是 138",
    citations: [{ slug: "inbox/2026-06-24-d47e405f", title: "# 老师电话是 138" }],
  });
});

test("query returns No results text with no citations", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner(() => ({ ok: true, stdout: "No results.\n", stderr: "", exitCode: 0 })),
  });

  expect(await cli.query("不存在")).toEqual({ answer: "No results.", citations: [] });
});

test("search passes limit when present", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args) => {
      expect(args).toEqual(["search", "老师", "--limit", "3"]);
      return {
        ok: true,
        stdout: "[2.3333] inbox/2026-06-24-d47e405f -- # 老师电话是 138\n\n老师电话是 138\n",
        stderr: "",
        exitCode: 0,
      };
    }),
  });

  expect(await cli.search("老师", 3)).toEqual([
    {
      slug: "inbox/2026-06-24-d47e405f",
      title: "# 老师电话是 138",
      snippet: "老师电话是 138",
      score: 2.3333,
    },
  ]);
});

test("search returns empty list for textual No results output", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner(() => ({ ok: true, stdout: "No results.\n", stderr: "", exitCode: 0 })),
  });

  expect(await cli.search("不存在")).toEqual([]);
});

test("sync returns combined log without parsing JSON", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args) => {
      expect(args).toEqual(["sync", "--source", "default"]);
      return { ok: true, stdout: "synced", stderr: "", exitCode: 0 };
    }),
  });

  expect(await cli.sync()).toEqual({ ok: true, log: "synced" });
});

test("sync can skip embedding for local development", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args) => {
      expect(args).toEqual(["sync", "--source", "default", "--no-embed"]);
      return { ok: true, stdout: "synced without embedding", stderr: "", exitCode: 0 };
    }),
  });

  expect(await cli.sync({ noEmbed: true })).toEqual({
    ok: true,
    log: "synced without embedding",
  });
});

test("listSources parses source rows and local paths", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args) => {
      expect(args).toEqual(["sources", "list"]);
      return {
        ok: true,
        stdout: `SOURCES
───────
  default               federated          0 pages  never synced
  homebrain             isolated           9 pages  2026-06-24
                        /Users/jossyzhang/work/GitHub/homebrain
`,
        stderr: "",
        exitCode: 0,
      };
    }),
  });

  expect(await cli.listSources()).toEqual([
    { id: "default" },
    { id: "homebrain", localPath: "/Users/jossyzhang/work/GitHub/homebrain" },
  ]);
});

test("ensureSourcePath registers a missing local source", async () => {
  const calls: string[][] = [];
  const cli = createGbrainCliContract({
    source: "homebrain",
    run: fakeRunner((args) => {
      calls.push(args);
      if (args[0] === "sources" && args[1] === "list") {
        return {
          ok: true,
          stdout: "SOURCES\n───────\n  default               federated          0 pages  never synced\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "sources" && args[1] === "add") {
        return {
          ok: true,
          stdout: 'Created source "homebrain" → /repo\n',
          stderr: "",
          exitCode: 0,
        };
      }
      return { ok: false, stdout: "", stderr: "unexpected command", exitCode: 9 };
    }),
  });

  expect(await cli.ensureSourcePath({ id: "homebrain", path: "/repo" })).toEqual({
    ok: true,
    created: true,
    log: 'Created source "homebrain" → /repo\n',
  });
  expect(calls).toEqual([
    ["sources", "list"],
    ["sources", "add", "homebrain", "--path", "/repo"],
  ]);
});

test("ensureSourcePath accepts an existing source with the same local path", async () => {
  const calls: string[][] = [];
  const cli = createGbrainCliContract({
    source: "homebrain",
    run: fakeRunner((args) => {
      calls.push(args);
      return {
        ok: true,
        stdout: `SOURCES
───────
  homebrain             isolated           9 pages  2026-06-24
                        /repo
`,
        stderr: "",
        exitCode: 0,
      };
    }),
  });

  expect(await cli.ensureSourcePath({ id: "homebrain", path: "/repo" })).toEqual({
    ok: true,
    created: false,
  });
  expect(calls).toEqual([["sources", "list"]]);
});

test("ensureSourcePath fails safely when source exists without local path", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner(() => ({
      ok: true,
      stdout: "SOURCES\n───────\n  default               federated          0 pages  never synced\n",
      stderr: "",
      exitCode: 0,
    })),
  });

  const result = await cli.ensureSourcePath({ id: "default", path: "/repo" });
  expect(result.ok).toBe(false);
  expect(result.created).toBe(false);
  expect(result.log).toContain('source "default" 已存在但没有 local_path');
});

test("dream runs dream cycle with JSON report and marks partial status as not ok", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args) => {
      expect(args).toEqual(["dream", "--dry-run", "--json"]);
      return {
        ok: true,
        stdout:
          '[cycle.embed] start\n{"schema_version":"1","status":"partial","phases":[{"phase":"embed","status":"fail"}]}\n',
        stderr: "",
        exitCode: 0,
      };
    }),
  });

  expect(await cli.dream({ dryRun: true })).toEqual({
    ok: false,
    status: "partial",
    log: '[cycle.embed] start\n{"schema_version":"1","status":"partial","phases":[{"phase":"embed","status":"fail"}]}\n',
  });
});

test("dream returns ok for clean JSON report", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args) => {
      expect(args).toEqual(["dream", "--json"]);
      return {
        ok: true,
        stdout: '{"schema_version":"1","status":"clean","phases":[]}\n',
        stderr: "",
        exitCode: 0,
      };
    }),
  });

  expect(await cli.dream()).toEqual({
    ok: true,
    status: "clean",
    log: '{"schema_version":"1","status":"clean","phases":[]}\n',
  });
});

test("putPage sends put command with markdown content and parses JSON", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args, input) => {
      calls.push({ args, input });
      return { ok: true, stdout: '{"slug":"partners/dad/user"}', stderr: "", exitCode: 0 };
    }),
  });

  expect(await cli.putPage("partners/dad/user", "# Dad")).toEqual({
    slug: "partners/dad/user",
  });
  expect(calls).toEqual([
    { args: ["put", "partners/dad/user", "--content", "# Dad"], input: undefined },
  ]);
});

test("getPage returns markdown text and maps missing pages to null", async () => {
  const cli = createGbrainCliContract({
    source: "default",
    run: fakeRunner((args) => {
      if (args[1] === "partners/dad/user") {
        return { ok: true, stdout: "# Dad\n", stderr: "", exitCode: 0 };
      }
      return {
        ok: false,
        stdout: "",
        stderr: "Error [page_not_found]: Page not found: partners/mom/user",
        exitCode: 1,
      };
    }),
  });

  expect(await cli.getPage("partners/dad/user")).toBe("# Dad");
  expect(await cli.getPage("partners/mom/user")).toBeNull();
});

test("formatGbrainError includes label, exit code, and command output", () => {
  const message = formatGbrainError("query", {
    ok: false,
    stdout: "bad stdout",
    stderr: "bad stderr",
    exitCode: 12,
  });

  expect(message).toContain("query 失败");
  expect(message).toContain("exit 12");
  expect(message).toContain("bad stderr");
});

test("createBunGbrainRunner passes brainDir as GBRAIN_HOME", async () => {
  const runner = createBunGbrainRunner({ bin: "bun", brainDir: "/tmp/homebrain-test-home" });
  const result = await runner(["-e", "console.log(process.env.GBRAIN_HOME ?? '')"]);

  expect(result.ok).toBe(true);
  expect(result.stdout.trim()).toBe("/tmp/homebrain-test-home");
});

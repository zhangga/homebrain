import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createHomebrain } from "./index";

test("remember serializes tags and occurredAt into captured text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homebrain-remember-meta-"));
  const argsPath = join(dir, "args.txt");
  const fakeGbrain = join(dir, "fake-gbrain.sh");
  await writeFile(
    fakeGbrain,
    `#!/bin/sh
for arg in "$@"; do
  printf '%s\\n' "$arg" >> '${argsPath}'
done
if [ "$1" = "capture" ]; then
  echo '{"slug":"inbox/meta"}'
  exit 0
fi
exit 9
`,
  );
  await Bun.spawn(["chmod", "+x", fakeGbrain]).exited;

  const brain = createHomebrain({ brainDir: dir, gbrainBin: fakeGbrain });
  await brain.remember({
    member: { slug: "kid" },
    text: "今天读完了第三章",
    tags: ["task", "feedback"],
    occurredAt: "2026-06-25",
  });

  expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
    "capture",
    "---",
    "member: kid",
    "occurredAt: 2026-06-25",
    "tags:",
    "  - task",
    "  - feedback",
    "---",
    "今天读完了第三章",
    "--source",
    "default",
    "--json",
  ]);
});

test("runDreamCycle can pass noEmbed to sync and then run dream dry-run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homebrain-index-"));
  const argsPath = join(dir, "args.txt");
  const fakeGbrain = join(dir, "fake-gbrain.sh");
  await writeFile(
    fakeGbrain,
    `#!/bin/sh
for arg in "$@"; do
  printf '%s\\n' "$arg" >> '${argsPath}'
done
printf '%s\\n' '---' >> '${argsPath}'
if [ "$1" = "sync" ]; then
  echo synced
  exit 0
fi
if [ "$1" = "dream" ]; then
  echo '{"status":"clean"}'
  exit 0
fi
exit 9
`,
  );
  await Bun.spawn(["chmod", "+x", fakeGbrain]).exited;

  const brain = createHomebrain({ brainDir: dir, gbrainBin: fakeGbrain });
  expect(await brain.runDreamCycle({ noEmbed: true, dryRun: true })).toEqual({
    ok: true,
    log: 'synced\n{"status":"clean"}',
  });

  expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
    "sync",
    "--source",
    "default",
    "--no-embed",
    "---",
    "dream",
    "--dry-run",
    "--json",
    "---",
  ]);
});

test("runDreamCycle ensures configured local source path before sync", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homebrain-index-source-"));
  const argsPath = join(dir, "args.txt");
  const fakeGbrain = join(dir, "fake-gbrain.sh");
  await writeFile(
    fakeGbrain,
    `#!/bin/sh
for arg in "$@"; do
  printf '%s\\n' "$arg" >> '${argsPath}'
done
printf '%s\\n' '---' >> '${argsPath}'
if [ "$1" = "sources" ] && [ "$2" = "list" ]; then
  cat <<'OUT'
SOURCES
───────
  default               federated          0 pages  never synced
OUT
  exit 0
fi
if [ "$1" = "sources" ] && [ "$2" = "add" ]; then
  echo 'Created source "homebrain" → /repo'
  exit 0
fi
if [ "$1" = "sync" ]; then
  echo synced
  exit 0
fi
if [ "$1" = "dream" ]; then
  echo '{"status":"clean"}'
  exit 0
fi
exit 9
`,
  );
  await Bun.spawn(["chmod", "+x", fakeGbrain]).exited;

  const brain = createHomebrain({
    brainDir: dir,
    gbrainBin: fakeGbrain,
    defaultSource: "homebrain",
    sourcePath: "/repo",
  });
  expect(await brain.runDreamCycle({ noEmbed: true, dryRun: true })).toEqual({
    ok: true,
    log: 'Created source "homebrain" → /repo\nsynced\n{"status":"clean"}',
  });

  expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
    "sources",
    "list",
    "---",
    "sources",
    "add",
    "homebrain",
    "--path",
    "/repo",
    "---",
    "sync",
    "--source",
    "homebrain",
    "--no-embed",
    "---",
    "dream",
    "--dry-run",
    "--json",
    "---",
  ]);
});

test("runDreamCycle reports source path conflict before sync", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homebrain-index-source-conflict-"));
  const argsPath = join(dir, "args.txt");
  const fakeGbrain = join(dir, "fake-gbrain.sh");
  await writeFile(
    fakeGbrain,
    `#!/bin/sh
for arg in "$@"; do
  printf '%s\\n' "$arg" >> '${argsPath}'
done
printf '%s\\n' '---' >> '${argsPath}'
if [ "$1" = "sources" ] && [ "$2" = "list" ]; then
  cat <<'OUT'
SOURCES
───────
  default               federated          0 pages  never synced
OUT
  exit 0
fi
exit 9
`,
  );
  await Bun.spawn(["chmod", "+x", fakeGbrain]).exited;

  const brain = createHomebrain({
    brainDir: dir,
    gbrainBin: fakeGbrain,
    defaultSource: "default",
    sourcePath: "/repo",
  });
  const result = await brain.runDreamCycle({ noEmbed: true, dryRun: true });
  expect(result.ok).toBe(false);
  expect(result.log).toContain('source "default" 已存在但没有 local_path');
  expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
    "sources",
    "list",
    "---",
  ]);
});

test("runDreamCycle returns not ok when dream report is partial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homebrain-index-partial-"));
  const fakeGbrain = join(dir, "fake-gbrain.sh");
  await writeFile(
    fakeGbrain,
    `#!/bin/sh
if [ "$1" = "dream" ]; then
  echo '{"status":"partial"}'
  exit 0
fi
exit 9
`,
  );
  await Bun.spawn(["chmod", "+x", fakeGbrain]).exited;

  const brain = createHomebrain({ brainDir: dir, gbrainBin: fakeGbrain });
  expect(await brain.runDreamCycle({ sync: false })).toEqual({
    ok: false,
    log: '{"status":"partial"}',
  });
});

test("profile methods read and write partners slug user page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homebrain-profile-"));
  const argsPath = join(dir, "args.txt");
  const fakeGbrain = join(dir, "fake-gbrain.sh");
  await writeFile(
    fakeGbrain,
    `#!/bin/sh
printf '%s\\n' "$@" > '${argsPath}'
if [ "$1" = "put" ]; then
  printf '{"slug":"%s"}\\n' "$2"
  exit 0
fi
if [ "$1" = "get" ]; then
  printf '# Dad\\n\\n- tea\\n'
  exit 0
fi
exit 9
`,
  );
  await Bun.spawn(["chmod", "+x", fakeGbrain]).exited;

  const brain = createHomebrain({ brainDir: dir, gbrainBin: fakeGbrain });
  await brain.upsertProfile({ member: { slug: "Dad" }, profileMarkdown: "# Dad\n\n- tea\n" });
  expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
    "put",
    "partners/dad/user",
    "--content",
    "# Dad",
    "",
    "- tea",
  ]);

  expect(await brain.getProfile({ member: { slug: "Dad" } })).toBe("# Dad\n\n- tea");
  expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
    "get",
    "partners/dad/user",
  ]);
});

test("getProfile returns null when gbrain page is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homebrain-profile-missing-"));
  const fakeGbrain = join(dir, "fake-gbrain.sh");
  await writeFile(
    fakeGbrain,
    `#!/bin/sh
echo 'Error [page_not_found]: Page not found: partners/dad/user' >&2
exit 1
`,
  );
  await Bun.spawn(["chmod", "+x", fakeGbrain]).exited;

  const brain = createHomebrain({ brainDir: dir, gbrainBin: fakeGbrain });
  expect(await brain.getProfile({ member: { slug: "Dad" } })).toBeNull();
});

test("recall falls back to search and filters hits by date in slug or text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homebrain-recall-"));
  const argsPath = join(dir, "args.txt");
  const fakeGbrain = join(dir, "fake-gbrain.sh");
  await writeFile(
    fakeGbrain,
    `#!/bin/sh
printf '%s\\n' "$@" > '${argsPath}'
if [ "$1" = "search" ]; then
  cat <<'OUT'
[2.0000] inbox/2025-06-24-family-trip -- # 去年今日去了海边
2025-06-24 全家去了海边。

[1.5000] inbox/2024-06-24-old-news -- # 更早的事情
2024-06-24 不在这次窗口里。

[1.0000] inbox/no-date -- # 没有日期的片段
只是普通片段。
OUT
  exit 0
fi
exit 9
`,
  );
  await Bun.spawn(["chmod", "+x", fakeGbrain]).exited;

  const brain = createHomebrain({ brainDir: dir, gbrainBin: fakeGbrain });
  expect(await brain.recall({ from: "2025-06-23", to: "2025-06-25" })).toEqual([
    {
      slug: "inbox/2025-06-24-family-trip",
      title: "# 去年今日去了海边",
      occurredAt: "2025-06-24",
    },
  ]);
  expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
    "search",
    "2025-06-23 2025-06-25",
    "--limit",
    "20",
  ]);
});

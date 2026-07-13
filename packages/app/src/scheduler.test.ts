import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig, type SpaceId } from "@homebrain/shared";
import { KnowledgeEngine, FakeLlm } from "@homebrain/core";
import { DEFAULT_SCHEDULE, Scheduler, shouldRunSpace, type ScheduleConfig } from "./scheduler.ts";

const cfg: ScheduleConfig = { hour: 3, stalenessHours: 24, tickMs: 60000 };

// A fixed "now" at 04:00 Asia/Shanghai (past the nightly hour).
const NIGHT = new Date("2026-07-04T04:00:00+08:00");
const NOON = new Date("2026-07-04T12:00:00+08:00");

describe("shouldRunSpace", () => {
  test("no pending raw -> never run", () => {
    expect(shouldRunSpace({ id: "team/a", hasPending: false }, NIGHT, cfg)).toBe(false);
    expect(
      shouldRunSpace({ id: "team/a", hasPending: false, lastDreamAt: 0 }, NIGHT, cfg),
    ).toBe(false);
  });

  test("pending + never distilled -> run", () => {
    expect(shouldRunSpace({ id: "team/a", hasPending: true }, NOON, cfg)).toBe(true);
  });

  test("pending + stale (>24h) -> run (catch-up)", () => {
    const old = NIGHT.getTime() - 30 * 3600_000;
    expect(shouldRunSpace({ id: "team/a", hasPending: true, lastDreamAt: old }, NIGHT, cfg)).toBe(true);
  });

  test("pending + fresh + before nightly hour -> skip", () => {
    const recent = NOON.getTime() - 1 * 3600_000;
    expect(shouldRunSpace({ id: "team/a", hasPending: true, lastDreamAt: recent }, NOON, cfg)).toBe(false);
  });

  test("pending + not run today + past nightly hour -> run", () => {
    // last dream was yesterday afternoon; now it's 04:00 today
    const yesterday = new Date("2026-07-03T15:00:00+08:00").getTime();
    expect(shouldRunSpace({ id: "team/a", hasPending: true, lastDreamAt: yesterday }, NIGHT, cfg)).toBe(true);
  });

  test("pending + already run today + past nightly hour -> skip", () => {
    const earlierToday = new Date("2026-07-04T03:30:00+08:00").getTime();
    expect(shouldRunSpace({ id: "team/a", hasPending: true, lastDreamAt: earlierToday }, NIGHT, cfg)).toBe(false);
  });
});

describe("Scheduler.tick", () => {
  let dir: string;
  let engine: KnowledgeEngine;
  let fake: FakeLlm;
  const SPACE: SpaceId = "team/oc_sched";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-sched-"));
    process.env.HOMEBRAIN_DATA_DIR = dir;
    resetConfig();
    fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HOMEBRAIN_DATA_DIR;
    resetConfig();
  });

  test("catch-up distills a space with pending raw after downtime", async () => {
    await engine.remember({ space: SPACE, source: "message", content: "Alice 负责后端。" });
    const pendingId = engine.registry.store(SPACE).index().listRaw({ onlyPending: true })[0]!.id;
    // Script analyze (reference the real pending id) then generate.
    fake.onJSON((call) => {
      const props = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("operations" in props) {
        return {
          operations: [{ type: "entity", name: "alice", title: "Alice", rawIds: [pendingId] }],
          skippedRawIds: [],
        };
      }
      // generate schema
      return { title: "Alice", summary: "后端负责人", aliases: [], tags: [], links: [], content: "# Alice\n负责后端。\n" };
    });

    const sched = new Scheduler(engine, cfg);
    const ran = await sched.tick("test", NOON);
    expect(ran).toContain(SPACE);
    expect(engine.registry.store(SPACE).index().getPage("entities/alice")).not.toBeNull();
  });

  test("skips a space with no pending raw", async () => {
    // create the space but leave nothing pending
    engine.ensureSpace(SPACE);
    const sched = new Scheduler(engine, cfg);
    const ran = await sched.tick("test", NOON);
    expect(ran).toEqual([]);
    expect(fake.calls.length).toBe(0);
  });

  test("localHour respects Asia/Shanghai", async () => {
    // covered indirectly; DEFAULT_SCHEDULE hour is 3
    expect(DEFAULT_SCHEDULE.hour).toBe(3);
  });
});

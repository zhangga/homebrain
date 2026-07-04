/**
 * Live ask test. Skipped unless HOMEBRAIN_LIVE=1. Builds a small KB via the real
 * dream cycle, then verifies a grounded answer with citations, and a general
 * fallback for an out-of-KB question. Run:
 *   HOMEBRAIN_LIVE=1 bun test packages/core/src/ask.live.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homebrain/shared";
import { resetConfig } from "@homebrain/shared";
import { SpaceStore } from "./space.ts";
import { runDreamCycle } from "./dream.ts";
import { ask } from "./ask.ts";

const LIVE = process.env.HOMEBRAIN_LIVE === "1";
const maybe = LIVE ? describe : describe.skip;

let dir: string;
let store: SpaceStore;
const SPACE: SpaceId = "team/oc_live_ask";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-ask-live-"));
  process.env.HOMEBRAIN_DATA_DIR = dir;
  resetConfig();
  store = new SpaceStore(SPACE, dir);
  store.ensure();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEBRAIN_DATA_DIR;
  resetConfig();
});

maybe("ask (live)", () => {
  test("grounded answer with citations, and general fallback out-of-KB", async () => {
    const idx = store.index();
    idx.insertRaw({
      space: SPACE,
      source: "message",
      author: "ou_lead",
      content: "我们团队的后端负责人是 Alice，她主导服务端架构与数据库设计。",
    });
    idx.insertRaw({
      space: SPACE,
      source: "message",
      author: "ou_pm",
      content: "前端由 Bob 负责，主要做用户界面与交互。",
    });
    await runDreamCycle(store, { model: "claude-sonnet-5" });

    const grounded = await ask([store], "谁负责后端？", { model: "claude-sonnet-5" });
    console.error("[live ask] grounded:", JSON.stringify(grounded, null, 2));
    expect(grounded.source).toBe("knowledge");
    expect(grounded.answer).toMatch(/Alice|爱丽丝/i);
    expect(grounded.citations.length).toBeGreaterThanOrEqual(1);

    const general = await ask([store], "今天上海的天气怎么样？", { model: "claude-sonnet-5" });
    console.error("[live ask] general source:", general.source);
    expect(general.source).toBe("general");
    expect(general.citations).toEqual([]);
  }, 180000);
});

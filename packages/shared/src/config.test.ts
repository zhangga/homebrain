import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, readSettings, saveSettings, resetConfig } from "./config.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-config-"));
  process.env.HOMEBRAIN_DATA_DIR = dir;
  process.env.ANTHROPIC_BASE_URL = "http://localhost:0";
  process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
  resetConfig();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEBRAIN_DATA_DIR;
  resetConfig();
});

describe("editable settings overlay", () => {
  test("defaults apply when no settings.json exists", () => {
    const cfg = loadConfig();
    expect(cfg.model).toBe("claude-sonnet-5");
    expect(cfg.dreamHour).toBe(3);
    expect(cfg.dailyBudgetUsd).toBe(5);
    expect(cfg.defaultProvider).toBe("claude");
    expect(cfg.defaultModel).toBe("");
    expect(cfg.rawRetentionDays).toBe(90);
    expect(cfg.webHost).toBe("127.0.0.1");
    expect(cfg.webAdminToken).toBeUndefined();
  });

  test("web exposure settings are env-only", () => {
    const cfg = loadConfig({
      ...process.env,
      HOMEBRAIN_WEB_HOST: "0.0.0.0",
      HOMEBRAIN_WEB_ADMIN_TOKEN: "admin-secret",
      HOMEBRAIN_RAW_RETENTION_DAYS: "45",
    });
    expect(cfg.webHost).toBe("0.0.0.0");
    expect(cfg.webAdminToken).toBe("admin-secret");
    expect(cfg.rawRetentionDays).toBe(45);
    expect(readSettings(dir)).toEqual({});
  });

  test("default provider/model overlay from settings.json", () => {
    saveSettings({ defaultProvider: "trae-cli", defaultModel: "openrouter-3o" }, dir);
    const cfg = loadConfig();
    expect(cfg.defaultProvider).toBe("trae-cli");
    expect(cfg.defaultModel).toBe("openrouter-3o");
  });

  test("saveSettings writes config/settings.json and overlays it", () => {
    saveSettings({ model: "claude-opus-4-8", dreamHour: 5, dailyBudgetUsd: 12, rawRetentionDays: 30 }, dir);
    const path = join(dir, "config", "settings.json");
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.model).toBe("claude-opus-4-8");

    const cfg = loadConfig();
    expect(cfg.model).toBe("claude-opus-4-8");
    expect(cfg.dreamHour).toBe(5);
    expect(cfg.dailyBudgetUsd).toBe(12);
    expect(cfg.rawRetentionDays).toBe(30);
  });

  test("persisted settings win over env defaults", () => {
    process.env.HOMEBRAIN_LLM_MODEL = "claude-haiku-4-5-20251001";
    resetConfig();
    expect(loadConfig().model).toBe("claude-haiku-4-5-20251001");
    saveSettings({ model: "claude-sonnet-5" }, dir);
    expect(loadConfig().model).toBe("claude-sonnet-5");
    delete process.env.HOMEBRAIN_LLM_MODEL;
  });

  test("saveSettings merges (does not clobber unrelated keys)", () => {
    saveSettings({ model: "claude-opus-4-8" }, dir);
    saveSettings({ dreamHour: 7 }, dir);
    const persisted = readSettings(dir);
    expect(persisted.model).toBe("claude-opus-4-8");
    expect(persisted.dreamHour).toBe(7);
  });

  test("feishu bot identity is exposed on config and editable", () => {
    saveSettings({ feishuBotName: "homebrain", feishuBotOpenId: "ou_x" }, dir);
    const cfg = loadConfig();
    expect(cfg.feishuBotName).toBe("homebrain");
    expect(cfg.feishuBotOpenId).toBe("ou_x");
  });

  test("readSettings tolerates a corrupt file", () => {
    saveSettings({ model: "claude-sonnet-5" }, dir);
    // corrupt it
    const path = join(dir, "config", "settings.json");
    require("node:fs").writeFileSync(path, "{ not json", "utf8");
    expect(readSettings(dir)).toEqual({});
  });
});

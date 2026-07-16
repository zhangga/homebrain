import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexReasoningEffortsForModel,
  curatedProviderModels,
  detectProviders,
  isCliProvider,
  providerFailureDetail,
  runProvider,
} from "./providers.ts";

describe("Codex model capabilities", () => {
  test("reasoning effort choices follow the selected model", () => {
    expect(codexReasoningEffortsForModel("gpt-5.6-sol")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(codexReasoningEffortsForModel("gpt-5.5")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(codexReasoningEffortsForModel("gpt-5.3-codex-spark")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(codexReasoningEffortsForModel("custom-codex-model")).toEqual([]);
    expect(codexReasoningEffortsForModel("gpt-5.6-custom")).toEqual([]);
    expect(codexReasoningEffortsForModel()).toEqual([]);
  });
});

describe("provider detection", () => {
  test("honors managed binary overrides for detection and execution", async () => {
    const keys = [
      "HOMEAGENT_CODEX_BIN",
      "HOMEAGENT_CLAUDE_BIN",
      "HOMEAGENT_TRAE_BIN",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) process.env[key] = "/bin/echo";

      const detected = await detectProviders(500);
      expect(detected.map(({ id, bin }) => ({ id, bin }))).toEqual([
        { id: "claude", bin: "/bin/echo" },
        { id: "codex", bin: "/bin/echo" },
        { id: "trae-cli", bin: "/bin/echo" },
      ]);
      expect(await runProvider("codex", { prompt: "hello" }, 500)).toBe(
        '-c cli_auth_credentials_store="keyring" exec --sandbox read-only hello',
      );
      expect(
        await runProvider(
          "codex",
          { prompt: "hello", model: "gpt-5.6-sol", reasoningEffort: "high" },
          500,
        ),
      ).toBe(
        '-c cli_auth_credentials_store="keyring" -c model_reasoning_effort="high" exec --sandbox read-only hello -m gpt-5.6-sol',
      );
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("accepts pre-rename managed binary overrides", async () => {
    const canonical = process.env.HOMEAGENT_CODEX_BIN;
    const legacy = process.env.HOMEBRAIN_CODEX_BIN;
    try {
      delete process.env.HOMEAGENT_CODEX_BIN;
      process.env.HOMEBRAIN_CODEX_BIN = "/bin/echo";

      const detected = await detectProviders(500);
      expect(detected.find((provider) => provider.id === "codex")?.bin).toBe("/bin/echo");
      expect(await runProvider("codex", { prompt: "legacy" }, 500)).toContain(
        "cli_auth_credentials_store",
      );
    } finally {
      if (canonical === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = canonical;
      if (legacy === undefined) delete process.env.HOMEBRAIN_CODEX_BIN;
      else process.env.HOMEBRAIN_CODEX_BIN = legacy;
    }
  });

  test("detects the fixed known CLIs and reports availability", async () => {
    const list = await detectProviders(8000);
    const ids = list.map((p) => p.id).sort();
    expect(ids).toEqual(["claude", "codex", "trae-cli"]);
    // every entry carries a boolean available + a detail string
    for (const p of list) {
      expect(typeof p.available).toBe("boolean");
      expect(typeof p.detail).toBe("string");
      expect(p.detail.length).toBeGreaterThan(0);
    }
  });

  test("isCliProvider recognizes known ids, rejects gateway/unknown", () => {
    expect(isCliProvider("claude")).toBe(true);
    expect(isCliProvider("codex")).toBe(true);
    expect(isCliProvider("trae-cli")).toBe(true);
    // "gateway" is the built-in network provider, not a local CLI
    expect(isCliProvider("gateway")).toBe(false);
    expect(isCliProvider("nope")).toBe(false);
  });

  test("runProvider rejects an unknown provider id", async () => {
    await expect(runProvider("gateway" as never, { prompt: "hi" })).rejects.toThrow();
  });

  test("runProvider terminates the CLI process when its abort signal fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ha-provider-abort-"));
    const bin = join(dir, "slow-provider");
    const previous = process.env.HOMEAGENT_TRAE_BIN;
    try {
      writeFileSync(bin, "#!/bin/sh\nexec sleep 10\n", "utf8");
      chmodSync(bin, 0o755);
      process.env.HOMEAGENT_TRAE_BIN = bin;
      const controller = new AbortController();
      const completion = runProvider(
        "trae-cli",
        { prompt: "wait" },
        5_000,
        controller.signal,
      );

      setTimeout(() => controller.abort(new Error("caller cancelled")), 10);

      await expect(completion).rejects.toThrow("caller cancelled");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_TRAE_BIN;
      else process.env.HOMEAGENT_TRAE_BIN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider errors fall back to stdout when stderr is empty", () => {
    expect(providerFailureDetail("auth failed on stdout", "")).toBe("auth failed on stdout");
    expect(providerFailureDetail("less useful stdout", "stderr detail")).toBe("stderr detail");
  });

  test("curatedProviderModels returns a distinct model list per CLI provider", () => {
    const m = curatedProviderModels();
    // no "gateway" key — providers are CLIs only
    expect(m.gateway).toBeUndefined();
    expect(m["trae-cli"]).toContain("openrouter-3o");
    // codex list mirrors mew's menu
    expect(m.codex?.slice(0, 3)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(m.codex).toContain("gpt-5.5");
    expect(m.codex).toContain("gpt-5.3-codex-spark");
    expect(m.claude?.length).toBeGreaterThan(0);
    // provider lists are not all identical
    expect(m.claude).not.toEqual(m["trae-cli"]);
  });
});

/**
 * Local agent-CLI providers (mew's "provider" concept, adapted to a single
 * machine). mew routes a task to a provider running on some Device; homebrain
 * has no remote devices, so a "provider" here is an agent CLI installed on THIS
 * machine (claude / codex / trae-cli). This module is the single choke point for
 * all CLI provider traffic — like gateway.ts is for the network gateway.
 *
 * Two responsibilities:
 *   - detectProviders(): probe each known CLI with `--version` (bounded), so the
 *     backend only offers providers that are actually installed AND runnable.
 *     (A CLI can be on PATH yet broken — e.g. a Windows npm shim under WSL with
 *     no linux `node` — and must NOT be offered.)
 *   - runProvider(): spawn the CLI non-interactively with a prompt/system/model
 *     and return its stdout text.
 *
 * The built-in "gateway" provider (the Anthropic network gateway) is handled by
 * gateway.ts, not here; it is always available and is the default.
 */
import { logger } from "@homebrain/shared";

const log = logger.child("providers");

/** Stable provider ids. "gateway" is the built-in network provider (elsewhere). */
export type ProviderId = "gateway" | "claude" | "codex" | "trae-cli";

/**
 * The default local CLI used when an agent doesn't specify one. "gateway" is no
 * longer a user-selectable provider (the internal API is only used by the claude
 * CLI, not homebrain directly), so agents default to a real CLI.
 */
export const DEFAULT_CLI_PROVIDER: ProviderId = "claude";

interface CliSpec {
  id: ProviderId;
  /** display name (mirrors mew's labels) */
  name: string;
  /** binary looked up on PATH */
  bin: string;
  /** args that print a version quickly and exit */
  versionArgs: string[];
  /** curated model ids this provider commonly offers (mew shows these per-provider) */
  models: string[];
  /**
   * Build the argv to run a one-shot, non-interactive completion. The prompt is
   * passed on argv; system/model are folded in per-CLI. stdin is not used.
   */
  buildRun: (input: RunInput) => string[];
}

export interface RunInput {
  prompt: string;
  system?: string;
  model?: string;
}

export interface DetectedProvider {
  id: ProviderId;
  name: string;
  bin: string;
  available: boolean;
  /** version string when available; else a short reason it is not */
  detail: string;
}

/**
 * The fixed set of known local agent CLIs (per product decision). Invocation
 * modes are verified against the installed CLIs:
 *   - claude   : `claude -p "<prompt>" [--model m] [--append-system-prompt s]`
 *   - trae-cli : `trae-cli exec "<prompt>" [-m model]`
 *   - codex    : `codex exec "<prompt>" [-m model]` (Codex CLI non-interactive)
 */
const KNOWN: CliSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    versionArgs: ["--version"],
    models: ["sonnet", "opus", "haiku", "claude-sonnet-4-6", "claude-opus-4-8"],
    buildRun: ({ prompt, system, model }) => {
      // Lean/read-only mode: --bare skips hooks/CLAUDE.md/memory/keychain and
      // --allowedTools "" disables all tools. Measured ~2.6x faster and avoids
      // permission prompts — right for Q&A/distillation (no side effects).
      const args = ["-p", prompt, "--bare", "--allowedTools", ""];
      if (model) args.push("--model", model);
      if (system) args.push("--append-system-prompt", system);
      return args;
    },
  },
  {
    id: "codex",
    name: "Codex",
    bin: "codex",
    versionArgs: ["--version"],
    // Curated to match mew's Codex model menu (CLIs expose no list command).
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
    buildRun: ({ prompt, model }) => {
      // Read-only sandbox + never ask for approval: pure Q&A, no side effects.
      const args = ["exec", "--sandbox", "read-only", prompt];
      if (model) args.push("-m", model);
      return args;
    },
  },
  {
    id: "trae-cli",
    name: "TRAE CLI",
    bin: "trae-cli",
    versionArgs: ["--version"],
    models: ["openrouter-3o", "openrouter-sonnet", "openrouter-gpt-5"],
    buildRun: ({ prompt, model }) => {
      // Read-only sandbox + never prompt for approval (see `trae-cli exec --help`):
      // pure Q&A, no file/command side effects.
      const args = ["exec", "--sandbox", "read-only", prompt];
      if (model) args.push("-m", model);
      return args;
    },
  },
];

/** Curated model ids for the built-in network gateway (Anthropic). */
export const GATEWAY_MODELS = ["claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-opus-4-8"];

const specById = new Map<ProviderId, CliSpec>(KNOWN.map((s) => [s.id, s]));

/** Spawn a command with a hard timeout; resolve stdout/stderr/exit code. */
async function runCmd(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(); // SIGTERM
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe every known CLI once. A provider is "available" only if its version
 * command exits 0 and prints something (installed AND runnable). Bounded so a
 * hanging CLI can't stall the backend.
 */
export async function detectProviders(timeoutMs = 6000): Promise<DetectedProvider[]> {
  const out: DetectedProvider[] = [];
  for (const spec of KNOWN) {
    try {
      const { code, stdout, stderr, timedOut } = await runCmd(spec.bin, spec.versionArgs, timeoutMs);
      const version = (stdout || stderr).trim().split("\n")[0]?.slice(0, 80) ?? "";
      if (timedOut) {
        out.push({ ...base(spec), available: false, detail: "探测超时" });
      } else if (code === 0 && version && !/not found|no such|cannot|error/i.test(version)) {
        out.push({ ...base(spec), available: true, detail: version });
      } else {
        out.push({ ...base(spec), available: false, detail: version || `退出码 ${code}` });
      }
    } catch (err) {
      out.push({ ...base(spec), available: false, detail: `未安装（${String(err).slice(0, 40)}）` });
    }
  }
  return out;
}

function base(spec: CliSpec): Omit<DetectedProvider, "available" | "detail"> {
  return { id: spec.id, name: spec.name, bin: spec.bin };
}

/** True for a provider id that maps to a known local CLI (not "gateway"). */
export function isCliProvider(id: string): id is ProviderId {
  return specById.has(id as ProviderId);
}

/**
 * Curated model ids per CLI provider id. Drives the provider-dependent Model
 * dropdown (mew shows different models per provider). Free-text is still
 * accepted elsewhere; this is just the menu. CLIs have no list-models command,
 * so these lists are curated. (The network gateway is not a user-selectable
 * provider, so it is not included.)
 */
export async function providerModels(): Promise<Record<string, string[]>> {
  return curatedProviderModels();
}

/** Prefer stderr for CLI failures, but many agent CLIs print errors to stdout. */
export function providerFailureDetail(stdout: string, stderr: string): string {
  return (stderr.trim() || stdout.trim() || "no output").slice(0, 300);
}

/** The curated CLI model catalog, keyed by provider id. */
export function curatedProviderModels(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const spec of KNOWN) map[spec.id] = spec.models;
  return map;
}

/**
 * Run a one-shot completion via a local CLI provider. Returns trimmed stdout.
 * Throws on non-zero exit / timeout so callers can surface a bounded failure.
 * These CLIs are full coding agents: slower and heavier than the gateway, and
 * they manage their own auth — so this is best-effort "hand the question to the
 * local agent", not a lightweight completion.
 */
export async function runProvider(
  id: ProviderId,
  input: RunInput,
  timeoutMs = 120_000,
): Promise<string> {
  const spec = specById.get(id);
  if (!spec) throw new Error(`unknown provider: ${id}`);
  const args = spec.buildRun(input);
  log.info("running local provider", { id, bin: spec.bin });
  const { code, stdout, stderr, timedOut } = await runCmd(spec.bin, args, timeoutMs);
  if (timedOut) throw new Error(`provider ${id} timed out after ${timeoutMs}ms`);
  if (code !== 0) throw new Error(`provider ${id} exited ${code}: ${providerFailureDetail(stdout, stderr)}`);
  return stdout.trim();
}

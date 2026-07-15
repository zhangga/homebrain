/**
 * Agent store (management backend, mew-style Agents page). An "agent" is a
 * named persona + provider CLI + model the bot uses to answer (and, in future,
 * to execute tasks) in a space.
 *
 * Active fields (used today): name, instruction (persona), provider (local CLI),
 * model, Codex reasoning effort, visibility. Reserved fields for the upcoming task-execution platform
 * (learning tasks / todos / more) are stored and editable but NOT yet consumed
 * by ask/dream: workdir, permission, skills. They are surfaced in the UI marked
 * "尚未生效" so the data model is ready when the execution engine lands.
 *
 * Agents are persisted to data/config/agents.json using the same whole-file
 * JSON pattern as the space registry (registry.ts). The markdown/DB knowledge is
 * unaffected; this is lightweight operational config.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexReasoningEffort, ProviderId } from "@homebrain/llm";
import {
  DEFAULT_CLI_PROVIDER,
  isCliProvider,
  isCodexReasoningEffortSupported,
} from "@homebrain/llm";
import { canonicalModelId } from "@homebrain/shared";

/** Task-execution permission tier (reserved; not enforced yet). */
export type AgentPermission = "read-only" | "write" | "full";
export const AGENT_PERMISSIONS: AgentPermission[] = ["read-only", "write", "full"];

/** A configurable answering persona. `model` empty => fall back to global default. */
export interface Agent {
  id: string;
  name: string;
  /** persona / extra system prompt injected into ask() */
  instruction: string;
  /** model id; empty string means "use the global default model" */
  model: string;
  /** Codex reasoning effort; empty string means "inherit the Codex default". */
  reasoningEffort: CodexReasoningEffort | "";
  /** local agent CLI to run (claude / codex / trae-cli) */
  provider: ProviderId;
  /** display-only: "Personal" | "Team" etc. */
  visibility?: string;
  /** RESERVED (task execution): working directory the CLI runs in. Unused today. */
  workdir?: string;
  /** RESERVED (task execution): permission tier. Stored/displayed; not enforced yet. */
  permission: AgentPermission;
  /** RESERVED (task execution): skill/plugin names to attach. Unused today. */
  skills: string[];
  createdAt: number;
  updatedAt: number;
}

/** Fields a caller may set when creating/updating an agent. */
export interface AgentInput {
  name?: string;
  instruction?: string;
  model?: string;
  reasoningEffort?: string;
  provider?: string;
  visibility?: string;
  workdir?: string;
  permission?: string;
  /** comma/newline-separated string or a string array */
  skills?: string | string[];
}

interface AgentsFile {
  agents: Record<string, Agent>;
}

/** Normalize a free-text provider into a valid CLI id; unknown => default CLI. */
function normalizeProvider(raw?: string): ProviderId {
  const v = raw?.trim();
  if (v && isCliProvider(v)) return v;
  return DEFAULT_CLI_PROVIDER;
}

/** Normalize a permission value; unknown/empty => read-only (safest default). */
function normalizePermission(raw?: string): AgentPermission {
  const v = raw?.trim() as AgentPermission | undefined;
  return v && AGENT_PERMISSIONS.includes(v) ? v : "read-only";
}

/** Normalize a Codex reasoning level; unknown/empty => inherit the CLI default. */
function normalizeReasoningEffort(raw: string | undefined, model: string): CodexReasoningEffort | "" {
  const value = raw?.trim() as CodexReasoningEffort | undefined;
  return value && isCodexReasoningEffortSupported(model || undefined, value) ? value : "";
}

/** Store the explicit GPT-5.6 Sol id instead of its shorter routing alias. */
function normalizeModel(raw?: string): string {
  return canonicalModelId(raw ?? "");
}

/** Parse skills from a string (comma/newline) or array into a clean string[]. */
function normalizeSkills(raw?: string | string[]): string[] {
  const parts = Array.isArray(raw) ? raw : (raw ?? "").split(/[,\n]/);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

export class AgentStore {
  private configPath: string;
  private agents: Map<string, Agent>;

  constructor(dataDir: string) {
    this.configPath = join(dataDir, "config", "agents.json");
    this.agents = this.load();
  }

  private load(): Map<string, Agent> {
    const map = new Map<string, Agent>();
    let migrated = false;
    if (existsSync(this.configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as AgentsFile;
        for (const [id, a] of Object.entries(parsed.agents ?? {})) {
          if (a && typeof a.id === "string") {
            // Migrate older files: unknown/legacy providers (e.g. "gateway",
            // which is no longer selectable) normalize to the default CLI.
            const normalized = normalizeProvider(a.provider as string | undefined);
            if (normalized !== a.provider) migrated = true;
            a.provider = normalized;
            const model = normalizeModel(a.model);
            if (model !== a.model) migrated = true;
            a.model = model;
            // Backfill reserved task-execution fields for older records.
            if (a.permission === undefined) { a.permission = "read-only"; migrated = true; }
            if (!Array.isArray(a.skills)) { a.skills = normalizeSkills(a.skills as unknown as string); migrated = true; }
            const reasoningEffort = normalizeReasoningEffort(a.reasoningEffort, a.model);
            if (reasoningEffort !== a.reasoningEffort) migrated = true;
            a.reasoningEffort = reasoningEffort;
            map.set(id, a);
          }
        }
      } catch {
        // corrupt file: start empty rather than crash the backend
      }
    }
    this.agents = map;
    // Rewrite once so the on-disk file reflects the migration.
    if (migrated) this.persist();
    return map;
  }

  private persist(): void {
    mkdirSync(join(this.configPath, ".."), { recursive: true });
    const obj: AgentsFile = { agents: Object.fromEntries(this.agents) };
    writeFileSync(this.configPath, JSON.stringify(obj, null, 2), "utf8");
  }

  list(): Agent[] {
    return [...this.agents.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  create(input: AgentInput): Agent {
    const now = Date.now();
    const model = normalizeModel(input.model);
    const agent: Agent = {
      id: `agent_${randomUUID()}`,
      name: input.name?.trim() || "未命名 Agent",
      instruction: input.instruction ?? "",
      model,
      reasoningEffort: normalizeReasoningEffort(input.reasoningEffort, model),
      provider: normalizeProvider(input.provider),
      visibility: input.visibility?.trim() || "Team",
      workdir: input.workdir?.trim() || undefined,
      permission: normalizePermission(input.permission),
      skills: normalizeSkills(input.skills),
      createdAt: now,
      updatedAt: now,
    };
    this.agents.set(agent.id, agent);
    this.persist();
    return agent;
  }

  /** Patch an existing agent. Only provided fields change. Returns undefined if absent. */
  update(id: string, input: AgentInput): Agent | undefined {
    const agent = this.agents.get(id);
    if (!agent) return undefined;
    if (input.name !== undefined) agent.name = input.name.trim() || agent.name;
    if (input.instruction !== undefined) agent.instruction = input.instruction;
    if (input.model !== undefined) agent.model = normalizeModel(input.model);
    if (input.reasoningEffort !== undefined) {
      agent.reasoningEffort = normalizeReasoningEffort(input.reasoningEffort, agent.model);
    } else if (input.model !== undefined) {
      agent.reasoningEffort = normalizeReasoningEffort(agent.reasoningEffort, agent.model);
    }
    if (input.provider !== undefined) agent.provider = normalizeProvider(input.provider);
    if (input.visibility !== undefined) agent.visibility = input.visibility.trim() || agent.visibility;
    if (input.workdir !== undefined) agent.workdir = input.workdir.trim() || undefined;
    if (input.permission !== undefined) agent.permission = normalizePermission(input.permission);
    if (input.skills !== undefined) agent.skills = normalizeSkills(input.skills);
    agent.updatedAt = Date.now();
    this.persist();
    return agent;
  }

  remove(id: string): boolean {
    const ok = this.agents.delete(id);
    if (ok) this.persist();
    return ok;
  }

  /** Restore an exact archived agent only when that id is not already present. */
  restore(agent: Agent): Agent {
    const existing = this.agents.get(agent.id);
    if (existing) return existing;
    const restored = { ...agent, skills: [...agent.skills] };
    this.agents.set(restored.id, restored);
    this.persist();
    return restored;
  }
}

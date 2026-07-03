export interface Citation {
  slug: string;
  title?: string;
}

export interface SearchHit {
  slug: string;
  title?: string;
  snippet?: string;
  score?: number;
}

export interface GbrainSource {
  id: string;
  localPath?: string;
}

export interface GbrainCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GbrainRun = (args: string[], input?: string) => Promise<GbrainCliResult>;

export interface DreamCycleResult {
  ok: boolean;
  status?: string;
  log?: string;
}

export interface EnsureSourcePathResult {
  ok: boolean;
  created: boolean;
  log?: string;
}

export interface GbrainCliContract {
  captureText(text: string): Promise<unknown>;
  putPage(slug: string, markdown: string): Promise<unknown>;
  getPage(slug: string): Promise<string | null>;
  query(question: string): Promise<{ answer: string; citations: Citation[] }>;
  search(query: string, limit?: number): Promise<SearchHit[]>;
  listSources(): Promise<GbrainSource[]>;
  ensureSourcePath(input: { id: string; path: string }): Promise<EnsureSourcePathResult>;
  sync(opts?: { noEmbed?: boolean }): Promise<{ ok: boolean; log?: string }>;
  dream(opts?: { dryRun?: boolean }): Promise<DreamCycleResult>;
  version(): Promise<{ ok: boolean; version?: string }>;
}

export function createBunGbrainRunner(opts: {
  bin: string;
  brainDir: string;
  env?: Record<string, string | undefined>;
}): GbrainRun {
  return async (args, input) => {
    const proc = Bun.spawn([opts.bin, ...args], {
      stdin: input === undefined ? undefined : new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env, GBRAIN_HOME: opts.brainDir },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { ok: exitCode === 0, stdout, stderr, exitCode };
  };
}

export function createGbrainCliContract(opts: {
  source: string;
  run: GbrainRun;
}): GbrainCliContract {
  async function listSources(): Promise<GbrainSource[]> {
    const result = await opts.run(["sources", "list"]);
    if (!result.ok) throw new Error(formatGbrainError("sources list", result));
    return parseSourcesOutput(result.stdout);
  }

  return {
    async captureText(text) {
      return parseGbrainJson<unknown>(
        "capture",
        await opts.run(["capture", text, "--source", opts.source, "--json"]),
      );
    },

    async putPage(slug, markdown) {
      return parseGbrainJson<unknown>(
        "put",
        await opts.run(["put", slug, "--content", markdown]),
      );
    },

    async getPage(slug) {
      const result = await opts.run(["get", slug]);
      if (!result.ok) {
        if (isPageNotFound(result)) return null;
        throw new Error(formatGbrainError("get", result));
      }
      return result.stdout.trim();
    },

    async query(question) {
      const result = await opts.run(["query", question]);
      if (!result.ok) throw new Error(formatGbrainError("query", result));
      const answer = result.stdout.trim();
      return {
        answer,
        citations: parseSearchOutput(result.stdout).map(({ slug, title }) => ({ slug, title })),
      };
    },

    async search(query, limit) {
      const args = ["search", query];
      if (limit !== undefined) args.push("--limit", String(limit));
      const result = await opts.run(args);
      if (!result.ok) throw new Error(formatGbrainError("search", result));
      return parseSearchOutput(result.stdout);
    },

    listSources,

    async ensureSourcePath(input) {
      let sources: GbrainSource[];
      try {
        sources = await listSources();
      } catch (err) {
        return {
          ok: false,
          created: false,
          log: err instanceof Error ? err.message : String(err),
        };
      }

      const existing = sources.find((source) => source.id === input.id);
      if (existing) {
        if (existing.localPath === input.path) return { ok: true, created: false };
        const detail = existing.localPath
          ? `当前 local_path 是 ${existing.localPath}`
          : "没有 local_path";
        return {
          ok: false,
          created: false,
          log: `source "${input.id}" 已存在但${detail}，不会自动删除或重建。请改用新的 GBRAIN_SOURCE，或手工确认后 remove/re-add。`,
        };
      }

      const result = await opts.run(["sources", "add", input.id, "--path", input.path]);
      const log = combinedOutput(result);
      if (!result.ok) {
        return { ok: false, created: false, log: formatGbrainError("sources add", result) };
      }
      return { ok: true, created: true, ...(log ? { log } : {}) };
    },

    async sync(syncOpts) {
      const args = ["sync", "--source", opts.source];
      if (syncOpts?.noEmbed) args.push("--no-embed");
      const result = await opts.run(args);
      const log = combinedOutput(result);
      if (!result.ok) return { ok: false, log };
      return log ? { ok: true, log } : { ok: true };
    },

    async dream(dreamOpts) {
      const args = ["dream"];
      if (dreamOpts?.dryRun) args.push("--dry-run");
      args.push("--json");
      const result = await opts.run(args);
      const log = combinedOutput(result);
      const status = parseDreamStatus(log);
      return {
        ok: result.ok && isDreamStatusOk(status),
        ...(status === undefined ? {} : { status }),
        ...(log ? { log } : {}),
      };
    },

    async version() {
      const result = await opts.run(["--version"]);
      if (!result.ok) return { ok: false };
      return { ok: true, version: result.stdout.trim() };
    },
  };
}

export function parseGbrainJson<T>(label: string, result: GbrainCliResult): T {
  if (!result.ok) throw new Error(formatGbrainError(label, result));
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`${label} 输出非 JSON：${result.stdout.slice(0, 200)}`);
  }
}

export function formatGbrainError(label: string, result: GbrainCliResult): string {
  const output = combinedOutput(result) || "(无输出)";
  return `${label} 失败 (exit ${result.exitCode}): ${output.slice(0, 500)}`;
}

function combinedOutput(result: GbrainCliResult): string {
  return [result.stderr, result.stdout].filter(Boolean).join("\n");
}

function isPageNotFound(result: GbrainCliResult): boolean {
  return combinedOutput(result).toLowerCase().includes("page not found");
}

function parseDreamStatus(log: string): string | undefined {
  const start = log.indexOf("{");
  const end = log.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    const parsed = JSON.parse(log.slice(start, end + 1)) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : undefined;
  } catch {
    return undefined;
  }
}

function isDreamStatusOk(status: string | undefined): boolean {
  return status === undefined || status === "clean" || status === "ok";
}

function parseSourcesOutput(stdout: string): GbrainSource[] {
  const sources: GbrainSource[] = [];
  let current: GbrainSource | undefined;

  for (const line of stdout.split("\n")) {
    const sourceMatch = line.match(/^\s{2}(\S+)\s+(?:federated|isolated)\b/);
    if (sourceMatch) {
      current = { id: sourceMatch[1]! };
      sources.push(current);
      continue;
    }

    const trimmed = line.trim();
    if (current && trimmed && !trimmed.startsWith("SOURCES") && !/^─+$/.test(trimmed)) {
      current.localPath = trimmed;
    }
  }

  return sources;
}

function parseSearchOutput(stdout: string): SearchHit[] {
  const text = stdout.trim();
  if (!text || text === "No results.") return [];

  const hits: SearchHit[] = [];
  let current: SearchHit | undefined;
  const snippets: string[] = [];

  function flush() {
    if (!current) return;
    const snippet = snippets.join("\n").trim();
    hits.push({ ...current, snippet: snippet || undefined });
    current = undefined;
    snippets.length = 0;
  }

  for (const line of text.split("\n")) {
    const match = line.match(/^\[([0-9.]+)\]\s+(.+?)\s+--\s+(.+)$/);
    if (match) {
      flush();
      current = {
        score: Number(match[1]),
        slug: match[2]!,
        title: match[3]!,
      };
      continue;
    }
    if (current && line.trim()) {
      snippets.push(line);
    }
  }
  flush();

  return hits;
}

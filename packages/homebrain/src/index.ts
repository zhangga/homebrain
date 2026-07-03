import {
  createBunGbrainRunner,
  createGbrainCliContract,
  type Citation,
  type SearchHit,
} from "./gbrainCli";
import { Serializer } from "./serialize";

/**
 * homebrain：gbrain 的薄封装，是整个项目【唯一】接触 gbrain 的地方。
 * homeagent 只认下面的 Homebrain 接口，永不直接 spawn gbrain。
 * 集成边界 = gbrain CLI 子进程（见实现计划 §0）。未来可加 MCP 后端而不动 homeagent。
 */

export interface BrainConfig {
  /** gbrain home 目录；gbrain 会在其下使用 .gbrain/config.json 和 brain.pglite */
  brainDir: string;
  /** gbrain 可执行路径，默认 'gbrain'（当外部可执行依赖，见 §1.1） */
  gbrainBin?: string;
  /** 默认 source；Model B 下为 'default'（见 §1.4 家庭成员映射） */
  defaultSource?: string;
  /** 可选：用于 `gbrain sources add <source> --path <path>` 的本地 markdown repo 路径。 */
  sourcePath?: string;
}

/** 家庭成员引用：slug 如 'dad' | 'mom' | 'kid' */
export interface MemberRef {
  slug: string;
}

export type { Citation, SearchHit } from "./gbrainCli";

export interface Homebrain {
  /** 写：把一条已抽取好的事实写入某成员名下 */
  remember(input: {
    member: MemberRef;
    text: string;
    tags?: string[];
    occurredAt?: string;
  }): Promise<{ slug: string }>;

  /** 综合问答（gbrain query/think，带引用） */
  ask(input: { question: string; member?: MemberRef }): Promise<{
    answer: string;
    citations: Citation[];
  }>;

  /** 原始检索（gbrain search，无 LLM，给调度 / 那年今日用） */
  search(input: { query: string; limit?: number }): Promise<SearchHit[]>;

  /** 按时间检索（那年今日 / 周报） */
  recall(input: { from: string; to: string; member?: MemberRef }): Promise<
    Array<{ slug: string; title?: string; occurredAt?: string }>
  >;

  /** 成员画像（读 / 写 partners/<slug>/USER.md） */
  upsertProfile(input: { member: MemberRef; profileMarkdown: string }): Promise<void>;
  getProfile(input: { member: MemberRef }): Promise<string | null>;

  /** 后台编排：sync + consolidate/synthesize（dream-cycle） */
  runDreamCycle(opts?: {
    sync?: boolean;
    noEmbed?: boolean;
    dryRun?: boolean;
  }): Promise<{ ok: boolean; log?: string }>;

  /** 健康检查 */
  health(): Promise<{ ok: boolean; version?: string }>;
}

export function createHomebrain(config: BrainConfig): Homebrain {
  const bin = config.gbrainBin ?? "gbrain";
  const source = config.defaultSource ?? "default";
  const sourcePath = config.sourcePath;
  // PGLite 单写者：所有写操作排进同一个串行队列（见 §0 / R3）。读操作不受限。
  const writes = new Serializer();
  const cli = createGbrainCliContract({
    source,
    run: createBunGbrainRunner({ bin, brainDir: config.brainDir }),
  });
  let sourceReady: Promise<{ ok: boolean; created: boolean; log?: string }> | undefined;

  async function ensureConfiguredSourcePath(): Promise<{
    ok: boolean;
    created: boolean;
    log?: string;
  }> {
    if (!sourcePath) return { ok: true, created: false };
    sourceReady ??= cli.ensureSourcePath({ id: source, path: sourcePath });
    const result = await sourceReady;
    if (!result.ok) sourceReady = undefined;
    return result;
  }

  return {
    remember({ member, text, tags, occurredAt }) {
      return writes.run(async () => {
        const ensured = await ensureConfiguredSourcePath();
        if (!ensured.ok) throw new Error(ensured.log ?? `source "${source}" 未就绪`);
        await cli.captureText(formatMemoryCaptureText({ member, text, tags, occurredAt }));
        return { slug: member.slug };
      });
    },

    async ask({ question }) {
      // Slice 0 实测：`gbrain query` 为文本输出，contract 层负责 citation 抽取。
      return cli.query(question);
    },

    async search({ query, limit }) {
      // Slice 0 实测：`gbrain search` 为文本输出，contract 层负责归一为 SearchHit。
      return cli.search(query, limit);
    },

    async recall({ from, to, member }) {
      // Slice 0 还没确认 gbrain 原生时间检索；先用 search + 日期解析做保守 fallback。
      const query = [from, to, member?.slug].filter(Boolean).join(" ");
      const hits = await cli.search(query, 20);
      return hits.flatMap((hit) => {
        const occurredAt = extractDate(hit);
        if (!occurredAt || occurredAt < from || occurredAt > to) return [];
        return [{ slug: hit.slug, title: hit.title, occurredAt }];
      });
    },

    upsertProfile({ member, profileMarkdown }) {
      return writes.run(async () => {
        // gbrain slug 使用小写；对应 git-markdown 语义里的 partners/<slug>/USER.md。
        await cli.putPage(profilePageSlug(member), profileMarkdown);
      });
    },

    async getProfile({ member }) {
      return cli.getPage(profilePageSlug(member));
    },

    runDreamCycle(opts) {
      return writes.run(async () => {
        const log: string[] = [];
        const ensured = await ensureConfiguredSourcePath();
        pushLog(log, ensured.log);
        if (!ensured.ok) return { ok: false, log: log.join("\n") };

        if (opts?.sync !== false) {
          const s = await cli.sync({ noEmbed: opts?.noEmbed });
          pushLog(log, s.log);
          if (!s.ok) return { ok: false, log: log.join("\n") };
        }
        const dream = await cli.dream({ dryRun: opts?.dryRun });
        pushLog(log, dream.log);
        return { ok: dream.ok, log: log.join("\n") };
      });
    },

    async health() {
      return cli.version();
    },
  };
}

function profilePageSlug(member: MemberRef): string {
  const slug = member.slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `partners/${slug || "member"}/user`;
}

function formatMemoryCaptureText(input: {
  member: MemberRef;
  text: string;
  tags?: string[];
  occurredAt?: string;
}): string {
  const lines = ["---", `member: ${formatYamlScalar(input.member.slug)}`];
  if (input.occurredAt) lines.push(`occurredAt: ${formatYamlScalar(input.occurredAt)}`);
  const tags = normalizeTags(input.tags);
  if (tags.length) {
    lines.push("tags:", ...tags.map((tag) => `  - ${formatYamlScalar(tag)}`));
  }
  return [...lines, "---", input.text].join("\n");
}

function normalizeTags(tags: string[] | undefined): string[] {
  const normalized: string[] = [];
  for (const tag of tags ?? []) {
    const value = tag.trim();
    if (value && !normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

function formatYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_.:/-]+$/.test(trimmed)) return trimmed;
  return JSON.stringify(trimmed);
}

function extractDate(hit: SearchHit): string | undefined {
  const text = [hit.slug, hit.title, hit.snippet].filter(Boolean).join("\n");
  return text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
}

function pushLog(log: string[], value: string | undefined): void {
  const normalized = value?.trimEnd();
  if (normalized) log.push(normalized);
}

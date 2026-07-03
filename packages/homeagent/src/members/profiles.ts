import type { Homebrain, MemberRef } from "homebrain";
import type { ExtractedFact } from "../understanding/extractor";

export interface MemberProfileUpdater {
  updateFromFacts(input: {
    member: MemberRef;
    facts: ExtractedFact[];
    updatedAt?: string;
  }): Promise<{ updated: boolean; profileMarkdown?: string }>;
}

export type ProfileBrain = Pick<Homebrain, "getProfile" | "upsertProfile">;

export interface ManagedProfileUpdaterOptions {
  brain: ProfileBrain;
  now?: () => string;
}

interface MergeProfileInput {
  memberSlug: string;
  existing: string | null;
  facts: ExtractedFact[];
  updatedAt: string;
}

type ProfileSectionKey = "identity" | "preferences" | "school" | "health" | "tasks" | "other";

interface ProfileSectionDef {
  key: ProfileSectionKey;
  title: string;
}

const MANAGED_START = "<!-- homeagent-profile:start -->";
const MANAGED_END = "<!-- homeagent-profile:end -->";

const SECTIONS: ProfileSectionDef[] = [
  { key: "identity", title: "身份与关系" },
  { key: "preferences", title: "偏好" },
  { key: "school", title: "学习与学校" },
  { key: "health", title: "健康与照护" },
  { key: "tasks", title: "任务与进展" },
  { key: "other", title: "其他长期事实" },
];

export function createManagedProfileUpdater(
  opts: ManagedProfileUpdaterOptions,
): MemberProfileUpdater {
  const now = opts.now ?? (() => new Date().toISOString());

  return {
    async updateFromFacts(input) {
      const facts = input.facts.filter((fact) => fact.text.trim() !== "");
      if (facts.length === 0) return { updated: false };

      const existing = await opts.brain.getProfile({ member: input.member });
      const profileMarkdown = mergeMemberProfileFacts({
        memberSlug: input.member.slug,
        existing,
        facts,
        updatedAt: input.updatedAt ?? now(),
      });
      if ((existing ?? "").trim() === profileMarkdown.trim()) {
        return { updated: false, profileMarkdown };
      }

      await opts.brain.upsertProfile({ member: input.member, profileMarkdown });
      return { updated: true, profileMarkdown };
    },
  };
}

export function mergeMemberProfileFacts(input: MergeProfileInput): string {
  const existing = input.existing?.trimEnd() || `# ${input.memberSlug}`;
  const manual = removeManagedBlock(existing).trimEnd() || `# ${input.memberSlug}`;
  const sections = parseManagedSections(existing);

  for (const fact of input.facts) {
    const line = formatFactLine(fact);
    if (!line) continue;
    addUnique(sections[classifyFact(fact)], line);
  }

  if (!hasAnySectionItem(sections)) return `${manual}\n`;
  return `${manual}\n\n${renderManagedBlock(sections, input.updatedAt)}\n`;
}

function parseManagedSections(markdown: string): Record<ProfileSectionKey, string[]> {
  const sections = emptySections();
  const block = extractManagedBlock(markdown);
  if (!block) return sections;

  let current: ProfileSectionKey | undefined;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("### ")) {
      current = sectionKeyByTitle(line.slice(4).trim());
      continue;
    }
    if (current && line.startsWith("- ")) addUnique(sections[current], line);
  }
  return sections;
}

function renderManagedBlock(
  sections: Record<ProfileSectionKey, string[]>,
  updatedAt: string,
): string {
  const lines = [MANAGED_START, "## 自动画像", "", `更新时间：${updatedAt}`];
  for (const section of SECTIONS) {
    const items = sections[section.key];
    if (items.length === 0) continue;
    lines.push("", `### ${section.title}`, ...items);
  }
  lines.push("", MANAGED_END);
  return lines.join("\n");
}

function extractManagedBlock(markdown: string): string | undefined {
  const start = markdown.indexOf(MANAGED_START);
  const end = markdown.indexOf(MANAGED_END);
  if (start < 0 || end < start) return undefined;
  return markdown.slice(start + MANAGED_START.length, end);
}

function removeManagedBlock(markdown: string): string {
  const start = markdown.indexOf(MANAGED_START);
  const end = markdown.indexOf(MANAGED_END);
  if (start < 0 || end < start) return markdown;
  return `${markdown.slice(0, start)}${markdown.slice(end + MANAGED_END.length)}`;
}

function emptySections(): Record<ProfileSectionKey, string[]> {
  return {
    identity: [],
    preferences: [],
    school: [],
    health: [],
    tasks: [],
    other: [],
  };
}

function classifyFact(fact: ExtractedFact): ProfileSectionKey {
  const tags = (fact.tags ?? []).join(" ").toLowerCase();
  const text = fact.text.toLowerCase();
  const signal = `${tags} ${text}`;
  if (/(preference|pref|偏好|喜好|喜欢|不喜欢|爱吃|讨厌)/.test(signal)) {
    return "preferences";
  }
  if (/(school|learning|study|学习|学校|课程|年级|老师|作业|考试)/.test(signal)) {
    return "school";
  }
  if (/(health|medical|care|健康|照护|医疗|过敏|发烧|咳嗽|吃药|医院|体检)/.test(signal)) {
    return "health";
  }
  if (/(task|goal|progress|任务|目标|进展|读到第|完成第|跳过|顺延)/.test(signal)) {
    return "tasks";
  }
  if (/(family|member|relation|contact|家庭|成员|关系|联系|生日|电话|手机号|住址)/.test(signal)) {
    return "identity";
  }
  return "other";
}

function formatFactLine(fact: ExtractedFact): string | undefined {
  const text = fact.text.trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  return `- ${text}${fact.occurredAt ? ` (${fact.occurredAt})` : ""}`;
}

function sectionKeyByTitle(title: string): ProfileSectionKey | undefined {
  return SECTIONS.find((section) => section.title === title)?.key;
}

function addUnique(items: string[], item: string): void {
  if (!items.includes(item)) items.push(item);
}

function hasAnySectionItem(sections: Record<ProfileSectionKey, string[]>): boolean {
  return SECTIONS.some((section) => sections[section.key].length > 0);
}

import type { MemberRef } from "homebrain";
import type { MemberProfileUpdater } from "../members/profiles";
import type { MemberRecord } from "../members/store";
import { buildProfileRefreshQuestion } from "../understanding/prompts";

export const DEFAULT_PROFILE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ProfileRefreshBrain {
  ask(input: { question: string }): Promise<{ answer: string }>;
}

export interface ProfileMemberStore {
  listMembers(): MemberRecord[];
}

export type ProfileRefreshTickResult =
  | { skipped: false; date: string; members: number; updated: number }
  | { skipped: true; reason: "empty_members" };

export interface ProfileRefreshTickOptions {
  brain: ProfileRefreshBrain;
  memberStore: ProfileMemberStore;
  profileUpdater: MemberProfileUpdater;
  now?: () => Date;
}

export interface ProfileRefreshSchedulerOptions extends ProfileRefreshTickOptions {
  intervalMs?: number;
  runOnStart?: boolean;
  setTimer?: (callback: () => void, intervalMs: number) => unknown;
  clearTimer?: (timerId: unknown) => void;
  onError?: (err: unknown) => void;
}

export interface ProfileRefreshScheduler {
  tick(): Promise<ProfileRefreshTickResult>;
  idle(): Promise<void>;
  stop(): void;
}

/** 周期性画像归纳：从 homebrain 问近期长期事实，再复用 USER.md 托管区块更新逻辑。 */
export async function runProfileRefreshTick(
  opts: ProfileRefreshTickOptions,
): Promise<ProfileRefreshTickResult> {
  const members = opts.memberStore.listMembers();
  if (members.length === 0) return { skipped: true, reason: "empty_members" };

  const now = (opts.now ?? (() => new Date()))();
  const date = toDateKey(now);
  const updatedAt = now.toISOString();
  let updated = 0;

  for (const member of members) {
    const result = await opts.brain.ask({
      question: buildProfileRefreshQuestion({ member, date }),
    });
    const factTexts = parseProfileFacts(result.answer);
    if (factTexts.length === 0) continue;

    const updateResult = await opts.profileUpdater.updateFromFacts({
      member: toMemberRef(member),
      facts: factTexts.map((text) => ({ text, tags: ["profile"], occurredAt: date })),
      updatedAt,
    });
    if (updateResult.updated) updated += 1;
  }

  return { skipped: false, date, members: members.length, updated };
}

export function startProfileRefreshScheduler(
  opts: ProfileRefreshSchedulerOptions,
): ProfileRefreshScheduler {
  const setTimer = opts.setTimer ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const clearTimer =
    opts.clearTimer ?? ((timerId) => clearInterval(timerId as ReturnType<typeof setInterval>));
  const intervalMs = opts.intervalMs ?? DEFAULT_PROFILE_REFRESH_INTERVAL_MS;

  let lastRun: Promise<void> = Promise.resolve();
  const runScheduledTick = () => {
    lastRun = runProfileRefreshTick(opts).then(
      () => undefined,
      (err) => {
        opts.onError?.(err);
      },
    );
  };

  const timerId = setTimer(runScheduledTick, intervalMs);
  if (opts.runOnStart) runScheduledTick();

  return {
    tick: () => runProfileRefreshTick(opts),
    idle: () => lastRun,
    stop: () => clearTimer(timerId),
  };
}

function toMemberRef(member: MemberRecord): MemberRef {
  return { slug: member.slug };
}

function parseProfileFacts(answer: string): string[] {
  const seen = new Set<string>();
  const facts: string[] = [];

  for (const rawLine of answer.split(/\r?\n/)) {
    const text = normalizeProfileFactLine(rawLine);
    if (
      !text ||
      isProfileHeading(text) ||
      isEmptyProfileAnswer(text) ||
      isExcludedProfileExplanation(text) ||
      isUncertainProfileFact(text)
    ) {
      continue;
    }
    if (seen.has(text)) continue;

    seen.add(text);
    facts.push(text);
  }

  return facts;
}

function normalizeProfileFactLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*•]\s*/, "")
    .replace(/^\d+\s*[.)、]\s*/, "")
    .replace(/^(?:事实要点|画像事实|长期事实|事实|要点|结果)[：:]\s*/, "")
    .trim();
}

function isProfileHeading(text: string): boolean {
  return (
    /^(事实要点|画像事实|长期事实|要点|结果)[：:]$/.test(text) ||
    /^以下是.*(画像|事实|要点).*[：:]$/.test(text)
  );
}

function isEmptyProfileAnswer(text: string): boolean {
  return (
    /^(无|没有|暂无|无新事实|没有新事实|暂无新事实|无新增事实|没有新增事实)[。.!！]*$/.test(
      text,
    ) ||
    /^(没有|暂无|无)(?:新的?|新增)?(?:长期)?(?:画像)?事实(?:可写入|需要写入|可以写入)?[。.!！]*$/.test(
      text,
    ) ||
    /^(没有|暂无|无)(?:可以|可|需要)?写入(?:\s*USER\.md\s*的?|的)?(?:新的?|新增)?(?:长期)?(?:画像)?事实[。.!！]*$/i.test(
      text,
    ) ||
    /^(暂无|没有)(?:需要|可以|可)?写入的?(?:新的?|新增)?(?:长期)?(?:画像)?事实[。.!！]*$/.test(
      text,
    ) ||
    /^(?:本次|当前|这次|近期|最近)?(?:没有|暂无|无)(?:值得|适合|需要|可以|可)?(?:写入|记录|保存).*(?:长期画像|画像|USER\.md|长期事实|画像事实|事实)[。.!！]*$/i.test(
      text,
    ) ||
    /^(?:暂不|不|无需|不需要|没必要)(?:需要)?(?:更新|写入|记录|保存).*(?:画像|USER\.md|长期事实|画像事实|事实)[。.!！]*$/i.test(
      text,
    ) ||
    /^(?:本次|当前|这次|近期|最近)?(?:没有|暂无|无)(?:可)?(?:长期|长期记忆|长期画像|画像)(?:价值|意义)的?(?:内容|信息|事实)?[。.!！]*$/i.test(
      text,
    ) ||
    /^(?:原因|说明|解释)[：:]/.test(text)
  );
}

function isExcludedProfileExplanation(text: string): boolean {
  return (
    /^(?:不(?:要|应|用)?写入|不要记录|不应记录|排除|忽略|跳过)[：:]/.test(text) ||
    /(?:一次性|短期|临时).*(?:不(?:适合|需要|应|要|建议)|无需|不能).*(?:写入|记录|保存).*(?:画像|USER\.md|长期)/i.test(
      text,
    )
  );
}

function isUncertainProfileFact(text: string): boolean {
  return /(?:可能|也许|大概|似乎|好像|疑似|不确定|无法确定|不能确定|暂不确定|尚不确定)/.test(text);
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

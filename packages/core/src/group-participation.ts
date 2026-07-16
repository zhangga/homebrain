import type { GroupParticipationLevel, SpaceMeta } from "./types.ts";

export const GROUP_PARTICIPATION_LEVELS = [
  "reserved",
  "balanced",
  "active",
] as const satisfies readonly GroupParticipationLevel[];

export function isGroupParticipationLevel(value: unknown): value is GroupParticipationLevel {
  return GROUP_PARTICIPATION_LEVELS.includes(value as GroupParticipationLevel);
}

export function resolveGroupParticipationLevel(
  meta?: Pick<SpaceMeta, "participationLevel">,
): GroupParticipationLevel {
  if (isGroupParticipationLevel(meta?.participationLevel)) return meta.participationLevel;
  return "balanced";
}

export function usesLegacyRespondAll(
  meta?: Pick<SpaceMeta, "participationLevel" | "mentionsOnly">,
): boolean {
  return meta?.participationLevel === undefined && meta?.mentionsOnly === false;
}

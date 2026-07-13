/**
 * SpaceId helpers. A SpaceId encodes both the kind (personal/team) and the
 * feishu identity (open_id / chat_id). Centralizing parse/build here keeps the
 * encoding in one place so core and orchestrator agree on it.
 */
import type { SpaceId, SpaceKind } from "./types.ts";

export function personalSpace(openId: string): SpaceId {
  return `personal/${openId}`;
}

export function teamSpace(chatId: string): SpaceId {
  return `team/${chatId}`;
}

export function spaceKind(space: SpaceId): SpaceKind {
  return space.startsWith("personal/") ? "personal" : "team";
}

/** The feishu id embedded in a space (open_id for personal, chat_id for team). */
export function spaceOwnerId(space: SpaceId): string {
  const idx = space.indexOf("/");
  return space.slice(idx + 1);
}

/**
 * Convert a SpaceId into a filesystem-safe directory name. open_id/chat_id can
 * contain characters that are awkward in paths, so we keep the kind prefix and
 * sanitize the id. Reversible enough for humans; the DB is the source of truth.
 */
export function spaceToDir(space: SpaceId): string {
  const kind = spaceKind(space);
  const id = spaceOwnerId(space).replace(/[^A-Za-z0-9_-]/g, "_");
  return `${kind}__${id}`;
}

const SPACE_RE = /^(personal|team)\/.+/;

export function isSpaceId(value: string): value is SpaceId {
  return SPACE_RE.test(value);
}

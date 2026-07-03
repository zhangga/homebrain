import { Database } from "bun:sqlite";
import type { MemberRef } from "homebrain";
import type { IncomingMessage } from "../connectors/types";

export interface MemberRecord {
  connector: string;
  externalId: string;
  slug: string;
  displayName?: string;
}

export interface MemberStore {
  resolveMember(input: {
    connector: string;
    externalId: string;
    displayName?: string;
  }): MemberRef;
  getMember(connector: string, externalId: string): MemberRecord | undefined;
  listMembers(): MemberRecord[];
  close(): void;
}

interface MemberRow {
  connector: string;
  external_id: string;
  slug: string;
  display_name: string | null;
}

export function createMemberStore(opts: { dbPath: string }): MemberStore {
  const db = new Database(opts.dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS members (
      connector TEXT NOT NULL,
      external_id TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (connector, external_id)
    )
  `);

  function getMember(connector: string, externalId: string): MemberRecord | undefined {
    const row = db
      .query(
        `SELECT connector, external_id, slug, display_name
         FROM members
         WHERE connector = ? AND external_id = ?`,
      )
      .get(connector, externalId) as MemberRow | null;
    return rowToMember(row);
  }

  function slugExists(slug: string): boolean {
    const row = db.query("SELECT 1 AS ok FROM members WHERE slug = ?").get(slug) as
      | { ok: number }
      | null;
    return row !== null;
  }

  function nextAvailableSlug(base: string): string {
    if (!slugExists(base)) return base;
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-${n}`;
      if (!slugExists(candidate)) return candidate;
    }
  }

  return {
    resolveMember({ connector, externalId, displayName }) {
      const existing = getMember(connector, externalId);
      const now = Date.now();
      if (existing) {
        db.query(
          `UPDATE members
           SET display_name = ?, updated_at = ?
           WHERE connector = ? AND external_id = ?`,
        ).run(displayName ?? null, now, connector, externalId);
        return { slug: existing.slug };
      }

      const baseSlug =
        slugifyMemberName(displayName ?? "") || slugifyMemberName(externalId) || "member";
      const slug = nextAvailableSlug(baseSlug);
      db.query(
        `INSERT INTO members (connector, external_id, slug, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(connector, externalId, slug, displayName ?? null, now, now);
      return { slug };
    },

    getMember,

    listMembers() {
      const rows = db
        .query(
          `SELECT connector, external_id, slug, display_name
           FROM members
           ORDER BY connector, external_id`,
        )
        .all() as MemberRow[];
      return rows.map((row) => rowToMember(row)!);
    },

    close() {
      db.close();
    },
  };
}

export function createMemberResolver(
  store: MemberStore,
  connector: string,
): (msg: IncomingMessage) => MemberRef {
  return (msg) =>
    store.resolveMember({
      connector,
      externalId: msg.senderId,
      displayName: msg.senderName,
    });
}

export function slugifyMemberName(value: string): string {
  return value
    .trim()
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function rowToMember(row: MemberRow | null): MemberRecord | undefined {
  if (!row) return undefined;
  return {
    connector: row.connector,
    externalId: row.external_id,
    slug: row.slug,
    displayName: row.display_name ?? undefined,
  };
}

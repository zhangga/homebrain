/**
 * Registry of known spaces and their metadata (plan §6: bindings stored under
 * data/config). Keeps a cache of open SpaceStore instances and persists a small
 * JSON registry so the scheduler knows each space's lastDreamAt across restarts.
 *
 * The markdown/DB on disk is authoritative for knowledge; this registry only
 * tracks lightweight operational metadata and space existence.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SpaceId } from "@homebrain/shared";
import { isSpaceId, spaceToDir } from "@homebrain/shared";
import type { SpaceMeta } from "./types.ts";
import { SpaceStore } from "./space.ts";

interface RegistryFile {
  spaces: Record<string, SpaceMeta>;
}

export class SpaceRegistry {
  private dataDir: string;
  private configPath: string;
  private stores = new Map<string, SpaceStore>();
  private meta: Map<string, SpaceMeta>;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.configPath = join(dataDir, "config", "spaces.json");
    this.meta = this.load();
  }

  private load(): Map<string, SpaceMeta> {
    const map = new Map<string, SpaceMeta>();
    if (existsSync(this.configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as RegistryFile;
        for (const [id, m] of Object.entries(parsed.spaces ?? {})) {
          if (isSpaceId(id)) map.set(id, m);
        }
      } catch {
        // corrupt registry: fall back to filesystem discovery below
      }
    }
    // Discover any space directories not yet in the registry (e.g. after a
    // registry loss) so knowledge is never orphaned.
    const wsDir = join(this.dataDir, "workspaces");
    if (existsSync(wsDir)) {
      const known = new Set([...map.values()].map((m) => spaceToDir(m.id)));
      for (const dir of readdirSync(wsDir)) {
        if (known.has(dir)) continue;
        // We cannot reverse a sanitized dir back to the exact id, so we only
        // adopt dirs we can't map if a marker file records the id.
        const marker = join(wsDir, dir, ".spaceid");
        if (existsSync(marker)) {
          const id = readFileSync(marker, "utf8").trim();
          if (isSpaceId(id) && !map.has(id)) {
            map.set(id, { id, createdAt: Date.now() });
          }
        }
      }
    }
    return map;
  }

  private persist(): void {
    mkdirSync(join(this.dataDir, "config"), { recursive: true });
    const obj: RegistryFile = { spaces: Object.fromEntries(this.meta) };
    writeFileSync(this.configPath, JSON.stringify(obj, null, 2), "utf8");
  }

  /** Get (creating on first use) the SpaceStore for a space. */
  store(space: SpaceId): SpaceStore {
    let s = this.stores.get(space);
    if (!s) {
      s = new SpaceStore(space, this.dataDir);
      this.stores.set(space, s);
    }
    return s;
  }

  /** True if the space has been registered/created. */
  has(space: SpaceId): boolean {
    return this.meta.has(space);
  }

  /** Ensure a space exists on disk and is registered. Idempotent. */
  ensure(space: SpaceId, opts: { chatId?: string } = {}): SpaceStore {
    const store = this.store(space);
    store.ensure();
    // Record the space id in a marker so the registry can self-heal.
    const marker = join(store.root, ".spaceid");
    if (!existsSync(marker)) writeFileSync(marker, space, "utf8");
    if (!this.meta.has(space)) {
      this.meta.set(space, { id: space, createdAt: Date.now(), chatId: opts.chatId });
      this.persist();
    } else if (opts.chatId && this.meta.get(space)!.chatId !== opts.chatId) {
      this.meta.get(space)!.chatId = opts.chatId;
      this.persist();
    }
    return store;
  }

  get(space: SpaceId): SpaceMeta | undefined {
    return this.meta.get(space);
  }

  list(): SpaceMeta[] {
    return [...this.meta.values()];
  }

  setLastDream(space: SpaceId, at: number): void {
    const m = this.meta.get(space);
    if (m) {
      m.lastDreamAt = at;
      this.persist();
    }
  }

  closeAll(): void {
    for (const s of this.stores.values()) s.close();
    this.stores.clear();
  }
}

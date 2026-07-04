/**
 * Dream-cycle scheduler (plan §VII, Q9). Robust to local sleep/shutdown by not
 * relying on a precise cron fire: it wakes on a coarse interval, and on each
 * wake (and once at startup — the "catch-up") it distills any space whose last
 * dream is older than the staleness threshold, or when the daily run hour has
 * passed and today's run hasn't happened yet.
 *
 * The decision of *whether* to run a space is a pure function (shouldRunSpace)
 * so the policy is unit-tested without timers.
 */
import { logger, type SpaceId } from "@homebrain/shared";
import type { KnowledgeEngine } from "@homebrain/core";

const log = logger.child("scheduler");

export interface ScheduleConfig {
  /** local hour (Asia/Shanghai) for the nightly run; default 3 */
  hour: number;
  /** re-run a space if its last dream is older than this many hours */
  stalenessHours: number;
  /** wake cadence in ms; default 15 min */
  tickMs: number;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  hour: 3,
  stalenessHours: 24,
  tickMs: 15 * 60 * 1000,
};

/** Local hour (0-23) in Asia/Shanghai for a given instant. */
export function localHour(at: Date): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hour12: false,
  }).format(at);
  const h = parseInt(s, 10);
  return h === 24 ? 0 : h; // some ICU builds emit "24" for midnight
}

export interface SpaceState {
  id: SpaceId;
  lastDreamAt?: number;
  /** whether the space has any pending (un-ingested) raw entries */
  hasPending: boolean;
}

/**
 * Decide whether to run a dream cycle for a space right now. Runs when:
 *   - there is pending raw AND
 *     - the space has never been distilled, OR
 *     - its last dream is older than stalenessHours (catch-up after downtime), OR
 *     - it's at/after the nightly hour and it hasn't been distilled today.
 * No pending raw => never run (nothing to do; saves cost).
 */
export function shouldRunSpace(
  state: SpaceState,
  now: Date,
  cfg: ScheduleConfig,
): boolean {
  if (!state.hasPending) return false;
  if (state.lastDreamAt === undefined) return true;

  const ageMs = now.getTime() - state.lastDreamAt;
  if (ageMs >= cfg.stalenessHours * 3600_000) return true;

  // Nightly window: after the configured hour and not yet run today.
  if (localHour(now) >= cfg.hour) {
    const lastDay = dayKey(new Date(state.lastDreamAt));
    const nowDay = dayKey(now);
    if (lastDay !== nowDay) return true;
  }
  return false;
}

function dayKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export class Scheduler {
  private engine: KnowledgeEngine;
  private cfg: ScheduleConfig;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(engine: KnowledgeEngine, cfg: Partial<ScheduleConfig> = {}) {
    this.engine = engine;
    this.cfg = { ...DEFAULT_SCHEDULE, ...cfg };
  }

  /** Start the loop and run an immediate catch-up pass. */
  async start(): Promise<void> {
    await this.tick("startup-catchup");
    this.timer = setInterval(() => void this.tick("interval"), this.cfg.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One scheduling pass over all known spaces. Exposed for tests. */
  async tick(reason: string, now = new Date()): Promise<SpaceId[]> {
    if (this.running) return [];
    this.running = true;
    const ran: SpaceId[] = [];
    try {
      for (const meta of this.engine.registry.list()) {
        const idx = this.engine.registry.store(meta.id).index();
        const state: SpaceState = {
          id: meta.id,
          lastDreamAt: meta.lastDreamAt,
          hasPending: idx.countRaw(true) > 0,
        };
        if (!shouldRunSpace(state, now, this.cfg)) continue;
        log.info("scheduling dream cycle", { space: meta.id, reason });
        try {
          await this.engine.runDreamCycle(meta.id);
          ran.push(meta.id);
        } catch (err) {
          log.error("scheduled dream failed", { space: meta.id, err: String(err) });
        }
      }
    } finally {
      this.running = false;
    }
    return ran;
  }
}

/**
 * Serializer runs async tasks one-at-a-time per key, in FIFO order.
 *
 * homebrain writes knowledge from concurrent sources (feishu events, the
 * scheduler's dream cycle, manual web triggers). Interleaving writes to the
 * same space would corrupt the markdown/SQLite pair. Every mutating path funnels
 * through here keyed by SpaceId, so reads stay lock-free while writes to one
 * space never overlap. Different keys run concurrently.
 */
export class Serializer {
  /** tail of the promise chain per key; absent key means idle */
  private chains = new Map<string, Promise<unknown>>();

  /**
   * Run `task` after all previously-enqueued tasks for `key` settle.
   * Rejections are isolated: one task throwing does not poison the chain.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    // Swallow the previous result/error so the chain never rejects for the next
    // task; the caller of each task still observes its own outcome via `result`.
    const result = prev.then(task, task);
    // Keep the chain alive but non-rejecting for scheduling purposes.
    const chained = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, chained);
    // Once this task is the last one, drop the key to avoid unbounded growth.
    void chained.finally(() => {
      if (this.chains.get(key) === chained) this.chains.delete(key);
    });
    return result;
  }

  /** True if any task is queued or running for `key`. */
  isBusy(key: string): boolean {
    return this.chains.has(key);
  }

  /** Resolve once all currently-enqueued tasks for `key` have settled. */
  async drain(key: string): Promise<void> {
    const chain = this.chains.get(key);
    if (chain) await chain;
  }
}

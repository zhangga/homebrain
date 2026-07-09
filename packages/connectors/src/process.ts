/**
 * Thin process abstraction so the feishu connector's daemon logic (ready-marker
 * gating, NDJSON line framing, restart-on-crash) can be unit-tested against a
 * fake process without spawning lark-cli (plan R4). The real implementation
 * wraps Bun.spawn.
 */

export interface ProcHandle {
  /** async iterator over stdout, chunk by chunk (Uint8Array) */
  stdout: AsyncIterable<Uint8Array>;
  /** async iterator over stderr, chunk by chunk (Uint8Array) */
  stderr: AsyncIterable<Uint8Array>;
  /** resolves with the exit code when the process ends */
  exited: Promise<number>;
  /** graceful stop (SIGTERM); never SIGKILL (plan R4) */
  kill(): void;
}

export interface ProcSpawner {
  spawn(cmd: string[]): ProcHandle;
}

/** Production spawner backed by Bun.spawn. */
export const bunSpawner: ProcSpawner = {
  spawn(cmd: string[]): ProcHandle {
    // stdin is a never-ending stream so `event consume` does not treat EOF as a
    // shutdown signal (plan §IV / lark-event contract for unbounded runs).
    const proc = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: proc.stdout as unknown as AsyncIterable<Uint8Array>,
      stderr: proc.stderr as unknown as AsyncIterable<Uint8Array>,
      exited: proc.exited,
      // Always graceful: Bun's kill() defaults to SIGTERM. We deliberately never
      // forward SIGKILL (plan R4: kill -9 leaks server-side subscriptions).
      kill: () => proc.kill(),
    };
  },
};

/** Split a byte stream into complete text lines (UTF-8), yielding as they arrive. */
export async function* lines(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      yield line;
    }
  }
  if (buffer.length > 0) yield buffer;
}

import { expect, test } from "bun:test";
import { bunSpawner } from "./process.ts";

test("bunSpawner keeps child stdin open for unbounded event consumers", async () => {
  const proc = bunSpawner.spawn([
    process.execPath,
    "-e",
    "for await (const _ of Bun.stdin.stream()) {}",
  ]);

  const state = await Promise.race([
    proc.exited.then(() => "exited" as const),
    Bun.sleep(300).then(() => "alive" as const),
  ]);

  try {
    expect(state).toBe("alive");
  } finally {
    proc.kill();
    await proc.exited;
  }
});

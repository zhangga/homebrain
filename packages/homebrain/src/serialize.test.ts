import { test, expect } from "bun:test";
import { Serializer } from "./serialize";

test("Serializer 串行执行，任意时刻最多一个在跑，且保持 FIFO", async () => {
  const s = new Serializer();
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];
  const make = (i: number) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    order.push(i);
    active--;
    return i;
  };
  const results = await Promise.all([s.run(make(1)), s.run(make(2)), s.run(make(3))]);
  expect(maxActive).toBe(1);
  expect(order).toEqual([1, 2, 3]);
  expect(results).toEqual([1, 2, 3]);
});

test("Serializer 单个任务抛错不阻断后续", async () => {
  const s = new Serializer();
  const p1 = s.run(async () => {
    throw new Error("boom");
  });
  const p2 = s.run(async () => "ok");
  await expect(p1).rejects.toThrow("boom");
  expect(await p2).toBe("ok");
});

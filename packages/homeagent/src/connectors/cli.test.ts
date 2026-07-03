import { test, expect } from "bun:test";
import { createCliConnector } from "./cli";
import type { IncomingMessage } from "./types";

async function* feed(...lines: string[]) {
  for (const l of lines) yield l;
}

test("CLI connector：@bot 前缀识别为提问并去掉前缀，空行跳过", async () => {
  const c = createCliConnector({ input: feed("老师电话 138", "@bot 老师电话是多少", "   ") });
  const got: IncomingMessage[] = [];
  for await (const m of c.receiveMessages()) got.push(m);

  expect(got.length).toBe(2);
  expect(got[0]!.mentionsBot).toBe(false);
  expect(got[0]!.text).toBe("老师电话 138");
  expect(got[1]!.mentionsBot).toBe(true);
  expect(got[1]!.text).toBe("老师电话是多少");
});

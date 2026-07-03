import { expect, test } from "bun:test";
import type { IncomingMessage } from "../connectors/types";
import {
  createMemberResolver,
  createMemberStore,
  slugifyMemberName,
} from "./store";

test("slugifyMemberName：把展示名转成稳定 folder slug", () => {
  expect(slugifyMemberName("Dad Zhang")).toBe("dad-zhang");
  expect(slugifyMemberName(" ou_123.ABC ")).toBe("ou-123-abc");
  expect(slugifyMemberName("!!!")).toBe("");
});

test("member store：同一平台用户稳定映射到同一个 slug，并更新展示名", () => {
  const store = createMemberStore({ dbPath: ":memory:" });
  try {
    expect(
      store.resolveMember({
        connector: "cli",
        externalId: "open-1",
        displayName: "Dad",
      }),
    ).toEqual({ slug: "dad" });

    expect(
      store.resolveMember({
        connector: "cli",
        externalId: "open-1",
        displayName: "Dad New",
      }),
    ).toEqual({ slug: "dad" });

    expect(store.getMember("cli", "open-1")).toEqual({
      connector: "cli",
      externalId: "open-1",
      displayName: "Dad New",
      slug: "dad",
    });
  } finally {
    store.close();
  }
});

test("member store：同名成员自动追加数字后缀避免 slug 冲突", () => {
  const store = createMemberStore({ dbPath: ":memory:" });
  try {
    expect(
      store.resolveMember({ connector: "feishu", externalId: "ou-a", displayName: "Dad" }),
    ).toEqual({ slug: "dad" });
    expect(
      store.resolveMember({ connector: "feishu", externalId: "ou-b", displayName: "Dad" }),
    ).toEqual({ slug: "dad-2" });
    expect(
      store.resolveMember({ connector: "feishu", externalId: "ou-b", displayName: "Dad" }),
    ).toEqual({ slug: "dad-2" });
  } finally {
    store.close();
  }
});

test("member store：可列出已知成员供后台画像归纳", () => {
  const store = createMemberStore({ dbPath: ":memory:" });
  try {
    store.resolveMember({ connector: "feishu", externalId: "ou-b", displayName: "Kid" });
    store.resolveMember({ connector: "cli", externalId: "local", displayName: "Dad" });

    expect(store.listMembers()).toEqual([
      { connector: "cli", externalId: "local", displayName: "Dad", slug: "dad" },
      { connector: "feishu", externalId: "ou-b", displayName: "Kid", slug: "kid" },
    ]);
  } finally {
    store.close();
  }
});

test("createMemberResolver：供 runtime 从 IncomingMessage 解析成员", () => {
  const store = createMemberStore({ dbPath: ":memory:" });
  try {
    const resolveMember = createMemberResolver(store, "cli");
    const msg: IncomingMessage = {
      channelId: "cli",
      senderId: "local-user",
      senderName: "Dad",
      mentionsBot: false,
      raw: {},
      ts: 1,
      text: "老师电话 138",
    };

    expect(resolveMember(msg)).toEqual({ slug: "dad" });
    expect(store.getMember("cli", "local-user")?.slug).toBe("dad");
  } finally {
    store.close();
  }
});

import { expect, test } from "bun:test";
import { createManagedProfileUpdater, mergeMemberProfileFacts } from "./profiles";

test("member profiles：保留手写内容并写入自动画像区块", () => {
  const markdown = mergeMemberProfileFacts({
    memberSlug: "dad",
    existing: "# Dad\n\n手写备注：周末通常陪孩子运动。\n",
    updatedAt: "2026-06-24T08:00:00.000Z",
    facts: [
      { text: "爸爸喜欢美式咖啡", tags: ["preference"], occurredAt: "2026-06-24" },
      { text: "爸爸在准备半马", tags: ["health"], occurredAt: "2026-06-20" },
    ],
  });

  expect(markdown).toContain("# Dad\n\n手写备注：周末通常陪孩子运动。");
  expect(markdown).toContain("<!-- homeagent-profile:start -->");
  expect(markdown).toContain("更新时间：2026-06-24T08:00:00.000Z");
  expect(markdown).toContain("### 偏好");
  expect(markdown).toContain("- 爸爸喜欢美式咖啡 (2026-06-24)");
  expect(markdown).toContain("### 健康与照护");
  expect(markdown).toContain("- 爸爸在准备半马 (2026-06-20)");
});

test("member profiles：更新自动画像区块时保留旧条目并去重", () => {
  const first = mergeMemberProfileFacts({
    memberSlug: "kid",
    existing: null,
    updatedAt: "2026-06-23T08:00:00.000Z",
    facts: [{ text: "孩子喜欢恐龙", tags: ["preference"], occurredAt: "2026-06-23" }],
  });

  const second = mergeMemberProfileFacts({
    memberSlug: "kid",
    existing: first,
    updatedAt: "2026-06-24T08:00:00.000Z",
    facts: [
      { text: "孩子喜欢恐龙", tags: ["preference"], occurredAt: "2026-06-23" },
      { text: "孩子今天读到第3章", tags: ["task"], occurredAt: "2026-06-24" },
    ],
  });

  expect(second.match(/孩子喜欢恐龙/g)).toHaveLength(1);
  expect(second).toContain("- 孩子今天读到第3章 (2026-06-24)");
  expect(second).toContain("更新时间：2026-06-24T08:00:00.000Z");
});

test("member profiles：无标签事实按文本关键词归入画像分区", () => {
  const markdown = mergeMemberProfileFacts({
    memberSlug: "kid",
    existing: null,
    updatedAt: "2026-06-24T08:00:00.000Z",
    facts: [
      { text: "孩子喜欢恐龙" },
      { text: "孩子在三年级" },
      { text: "孩子对花生过敏" },
      { text: "孩子生日是5月1日" },
      { text: "孩子今天读到第4章" },
    ],
  });

  expect(markdown).toContain("### 偏好\n- 孩子喜欢恐龙");
  expect(markdown).toContain("### 学习与学校\n- 孩子在三年级");
  expect(markdown).toContain("### 健康与照护\n- 孩子对花生过敏");
  expect(markdown).toContain("### 身份与关系\n- 孩子生日是5月1日");
  expect(markdown).toContain("### 任务与进展\n- 孩子今天读到第4章");
});

test("member profiles：updater 从 homebrain 读写 USER.md", async () => {
  const calls: Array<unknown> = [];
  const updater = createManagedProfileUpdater({
    now: () => "2026-06-24T08:00:00.000Z",
    brain: {
      async getProfile(input) {
        calls.push({ kind: "get", ...input });
        return "# dad\n";
      },
      async upsertProfile(input) {
        calls.push({ kind: "upsert", ...input });
      },
    },
  });

  const result = await updater.updateFromFacts({
    member: { slug: "dad" },
    facts: [{ text: "爸爸喜欢美式咖啡", tags: ["preference"], occurredAt: "2026-06-24" }],
  });

  expect(result.updated).toBe(true);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual({ kind: "get", member: { slug: "dad" } });
  expect(calls[1]).toMatchObject({ kind: "upsert", member: { slug: "dad" } });
});

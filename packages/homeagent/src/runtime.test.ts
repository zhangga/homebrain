import { expect, spyOn, test } from "bun:test";
import { runRuntime } from "./runtime";
import type { Connector, IncomingMessage, OutgoingMessage } from "./connectors/types";
import type { TaskStore } from "./tasks/store";

class FakeConnector implements Connector {
  readonly name = "fake";
  readonly sent: OutgoingMessage[] = [];

  constructor(private readonly messages: IncomingMessage[]) {}

  async *receiveMessages(): AsyncIterable<IncomingMessage> {
    for (const msg of this.messages) yield msg;
  }

  async sendMessage(msg: OutgoingMessage): Promise<void> {
    this.sent.push(msg);
  }
}

class FakeBrain {
  readonly rememberCalls: Array<{
    member: { slug: string };
    text: string;
    tags?: string[];
    occurredAt?: string;
  }> = [];
  readonly askCalls: Array<{ question: string }> = [];
  readonly healthCalls: Array<Record<string, never>> = [];

  async remember(input: {
    member: { slug: string };
    text: string;
    tags?: string[];
    occurredAt?: string;
  }): Promise<{ slug: string }> {
    this.rememberCalls.push(input);
    return { slug: input.member.slug };
  }

  async ask(input: { question: string }): Promise<{ answer: string; citations: [] }> {
    this.askCalls.push(input);
    return { answer: "138", citations: [] };
  }

  async health(): Promise<{ ok: boolean; version?: string }> {
    this.healthCalls.push({});
    return { ok: true, version: "gbrain 0.42.52.0" };
  }
}

function message(overrides: Partial<IncomingMessage>): IncomingMessage {
  return {
    channelId: "cli",
    senderId: "local",
    mentionsBot: false,
    raw: {},
    ts: 1,
    ...overrides,
  };
}

test("runtime：普通消息写入 homebrain，@bot 消息发送问答结果", async () => {
  const connector = new FakeConnector([
    message({ text: "老师电话 138" }),
    message({ mentionsBot: true, text: "老师电话是多少" }),
  ]);
  const brain = new FakeBrain();

  await runRuntime({ connector, brain });

  expect(brain.rememberCalls).toEqual([
    { member: { slug: "local" }, text: "老师电话 138" },
  ]);
  expect(brain.askCalls).toEqual([{ question: "老师电话是多少" }]);
  expect(connector.sent).toEqual([{ channelId: "cli", text: "138" }]);
});

test("runtime：@bot health 调用 homebrain 健康检查", async () => {
  const connector = new FakeConnector([message({ mentionsBot: true, text: "health" })]);
  const brain = new FakeBrain();

  await runRuntime({ connector, brain });

  expect(brain.healthCalls).toEqual([{}]);
  expect(brain.askCalls).toEqual([]);
  expect(connector.sent).toEqual([{ channelId: "cli", text: "健康检查通过：gbrain 0.42.52.0" }]);
});

test("runtime：@bot 附件消息进入问答路径", async () => {
  const connector = new FakeConnector([
    message({
      mentionsBot: true,
      attachments: [{ kind: "image", key: "img_v3_question" }],
    }),
  ]);
  const brain = new FakeBrain();

  await runRuntime({ connector, brain });

  expect(brain.askCalls).toEqual([{ question: "收到图片附件：img_v3_question" }]);
  expect(brain.rememberCalls).toEqual([]);
  expect(connector.sent).toEqual([{ channelId: "cli", text: "138" }]);
});

test("runtime：@bot 文本带附件时问题正文保留附件引用", async () => {
  const connector = new FakeConnector([
    message({
      mentionsBot: true,
      text: "这张图里有什么？",
      attachments: [{ kind: "image", key: "img_v3_question" }],
    }),
  ]);
  const brain = new FakeBrain();

  await runRuntime({ connector, brain });

  expect(brain.askCalls).toEqual([
    { question: "这张图里有什么？\n收到图片附件：img_v3_question" },
  ]);
  expect(brain.rememberCalls).toEqual([]);
  expect(connector.sent).toEqual([{ channelId: "cli", text: "138" }]);
});

test("runtime：单条消息处理失败时记录错误并继续处理后续消息", async () => {
  const connector = new FakeConnector([
    message({ text: "老师电话 138" }),
    message({ mentionsBot: true, text: "老师电话是多少" }),
  ]);
  const errors: Array<{ text: string; error: string }> = [];
  const brain = {
    async remember(): Promise<{ slug: string }> {
      throw new Error("capture failed");
    },
    async ask(input: { question: string }): Promise<{ answer: string; citations: [] }> {
      return { answer: `answer: ${input.question}`, citations: [] };
    },
  };

  await runRuntime({
    connector,
    brain,
    onError({ error, msg }) {
      errors.push({
        text: msg.text ?? "",
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  expect(errors).toEqual([{ text: "老师电话 138", error: "capture failed" }]);
  expect(connector.sent).toEqual([{ channelId: "cli", text: "answer: 老师电话是多少" }]);
});

test("runtime：没有错误回调时使用默认日志记录并继续处理后续消息", async () => {
  const connector = new FakeConnector([
    message({ text: "老师电话 138" }),
    message({ mentionsBot: true, text: "老师电话是多少" }),
  ]);
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  const brain = {
    async remember(): Promise<{ slug: string }> {
      throw new Error("capture failed");
    },
    async ask(input: { question: string }): Promise<{ answer: string; citations: [] }> {
      return { answer: `answer: ${input.question}`, citations: [] };
    },
  };

  try {
    await runRuntime({ connector, brain });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe("runtime message error");
    expect(errorSpy.mock.calls[0]?.[1]).toEqual({
      channelId: "cli",
      senderId: "local",
      text: "老师电话 138",
    });
    expect(errorSpy.mock.calls[0]?.[2]).toBeInstanceOf(Error);
    expect(connector.sent).toEqual([{ channelId: "cli", text: "answer: 老师电话是多少" }]);
  } finally {
    errorSpy.mockRestore();
  }
});

test("runtime：忽略空消息", async () => {
  const connector = new FakeConnector([message({ text: "   " })]);
  const brain = new FakeBrain();

  await runRuntime({ connector, brain });

  expect(brain.rememberCalls).toEqual([]);
  expect(brain.askCalls).toEqual([]);
  expect(connector.sent).toEqual([]);
});

test("runtime：附件消息不会被空消息路径丢弃", async () => {
  const connector = new FakeConnector([
    message({
      attachments: [{ kind: "image", key: "img_v3_abc" }],
    }),
  ]);
  const brain = new FakeBrain();

  await runRuntime({ connector, brain });

  expect(brain.rememberCalls).toEqual([
    {
      member: { slug: "local" },
      text: "收到图片附件：img_v3_abc",
      tags: ["attachment", "image"],
    },
  ]);
});

test("runtime：附件文本抽取结果进入记忆正文", async () => {
  const connector = new FakeConnector([
    message({
      attachments: [{ kind: "image", key: "img_v3_notice", localPath: ".homeagent/attachments/om_1/img_v3_notice" }],
    }),
  ]);
  const brain = new FakeBrain();

  await runRuntime({
    connector,
    brain,
    attachmentTextExtractor: {
      async extractText({ attachment }) {
        expect(attachment.localPath).toBe(".homeagent/attachments/om_1/img_v3_notice");
        return "明天带水彩笔";
      },
    },
  });

  expect(brain.rememberCalls).toEqual([
    {
      member: { slug: "local" },
      text: "收到图片附件：img_v3_notice (local: .homeagent/attachments/om_1/img_v3_notice)\n附件内容：明天带水彩笔",
      tags: ["attachment", "image"],
    },
  ]);
});

test("runtime：普通文本带附件时写入的记忆保留附件引用", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天的作业拍给你",
      attachments: [{ kind: "image", key: "img_v3_homework" }],
    }),
  ]);
  const brain = new FakeBrain();

  await runRuntime({ connector, brain });

  expect(brain.rememberCalls).toEqual([
    {
      member: { slug: "local" },
      text: "今天的作业拍给你\n收到图片附件：img_v3_homework",
      tags: ["attachment", "image"],
    },
  ]);
});

test("runtime：普通消息先经 extractor 抽取，再逐条写入 homebrain", async () => {
  const connector = new FakeConnector([message({ text: "老师电话 138" })]);
  const brain = new FakeBrain();
  const extractCalls: Array<{ text: string }> = [];

  await runRuntime({
    connector,
    brain,
    extractor: {
      async extract({ text }) {
        extractCalls.push({ text });
        return [
          { text: "老师电话是 138", tags: ["school"], occurredAt: "2026-06-24" },
          { text: "需要更新通讯录" },
        ];
      },
    },
  });

  expect(extractCalls).toEqual([{ text: "老师电话 138" }]);
  expect(brain.rememberCalls).toEqual([
    {
      member: { slug: "local" },
      text: "老师电话是 138",
      tags: ["school"],
      occurredAt: "2026-06-24",
    },
    { member: { slug: "local" }, text: "需要更新通讯录" },
  ]);
});

test("runtime：普通消息抽取后触发成员画像更新", async () => {
  const connector = new FakeConnector([
    message({ text: "爸爸喜欢美式咖啡", ts: Date.parse("2026-06-24T08:00:00.000Z") }),
  ]);
  const brain = new FakeBrain();
  const profileCalls: Array<unknown> = [];

  await runRuntime({
    connector,
    brain,
    extractor: {
      async extract() {
        return [
          { text: "爸爸喜欢美式咖啡", tags: ["preference"], occurredAt: "2026-06-24" },
        ];
      },
    },
    profileUpdater: {
      async updateFromFacts(input) {
        profileCalls.push(input);
        return { updated: true };
      },
    },
  });

  expect(profileCalls).toEqual([
    {
      member: { slug: "local" },
      facts: [{ text: "爸爸喜欢美式咖啡", tags: ["preference"], occurredAt: "2026-06-24" }],
      updatedAt: "2026-06-24T08:00:00.000Z",
    },
  ]);
});

test("runtime：使用成员 resolver 决定写入成员 slug", async () => {
  const connector = new FakeConnector([message({ senderId: "open-1", senderName: "Dad", text: "老师电话 138" })]);
  const brain = new FakeBrain();

  await runRuntime({
    connector,
    brain,
    resolveMember(msg) {
      expect(msg.senderName).toBe("Dad");
      return { slug: "dad" };
    },
  });

  expect(brain.rememberCalls).toEqual([
    { member: { slug: "dad" }, text: "老师电话 138" },
  ]);
});

test("runtime：任务目标先记录成任务事实并给回执", async () => {
  const connector = new FakeConnector([message({ text: "我想30天读完《小王子》" })]);
  const brain = new FakeBrain();

  await runRuntime({ connector, brain });

  expect(brain.rememberCalls).toEqual([
    {
      member: { slug: "local" },
      text: "学习目标：我想30天读完《小王子》",
      tags: ["task", "goal"],
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：小王子。后续会拆解成每日份额。" },
  ]);
});

test("runtime：任务反馈先记录成任务事实并给回执", async () => {
  const connector = new FakeConnector([message({ text: "今天的阅读太难了" })]);
  const brain = new FakeBrain();

  await runRuntime({ connector, brain });

  expect(brain.rememberCalls).toEqual([
    {
      member: { slug: "local" },
      text: "任务反馈（too_hard）：今天的阅读太难了",
      tags: ["task", "feedback"],
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已记录反馈：太难了。后续会据此调整份额。" },
  ]);
});

test("runtime：任务目标和反馈写入 taskStore", async () => {
  const connector = new FakeConnector([
    message({ text: "我想30天读完《小王子》" }),
    message({ text: "今天的阅读太难了" }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T09:00:00.000Z",
      };
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      title: "小王子",
      sourceText: "我想30天读完《小王子》",
      horizonDays: 30,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "too_hard",
      note: "今天的阅读太难了",
    },
  ]);
});

test("runtime：明确天数和总量的任务目标会生成每日份额", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想3天读完10章《小王子》",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      title: "小王子",
      sourceText: "我想3天读完10章《小王子》",
      horizonDays: 3,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 10,
      days: 3,
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：小王子。已生成 3 天每日份额。" },
  ]);
});

test("runtime：任务目标里的开始日期会传给每日份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想明天开始3天读完6章《小王子》",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      title: "小王子",
      sourceText: "我想明天开始3天读完6章《小王子》",
      horizonDays: 3,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-25",
      totalUnits: 6,
      days: 3,
    },
  ]);
});

test("runtime：开始日期和截止日期组合会从开始日算计划天数", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想明天开始，6月30日前读完10章《小王子》",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      title: "小王子",
      sourceText: "我想明天开始，6月30日前读完10章《小王子》",
      horizonDays: 6,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-25",
      totalUnits: 10,
      days: 6,
    },
  ]);
});

test("runtime：中文数字的明确任务目标会生成每日份额", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想三天读完十章《小王子》",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("明确中文数字目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      title: "小王子",
      sourceText: "我想三天读完十章《小王子》",
      horizonDays: 3,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 10,
      days: 3,
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：小王子。已生成 3 天每日份额。" },
  ]);
});

test("runtime：截止日期任务目标会换算成每日份额天数", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想6月30日前读完10章《小王子》",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      title: "小王子",
      sourceText: "我想6月30日前读完10章《小王子》",
      horizonDays: 7,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 10,
      days: 7,
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：小王子。已生成 7 天每日份额。" },
  ]);
});

test("runtime：周数任务目标会换算成每日份额天数", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想一周内读完10章《小王子》",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("明确周数目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      title: "小王子",
      sourceText: "我想一周内读完10章《小王子》",
      horizonDays: 7,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 10,
      days: 7,
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：小王子。已生成 7 天每日份额。" },
  ]);
});

test("runtime：明确任务目标里的每日份额计划会直接透传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想3天读完6章《小王子》，第1天读1章，第2天读2到4章，第3天读5到6章",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("明确每日份额目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      title: "小王子",
      sourceText: "我想3天读完6章《小王子》，第1天读1章，第2天读2到4章，第3天读5到6章",
      horizonDays: 3,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 6,
      days: 3,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 1 },
        { day: 2, unitFrom: 2, unitTo: 4 },
        { day: 3, unitFrom: 5, unitTo: 6 },
      ],
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：小王子。已生成 3 天每日份额。" },
  ]);
});

test("runtime：阶段式每日份额计划会直接透传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想5天做完60题口算，前3天每天做10题，后2天每天做15题",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("阶段式每日份额目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想5天做完60题口算，前3天每天做10题，后2天每天做15题",
      horizonDays: 5,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 60,
      days: 5,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 10 },
        { day: 2, unitFrom: 11, unitTo: 20 },
        { day: 3, unitFrom: 21, unitTo: 30 },
        { day: 4, unitFrom: 31, unitTo: 45 },
        { day: 5, unitFrom: 46, unitTo: 60 },
      ],
    },
  ]);
  expect(connector.sent).toEqual([
    {
      channelId: "cli",
      text: "已收到学习目标：我想5天做完60题口算，前3天每天做10题，后2天每天做15题。已生成 5 天每日份额。",
    },
  ]);
});

test("runtime：剩余阶段式每日份额计划会直接透传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想5天做完65题口算，前2天每天做10题，剩下每天做15题",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("剩余阶段式每日份额目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想5天做完65题口算，前2天每天做10题，剩下每天做15题",
      horizonDays: 5,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 65,
      days: 5,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 10 },
        { day: 2, unitFrom: 11, unitTo: 20 },
        { day: 3, unitFrom: 21, unitTo: 35 },
        { day: 4, unitFrom: 36, unitTo: 50 },
        { day: 5, unitFrom: 51, unitTo: 65 },
      ],
    },
  ]);
  expect(connector.sent).toEqual([
    {
      channelId: "cli",
      text: "已收到学习目标：我想5天做完65题口算，前2天每天做10题，剩下每天做15题。已生成 5 天每日份额。",
    },
  ]);
});

test("runtime：最后阶段式每日份额计划会直接透传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想5天做完65题口算，前两天每天做10题，最后三天每天做15题",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("最后阶段式每日份额目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想5天做完65题口算，前两天每天做10题，最后三天每天做15题",
      horizonDays: 5,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 65,
      days: 5,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 10 },
        { day: 2, unitFrom: 11, unitTo: 20 },
        { day: 3, unitFrom: 21, unitTo: 35 },
        { day: 4, unitFrom: 36, unitTo: 50 },
        { day: 5, unitFrom: 51, unitTo: 65 },
      ],
    },
  ]);
  expect(connector.sent).toEqual([
    {
      channelId: "cli",
      text: "已收到学习目标：我想5天做完65题口算，前两天每天做10题，最后三天每天做15题。已生成 5 天每日份额。",
    },
  ]);
});

test("runtime：开始到最后阶段式每日份额计划会直接透传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想5天做完65题口算，开始两天每天10题，最后三天每天15题",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("开始到最后阶段式每日份额目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想5天做完65题口算，开始两天每天10题，最后三天每天15题",
      horizonDays: 5,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 65,
      days: 5,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 10 },
        { day: 2, unitFrom: 11, unitTo: 20 },
        { day: 3, unitFrom: 21, unitTo: 35 },
        { day: 4, unitFrom: 36, unitTo: 50 },
        { day: 5, unitFrom: 51, unitTo: 65 },
      ],
    },
  ]);
  expect(connector.sent).toEqual([
    {
      channelId: "cli",
      text: "已收到学习目标：我想5天做完65题口算，开始两天每天10题，最后三天每天15题。已生成 5 天每日份额。",
    },
  ]);
});

test("runtime：三段口语阶段式每日份额计划会直接透传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想6天做完90题口算，前两天每天10题，中间两天每天15题，最后两天每天20题",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("三段口语阶段式每日份额目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想6天做完90题口算，前两天每天10题，中间两天每天15题，最后两天每天20题",
      horizonDays: 6,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 90,
      days: 6,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 10 },
        { day: 2, unitFrom: 11, unitTo: 20 },
        { day: 3, unitFrom: 21, unitTo: 35 },
        { day: 4, unitFrom: 36, unitTo: 50 },
        { day: 5, unitFrom: 51, unitTo: 70 },
        { day: 6, unitFrom: 71, unitTo: 90 },
      ],
    },
  ]);
  expect(connector.sent).toEqual([
    {
      channelId: "cli",
      text: "已收到学习目标：我想6天做完90题口算，前两天每天10题，中间两天每天15题，最后两天每天20题。已生成 6 天每日份额。",
    },
  ]);
});

test("runtime：口语剩余阶段式每日份额计划会直接透传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想5天做完65题口算，头两天每天做10题，接下来每天做15题",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("口语剩余阶段式每日份额目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想5天做完65题口算，头两天每天做10题，接下来每天做15题",
      horizonDays: 5,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 65,
      days: 5,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 10 },
        { day: 2, unitFrom: 11, unitTo: 20 },
        { day: 3, unitFrom: 21, unitTo: 35 },
        { day: 4, unitFrom: 36, unitTo: 50 },
        { day: 5, unitFrom: 51, unitTo: 65 },
      ],
    },
  ]);
  expect(connector.sent).toEqual([
    {
      channelId: "cli",
      text: "已收到学习目标：我想5天做完65题口算，头两天每天做10题，接下来每天做15题。已生成 5 天每日份额。",
    },
  ]);
});

test("runtime：先后阶段式每日份额计划会直接透传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想5天做完65题口算，先2天每天做10题，之后每天做15题",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("先后阶段式每日份额目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想5天做完65题口算，先2天每天做10题，之后每天做15题",
      horizonDays: 5,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 65,
      days: 5,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 10 },
        { day: 2, unitFrom: 11, unitTo: 20 },
        { day: 3, unitFrom: 21, unitTo: 35 },
        { day: 4, unitFrom: 36, unitTo: 50 },
        { day: 5, unitFrom: 51, unitTo: 65 },
      ],
    },
  ]);
  expect(connector.sent).toEqual([
    {
      channelId: "cli",
      text: "已收到学习目标：我想5天做完65题口算，先2天每天做10题，之后每天做15题。已生成 5 天每日份额。",
    },
  ]);
});

test("runtime：口语先后阶段式每日份额计划会直接透传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想5天做完65题口算，先每天做10题做2天，然后每天做15题做3天",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("口语先后阶段式每日份额目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想5天做完65题口算，先每天做10题做2天，然后每天做15题做3天",
      horizonDays: 5,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 65,
      days: 5,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 10 },
        { day: 2, unitFrom: 11, unitTo: 20 },
        { day: 3, unitFrom: 21, unitTo: 35 },
        { day: 4, unitFrom: 36, unitTo: 50 },
        { day: 5, unitFrom: 51, unitTo: 65 },
      ],
    },
  ]);
  expect(connector.sent).toEqual([
    {
      channelId: "cli",
      text: "已收到学习目标：我想5天做完65题口算，先每天做10题做2天，然后每天做15题做3天。已生成 5 天每日份额。",
    },
  ]);
});

test("runtime：多段范围式每日份额计划会直接透传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想6天做完90题口算，第1到2天每天做10题，第3到4天每天做15题，第5到6天每天做20题",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("多段范围式每日份额目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText:
        "我想6天做完90题口算，第1到2天每天做10题，第3到4天每天做15题，第5到6天每天做20题",
      horizonDays: 6,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 90,
      days: 6,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 10 },
        { day: 2, unitFrom: 11, unitTo: 20 },
        { day: 3, unitFrom: 21, unitTo: 35 },
        { day: 4, unitFrom: 36, unitTo: 50 },
        { day: 5, unitFrom: 51, unitTo: 70 },
        { day: 6, unitFrom: 71, unitTo: 90 },
      ],
    },
  ]);
  expect(connector.sent).toEqual([
    {
      channelId: "cli",
      text: "已收到学习目标：我想6天做完90题口算，第1到2天每天做10题，第3到4天每天做15题，第5到6天每天做20题。已生成 6 天每日份额。",
    },
  ]);
});

test("runtime：逐日列举式每日份额计划会直接透传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想5天做完75题口算，每天分别做10题、15题、15题、20题、15题",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("逐日列举式每日份额目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想5天做完75题口算，每天分别做10题、15题、15题、20题、15题",
      horizonDays: 5,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 75,
      days: 5,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 10 },
        { day: 2, unitFrom: 11, unitTo: 25 },
        { day: 3, unitFrom: 26, unitTo: 40 },
        { day: 4, unitFrom: 41, unitTo: 60 },
        { day: 5, unitFrom: 61, unitTo: 75 },
      ],
    },
  ]);
  expect(connector.sent).toEqual([
    {
      channelId: "cli",
      text: "已收到学习目标：我想5天做完75题口算，每天分别做10题、15题、15题、20题、15题。已生成 5 天每日份额。",
    },
  ]);
});

test("runtime：做题类明确任务目标会生成每日份额且不调用 planner", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想3天做完30题口算",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("明确做题目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想3天做完30题口算",
      horizonDays: 3,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 30,
      days: 3,
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：我想3天做完30题口算。已生成 3 天每日份额。" },
  ]);
});

test("runtime：明确任务目标里的休息日会传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想3天读完10章《小王子》，周末休息",
      ts: Date.parse("2026-06-26T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-26T08:00:00.000Z",
        updatedAt: "2026-06-26T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      title: "小王子",
      sourceText: "我想3天读完10章《小王子》，周末休息",
      horizonDays: 3,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-26",
      totalUnits: 10,
      days: 3,
      restWeekdays: [0, 6],
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：小王子。已生成 3 天每日份额。" },
  ]);
});

test("runtime：固定每日量任务目标会换算总量并生成每日份额", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想每天做10题口算，坚持5天",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal() {
        throw new Error("固定每日量明确目标不应调用 planner");
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想每天做10题口算，坚持5天",
      horizonDays: 5,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 50,
      days: 5,
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：我想每天做10题口算，坚持5天。已生成 5 天每日份额。" },
  ]);
});

test("runtime：明确任务目标里的固定学习日会转成休息日传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想6天做完60题口算，只在周一三五做",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想6天做完60题口算，只在周一三五做",
      horizonDays: 6,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 60,
      days: 6,
      restWeekdays: [0, 2, 4, 6],
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：我想6天做完60题口算，只在周一三五做。已生成 6 天每日份额。" },
  ]);
});

test("runtime：口语固定学习日会转成休息日传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想6天做完60题口算，周一三五做",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想6天做完60题口算，周一三五做",
      horizonDays: 6,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 60,
      days: 6,
      restWeekdays: [0, 2, 4, 6],
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：我想6天做完60题口算，周一三五做。已生成 6 天每日份额。" },
  ]);
});

test("runtime：工作日学习目标会转成周末休息传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "计划5天背完100个单词，只在工作日背",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "计划5天背完100个单词，只在工作日背",
      horizonDays: 5,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 100,
      days: 5,
      restWeekdays: [0, 6],
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：计划5天背完100个单词，只在工作日背。已生成 5 天每日份额。" },
  ]);
});

test("runtime：隔天学习目标会把日期间隔传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想4天做完40题口算，隔天做",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想4天做完40题口算，隔天做",
      horizonDays: 4,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 40,
      days: 4,
      dateSpacingDays: 2,
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：我想4天做完40题口算，隔天做。已生成 4 天每日份额。" },
  ]);
});

test("runtime：每 N 天一次学习目标会把日期间隔传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "计划三天背完三十个单词，每三天背一次",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "计划三天背完三十个单词，每三天背一次",
      horizonDays: 3,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 30,
      days: 3,
      dateSpacingDays: 3,
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：计划三天背完三十个单词，每三天背一次。已生成 3 天每日份额。" },
  ]);
});

test("runtime：连续学习再休息的周期目标会传给份额计划", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想5天做完50题口算，做两天休一天",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "goal",
      memberSlug: "local",
      sourceText: "我想5天做完50题口算，做两天休一天",
      horizonDays: 5,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 50,
      days: 5,
      activeRestCycle: { activeDays: 2, restDays: 1 },
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：我想5天做完50题口算，做两天休一天。已生成 5 天每日份额。" },
  ]);
});

test("runtime：复杂任务目标会调用 planner 并生成每日份额", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想学完自然拼读",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal(input) {
        calls.push({ kind: "planner", ...input });
        return { title: "自然拼读", horizonDays: 7, totalUnits: 14 };
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "planner",
      text: "我想学完自然拼读",
      member: { slug: "local" },
      startDate: "2026-06-24",
    },
    {
      kind: "goal",
      memberSlug: "local",
      title: "自然拼读",
      sourceText: "我想学完自然拼读",
      horizonDays: 7,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 14,
      days: 7,
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：自然拼读。已生成 7 天每日份额。" },
  ]);
});

test("runtime：复杂任务目标会优先使用 planner 的非均摊份额", async () => {
  const connector = new FakeConnector([
    message({
      text: "我想一周内学完自然拼读，周三休息",
      ts: Date.parse("2026-06-24T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "planDailyPortions"> = {
    createGoal(input) {
      calls.push({ kind: "goal", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: input.title,
        sourceText: input.sourceText,
        horizonDays: input.horizonDays,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      };
    },
    recordFeedback() {
      throw new Error("不应记录反馈");
    },
    planDailyPortions(input) {
      calls.push({ kind: "plan", ...input });
      return [];
    },
  };

  await runRuntime({
    connector,
    brain,
    taskStore,
    taskPlanner: {
      async planGoal(input) {
        calls.push({ kind: "planner", ...input });
        return {
          title: "自然拼读",
          horizonDays: 4,
          totalUnits: 8,
          dailyPortions: [
            { day: 1, unitFrom: 1, unitTo: 1 },
            { day: 2, unitFrom: 2, unitTo: 4 },
            { day: 4, unitFrom: 5, unitTo: 8 },
          ],
        };
      },
    },
  });

  expect(calls).toEqual([
    {
      kind: "planner",
      text: "我想一周内学完自然拼读，周三休息",
      member: { slug: "local" },
      startDate: "2026-06-24",
    },
    {
      kind: "goal",
      memberSlug: "local",
      title: "自然拼读",
      sourceText: "我想一周内学完自然拼读，周三休息",
      horizonDays: 7,
    },
    {
      kind: "plan",
      goalId: "goal-1",
      startDate: "2026-06-24",
      totalUnits: 8,
      days: 7,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 1 },
        { day: 2, unitFrom: 2, unitTo: 4 },
        { day: 4, unitFrom: 5, unitTo: 8 },
      ],
      restWeekdays: [3],
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已收到学习目标：自然拼读。已生成 3 天每日份额。" },
  ]);
});

test("runtime：任务反馈会尝试记录当天份额反馈用于重排", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天的阅读太难了",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "too_hard",
      note: "今天的阅读太难了",
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "too_hard",
      note: "今天的阅读太难了",
    },
  ]);
});

test("runtime：任务反馈会把已完成单元传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天只读到第3章",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天只读到第3章",
      completedUnit: 3,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "partial",
      note: "今天只读到第3章",
    },
  ]);
});

test("runtime：刷题完成反馈会把已完成单元传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天刷完20题",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "done",
      note: "今天刷完20题",
      completedUnit: 20,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "done",
      note: "今天刷完20题",
    },
  ]);
});

test("runtime：口语完成反馈会按完成传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "《小王子》打卡了",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "done",
      note: "《小王子》打卡了",
      targetTitle: "小王子",
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "done",
      note: "《小王子》打卡了",
    },
  ]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已记录反馈：完成了。后续会据此调整份额。" },
  ]);
});

test("runtime：比例型部分完成反馈会把完成比例传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天做了一半",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天做了一半",
      completedRatio: 0.5,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "partial",
      note: "今天做了一半",
    },
  ]);
});

test("runtime：模糊比例反馈会按部分完成传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天一半多一点",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天一半多一点",
      completedRatio: 0.6,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "partial",
      note: "今天一半多一点",
    },
  ]);
});

test("runtime：定性比例反馈会按部分完成传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天完成了大半",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天完成了大半",
      completedRatio: 0.75,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "partial",
      note: "今天完成了大半",
    },
  ]);
});

test("runtime：近完成语义反馈会按部分完成传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天差不多做完了",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天差不多做完了",
      completedRatio: 0.9,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      goalId: undefined,
      feedback: "partial",
      note: "今天差不多做完了",
    },
  ]);
});

test("runtime：少量完成语义反馈会按部分完成传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天只做了一点点",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天只做了一点点",
      completedRatio: 0.1,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      goalId: undefined,
      feedback: "partial",
      note: "今天只做了一点点",
    },
  ]);
});

test("runtime：成数型部分完成反馈会把完成比例传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天做了七成",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天做了七成",
      completedRatio: 0.7,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "partial",
      note: "今天做了七成",
    },
  ]);
});

test("runtime：任务反馈会把点名目标传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "《小王子》今天读完了",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "done",
      note: "《小王子》今天读完了",
      targetTitle: "小王子",
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "done",
      note: "《小王子》今天读完了",
    },
  ]);
});

test("runtime：数量型部分完成反馈会把完成数量传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天只背了20个词",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天只背了20个词",
      completedUnit: 20,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "partial",
      note: "今天只背了20个词",
    },
  ]);
});

test("runtime：无只字动作数量型反馈会把完成数量传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天做了20题",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天做了20题",
      completedUnit: 20,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "partial",
      note: "今天做了20题",
    },
  ]);
});

test("runtime：无只字数量型完成反馈会把完成数量传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天完成了20题",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天完成了20题",
      completedUnit: 20,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "partial",
      note: "今天完成了20题",
    },
  ]);
});

test("runtime：中文数字数量型反馈会把完成数量传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天只背了二十个词",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天只背了二十个词",
      completedUnit: 20,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "partial",
      note: "今天只背了二十个词",
    },
  ]);
});

test("runtime：能力上限表达会把完成数量传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天只来得及10题",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天只来得及10题",
      completedUnit: 10,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "partial",
      note: "今天只来得及10题",
    },
  ]);
});

test("runtime：超额完成反馈会把额外数量传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天多背了10个词",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "done",
      note: "今天多背了10个词",
      extraUnits: 10,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "done",
      note: "今天多背了10个词",
    },
  ]);
});

test("runtime：缺口型部分完成反馈会把剩余数量传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天还差3题",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天还差3题",
      remainingUnits: 3,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "partial",
      note: "今天还差3题",
    },
  ]);
});

test("runtime：顺延反馈会把顺延天数传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "这两天太忙，顺延2天",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "skip",
      note: "这两天太忙，顺延2天",
      deferDays: 2,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "这两天太忙，顺延2天",
    },
  ]);
});

test("runtime：来不及反馈会按跳过传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天来不及做了",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "skip",
      note: "今天来不及做了",
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "今天来不及做了",
    },
  ]);
});

test("runtime：未来日期请假反馈会写到对应份额日期", async () => {
  const connector = new FakeConnector([
    message({
      text: "明天请假",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-25",
      feedback: "skip",
      note: "明天请假",
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "明天请假",
    },
  ]);
});

test("runtime：未来日期不做反馈会写到对应份额日期", async () => {
  const connector = new FakeConnector([
    message({
      text: "明天不做了",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-25",
      feedback: "skip",
      note: "明天不做了",
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "明天不做了",
    },
  ]);
});

test("runtime：未来日期没法做反馈会写到对应份额日期", async () => {
  const connector = new FakeConnector([
    message({
      text: "明天没法做了",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-25",
      feedback: "skip",
      note: "明天没法做了",
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "明天没法做了",
    },
  ]);
});

test("runtime：状态不好反馈会按跳过传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今晚状态不好",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "skip",
      note: "今晚状态不好",
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "今晚状态不好",
    },
  ]);
});

test("runtime：临时有事反馈会按跳过传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天临时有事",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "skip",
      note: "今天临时有事",
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "今天临时有事",
    },
  ]);
});

test("runtime：明天补反馈会把顺延一天传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天休息，明天补",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "skip",
      note: "今天休息，明天补",
      deferDays: 1,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "今天休息，明天补",
    },
  ]);
});

test("runtime：指定补做日期反馈会换算顺延天数传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天休息，周五补",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "skip",
      note: "今天休息，周五补",
      deferDays: 2,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "今天休息，周五补",
    },
  ]);
});

test("runtime：明天再做反馈会把顺延一天传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "今天歇一天，明天再做",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "skip",
      note: "今天歇一天，明天再做",
      deferDays: 1,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "今天歇一天，明天再做",
    },
  ]);
});

test("runtime：请假反馈会把顺延天数传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "请假两天",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "skip",
      note: "请假两天",
      deferDays: 2,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "请假两天",
    },
  ]);
});

test("runtime：相对日期任务反馈会写到对应份额日期", async () => {
  const connector = new FakeConnector([
    message({
      text: "昨天没读",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-23",
      feedback: "skip",
      note: "昨天没读",
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "昨天没读",
    },
  ]);
});

test("runtime：绝对日期任务反馈会写到指定份额日期", async () => {
  const connector = new FakeConnector([
    message({
      text: "6月24日没读",
      ts: Date.parse("2026-06-25T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-25T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "skip",
      note: "6月24日没读",
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "6月24日没读",
    },
  ]);
});

test("runtime：周几日期任务反馈会写到对应份额日期", async () => {
  const connector = new FakeConnector([
    message({
      text: "这周一没法做了",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-22",
      feedback: "skip",
      note: "这周一没法做了",
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "这周一没法做了",
    },
  ]);
});

test("runtime：周几日期部分完成反馈会把日期和比例传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "周五做了一半",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-26",
      feedback: "partial",
      note: "周五做了一半",
      completedRatio: 0.5,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "partial",
      note: "周五做了一半",
    },
  ]);
});

test("runtime：跨度缺勤反馈会把顺延天数传给重排逻辑", async () => {
  const connector = new FakeConnector([
    message({
      text: "最近三天没读",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "skip",
      note: "最近三天没读",
      deferDays: 3,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "最近三天没读",
    },
  ]);
});

test("runtime：周跨度缺勤反馈会换算成顺延天数", async () => {
  const connector = new FakeConnector([
    message({
      text: "最近一周没读",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "skip",
      note: "最近一周没读",
      deferDays: 7,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "最近一周没读",
    },
  ]);
});

test("runtime：无数字周跨度缺勤反馈会换算成顺延天数", async () => {
  const connector = new FakeConnector([
    message({
      text: "这周没读",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return undefined;
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "skip",
      note: "这周没读",
      deferDays: 7,
    },
    {
      kind: "feedback",
      memberSlug: "local",
      feedback: "skip",
      note: "这周没读",
    },
  ]);
});

test("runtime：任务反馈记录会关联当天份额所属目标", async () => {
  const connector = new FakeConnector([
    message({
      text: "读完了",
      ts: Date.parse("2026-06-24T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      calls.push({ kind: "feedback", ...input });
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-24T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback(input) {
      calls.push({ kind: "portion-feedback", ...input });
      return {
        goalCompleted: false,
        portion: {
          goalId: "goal-1",
          date: "2026-06-24",
          unitFrom: 1,
          unitTo: 2,
          dispatched: true,
          feedback: "done",
          note: "读完了",
        },
        replanned: [],
      };
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    {
      kind: "portion-feedback",
      memberSlug: "local",
      date: "2026-06-24",
      feedback: "done",
      note: "读完了",
    },
    {
      kind: "feedback",
      memberSlug: "local",
      goalId: "goal-1",
      feedback: "done",
      note: "读完了",
    },
  ]);
});

test("runtime：完成最后份额时发送目标完成回执", async () => {
  const connector = new FakeConnector([
    message({
      text: "读完了",
      ts: Date.parse("2026-06-25T20:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const taskStore: Pick<
    TaskStore,
    "createGoal" | "recordFeedback" | "recordLatestPortionFeedback"
  > = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback(input) {
      return {
        id: "feedback-1",
        memberSlug: input.memberSlug,
        goalId: input.goalId,
        feedback: input.feedback,
        note: input.note,
        createdAt: "2026-06-25T20:00:00.000Z",
      };
    },
    recordLatestPortionFeedback() {
      return {
        goalCompleted: true,
        portion: {
          goalId: "goal-1",
          date: "2026-06-25",
          unitFrom: 3,
          unitTo: 4,
          dispatched: true,
          feedback: "done",
          note: "读完了",
        },
        replanned: [],
      };
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已完成学习目标。真不错，目标我也标记为完成了。" },
  ]);
});

test("runtime：暂停任务会暂停最近活跃目标并发送回执", async () => {
  const connector = new FakeConnector([
    message({
      text: "暂停这个任务",
      ts: Date.parse("2026-06-24T21:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "pauseLatestGoal"> = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback() {
      throw new Error("暂停不应写成普通反馈");
    },
    pauseLatestGoal(input) {
      calls.push({ kind: "pause", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: "小王子",
        sourceText: "我想2天读完4章《小王子》",
        horizonDays: 2,
        status: "paused",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T21:00:00.000Z",
      };
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([{ kind: "pause", memberSlug: "local" }]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已暂停学习目标：小王子。之后不会继续派发它的每日份额。" },
  ]);
  expect(brain.rememberCalls).toEqual([
    {
      member: { slug: "local" },
      text: "学习目标已暂停：小王子",
      tags: ["task", "pause"],
    },
  ]);
});

test("runtime：口语暂停任务会暂停最近活跃目标并发送回执", async () => {
  const connector = new FakeConnector([
    message({
      text: "这个任务先放一放",
      ts: Date.parse("2026-06-24T21:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "pauseLatestGoal"> = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback() {
      throw new Error("暂停不应写成普通反馈");
    },
    pauseLatestGoal(input) {
      calls.push({ kind: "pause", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: "小王子",
        sourceText: "我想2天读完4章《小王子》",
        horizonDays: 2,
        status: "paused",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T21:00:00.000Z",
      };
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([{ kind: "pause", memberSlug: "local" }]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已暂停学习目标：小王子。之后不会继续派发它的每日份额。" },
  ]);
  expect(brain.rememberCalls).toEqual([
    {
      member: { slug: "local" },
      text: "学习目标已暂停：小王子",
      tags: ["task", "pause"],
    },
  ]);
});

test("runtime：暂停任务会把点名目标传给 task store", async () => {
  const connector = new FakeConnector([
    message({
      text: "暂停《小王子》",
      ts: Date.parse("2026-06-24T21:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "pauseLatestGoal"> = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback() {
      throw new Error("暂停不应写成普通反馈");
    },
    pauseLatestGoal(input) {
      calls.push({ kind: "pause", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: "小王子",
        sourceText: "我想2天读完4章《小王子》",
        horizonDays: 2,
        status: "paused",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-24T21:00:00.000Z",
      };
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([{ kind: "pause", memberSlug: "local", targetTitle: "小王子" }]);
});

test("runtime：恢复任务会恢复最近暂停目标并发送回执", async () => {
  const connector = new FakeConnector([
    message({
      text: "恢复这个任务",
      ts: Date.parse("2026-06-27T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "resumeLatestPausedGoal"> = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback() {
      throw new Error("恢复不应写成普通反馈");
    },
    resumeLatestPausedGoal(input) {
      calls.push({ kind: "resume", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: "小王子",
        sourceText: "我想3天读完6章《小王子》",
        horizonDays: 3,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-27T08:00:00.000Z",
      };
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([{ kind: "resume", memberSlug: "local", date: "2026-06-27" }]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已恢复学习目标：小王子。后续会从今天重新派发剩余份额。" },
  ]);
  expect(brain.rememberCalls).toEqual([
    {
      member: { slug: "local" },
      text: "学习目标已恢复：小王子",
      tags: ["task", "resume"],
    },
  ]);
});

test("runtime：口语恢复任务会恢复最近暂停目标并发送回执", async () => {
  const connector = new FakeConnector([
    message({
      text: "这个任务继续做",
      ts: Date.parse("2026-06-27T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "resumeLatestPausedGoal"> = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback() {
      throw new Error("恢复不应写成普通反馈");
    },
    resumeLatestPausedGoal(input) {
      calls.push({ kind: "resume", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: "小王子",
        sourceText: "我想3天读完6章《小王子》",
        horizonDays: 3,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-27T08:00:00.000Z",
      };
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([{ kind: "resume", memberSlug: "local", date: "2026-06-27" }]);
  expect(connector.sent).toEqual([
    { channelId: "cli", text: "已恢复学习目标：小王子。后续会从今天重新派发剩余份额。" },
  ]);
  expect(brain.rememberCalls).toEqual([
    {
      member: { slug: "local" },
      text: "学习目标已恢复：小王子",
      tags: ["task", "resume"],
    },
  ]);
});

test("runtime：恢复任务会把点名目标传给 task store", async () => {
  const connector = new FakeConnector([
    message({
      text: "恢复《小王子》",
      ts: Date.parse("2026-06-27T08:00:00.000Z"),
    }),
  ]);
  const brain = new FakeBrain();
  const calls: Array<unknown> = [];
  const taskStore: Pick<TaskStore, "createGoal" | "recordFeedback" | "resumeLatestPausedGoal"> = {
    createGoal() {
      throw new Error("不应创建目标");
    },
    recordFeedback() {
      throw new Error("恢复不应写成普通反馈");
    },
    resumeLatestPausedGoal(input) {
      calls.push({ kind: "resume", ...input });
      return {
        id: "goal-1",
        memberSlug: input.memberSlug,
        title: "小王子",
        sourceText: "我想3天读完6章《小王子》",
        horizonDays: 3,
        status: "active",
        createdAt: "2026-06-24T08:00:00.000Z",
        updatedAt: "2026-06-27T08:00:00.000Z",
      };
    },
  };

  await runRuntime({ connector, brain, taskStore });

  expect(calls).toEqual([
    { kind: "resume", memberSlug: "local", date: "2026-06-27", targetTitle: "小王子" },
  ]);
});

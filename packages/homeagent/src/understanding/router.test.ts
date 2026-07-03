import { expect, test } from "bun:test";
import { routeIncomingMessage } from "./router";
import type { IncomingMessage } from "../connectors/types";

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

test("router：@bot 消息进入问答路径", () => {
  expect(
    routeIncomingMessage(message({ mentionsBot: true, text: " 老师电话是多少 " })),
  ).toEqual({
    kind: "ask",
    question: "老师电话是多少",
  });
});

test("router：@bot 附件消息进入问答路径并保留附件 key", () => {
  expect(
    routeIncomingMessage(
      message({
        mentionsBot: true,
        attachments: [{ kind: "image", key: "img_v3_question" }],
      }),
    ),
  ).toEqual({
    kind: "ask",
    question: "收到图片附件：img_v3_question",
  });
});

test("router：@bot 附件消息进入问答路径并保留附件文本", () => {
  expect(
    routeIncomingMessage(
      message({
        mentionsBot: true,
        attachments: [
          {
            kind: "image",
            key: "img_v3_question",
            localPath: ".homeagent/attachments/om_1/img_v3_question",
            extractedText: "题目要求写出三个近义词",
          },
        ],
      }),
    ),
  ).toEqual({
    kind: "ask",
    question:
      "收到图片附件：img_v3_question (local: .homeagent/attachments/om_1/img_v3_question)\n附件内容：题目要求写出三个近义词",
  });
});

test("router：@bot 文本带附件时问题正文保留附件 key", () => {
  expect(
    routeIncomingMessage(
      message({
        mentionsBot: true,
        text: "这张图里有什么？",
        attachments: [{ kind: "image", key: "img_v3_question" }],
      }),
    ),
  ).toEqual({
    kind: "ask",
    question: "这张图里有什么？\n收到图片附件：img_v3_question",
  });
});

test("router：普通文本进入记忆路径", () => {
  expect(routeIncomingMessage(message({ text: " 老师电话 138 " }))).toEqual({
    kind: "remember",
    text: "老师电话 138",
  });

  expect(routeIncomingMessage(message({ text: "今天大半天都在外面" }))).toEqual({
    kind: "remember",
    text: "今天大半天都在外面",
  });
});

test("router：附件消息进入记忆路径并保留附件 key", () => {
  expect(
    routeIncomingMessage(
      message({
        attachments: [
          { kind: "image", key: "img_v3_abc" },
          { kind: "file", key: "file_v3_def", name: "课表.pdf" },
        ],
      }),
    ),
  ).toEqual({
    kind: "remember",
    text: "收到图片附件：img_v3_abc\n收到文件附件：课表.pdf (file_v3_def)",
  });
});

test("router：附件摘要保留本地下载路径", () => {
  expect(
    routeIncomingMessage(
      message({
        attachments: [
          {
            kind: "image",
            key: "img_v3_abc",
            localPath: ".homeagent/attachments/om_1/img_v3_abc",
          },
        ],
      }),
    ),
  ).toEqual({
    kind: "remember",
    text: "收到图片附件：img_v3_abc (local: .homeagent/attachments/om_1/img_v3_abc)",
  });
});

test("router：普通文本带附件时记忆正文保留附件 key", () => {
  expect(
    routeIncomingMessage(
      message({
        text: "今天的作业拍给你",
        attachments: [{ kind: "image", key: "img_v3_homework" }],
      }),
    ),
  ).toEqual({
    kind: "remember",
    text: "今天的作业拍给你\n收到图片附件：img_v3_homework",
  });
});

test("router：识别学习目标指令", () => {
  expect(routeIncomingMessage(message({ text: " 我想30天读完《小王子》 " }))).toEqual({
    kind: "task_goal",
    text: "我想30天读完《小王子》",
    title: "小王子",
    horizonDays: 30,
  });
});

test("router：识别带明确总量的学习目标", () => {
  expect(routeIncomingMessage(message({ text: "我想3天读完10章《小王子》" }))).toEqual({
    kind: "task_goal",
    text: "我想3天读完10章《小王子》",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 10,
  });

  expect(routeIncomingMessage(message({ text: "我想三天读完十章《小王子》" }))).toEqual({
    kind: "task_goal",
    text: "我想三天读完十章《小王子》",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 10,
  });

  expect(routeIncomingMessage(message({ text: "我想3天做完30题口算" }))).toEqual({
    kind: "task_goal",
    text: "我想3天做完30题口算",
    horizonDays: 3,
    totalUnits: 30,
  });

  expect(routeIncomingMessage(message({ text: "我想3天做完30道题口算" }))).toEqual({
    kind: "task_goal",
    text: "我想3天做完30道题口算",
    horizonDays: 3,
    totalUnits: 30,
  });

  expect(routeIncomingMessage(message({ text: "我想3天做完30个题口算" }))).toEqual({
    kind: "task_goal",
    text: "我想3天做完30个题口算",
    horizonDays: 3,
    totalUnits: 30,
  });

  expect(routeIncomingMessage(message({ text: "计划四天练完二十题口算" }))).toEqual({
    kind: "task_goal",
    text: "计划四天练完二十题口算",
    horizonDays: 4,
    totalUnits: 20,
  });

  expect(routeIncomingMessage(message({ text: "我要5天学完8课自然拼读" }))).toEqual({
    kind: "task_goal",
    text: "我要5天学完8课自然拼读",
    horizonDays: 5,
    totalUnits: 8,
  });

  expect(routeIncomingMessage(message({ text: "我想每天做10题口算，坚持5天" }))).toEqual({
    kind: "task_goal",
    text: "我想每天做10题口算，坚持5天",
    horizonDays: 5,
    totalUnits: 50,
  });

  expect(routeIncomingMessage(message({ text: "计划每天背二十个单词，连续五天" }))).toEqual({
    kind: "task_goal",
    text: "计划每天背二十个单词，连续五天",
    horizonDays: 5,
    totalUnits: 100,
  });

  expect(routeIncomingMessage(message({ text: "给小宝安排每天10题口算，坚持5天" }))).toEqual({
    kind: "task_goal",
    text: "给小宝安排每天10题口算，坚持5天",
    horizonDays: 5,
    totalUnits: 50,
  });

  expect(routeIncomingMessage(message({ text: "给小宝每天安排10题口算，坚持5天" }))).toEqual({
    kind: "task_goal",
    text: "给小宝每天安排10题口算，坚持5天",
    horizonDays: 5,
    totalUnits: 50,
  });

  expect(routeIncomingMessage(message({ text: "布置每天背二十个单词，连续五天" }))).toEqual({
    kind: "task_goal",
    text: "布置每天背二十个单词，连续五天",
    horizonDays: 5,
    totalUnits: 100,
  });

  expect(routeIncomingMessage(message({ text: "每天布置二十个单词，连续五天" }))).toEqual({
    kind: "task_goal",
    text: "每天布置二十个单词，连续五天",
    horizonDays: 5,
    totalUnits: 100,
  });

  expect(routeIncomingMessage(message({ text: "我想一周内读完10章《小王子》" }))).toEqual({
    kind: "task_goal",
    text: "我想一周内读完10章《小王子》",
    title: "小王子",
    horizonDays: 7,
    totalUnits: 10,
  });

  expect(routeIncomingMessage(message({ text: "计划两个星期背完一百个单词" }))).toEqual({
    kind: "task_goal",
    text: "计划两个星期背完一百个单词",
    horizonDays: 14,
    totalUnits: 100,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6月30日前读完10章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6月30日前读完10章《小王子》",
    title: "小王子",
    horizonDays: 7,
    totalUnits: 10,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想本月底前读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想本月底前读完6章《小王子》",
    title: "小王子",
    horizonDays: 7,
    totalUnits: 6,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下月底前读完10章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下月底前读完10章《小王子》",
    title: "小王子",
    horizonDays: 38,
    totalUnits: 10,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想本月内读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想本月内读完6章《小王子》",
    title: "小王子",
    horizonDays: 7,
    totalUnits: 6,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下个月内读完10章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下个月内读完10章《小王子》",
    title: "小王子",
    horizonDays: 38,
    totalUnits: 10,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想这个月读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想这个月读完6章《小王子》",
    title: "小王子",
    horizonDays: 7,
    totalUnits: 6,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下个月读完10章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下个月读完10章《小王子》",
    title: "小王子",
    horizonDays: 38,
    totalUnits: 10,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下月五号前读完10章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下月五号前读完10章《小王子》",
    title: "小王子",
    horizonDays: 12,
    totalUnits: 10,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想本月30号前读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想本月30号前读完6章《小王子》",
    title: "小王子",
    horizonDays: 7,
    totalUnits: 6,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下周五前读完10章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下周五前读完10章《小王子》",
    title: "小王子",
    horizonDays: 10,
    totalUnits: 10,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想这周末前读完4章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想这周末前读完4章《小王子》",
    title: "小王子",
    horizonDays: 5,
    totalUnits: 4,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下周末前读完10章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下周末前读完10章《小王子》",
    title: "小王子",
    horizonDays: 12,
    totalUnits: 10,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想本周内读完4章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想本周内读完4章《小王子》",
    title: "小王子",
    horizonDays: 5,
    totalUnits: 4,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下周内读完10章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下周内读完10章《小王子》",
    title: "小王子",
    horizonDays: 12,
    totalUnits: 10,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想本周读完4章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想本周读完4章《小王子》",
    title: "小王子",
    horizonDays: 5,
    totalUnits: 4,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下周读完10章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下周读完10章《小王子》",
    title: "小王子",
    horizonDays: 12,
    totalUnits: 10,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想这周五前读完3章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想这周五前读完3章《小王子》",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 3,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想周五前读完3章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想周五前读完3章《小王子》",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 3,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "计划截止到周五背完30个单词",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "计划截止到周五背完30个单词",
    horizonDays: 3,
    totalUnits: 30,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想3天读完6章《小王子》，第1天读1章，第2天读2到4章，第3天读5到6章",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想3天读完6章《小王子》，第1天读1章，第2天读2到4章，第3天读5到6章",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 6,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 1 },
      { day: 2, unitFrom: 2, unitTo: 4 },
      { day: 3, unitFrom: 5, unitTo: 6 },
    ],
  });
});

test("router：识别学习目标里的休息日", () => {
  expect(routeIncomingMessage(message({ text: "我想3天读完10章《小王子》，周末休息" }))).toEqual({
    kind: "task_goal",
    text: "我想3天读完10章《小王子》，周末休息",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 10,
    restWeekdays: [0, 6],
  });

  expect(routeIncomingMessage(message({ text: "计划5天背完100个单词，周三休息" }))).toEqual({
    kind: "task_goal",
    text: "计划5天背完100个单词，周三休息",
    horizonDays: 5,
    totalUnits: 100,
    restWeekdays: [3],
  });

  expect(routeIncomingMessage(message({ text: "计划五天背完一百个单词，周三休息" }))).toEqual({
    kind: "task_goal",
    text: "计划五天背完一百个单词，周三休息",
    horizonDays: 5,
    totalUnits: 100,
    restWeekdays: [3],
  });

  expect(routeIncomingMessage(message({ text: "计划五天背完一百零五个单词，周三休息" }))).toEqual({
    kind: "task_goal",
    text: "计划五天背完一百零五个单词，周三休息",
    horizonDays: 5,
    totalUnits: 105,
    restWeekdays: [3],
  });

  expect(routeIncomingMessage(message({ text: "我想6天做完60题口算，只在周一三五做" }))).toEqual({
    kind: "task_goal",
    text: "我想6天做完60题口算，只在周一三五做",
    horizonDays: 6,
    totalUnits: 60,
    restWeekdays: [0, 2, 4, 6],
  });

  expect(routeIncomingMessage(message({ text: "我想6天做完60题口算，每周一三五做" }))).toEqual({
    kind: "task_goal",
    text: "我想6天做完60题口算，每周一三五做",
    horizonDays: 6,
    totalUnits: 60,
    restWeekdays: [0, 2, 4, 6],
  });

  expect(routeIncomingMessage(message({ text: "我想6天做完60题口算，周一三五做" }))).toEqual({
    kind: "task_goal",
    text: "我想6天做完60题口算，周一三五做",
    horizonDays: 6,
    totalUnits: 60,
    restWeekdays: [0, 2, 4, 6],
  });

  expect(routeIncomingMessage(message({ text: "我想6天做完60题口算，周一周三周五做" }))).toEqual({
    kind: "task_goal",
    text: "我想6天做完60题口算，周一周三周五做",
    horizonDays: 6,
    totalUnits: 60,
    restWeekdays: [0, 2, 4, 6],
  });

  expect(routeIncomingMessage(message({ text: "计划5天背完100个单词，只在工作日背" }))).toEqual({
    kind: "task_goal",
    text: "计划5天背完100个单词，只在工作日背",
    horizonDays: 5,
    totalUnits: 100,
    restWeekdays: [0, 6],
  });

  expect(routeIncomingMessage(message({ text: "我想4天做完40题口算，只在周末做" }))).toEqual({
    kind: "task_goal",
    text: "我想4天做完40题口算，只在周末做",
    horizonDays: 4,
    totalUnits: 40,
    restWeekdays: [1, 2, 3, 4, 5],
  });

  expect(routeIncomingMessage(message({ text: "我想5天做完50题口算，只在周一到周五做" }))).toEqual({
    kind: "task_goal",
    text: "我想5天做完50题口算，只在周一到周五做",
    horizonDays: 5,
    totalUnits: 50,
    restWeekdays: [0, 6],
  });

  expect(routeIncomingMessage(message({ text: "计划5天背完100个单词，每周一到周五背" }))).toEqual({
    kind: "task_goal",
    text: "计划5天背完100个单词，每周一到周五背",
    horizonDays: 5,
    totalUnits: 100,
    restWeekdays: [0, 6],
  });

  expect(routeIncomingMessage(message({ text: "计划5天背完100个单词，周一到周五背" }))).toEqual({
    kind: "task_goal",
    text: "计划5天背完100个单词，周一到周五背",
    horizonDays: 5,
    totalUnits: 100,
    restWeekdays: [0, 6],
  });

  expect(routeIncomingMessage(message({ text: "我想4天做完40题口算，隔天做" }))).toEqual({
    kind: "task_goal",
    text: "我想4天做完40题口算，隔天做",
    horizonDays: 4,
    totalUnits: 40,
    dateSpacingDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "计划四天背完四十个单词，每隔一天背" }))).toEqual({
    kind: "task_goal",
    text: "计划四天背完四十个单词，每隔一天背",
    horizonDays: 4,
    totalUnits: 40,
    dateSpacingDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "我想4天做完40题口算，做一天休一天" }))).toEqual({
    kind: "task_goal",
    text: "我想4天做完40题口算，做一天休一天",
    horizonDays: 4,
    totalUnits: 40,
    dateSpacingDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "我想4天做完40题口算，做一天歇一天" }))).toEqual({
    kind: "task_goal",
    text: "我想4天做完40题口算，做一天歇一天",
    horizonDays: 4,
    totalUnits: 40,
    dateSpacingDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "我想4天做完40题口算，做一休一" }))).toEqual({
    kind: "task_goal",
    text: "我想4天做完40题口算，做一休一",
    horizonDays: 4,
    totalUnits: 40,
    dateSpacingDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "我想4天做完40题口算，一天做一天休" }))).toEqual({
    kind: "task_goal",
    text: "我想4天做完40题口算，一天做一天休",
    horizonDays: 4,
    totalUnits: 40,
    dateSpacingDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "计划4天学完8课自然拼读，上一天休一天" }))).toEqual({
    kind: "task_goal",
    text: "计划4天学完8课自然拼读，上一天休一天",
    horizonDays: 4,
    totalUnits: 8,
    dateSpacingDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "我想5天做完50题口算，做两天休一天" }))).toEqual({
    kind: "task_goal",
    text: "我想5天做完50题口算，做两天休一天",
    horizonDays: 5,
    totalUnits: 50,
    activeRestCycle: { activeDays: 2, restDays: 1 },
  });

  expect(routeIncomingMessage(message({ text: "我想4天做完40题口算，每2天做一次" }))).toEqual({
    kind: "task_goal",
    text: "我想4天做完40题口算，每2天做一次",
    horizonDays: 4,
    totalUnits: 40,
    dateSpacingDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "我想4天做完40题口算，两天做一次" }))).toEqual({
    kind: "task_goal",
    text: "我想4天做完40题口算，两天做一次",
    horizonDays: 4,
    totalUnits: 40,
    dateSpacingDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "计划三天背完三十个单词，每三天背一次" }))).toEqual({
    kind: "task_goal",
    text: "计划三天背完三十个单词，每三天背一次",
    horizonDays: 3,
    totalUnits: 30,
    dateSpacingDays: 3,
  });

  expect(routeIncomingMessage(message({ text: "我想4天做完40题口算，每隔两天做一次" }))).toEqual({
    kind: "task_goal",
    text: "我想4天做完40题口算，每隔两天做一次",
    horizonDays: 4,
    totalUnits: 40,
    dateSpacingDays: 3,
  });
});

test("router：识别学习目标里的开始日期", () => {
  expect(
    routeIncomingMessage(
      message({
        text: "我想明天开始3天读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想明天开始3天读完6章《小王子》",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 6,
    startDate: "2026-06-25",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想后天开始3天读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想后天开始3天读完6章《小王子》",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 6,
    startDate: "2026-06-26",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下周一开始3天读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下周一开始3天读完6章《小王子》",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 6,
    startDate: "2026-06-29",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下周开始3天读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下周开始3天读完6章《小王子》",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 6,
    startDate: "2026-06-29",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下个月一号开始3天读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下个月一号开始3天读完6章《小王子》",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 6,
    startDate: "2026-07-01",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下个月开始3天读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下个月开始3天读完6章《小王子》",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 6,
    startDate: "2026-07-01",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想这周五开始3天读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想这周五开始3天读完6章《小王子》",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 6,
    startDate: "2026-06-26",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想周五开始3天读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想周五开始3天读完6章《小王子》",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 6,
    startDate: "2026-06-26",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "计划从周五起3天背完30个单词",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "计划从周五起3天背完30个单词",
    horizonDays: 3,
    totalUnits: 30,
    startDate: "2026-06-26",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想从6月30日开始3天读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想从6月30日开始3天读完6章《小王子》",
    title: "小王子",
    horizonDays: 3,
    totalUnits: 6,
    startDate: "2026-06-30",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想明天开始，6月30日前读完10章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想明天开始，6月30日前读完10章《小王子》",
    title: "小王子",
    horizonDays: 6,
    totalUnits: 10,
    startDate: "2026-06-25",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想明天开始，月底前读完6章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想明天开始，月底前读完6章《小王子》",
    title: "小王子",
    horizonDays: 6,
    totalUnits: 6,
    startDate: "2026-06-25",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下个月1号开始，下个月5号前读完10章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下个月1号开始，下个月5号前读完10章《小王子》",
    title: "小王子",
    horizonDays: 5,
    totalUnits: 10,
    startDate: "2026-07-01",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想下周开始，月底前读完4章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想下周开始，月底前读完4章《小王子》",
    title: "小王子",
    horizonDays: 2,
    totalUnits: 4,
    startDate: "2026-06-29",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想从6月26日开始，6月30日前读完10章《小王子》",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想从6月26日开始，6月30日前读完10章《小王子》",
    title: "小王子",
    horizonDays: 5,
    totalUnits: 10,
    startDate: "2026-06-26",
  });
});

test("router：识别阶段式每日份额计划", () => {
  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完60题口算，前3天每天做10题，后2天每天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完60题口算，前3天每天做10题，后2天每天做15题",
    horizonDays: 5,
    totalUnits: 60,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 30 },
      { day: 4, unitFrom: 31, unitTo: 45 },
      { day: 5, unitFrom: 46, unitTo: 60 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完60题口算，第1天到第3天每天做10题，第4天到第5天每天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完60题口算，第1天到第3天每天做10题，第4天到第5天每天做15题",
    horizonDays: 5,
    totalUnits: 60,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 30 },
      { day: 4, unitFrom: 31, unitTo: 45 },
      { day: 5, unitFrom: 46, unitTo: 60 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想五天背完六十个单词，前三天每天背十个单词，后两天每天背十五个单词",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想五天背完六十个单词，前三天每天背十个单词，后两天每天背十五个单词",
    horizonDays: 5,
    totalUnits: 60,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 30 },
      { day: 4, unitFrom: 31, unitTo: 45 },
      { day: 5, unitFrom: 46, unitTo: 60 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前2天做10题，后3天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前2天做10题，后3天做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前两天每天做10题，最后三天每天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前两天每天做10题，最后三天每天做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，开始两天每天10题，最后三天每天15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，开始两天每天10题，最后三天每天15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前2天每天做10题，剩下每天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前2天每天做10题，剩下每天做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，先2天每天做10题，之后每天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，先2天每天做10题，之后每天做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，先每天做10题做2天，然后每天做15题做3天",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，先每天做10题做2天，然后每天做15题做3天",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，每天10题先做2天，再每天15题做3天",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，每天10题先做2天，再每天15题做3天",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，先做10题做2天，再做15题做3天",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，先做10题做2天，再做15题做3天",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想五天背完六十五个单词，先每天背十个单词背两天，接着每天背十五个单词背三天",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想五天背完六十五个单词，先每天背十个单词背两天，接着每天背十五个单词背三天",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，先做两天10题，再做三天15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，先做两天10题，再做三天15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，先用两天做10题，再用三天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，先用两天做10题，再用三天做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想五天背完六十五个单词，先背两天十个单词，接着背三天十五个单词",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想五天背完六十五个单词，先背两天十个单词，接着背三天十五个单词",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想五天背完六十五个单词，前两天每天背十个单词，剩下三天每天背十五个单词",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想五天背完六十五个单词，前两天每天背十个单词，剩下三天每天背十五个单词",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前两天做10题，后面三天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前两天做10题，后面三天做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前两天每天10题，后面三天改成每天15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前两天每天10题，后面三天改成每天15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前两天每天10题，后面三天增加到每天15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前两天每天10题，后面三天增加到每天15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前两天各做10题，后面三天各做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前两天各做10题，后面三天各做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前两天每次做10题，后面三天每次做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前两天每次做10题，后面三天每次做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前两天一天10题，后面三天一天15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前两天一天10题，后面三天一天15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前两天每一天做10题，后面三天每一天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前两天每一天做10题，后面三天每一天做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前两天每日做10题，后面三天每日做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前两天每日做10题，后面三天每日做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，头两天每天做10题，接下来每天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，头两天每天做10题，接下来每天做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，先两天每天做10题，余下三天每天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，先两天每天做10题，余下三天每天做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前两天做10题，余下三天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前两天做10题，余下三天做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前两天少一点，每天做10题，后面三天加量，每天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前两天少一点，每天做10题，后面三天加量，每天做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前两天少做点，每天10题，后面三天加到每天15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前两天少做点，每天10题，后面三天加到每天15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，第一阶段2天每天10题，第二阶段3天每天15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，第一阶段2天每天10题，第二阶段3天每天15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想五天背完六十五个单词，阶段一两天每天十个单词，阶段二三天每天十五个单词",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想五天背完六十五个单词，阶段一两天每天十个单词，阶段二三天每天十五个单词",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，第一阶段每天10题做2天，第二阶段每天15题做3天",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，第一阶段每天10题做2天，第二阶段每天15题做3天",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想五天背完六十五个单词，阶段一每天十个单词背两天，阶段二每天十五个单词背三天",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想五天背完六十五个单词，阶段一每天十个单词背两天，阶段二每天十五个单词背三天",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，先少做点10题做2天，再加到15题做3天",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，先少做点10题做2天，再加到15题做3天",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前两天每天10题，第3天开始每天15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前两天每天10题，第3天开始每天15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，前2天每天做10题，第3天起每天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，前2天每天做10题，第3天起每天做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，前半段每天做10题，后半段每天做20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，前半段每天做10题，后半段每天做20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 30 },
      { day: 4, unitFrom: 31, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，前半段10题，后半段20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，前半段10题，后半段20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 30 },
      { day: 4, unitFrom: 31, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，前半段做10题，后半段做20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，前半段做10题，后半段做20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 30 },
      { day: 4, unitFrom: 31, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，前两天每天10题，中间两天每天15题，最后两天每天20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，前两天每天10题，中间两天每天15题，最后两天每天20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，前两天每天10题，中间每天15题，最后两天每天20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，前两天每天10题，中间每天15题，最后两天每天20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，前两天每天10题，中间两天每天15题，最后每天20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，前两天每天10题，中间两天每天15题，最后每天20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，前两天每天10题，中间每天15题，最后每天20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，前两天每天10题，中间每天15题，最后每天20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完80题口算，前两天每天10题，中间每天15题，最后每天15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完80题口算，前两天每天10题，中间每天15题，最后每天15题",
    horizonDays: 6,
    totalUnits: 80,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完60题口算，前3天每天做10题，后2天每天做10题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完60题口算，前3天每天做10题，后2天每天做10题",
    horizonDays: 5,
    totalUnits: 60,
  });
});

test("router：阶段式每日份额计划可从阶段天数推导总天数", () => {
  expect(
    routeIncomingMessage(
      message({
        text: "我想做完65题口算，前两天每天10题，后面三天每天15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想做完65题口算，前两天每天10题，后面三天每天15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想做完65题口算，先做两天10题，再做三天15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想做完65题口算，先做两天10题，再做三天15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想做完65题口算，先用两天做10题，再用三天做15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想做完65题口算，先用两天做10题，再用三天做15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想做完65题口算，每天10题先做2天，再每天15题做3天",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想做完65题口算，每天10题先做2天，再每天15题做3天",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想做完90题口算，前两天每天10题，中间两天每天15题，最后两天每天20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想做完90题口算，前两天每天10题，中间两天每天15题，最后两天每天20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });
});

test("router：识别安排型阶段式任务目标", () => {
  expect(
    routeIncomingMessage(
      message({
        text: "给小宝安排65题口算，前两天每天10题，后面三天每天15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "给小宝安排65题口算，前两天每天10题，后面三天每天15题",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });
});

test("router：带安排词的阶段计划仍优先使用显式总量", () => {
  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完65题口算，第一阶段先安排每天10题两天，第二阶段再安排每天15题三天",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完65题口算，第一阶段先安排每天10题两天，第二阶段再安排每天15题三天",
    horizonDays: 5,
    totalUnits: 65,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 65 },
    ],
  });
});

test("router：识别多段范围式每日份额计划", () => {
  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，第1到2天每天做10题，第3到4天每天做15题，第5到6天每天做20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，第1到2天每天做10题，第3到4天每天做15题，第5到6天每天做20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想六天背完九十个单词，第一至二天每天背十个单词，第三至四天每天背十五个单词，第五至六天每天背二十个单词",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想六天背完九十个单词，第一至二天每天背十个单词，第三至四天每天背十五个单词，第五至六天每天背二十个单词",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，第1到2天做10题，第3到4天做15题，第5到6天做20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，第1到2天做10题，第3到4天做15题，第5到6天做20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，第1—2天每天做10题，第3—4天每天做15题，第5—6天每天做20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，第1—2天每天做10题，第3—4天每天做15题，第5—6天每天做20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，第1～2天每天做10题，第3～4天每天做15题，第5～6天每天做20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，第1～2天每天做10题，第3～4天每天做15题，第5～6天每天做20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，第1、2天10题，第3、4天15题，第5、6天20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，第1、2天10题，第3、4天15题，第5、6天20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，第1、2天每天做10题，第3、4天每天做15题，第5、6天每天做20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，第1、2天每天做10题，第3、4天每天做15题，第5、6天每天做20题",
    horizonDays: 6,
    totalUnits: 90,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 20 },
      { day: 3, unitFrom: 21, unitTo: 35 },
      { day: 4, unitFrom: 36, unitTo: 50 },
      { day: 5, unitFrom: 51, unitTo: 70 },
      { day: 6, unitFrom: 71, unitTo: 90 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想6天做完90题口算，第1到2天每天做10题，第4到6天每天做20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想6天做完90题口算，第1到2天每天做10题，第4到6天每天做20题",
    horizonDays: 6,
    totalUnits: 90,
  });
});

test("router：识别逐日列举式每日份额计划", () => {
  expect(
    routeIncomingMessage(
      message({
        text: "我想3天做完45题口算，第1天做10题，第2天做15题，第3天做20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想3天做完45题口算，第1天做10题，第2天做15题，第3天做20题",
    horizonDays: 3,
    totalUnits: 45,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 25 },
      { day: 3, unitFrom: 26, unitTo: 45 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想三天背完四十五个单词，第一天背十个单词，第二天背十五个单词，第三天背二十个单词",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想三天背完四十五个单词，第一天背十个单词，第二天背十五个单词，第三天背二十个单词",
    horizonDays: 3,
    totalUnits: 45,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 25 },
      { day: 3, unitFrom: 26, unitTo: 45 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完75题口算，每天分别做10题、15题、15题、20题、15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完75题口算，每天分别做10题、15题、15题、20题、15题",
    horizonDays: 5,
    totalUnits: 75,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 25 },
      { day: 3, unitFrom: 26, unitTo: 40 },
      { day: 4, unitFrom: 41, unitTo: 60 },
      { day: 5, unitFrom: 61, unitTo: 75 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完75题口算，每天做10题、15题、15题、20题、15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完75题口算，每天做10题、15题、15题、20题、15题",
    horizonDays: 5,
    totalUnits: 75,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 25 },
      { day: 3, unitFrom: 26, unitTo: 40 },
      { day: 4, unitFrom: 41, unitTo: 60 },
      { day: 5, unitFrom: 61, unitTo: 75 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完75题口算，每天10题、15题、15题、20题、15题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完75题口算，每天10题、15题、15题、20题、15题",
    horizonDays: 5,
    totalUnits: 75,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 25 },
      { day: 3, unitFrom: 26, unitTo: 40 },
      { day: 4, unitFrom: 41, unitTo: 60 },
      { day: 5, unitFrom: 61, unitTo: 75 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想五天背完七十五个单词，每天分别背十个、十五个、十五个、二十个、十五个单词",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想五天背完七十五个单词，每天分别背十个、十五个、十五个、二十个、十五个单词",
    horizonDays: 5,
    totalUnits: 75,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 25 },
      { day: 3, unitFrom: 26, unitTo: 40 },
      { day: 4, unitFrom: 41, unitTo: 60 },
      { day: 5, unitFrom: 61, unitTo: 75 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想五天背完七十五个单词，每天背十个、十五个、十五个、二十个、十五个单词",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想五天背完七十五个单词，每天背十个、十五个、十五个、二十个、十五个单词",
    horizonDays: 5,
    totalUnits: 75,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 25 },
      { day: 3, unitFrom: 26, unitTo: 40 },
      { day: 4, unitFrom: 41, unitTo: 60 },
      { day: 5, unitFrom: 61, unitTo: 75 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想五天背完七十五个单词，每日背十个、十五个、十五个、二十个、十五个单词",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想五天背完七十五个单词，每日背十个、十五个、十五个、二十个、十五个单词",
    horizonDays: 5,
    totalUnits: 75,
    dailyPortions: [
      { day: 1, unitFrom: 1, unitTo: 10 },
      { day: 2, unitFrom: 11, unitTo: 25 },
      { day: 3, unitFrom: 26, unitTo: 40 },
      { day: 4, unitFrom: 41, unitTo: 60 },
      { day: 5, unitFrom: 61, unitTo: 75 },
    ],
  });

  expect(
    routeIncomingMessage(
      message({
        text: "我想5天做完75题口算，每天分别做10题、15题、20题",
      }),
    ),
  ).toEqual({
    kind: "task_goal",
    text: "我想5天做完75题口算，每天分别做10题、15题、20题",
    horizonDays: 5,
    totalUnits: 75,
  });
});

test("router：识别任务反馈", () => {
  expect(routeIncomingMessage(message({ text: " 今天的阅读太难了 " }))).toEqual({
    kind: "task_feedback",
    feedback: "too_hard",
    text: "今天的阅读太难了",
  });

  expect(routeIncomingMessage(message({ text: "读完了" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "读完了",
  });
});

test("router：识别任务反馈里的细粒度完成进度", () => {
  expect(routeIncomingMessage(message({ text: "今天只读到第3章" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天只读到第3章",
    completedUnit: 3,
  });

  expect(routeIncomingMessage(message({ text: "今天只读到第四章" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天只读到第四章",
    completedUnit: 4,
  });

  expect(routeIncomingMessage(message({ text: "今天读到第3章" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天读到第3章",
    completedUnit: 3,
  });

  expect(routeIncomingMessage(message({ text: "今天读到了第3章" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天读到了第3章",
    completedUnit: 3,
  });

  expect(routeIncomingMessage(message({ text: "今天读到第3章左右" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天读到第3章左右",
    completedUnit: 3,
  });

  expect(routeIncomingMessage(message({ text: "《口算》做到20题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》做到20题",
    targetTitle: "口算",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "《口算》做到了第20题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》做到了第20题",
    targetTitle: "口算",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天做到第20题左右" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天做到第20题左右",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天做到大概20题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天做到大概20题",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天做到20题上下" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天做到20题上下",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天学到第8课" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天学到第8课",
    completedUnit: 8,
  });

  expect(routeIncomingMessage(message({ text: "今天复习到第3课" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天复习到第3课",
    completedUnit: 3,
  });

  expect(routeIncomingMessage(message({ text: "今天预习到了第2课" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天预习到了第2课",
    completedUnit: 2,
  });

  expect(routeIncomingMessage(message({ text: "今天只背了20个词" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天只背了20个词",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天只背了二十个词" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天只背了二十个词",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天完成了20题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天完成了20题",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天完成了二十题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天完成了二十题",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天做了20题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天做了20题",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天做了大概20题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天做了大概20题",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天背了大约二十个词" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天背了大约二十个词",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天完成了约二十题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天完成了约二十题",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天做了20道题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天做了20道题",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天只做了二十道题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天只做了二十道题",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天最多做10题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天最多做10题",
    completedUnit: 10,
  });

  expect(routeIncomingMessage(message({ text: "今天最多做10道题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天最多做10道题",
    completedUnit: 10,
  });

  expect(routeIncomingMessage(message({ text: "今天顶多背二十个词" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天顶多背二十个词",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天只能做10题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天只能做10题",
    completedUnit: 10,
  });

  expect(routeIncomingMessage(message({ text: "今天只来得及背二十个词" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天只来得及背二十个词",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天只来得及10题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天只来得及10题",
    completedUnit: 10,
  });

  expect(routeIncomingMessage(message({ text: "今天最多二十个词" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天最多二十个词",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天刷完20题" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "今天刷完20题",
    completedUnit: 20,
  });

  expect(routeIncomingMessage(message({ text: "今天写了3页" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天写了3页",
    completedUnit: 3,
  });

  expect(routeIncomingMessage(message({ text: "今天只写了3页" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天只写了3页",
    completedUnit: 3,
  });

  expect(routeIncomingMessage(message({ text: "今天少背了10个词" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天少背了10个词",
    remainingUnits: 10,
  });

  expect(routeIncomingMessage(message({ text: "数学还差3题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "数学还差3题",
    remainingUnits: 3,
  });

  expect(routeIncomingMessage(message({ text: "今天还剩3题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天还剩3题",
    remainingUnits: 3,
  });

  expect(routeIncomingMessage(message({ text: "今天剩三题没做" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天剩三题没做",
    remainingUnits: 3,
  });

  expect(routeIncomingMessage(message({ text: "今天还有三题没做" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天还有三题没做",
    remainingUnits: 3,
  });

  expect(routeIncomingMessage(message({ text: "《口算》剩三题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》剩三题",
    targetTitle: "口算",
    remainingUnits: 3,
  });

  expect(routeIncomingMessage(message({ text: "《口算》还有三题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》还有三题",
    targetTitle: "口算",
    remainingUnits: 3,
  });

  expect(routeIncomingMessage(message({ text: "今天没完成" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天没完成",
  });

  expect(routeIncomingMessage(message({ text: "昨天没完成" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "昨天没完成",
    dateOffsetDays: -1,
  });

  expect(routeIncomingMessage(message({ text: "今天做了一半" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天做了一半",
    completedRatio: 0.5,
  });

  expect(routeIncomingMessage(message({ text: "今天完成三分之一" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天完成三分之一",
    completedRatio: 1 / 3,
  });

  expect(routeIncomingMessage(message({ text: "今天做了三分之一多一点" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天做了三分之一多一点",
    completedRatio: 1 / 3,
  });

  expect(routeIncomingMessage(message({ text: "今天做了七成" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天做了七成",
    completedRatio: 0.7,
  });

  expect(routeIncomingMessage(message({ text: "今天完成8成" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天完成8成",
    completedRatio: 0.8,
  });

  expect(routeIncomingMessage(message({ text: "今天完成100%" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "今天完成100%",
  });

  expect(routeIncomingMessage(message({ text: "今天一半了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天一半了",
    completedRatio: 0.5,
  });

  expect(routeIncomingMessage(message({ text: "今天还差一半" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天还差一半",
    completedRatio: 0.5,
  });

  expect(routeIncomingMessage(message({ text: "今天还差三分之一" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天还差三分之一",
    completedRatio: 1 - 1 / 3,
  });

  expect(routeIncomingMessage(message({ text: "今天剩下三分之一没做" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天剩下三分之一没做",
    completedRatio: 1 - 1 / 3,
  });

  expect(routeIncomingMessage(message({ text: "今天还剩50%" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天还剩50%",
    completedRatio: 0.5,
  });

  expect(routeIncomingMessage(message({ text: "今天差不多一半" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天差不多一半",
    completedRatio: 0.5,
  });

  expect(routeIncomingMessage(message({ text: "今天基本一半了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天基本一半了",
    completedRatio: 0.5,
  });

  expect(routeIncomingMessage(message({ text: "今天一半多一点" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天一半多一点",
    completedRatio: 0.6,
  });

  expect(routeIncomingMessage(message({ text: "《口算》一半多一点" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》一半多一点",
    targetTitle: "口算",
    completedRatio: 0.6,
  });

  expect(routeIncomingMessage(message({ text: "今天一半多了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天一半多了",
    completedRatio: 0.6,
  });

  expect(routeIncomingMessage(message({ text: "今天做了一半多" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天做了一半多",
    completedRatio: 0.6,
  });

  expect(routeIncomingMessage(message({ text: "今天不到一半" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天不到一半",
    completedRatio: 0.4,
  });

  expect(routeIncomingMessage(message({ text: "今天做了不到一半" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天做了不到一半",
    completedRatio: 0.4,
  });

  expect(routeIncomingMessage(message({ text: "今天完成了一半不到" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天完成了一半不到",
    completedRatio: 0.4,
  });

  expect(routeIncomingMessage(message({ text: "今天没过半" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天没过半",
    completedRatio: 0.4,
  });

  expect(routeIncomingMessage(message({ text: "今天没超过一半" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天没超过一半",
    completedRatio: 0.4,
  });

  expect(routeIncomingMessage(message({ text: "今天不到50%" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天不到50%",
    completedRatio: 0.4,
  });

  expect(routeIncomingMessage(message({ text: "今天完成不到50%" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天完成不到50%",
    completedRatio: 0.4,
  });

  expect(routeIncomingMessage(message({ text: "今天50%不到" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天50%不到",
    completedRatio: 0.4,
  });

  expect(routeIncomingMessage(message({ text: "《口算》还没到一半" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》还没到一半",
    targetTitle: "口算",
    completedRatio: 0.4,
  });

  expect(routeIncomingMessage(message({ text: "今天超过一半了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天超过一半了",
    completedRatio: 0.6,
  });

  expect(routeIncomingMessage(message({ text: "《口算》过半了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》过半了",
    targetTitle: "口算",
    completedRatio: 0.6,
  });

  expect(routeIncomingMessage(message({ text: "今天完成过半" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天完成过半",
    completedRatio: 0.6,
  });

  expect(routeIncomingMessage(message({ text: "今天完成了一小半" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天完成了一小半",
    completedRatio: 1 / 3,
  });

  expect(routeIncomingMessage(message({ text: "今天大半了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天大半了",
    completedRatio: 0.75,
  });

  expect(routeIncomingMessage(message({ text: "《口算》大半了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》大半了",
    targetTitle: "口算",
    completedRatio: 0.75,
  });

  expect(routeIncomingMessage(message({ text: "今天快做完了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天快做完了",
    completedRatio: 0.9,
  });

  expect(routeIncomingMessage(message({ text: "今天差一点就完成了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天差一点就完成了",
    completedRatio: 0.9,
  });

  expect(routeIncomingMessage(message({ text: "《口算》还差一点" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》还差一点",
    targetTitle: "口算",
    completedRatio: 0.9,
  });

  expect(routeIncomingMessage(message({ text: "今天还剩一点没做" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天还剩一点没做",
    completedRatio: 0.9,
  });

  expect(routeIncomingMessage(message({ text: "《口算》只剩一点没写" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》只剩一点没写",
    targetTitle: "口算",
    completedRatio: 0.9,
  });

  expect(routeIncomingMessage(message({ text: "今天只剩一点就做完了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天只剩一点就做完了",
    completedRatio: 0.9,
  });

  expect(routeIncomingMessage(message({ text: "今天还差一点没做完" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天还差一点没做完",
    completedRatio: 0.9,
  });

  expect(routeIncomingMessage(message({ text: "《口算》还差一点没写完" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》还差一点没写完",
    targetTitle: "口算",
    completedRatio: 0.9,
  });

  expect(routeIncomingMessage(message({ text: "今天差不多做完了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天差不多做完了",
    completedRatio: 0.9,
  });

  expect(routeIncomingMessage(message({ text: "《口算》基本完成了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》基本完成了",
    targetTitle: "口算",
    completedRatio: 0.9,
  });

  expect(routeIncomingMessage(message({ text: "今天快搞定了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天快搞定了",
    completedRatio: 0.9,
  });

  expect(routeIncomingMessage(message({ text: "《口算》基本搞定了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》基本搞定了",
    targetTitle: "口算",
    completedRatio: 0.9,
  });

  expect(routeIncomingMessage(message({ text: "今天差一点搞完" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天差一点搞完",
    completedRatio: 0.9,
  });

  expect(routeIncomingMessage(message({ text: "今天刚开始做" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天刚开始做",
    completedRatio: 0.1,
  });

  expect(routeIncomingMessage(message({ text: "今天只做了一点点" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天只做了一点点",
    completedRatio: 0.1,
  });

  expect(routeIncomingMessage(message({ text: "《口算》没做多少" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》没做多少",
    targetTitle: "口算",
    completedRatio: 0.1,
  });

  expect(routeIncomingMessage(message({ text: "今天没怎么做" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天没怎么做",
    completedRatio: 0.1,
  });

  expect(routeIncomingMessage(message({ text: "《口算》几乎没写" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》几乎没写",
    targetTitle: "口算",
    completedRatio: 0.1,
  });

  expect(routeIncomingMessage(message({ text: "今天基本没背" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天基本没背",
    completedRatio: 0.1,
  });

  expect(routeIncomingMessage(message({ text: "今天没怎么写完" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天没怎么写完",
    completedRatio: 0.1,
  });

  expect(routeIncomingMessage(message({ text: "今天少背了一百零五个词" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "今天少背了一百零五个词",
    remainingUnits: 105,
  });

  expect(routeIncomingMessage(message({ text: "今天多背了10个词" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "今天多背了10个词",
    extraUnits: 10,
  });

  expect(routeIncomingMessage(message({ text: "今天额外做了三题" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "今天额外做了三题",
    extraUnits: 3,
  });
});

test("router：识别任务反馈里点名的目标", () => {
  expect(routeIncomingMessage(message({ text: "《小王子》今天读完了" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "《小王子》今天读完了",
    targetTitle: "小王子",
  });

  expect(routeIncomingMessage(message({ text: "《口算》今天超额做了5题" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "《口算》今天超额做了5题",
    targetTitle: "口算",
    extraUnits: 5,
  });

  expect(routeIncomingMessage(message({ text: "《口算》一半了" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》一半了",
    targetTitle: "口算",
    completedRatio: 0.5,
  });

  expect(routeIncomingMessage(message({ text: "《口算》百分之百了" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "《口算》百分之百了",
    targetTitle: "口算",
  });

  expect(routeIncomingMessage(message({ text: "《口算》剩下三题" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》剩下三题",
    targetTitle: "口算",
    remainingUnits: 3,
  });

  expect(routeIncomingMessage(message({ text: "《口算》没完成" }))).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "《口算》没完成",
    targetTitle: "口算",
  });
});

test("router：识别更自然的完成反馈和跳过反馈", () => {
  expect(routeIncomingMessage(message({ text: "今天读完第4章了" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "今天读完第4章了",
    completedUnit: 4,
  });

  expect(routeIncomingMessage(message({ text: "今天读完第四章" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "今天读完第四章",
    completedUnit: 4,
  });

  expect(routeIncomingMessage(message({ text: "完成第2节" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "完成第2节",
    completedUnit: 2,
  });

  expect(routeIncomingMessage(message({ text: "今天完成第四章" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "今天完成第四章",
    completedUnit: 4,
  });

  expect(routeIncomingMessage(message({ text: "今天搞定了" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "今天搞定了",
  });

  expect(routeIncomingMessage(message({ text: "《小王子》打卡了" }))).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "《小王子》打卡了",
    targetTitle: "小王子",
  });

  expect(routeIncomingMessage(message({ text: "今天休息，明天补" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天休息，明天补",
    deferDays: 1,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "今天休息，周五补",
        ts: Date.parse("2026-06-24T20:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天休息，周五补",
    deferDays: 2,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "今天休息，下周一继续做",
        ts: Date.parse("2026-06-24T20:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天休息，下周一继续做",
    deferDays: 5,
  });

  expect(routeIncomingMessage(message({ text: "今天请假" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天请假",
  });

  expect(routeIncomingMessage(message({ text: "昨天请假" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "昨天请假",
    dateOffsetDays: -1,
  });

  expect(routeIncomingMessage(message({ text: "明天请假" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "明天请假",
    dateOffsetDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "明天停课" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "明天停课",
    dateOffsetDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "后天休息" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "后天休息",
    dateOffsetDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "《口算》明天请假" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "《口算》明天请假",
    targetTitle: "口算",
    dateOffsetDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "明天不做了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "明天不做了",
    dateOffsetDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "后天不读了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "后天不读了",
    dateOffsetDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "明天有事" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "明天有事",
    dateOffsetDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "后天有安排" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "后天有安排",
    dateOffsetDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "明天作业太多了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "明天作业太多了",
    dateOffsetDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "后天事情太多了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "后天事情太多了",
    dateOffsetDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "明天来不及做" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "明天来不及做",
    dateOffsetDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "《口算》明天不做了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "《口算》明天不做了",
    targetTitle: "口算",
    dateOffsetDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "明天没法做了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "明天没法做了",
    dateOffsetDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "后天没办法读" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "后天没办法读",
    dateOffsetDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "明天不方便" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "明天不方便",
    dateOffsetDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "后天不方便继续学" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "后天不方便继续学",
    dateOffsetDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "明天完成不了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "明天完成不了",
    dateOffsetDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "后天任务搞不定" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "后天任务搞不定",
    dateOffsetDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "《口算》明天没法做了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "《口算》明天没法做了",
    targetTitle: "口算",
    dateOffsetDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "前天停课" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "前天停课",
    dateOffsetDays: -2,
  });

  expect(routeIncomingMessage(message({ text: "昨天休息" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "昨天休息",
    dateOffsetDays: -1,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "6月24日请假",
        ts: Date.parse("2026-06-25T20:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "6月24日请假",
    feedbackDate: "2026-06-24",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "周五请假",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "周五请假",
    feedbackDate: "2026-06-26",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "这周五请假",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这周五请假",
    feedbackDate: "2026-06-26",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "这周一请假",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这周一请假",
    feedbackDate: "2026-06-22",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "上周五请假",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "上周五请假",
    feedbackDate: "2026-06-19",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "下周一停课",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "下周一停课",
    feedbackDate: "2026-06-29",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "周五有事",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "周五有事",
    feedbackDate: "2026-06-26",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "这周一没法做了",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这周一没法做了",
    feedbackDate: "2026-06-22",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "上周五作业太多了",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "上周五作业太多了",
    feedbackDate: "2026-06-19",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "周五没读",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "周五没读",
    feedbackDate: "2026-06-26",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "这周一没做",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这周一没做",
    feedbackDate: "2026-06-22",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "上周五没背",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "上周五没背",
    feedbackDate: "2026-06-19",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "周五忘记做了",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "周五忘记做了",
    feedbackDate: "2026-06-26",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "这周一漏做了",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这周一漏做了",
    feedbackDate: "2026-06-22",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "上周五还没开始",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "上周五还没开始",
    feedbackDate: "2026-06-19",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "周五还没动笔",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "周五还没动笔",
    feedbackDate: "2026-06-26",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "周五做了一半",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "周五做了一半",
    completedRatio: 0.5,
    feedbackDate: "2026-06-26",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "这周一做了10题",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "这周一做了10题",
    completedUnit: 10,
    feedbackDate: "2026-06-22",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "上周五还剩3题",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "partial",
    text: "上周五还剩3题",
    remainingUnits: 3,
    feedbackDate: "2026-06-19",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "下周一多做了5题",
        ts: Date.parse("2026-06-24T08:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "done",
    text: "下周一多做了5题",
    extraUnits: 5,
    feedbackDate: "2026-06-29",
  });

  expect(routeIncomingMessage(message({ text: "今天歇一天，明天再做" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天歇一天，明天再做",
    deferDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "今天先不读了，后天补" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天先不读了，后天补",
    deferDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "今晚不做了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今晚不做了",
  });

  expect(routeIncomingMessage(message({ text: "这次不做了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这次不做了",
  });

  expect(routeIncomingMessage(message({ text: "今天没读" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天没读",
  });

  expect(routeIncomingMessage(message({ text: "今天来不及做了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天来不及做了",
  });

  expect(routeIncomingMessage(message({ text: "今天没来得及做" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天没来得及做",
  });

  expect(routeIncomingMessage(message({ text: "今天一点都没做" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天一点都没做",
  });

  expect(routeIncomingMessage(message({ text: "今天还没开始做" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天还没开始做",
  });

  expect(routeIncomingMessage(message({ text: "《口算》还没开始" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "《口算》还没开始",
    targetTitle: "口算",
  });

  expect(routeIncomingMessage(message({ text: "今天还没动笔" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天还没动笔",
  });

  expect(routeIncomingMessage(message({ text: "《口算》今天还没碰" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "《口算》今天还没碰",
    targetTitle: "口算",
  });

  expect(routeIncomingMessage(message({ text: "昨天没来得及读" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "昨天没来得及读",
    dateOffsetDays: -1,
  });

  expect(routeIncomingMessage(message({ text: "今天没顾上做" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天没顾上做",
  });

  expect(routeIncomingMessage(message({ text: "《口算》没顾得上做" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "《口算》没顾得上做",
    targetTitle: "口算",
  });

  expect(routeIncomingMessage(message({ text: "今天没赶上做" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天没赶上做",
  });

  expect(routeIncomingMessage(message({ text: "今天来不及了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天来不及了",
  });

  expect(routeIncomingMessage(message({ text: "今天做不完了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天做不完了",
  });

  expect(routeIncomingMessage(message({ text: "今天写不了了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天写不了了",
  });

  expect(routeIncomingMessage(message({ text: "今天完成不了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天完成不了",
  });

  expect(routeIncomingMessage(message({ text: "今晚完成不了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今晚完成不了",
  });

  expect(routeIncomingMessage(message({ text: "今天任务搞不定" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天任务搞不定",
  });

  expect(routeIncomingMessage(message({ text: "今天没法做了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天没法做了",
  });

  expect(routeIncomingMessage(message({ text: "今天不方便" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天不方便",
  });

  expect(routeIncomingMessage(message({ text: "今晚没办法" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今晚没办法",
  });

  expect(routeIncomingMessage(message({ text: "这次没法继续了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这次没法继续了",
  });

  expect(routeIncomingMessage(message({ text: "今天太晚了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天太晚了",
  });

  expect(routeIncomingMessage(message({ text: "今天太困了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天太困了",
  });

  expect(routeIncomingMessage(message({ text: "今天有点累" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天有点累",
  });

  expect(routeIncomingMessage(message({ text: "今天提不起劲" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天提不起劲",
  });

  expect(routeIncomingMessage(message({ text: "今天太晚了，明天再做" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天太晚了，明天再做",
    deferDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "今天太忙了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天太忙了",
  });

  expect(routeIncomingMessage(message({ text: "今天作业太多了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天作业太多了",
  });

  expect(routeIncomingMessage(message({ text: "今天事情太多了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天事情太多了",
  });

  expect(routeIncomingMessage(message({ text: "今天事太多了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天事太多了",
  });

  expect(routeIncomingMessage(message({ text: "今天太多事了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天太多事了",
  });

  expect(routeIncomingMessage(message({ text: "今天生病了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天生病了",
  });

  expect(routeIncomingMessage(message({ text: "今天发烧了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天发烧了",
  });

  expect(routeIncomingMessage(message({ text: "今天感冒了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天感冒了",
  });

  expect(routeIncomingMessage(message({ text: "今天拉肚子" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天拉肚子",
  });

  expect(routeIncomingMessage(message({ text: "今晚难受" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今晚难受",
  });

  expect(routeIncomingMessage(message({ text: "昨天感冒了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "昨天感冒了",
    dateOffsetDays: -1,
  });

  expect(routeIncomingMessage(message({ text: "《口算》今天感冒了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "《口算》今天感冒了",
    targetTitle: "口算",
  });

  expect(routeIncomingMessage(message({ text: "今天头疼" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天头疼",
  });

  expect(routeIncomingMessage(message({ text: "今天头痛" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天头痛",
  });

  expect(routeIncomingMessage(message({ text: "今天肚子疼" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天肚子疼",
  });

  expect(routeIncomingMessage(message({ text: "今晚嗓子疼" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今晚嗓子疼",
  });

  expect(routeIncomingMessage(message({ text: "今天咳嗽" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天咳嗽",
  });

  expect(routeIncomingMessage(message({ text: "今晚状态不好" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今晚状态不好",
  });

  expect(routeIncomingMessage(message({ text: "今晚没状态" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今晚没状态",
  });

  expect(routeIncomingMessage(message({ text: "今天状态不行" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天状态不行",
  });

  expect(routeIncomingMessage(message({ text: "今天临时有事" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天临时有事",
  });

  expect(routeIncomingMessage(message({ text: "今天不想做了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天不想做了",
  });

  expect(routeIncomingMessage(message({ text: "今天忘记做了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天忘记做了",
  });

  expect(routeIncomingMessage(message({ text: "今天忘了做" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天忘了做",
  });

  expect(routeIncomingMessage(message({ text: "今天漏做了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "今天漏做了",
  });

  expect(routeIncomingMessage(message({ text: "昨天忘了读" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "昨天忘了读",
    dateOffsetDays: -1,
  });

  expect(routeIncomingMessage(message({ text: "《口算》忘记做了" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "《口算》忘记做了",
    targetTitle: "口算",
  });

  expect(routeIncomingMessage(message({ text: "昨天没读" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "昨天没读",
    dateOffsetDays: -1,
  });

  expect(
    routeIncomingMessage(
      message({
        text: "6月24日没读",
        ts: Date.parse("2026-06-25T20:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "6月24日没读",
    feedbackDate: "2026-06-24",
  });

  expect(
    routeIncomingMessage(
      message({
        text: "2025年12月31日没读",
        ts: Date.parse("2026-06-25T20:00:00.000Z"),
      }),
    ),
  ).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "2025年12月31日没读",
    feedbackDate: "2025-12-31",
  });

  expect(routeIncomingMessage(message({ text: "这两天没读" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这两天没读",
    deferDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "最近三天没读" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "最近三天没读",
    deferDays: 3,
  });

  expect(routeIncomingMessage(message({ text: "最近一周没读" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "最近一周没读",
    deferDays: 7,
  });

  expect(routeIncomingMessage(message({ text: "最近一星期没读" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "最近一星期没读",
    deferDays: 7,
  });

  expect(routeIncomingMessage(message({ text: "过去两个星期没背" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "过去两个星期没背",
    deferDays: 14,
  });

  expect(routeIncomingMessage(message({ text: "这周没读" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这周没读",
    deferDays: 7,
  });

  expect(routeIncomingMessage(message({ text: "这礼拜没做" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这礼拜没做",
    deferDays: 7,
  });

  expect(routeIncomingMessage(message({ text: "上礼拜没做" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "上礼拜没做",
    deferDays: 7,
  });

  expect(routeIncomingMessage(message({ text: "这两天太忙，顺延2天" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这两天太忙，顺延2天",
    deferDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "这两天太忙，顺延两天" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这两天太忙，顺延两天",
    deferDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "这两天请假" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这两天请假",
    deferDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "休息三天" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "休息三天",
    deferDays: 3,
  });

  expect(routeIncomingMessage(message({ text: "休两天" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "休两天",
    deferDays: 2,
  });

  expect(routeIncomingMessage(message({ text: "停一天课" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "停一天课",
    deferDays: 1,
  });

  expect(routeIncomingMessage(message({ text: "这礼拜请假" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "这礼拜请假",
    deferDays: 7,
  });

  expect(routeIncomingMessage(message({ text: "最近一星期请假" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "最近一星期请假",
    deferDays: 7,
  });

  expect(routeIncomingMessage(message({ text: "请两个星期假" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "请两个星期假",
    deferDays: 14,
  });

  expect(routeIncomingMessage(message({ text: "休息一礼拜" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "休息一礼拜",
    deferDays: 7,
  });

  expect(routeIncomingMessage(message({ text: "停课一周" }))).toEqual({
    kind: "task_feedback",
    feedback: "skip",
    text: "停课一周",
    deferDays: 7,
  });
});

test("router：识别暂停任务指令", () => {
  expect(routeIncomingMessage(message({ text: "暂停这个任务" }))).toEqual({
    kind: "task_pause",
    text: "暂停这个任务",
  });

  expect(routeIncomingMessage(message({ text: "这个任务先放一放" }))).toEqual({
    kind: "task_pause",
    text: "这个任务先放一放",
  });

  expect(routeIncomingMessage(message({ text: "暂停《小王子》" }))).toEqual({
    kind: "task_pause",
    text: "暂停《小王子》",
    targetTitle: "小王子",
  });

  expect(routeIncomingMessage(message({ text: "《小王子》先放一放" }))).toEqual({
    kind: "task_pause",
    text: "《小王子》先放一放",
    targetTitle: "小王子",
  });
});

test("router：识别恢复任务指令", () => {
  expect(routeIncomingMessage(message({ text: "恢复这个任务" }))).toEqual({
    kind: "task_resume",
    text: "恢复这个任务",
  });

  expect(routeIncomingMessage(message({ text: "这个任务继续做" }))).toEqual({
    kind: "task_resume",
    text: "这个任务继续做",
  });

  expect(routeIncomingMessage(message({ text: "恢复《小王子》" }))).toEqual({
    kind: "task_resume",
    text: "恢复《小王子》",
    targetTitle: "小王子",
  });

  expect(routeIncomingMessage(message({ text: "《小王子》重新捡起来" }))).toEqual({
    kind: "task_resume",
    text: "《小王子》重新捡起来",
    targetTitle: "小王子",
  });
});

test("router：空消息忽略", () => {
  expect(routeIncomingMessage(message({ mentionsBot: true, text: "   " }))).toEqual({
    kind: "ignore",
    reason: "empty_message",
  });
});

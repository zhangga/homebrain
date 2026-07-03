import { expect, test } from "bun:test";
import { createTaskStore } from "./store";

test("task store：创建学习目标并按成员列出", () => {
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T08:00:00.000Z",
    createId: (kind) => `${kind}-1`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "dad",
      title: "小王子",
      sourceText: "我想30天读完《小王子》",
      horizonDays: 30,
    });

    expect(goal).toEqual({
      id: "goal-1",
      memberSlug: "dad",
      title: "小王子",
      sourceText: "我想30天读完《小王子》",
      horizonDays: 30,
      status: "active",
      createdAt: "2026-06-24T08:00:00.000Z",
      updatedAt: "2026-06-24T08:00:00.000Z",
    });
    expect(store.listGoals({ memberSlug: "dad" })).toEqual([goal]);
    expect(store.listGoals({ memberSlug: "mom" })).toEqual([]);
  } finally {
    store.close();
  }
});

test("task store：记录任务反馈并可按成员列出", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T09:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "dad",
      title: "小王子",
      sourceText: "我想读完《小王子》",
    });
    const feedback = store.recordFeedback({
      memberSlug: "dad",
      goalId: goal.id,
      feedback: "too_hard",
      note: "今天的阅读太难了",
    });

    expect(feedback).toEqual({
      id: "feedback-2",
      memberSlug: "dad",
      goalId: "goal-1",
      feedback: "too_hard",
      note: "今天的阅读太难了",
      createdAt: "2026-06-24T09:00:00.000Z",
    });
    expect(store.listFeedback({ memberSlug: "dad" })).toEqual([feedback]);
    expect(store.listFeedback({ memberSlug: "mom" })).toEqual([]);
  } finally {
    store.close();
  }
});

test("task store：为目标生成每日份额并查询待派发项", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T10:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想3天读完《小王子》",
      horizonDays: 3,
    });

    const portions = store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 10,
      days: 3,
    });

    expect(portions).toEqual([
      {
        goalId: "goal-1",
        date: "2026-06-24",
        unitFrom: 1,
        unitTo: 4,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-25",
        unitFrom: 5,
        unitTo: 7,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-26",
        unitFrom: 8,
        unitTo: 10,
        dispatched: false,
      },
    ]);
    expect(store.listDuePortions({ date: "2026-06-24" })).toEqual([
      { ...portions[0]!, memberSlug: "kid", title: "小王子" },
    ]);
  } finally {
    store.close();
  }
});

test("task store：计划每日份额时跳过休息日", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-26T10:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想3天读完10章《小王子》，周末休息",
      horizonDays: 3,
    });

    const portions = store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-26",
      totalUnits: 10,
      days: 3,
      restWeekdays: [0, 6],
    });

    expect(portions).toEqual([
      {
        goalId: "goal-1",
        date: "2026-06-26",
        unitFrom: 1,
        unitTo: 4,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-29",
        unitFrom: 5,
        unitTo: 7,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-30",
        unitFrom: 8,
        unitTo: 10,
        dispatched: false,
      },
    ]);
    expect(store.listDuePortions({ date: "2026-06-27" })).toEqual([]);
    expect(store.listDuePortions({ date: "2026-06-29" })).toEqual([
      { ...portions[1]!, memberSlug: "kid", title: "小王子" },
    ]);
  } finally {
    store.close();
  }
});

test("task store：计划每日份额时支持隔天派发", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T10:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "口算",
      sourceText: "我想4天做完40题口算，隔天做",
      horizonDays: 4,
    });

    const portions = store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 40,
      days: 4,
      dateSpacingDays: 2,
    });

    expect(portions).toEqual([
      {
        goalId: "goal-1",
        date: "2026-06-24",
        unitFrom: 1,
        unitTo: 10,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-26",
        unitFrom: 11,
        unitTo: 20,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-28",
        unitFrom: 21,
        unitTo: 30,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-30",
        unitFrom: 31,
        unitTo: 40,
        dispatched: false,
      },
    ]);
    expect(store.listGoals({ memberSlug: "kid" })).toEqual([
      {
        ...goal,
        dateSpacingDays: 2,
      },
    ]);
    expect(store.listDuePortions({ date: "2026-06-25" })).toEqual([]);
    expect(store.listDuePortions({ date: "2026-06-26" })).toEqual([
      { ...portions[1]!, memberSlug: "kid", title: "口算" },
    ]);
  } finally {
    store.close();
  }
});

test("task store：计划每日份额时支持连续学习若干天后休息若干天", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T10:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "口算",
      sourceText: "我想5天做完50题口算，做两天休一天",
      horizonDays: 5,
    });

    const portions = store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 50,
      days: 5,
      activeRestCycle: { activeDays: 2, restDays: 1 },
    });

    expect(portions).toEqual([
      {
        goalId: "goal-1",
        date: "2026-06-24",
        unitFrom: 1,
        unitTo: 10,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-25",
        unitFrom: 11,
        unitTo: 20,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-27",
        unitFrom: 21,
        unitTo: 30,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-28",
        unitFrom: 31,
        unitTo: 40,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-30",
        unitFrom: 41,
        unitTo: 50,
        dispatched: false,
      },
    ]);
    expect(store.listGoals({ memberSlug: "kid" })).toEqual([
      {
        ...goal,
        activeRestCycle: { activeDays: 2, restDays: 1 },
      },
    ]);
    expect(store.listDuePortions({ date: "2026-06-26" })).toEqual([]);
    expect(store.listDuePortions({ date: "2026-06-27" })).toEqual([
      { ...portions[2]!, memberSlug: "kid", title: "口算" },
    ]);
  } finally {
    store.close();
  }
});

test("task store：按 planner 给出的非均摊份额写入每日计划", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T10:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "自然拼读",
      sourceText: "我想一周内学完自然拼读，周三休息",
      horizonDays: 4,
    });

    const portions = store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 8,
      days: 4,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 1 },
        { day: 2, unitFrom: 2, unitTo: 4 },
        { day: 4, unitFrom: 5, unitTo: 8 },
      ],
    });

    expect(portions).toEqual([
      {
        goalId: "goal-1",
        date: "2026-06-24",
        unitFrom: 1,
        unitTo: 1,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-25",
        unitFrom: 2,
        unitTo: 4,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-27",
        unitFrom: 5,
        unitTo: 8,
        dispatched: false,
      },
    ]);
    expect(store.listDuePortions({ date: "2026-06-26" })).toEqual([]);
    expect(store.listDuePortions({ date: "2026-06-27" })).toEqual([
      { ...portions[2]!, memberSlug: "kid", title: "自然拼读" },
    ]);
  } finally {
    store.close();
  }
});

test("task store：非均摊份额按学习日序号落到日期", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T10:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "自然拼读",
      sourceText: "我想一周内学完自然拼读，周三休息",
      horizonDays: 4,
    });

    const portions = store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 8,
      days: 4,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 1 },
        { day: 2, unitFrom: 2, unitTo: 4 },
        { day: 4, unitFrom: 5, unitTo: 8 },
      ],
      restWeekdays: [3],
    });

    expect(portions).toEqual([
      {
        goalId: "goal-1",
        date: "2026-06-25",
        unitFrom: 1,
        unitTo: 1,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-26",
        unitFrom: 2,
        unitTo: 4,
        dispatched: false,
      },
      {
        goalId: "goal-1",
        date: "2026-06-28",
        unitFrom: 5,
        unitTo: 8,
        dispatched: false,
      },
    ]);
    expect(store.listDuePortions({ date: "2026-06-24" })).toEqual([]);
    expect(store.listDuePortions({ date: "2026-06-25" })).toEqual([
      { ...portions[0]!, memberSlug: "kid", title: "自然拼读" },
    ]);
  } finally {
    store.close();
  }
});

test("task store：标记份额已派发后不再出现在待派发列表", () => {
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T10:00:00.000Z",
    createId: (kind) => `${kind}-1`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想读完《小王子》",
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 1,
      days: 1,
    });

    expect(store.listDuePortions({ date: "2026-06-24" })).toHaveLength(1);
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-24" });
    expect(store.listDuePortions({ date: "2026-06-24" })).toEqual([]);
  } finally {
    store.close();
  }
});

test("task store：记录当天份额反馈后重排后续未完成单元", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T20:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想3天读完10章《小王子》",
      horizonDays: 3,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 10,
      days: 3,
    });
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-24" });

    const result = store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-24",
      feedback: "too_hard",
      note: "今天太难了",
    });

    expect(result).toEqual({
      goalCompleted: false,
      portion: {
        goalId: "goal-1",
        date: "2026-06-24",
        unitFrom: 1,
        unitTo: 4,
        dispatched: true,
        feedback: "too_hard",
        note: "今天太难了",
      },
      replanned: [
        {
          goalId: "goal-1",
          date: "2026-06-25",
          unitFrom: 1,
          unitTo: 5,
          dispatched: false,
        },
        {
          goalId: "goal-1",
          date: "2026-06-26",
          unitFrom: 6,
          unitTo: 10,
          dispatched: false,
        },
      ],
    });
    expect(store.listDuePortions({ date: "2026-06-24" })).toEqual([]);
    expect(store.listDuePortions({ date: "2026-06-25" })).toEqual([
      {
        goalId: "goal-1",
        memberSlug: "kid",
        title: "小王子",
        date: "2026-06-25",
        unitFrom: 1,
        unitTo: 5,
        dispatched: false,
      },
    ]);
  } finally {
    store.close();
  }
});

test("task store：根据反馈里的已完成单元重排剩余份额", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T20:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想3天读完10章《小王子》",
      horizonDays: 3,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 10,
      days: 3,
    });
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-24" });

    const result = store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天只读到第3章",
      completedUnit: 3,
    });

    expect(result).toEqual({
      goalCompleted: false,
      portion: {
        goalId: "goal-1",
        date: "2026-06-24",
        unitFrom: 1,
        unitTo: 4,
        dispatched: true,
        feedback: "partial",
        note: "今天只读到第3章",
      },
      replanned: [
        {
          goalId: "goal-1",
          date: "2026-06-25",
          unitFrom: 4,
          unitTo: 7,
          dispatched: false,
        },
        {
          goalId: "goal-1",
          date: "2026-06-26",
          unitFrom: 8,
          unitTo: 10,
          dispatched: false,
        },
      ],
    });
  } finally {
    store.close();
  }
});

test("task store：根据反馈里的剩余数量换算当天完成进度", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T20:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "口算",
      sourceText: "我想3天做完30题口算",
      horizonDays: 3,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 30,
      days: 3,
    });
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-24" });

    const result = store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天还差3题",
      remainingUnits: 3,
    });

    expect(result).toEqual({
      goalCompleted: false,
      portion: {
        goalId: "goal-1",
        date: "2026-06-24",
        unitFrom: 1,
        unitTo: 10,
        dispatched: true,
        feedback: "partial",
        note: "今天还差3题",
      },
      replanned: [
        {
          goalId: "goal-1",
          date: "2026-06-25",
          unitFrom: 8,
          unitTo: 19,
          dispatched: false,
        },
        {
          goalId: "goal-1",
          date: "2026-06-26",
          unitFrom: 20,
          unitTo: 30,
          dispatched: false,
        },
      ],
    });
  } finally {
    store.close();
  }
});

test("task store：根据反馈里的完成比例换算当天完成进度", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T20:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "口算",
      sourceText: "我想2天做完20题口算",
      horizonDays: 2,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 20,
      days: 2,
      portions: [
        { day: 1, unitFrom: 1, unitTo: 10 },
        { day: 2, unitFrom: 11, unitTo: 20 },
      ],
    });
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-24" });

    const result = store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-24",
      feedback: "partial",
      note: "今天做了一半",
      completedRatio: 0.5,
    });

    expect(result).toEqual({
      goalCompleted: false,
      portion: {
        goalId: "goal-1",
        date: "2026-06-24",
        unitFrom: 1,
        unitTo: 10,
        dispatched: true,
        feedback: "partial",
        note: "今天做了一半",
      },
      replanned: [
        {
          goalId: "goal-1",
          date: "2026-06-25",
          unitFrom: 6,
          unitTo: 20,
          dispatched: false,
        },
      ],
    });
  } finally {
    store.close();
  }
});

test("task store：根据反馈里的额外完成数量重排剩余份额", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T20:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "口算",
      sourceText: "我想3天做完30题口算",
      horizonDays: 3,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 30,
      days: 3,
    });
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-24" });

    const result = store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-24",
      feedback: "done",
      note: "今天多做了5题",
      extraUnits: 5,
    });

    expect(result).toEqual({
      goalCompleted: false,
      portion: {
        goalId: "goal-1",
        date: "2026-06-24",
        unitFrom: 1,
        unitTo: 10,
        dispatched: true,
        feedback: "done",
        note: "今天多做了5题",
      },
      replanned: [
        {
          goalId: "goal-1",
          date: "2026-06-25",
          unitFrom: 16,
          unitTo: 23,
          dispatched: false,
        },
        {
          goalId: "goal-1",
          date: "2026-06-26",
          unitFrom: 24,
          unitTo: 30,
          dispatched: false,
        },
      ],
    });
  } finally {
    store.close();
  }
});

test("task store：反馈点名目标时更新对应目标的当天份额", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T20:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const littlePrince = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想2天读完4章《小王子》",
      horizonDays: 2,
    });
    store.planDailyPortions({
      goalId: littlePrince.id,
      startDate: "2026-06-24",
      totalUnits: 4,
      days: 2,
    });
    const phonics = store.createGoal({
      memberSlug: "kid",
      title: "自然拼读",
      sourceText: "我想2天学完自然拼读",
      horizonDays: 2,
    });
    store.planDailyPortions({
      goalId: phonics.id,
      startDate: "2026-06-24",
      totalUnits: 4,
      days: 2,
    });

    const result = store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-24",
      feedback: "done",
      note: "《小王子》今天读完了",
      targetTitle: "小王子",
    });

    expect(result?.portion.goalId).toBe(littlePrince.id);
    expect(result?.replanned).toEqual([
      {
        goalId: littlePrince.id,
        date: "2026-06-25",
        unitFrom: 3,
        unitTo: 4,
        dispatched: false,
      },
    ]);
    expect(store.listDuePortions({ date: "2026-06-24" })).toEqual([
      {
        goalId: phonics.id,
        memberSlug: "kid",
        title: "自然拼读",
        date: "2026-06-24",
        unitFrom: 1,
        unitTo: 2,
        dispatched: false,
      },
    ]);
  } finally {
    store.close();
  }
});

test("task store：最后一天跳过时顺延未完成份额", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-25T20:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想2天读完4章《小王子》",
      horizonDays: 2,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 4,
      days: 2,
    });
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-25" });

    const result = store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-25",
      feedback: "skip",
      note: "今天休息，明天补",
    });

    expect(result).toEqual({
      goalCompleted: false,
      portion: {
        goalId: "goal-1",
        date: "2026-06-25",
        unitFrom: 3,
        unitTo: 4,
        dispatched: true,
        feedback: "skip",
        note: "今天休息，明天补",
      },
      replanned: [
        {
          goalId: "goal-1",
          date: "2026-06-26",
          unitFrom: 3,
          unitTo: 4,
          dispatched: false,
        },
      ],
    });
    expect(store.listDuePortions({ date: "2026-06-26" })).toEqual([
      {
        goalId: "goal-1",
        memberSlug: "kid",
        title: "小王子",
        date: "2026-06-26",
        unitFrom: 3,
        unitTo: 4,
        dispatched: false,
      },
    ]);
  } finally {
    store.close();
  }
});

test("task store：最后一天跳过时继续避让目标休息日", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-26T20:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想1天读完2章《小王子》，周末休息",
      horizonDays: 1,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-26",
      totalUnits: 2,
      days: 1,
      restWeekdays: [0, 6],
    });
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-26" });

    const result = store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-26",
      feedback: "skip",
      note: "今天休息，明天补",
    });

    expect(result?.replanned).toEqual([
      {
        goalId: goal.id,
        date: "2026-06-29",
        unitFrom: 1,
        unitTo: 2,
        dispatched: false,
      },
    ]);
    expect(store.listDuePortions({ date: "2026-06-27" })).toEqual([]);
    expect(store.listDuePortions({ date: "2026-06-29" })).toEqual([
      {
        goalId: goal.id,
        memberSlug: "kid",
        title: "小王子",
        date: "2026-06-29",
        unitFrom: 1,
        unitTo: 2,
        dispatched: false,
      },
    ]);
  } finally {
    store.close();
  }
});

test("task store：最后一天跳过时继续避让连续学习休息周期", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-28T20:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "口算",
      sourceText: "我想4天做完40题口算，做两天休一天",
      horizonDays: 4,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 40,
      days: 4,
      activeRestCycle: { activeDays: 2, restDays: 1 },
    });
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-28" });

    const result = store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-28",
      feedback: "skip",
      note: "今天休息，明天补",
    });

    expect(result?.replanned).toEqual([
      {
        goalId: goal.id,
        date: "2026-06-30",
        unitFrom: 31,
        unitTo: 40,
        dispatched: false,
      },
    ]);
    expect(store.listDuePortions({ date: "2026-06-29" })).toEqual([]);
    expect(store.listDuePortions({ date: "2026-06-30" })).toEqual([
      {
        goalId: goal.id,
        memberSlug: "kid",
        title: "口算",
        date: "2026-06-30",
        unitFrom: 31,
        unitTo: 40,
        dispatched: false,
      },
    ]);
  } finally {
    store.close();
  }
});

test("task store：显式顺延天数时整体后移当前和未来未完成份额", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T20:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想3天读完6章《小王子》",
      horizonDays: 3,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 6,
      days: 3,
    });
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-24" });

    const result = store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-24",
      feedback: "skip",
      note: "这两天太忙，顺延2天",
      deferDays: 2,
    });

    expect(result).toEqual({
      goalCompleted: false,
      portion: {
        goalId: goal.id,
        date: "2026-06-24",
        unitFrom: 1,
        unitTo: 2,
        dispatched: true,
        feedback: "skip",
        note: "这两天太忙，顺延2天",
      },
      replanned: [
        {
          goalId: goal.id,
          date: "2026-06-26",
          unitFrom: 1,
          unitTo: 2,
          dispatched: false,
        },
        {
          goalId: goal.id,
          date: "2026-06-27",
          unitFrom: 3,
          unitTo: 4,
          dispatched: false,
        },
        {
          goalId: goal.id,
          date: "2026-06-28",
          unitFrom: 5,
          unitTo: 6,
          dispatched: false,
        },
      ],
    });
    expect(store.listDuePortions({ date: "2026-06-25" })).toEqual([]);
    expect(store.listDuePortions({ date: "2026-06-26" })).toEqual([
      {
        goalId: goal.id,
        memberSlug: "kid",
        title: "小王子",
        date: "2026-06-26",
        unitFrom: 1,
        unitTo: 2,
        dispatched: false,
      },
    ]);
  } finally {
    store.close();
  }
});

test("task store：完成最后份额后关闭目标", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-25T20:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想2天读完4章《小王子》",
      horizonDays: 2,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 4,
      days: 2,
    });
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-25" });

    const result = store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-25",
      feedback: "done",
      note: "读完了",
    });

    expect(result?.goalCompleted).toBe(true);
    expect(result?.replanned).toEqual([]);
    expect(store.listGoals({ memberSlug: "kid" })).toEqual([
      {
        ...goal,
        status: "done",
        updatedAt: "2026-06-25T20:00:00.000Z",
      },
    ]);
    expect(store.listDuePortions({ date: "2026-06-26" })).toEqual([]);
  } finally {
    store.close();
  }
});

test("task store：暂停最近活跃目标后不再派发份额", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T21:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想2天读完4章《小王子》",
      horizonDays: 2,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 4,
      days: 2,
    });

    const paused = store.pauseLatestGoal({ memberSlug: "kid" });

    expect(paused).toEqual({
      ...goal,
      status: "paused",
      updatedAt: "2026-06-24T21:00:00.000Z",
    });
    expect(store.listDuePortions({ date: "2026-06-25" })).toEqual([]);
  } finally {
    store.close();
  }
});

test("task store：暂停点名目标时只暂停对应目标", () => {
  let seq = 0;
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => "2026-06-24T21:00:00.000Z",
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const littlePrince = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想2天读完4章《小王子》",
      horizonDays: 2,
    });
    store.planDailyPortions({
      goalId: littlePrince.id,
      startDate: "2026-06-24",
      totalUnits: 4,
      days: 2,
    });
    const phonics = store.createGoal({
      memberSlug: "kid",
      title: "自然拼读",
      sourceText: "我想2天学完自然拼读",
      horizonDays: 2,
    });
    store.planDailyPortions({
      goalId: phonics.id,
      startDate: "2026-06-24",
      totalUnits: 4,
      days: 2,
    });

    const paused = store.pauseLatestGoal({ memberSlug: "kid", targetTitle: "小王子" });

    expect(paused?.id).toBe(littlePrince.id);
    expect(store.listGoals({ memberSlug: "kid" }).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: littlePrince.id, status: "paused" },
      { id: phonics.id, status: "active" },
    ]);
    expect(store.listDuePortions({ date: "2026-06-25" }).map(({ goalId }) => goalId)).toEqual([
      phonics.id,
    ]);
  } finally {
    store.close();
  }
});

test("task store：恢复最近暂停目标后从恢复日重新派发未完成份额", () => {
  let seq = 0;
  let timestamp = "2026-06-24T21:00:00.000Z";
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => timestamp,
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想3天读完6章《小王子》",
      horizonDays: 3,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 6,
      days: 3,
    });
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-24" });
    timestamp = "2026-06-24T21:30:00.000Z";
    store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-24",
      feedback: "done",
      note: "读完了",
    });
    timestamp = "2026-06-25T08:00:00.000Z";
    store.pauseLatestGoal({ memberSlug: "kid" });

    timestamp = "2026-06-27T08:00:00.000Z";
    const resumed = store.resumeLatestPausedGoal({
      memberSlug: "kid",
      date: "2026-06-27",
    });

    expect(resumed).toEqual({
      ...goal,
      status: "active",
      updatedAt: "2026-06-27T08:00:00.000Z",
    });
    expect(store.listDuePortions({ date: "2026-06-25" })).toEqual([]);
    expect(store.listDuePortions({ date: "2026-06-27" })).toEqual([
      {
        goalId: goal.id,
        memberSlug: "kid",
        title: "小王子",
        date: "2026-06-27",
        unitFrom: 3,
        unitTo: 4,
        dispatched: false,
      },
    ]);
    expect(store.listDuePortions({ date: "2026-06-28" })).toEqual([
      {
        goalId: goal.id,
        memberSlug: "kid",
        title: "小王子",
        date: "2026-06-28",
        unitFrom: 5,
        unitTo: 6,
        dispatched: false,
      },
    ]);
  } finally {
    store.close();
  }
});

test("task store：恢复暂停目标时继续避让目标休息日", () => {
  let seq = 0;
  let timestamp = "2026-06-24T21:00:00.000Z";
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => timestamp,
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想3天读完6章《小王子》，周末休息",
      horizonDays: 3,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 6,
      days: 3,
      restWeekdays: [0, 6],
    });
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-24" });
    timestamp = "2026-06-24T21:30:00.000Z";
    store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-24",
      feedback: "done",
      note: "读完了",
    });
    timestamp = "2026-06-25T08:00:00.000Z";
    store.pauseLatestGoal({ memberSlug: "kid" });

    timestamp = "2026-06-27T08:00:00.000Z";
    store.resumeLatestPausedGoal({
      memberSlug: "kid",
      date: "2026-06-27",
    });

    expect(store.listDuePortions({ date: "2026-06-27" })).toEqual([]);
    expect(store.listDuePortions({ date: "2026-06-29" })).toEqual([
      {
        goalId: goal.id,
        memberSlug: "kid",
        title: "小王子",
        date: "2026-06-29",
        unitFrom: 3,
        unitTo: 4,
        dispatched: false,
      },
    ]);
    expect(store.listDuePortions({ date: "2026-06-30" })).toEqual([
      {
        goalId: goal.id,
        memberSlug: "kid",
        title: "小王子",
        date: "2026-06-30",
        unitFrom: 5,
        unitTo: 6,
        dispatched: false,
      },
    ]);
  } finally {
    store.close();
  }
});

test("task store：恢复暂停目标时继续避让连续学习休息周期", () => {
  let seq = 0;
  let timestamp = "2026-06-24T21:00:00.000Z";
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => timestamp,
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const goal = store.createGoal({
      memberSlug: "kid",
      title: "口算",
      sourceText: "我想4天做完40题口算，做两天休一天",
      horizonDays: 4,
    });
    store.planDailyPortions({
      goalId: goal.id,
      startDate: "2026-06-24",
      totalUnits: 40,
      days: 4,
      activeRestCycle: { activeDays: 2, restDays: 1 },
    });
    store.markPortionDispatched({ goalId: goal.id, date: "2026-06-24" });
    timestamp = "2026-06-24T21:30:00.000Z";
    store.recordLatestPortionFeedback({
      memberSlug: "kid",
      date: "2026-06-24",
      feedback: "done",
      note: "做完了",
    });
    timestamp = "2026-06-25T08:00:00.000Z";
    store.pauseLatestGoal({ memberSlug: "kid" });

    timestamp = "2026-06-26T08:00:00.000Z";
    store.resumeLatestPausedGoal({
      memberSlug: "kid",
      date: "2026-06-26",
    });

    expect(store.listDuePortions({ date: "2026-06-26" })).toEqual([]);
    expect(store.listDuePortions({ date: "2026-06-27" })).toEqual([
      {
        goalId: goal.id,
        memberSlug: "kid",
        title: "口算",
        date: "2026-06-27",
        unitFrom: 11,
        unitTo: 20,
        dispatched: false,
      },
    ]);
    expect(store.listDuePortions({ date: "2026-06-28" })).toEqual([
      {
        goalId: goal.id,
        memberSlug: "kid",
        title: "口算",
        date: "2026-06-28",
        unitFrom: 21,
        unitTo: 30,
        dispatched: false,
      },
    ]);
  } finally {
    store.close();
  }
});

test("task store：恢复点名目标时只恢复对应目标", () => {
  let seq = 0;
  let timestamp = "2026-06-24T21:00:00.000Z";
  const store = createTaskStore({
    dbPath: ":memory:",
    now: () => timestamp,
    createId: (kind) => `${kind}-${++seq}`,
  });
  try {
    const littlePrince = store.createGoal({
      memberSlug: "kid",
      title: "小王子",
      sourceText: "我想2天读完4章《小王子》",
      horizonDays: 2,
    });
    store.planDailyPortions({
      goalId: littlePrince.id,
      startDate: "2026-06-24",
      totalUnits: 4,
      days: 2,
    });
    const phonics = store.createGoal({
      memberSlug: "kid",
      title: "自然拼读",
      sourceText: "我想2天学完自然拼读",
      horizonDays: 2,
    });
    store.planDailyPortions({
      goalId: phonics.id,
      startDate: "2026-06-24",
      totalUnits: 4,
      days: 2,
    });
    timestamp = "2026-06-24T21:30:00.000Z";
    store.pauseLatestGoal({ memberSlug: "kid", targetTitle: "小王子" });
    timestamp = "2026-06-24T22:00:00.000Z";
    store.pauseLatestGoal({ memberSlug: "kid", targetTitle: "自然拼读" });

    timestamp = "2026-06-26T08:00:00.000Z";
    const resumed = store.resumeLatestPausedGoal({
      memberSlug: "kid",
      date: "2026-06-26",
      targetTitle: "小王子",
    });

    expect(resumed?.id).toBe(littlePrince.id);
    expect(store.listGoals({ memberSlug: "kid" }).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: littlePrince.id, status: "active" },
      { id: phonics.id, status: "paused" },
    ]);
    expect(store.listDuePortions({ date: "2026-06-26" }).map(({ goalId }) => goalId)).toEqual([
      littlePrince.id,
    ]);
  } finally {
    store.close();
  }
});

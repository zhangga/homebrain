import { expect, test } from "bun:test";
import type { Connector, OutgoingMessage } from "../connectors/types";
import { dispatchDuePortions } from "./dispatcher";
import type { DuePortion, TaskStore } from "./store";

class FakeConnector implements Pick<Connector, "sendMessage"> {
  readonly sent: OutgoingMessage[] = [];

  async sendMessage(msg: OutgoingMessage): Promise<void> {
    this.sent.push(msg);
  }
}

test("dispatchDuePortions：发送当天待派发份额并标记已派发", async () => {
  const portion: DuePortion = {
    goalId: "goal-1",
    memberSlug: "kid",
    title: "小王子",
    date: "2026-06-24",
    unitFrom: 3,
    unitTo: 5,
    dispatched: false,
  };
  const marked: Array<{ goalId: string; date: string }> = [];
  const taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched"> = {
    listDuePortions(filter) {
      expect(filter).toEqual({ date: "2026-06-24" });
      return [portion];
    },
    markPortionDispatched(input) {
      marked.push(input);
    },
  };
  const connector = new FakeConnector();

  const result = await dispatchDuePortions({
    taskStore,
    connector,
    channelId: "family",
    date: "2026-06-24",
  });

  expect(result).toEqual({ dispatched: 1 });
  expect(connector.sent).toEqual([
    {
      channelId: "family",
      text: "今日任务：kid 读《小王子》第 3-5 单元",
    },
  ]);
  expect(marked).toEqual([{ goalId: "goal-1", date: "2026-06-24" }]);
});

test("dispatchDuePortions：没有待派发份额时不发送消息", async () => {
  const connector = new FakeConnector();
  const taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched"> = {
    listDuePortions() {
      return [];
    },
    markPortionDispatched() {
      throw new Error("不应标记");
    },
  };

  const result = await dispatchDuePortions({
    taskStore,
    connector,
    channelId: "family",
    date: "2026-06-24",
  });

  expect(result).toEqual({ dispatched: 0 });
  expect(connector.sent).toEqual([]);
});

import type { Connector } from "../connectors/types";
import type { DuePortion, TaskStore } from "./store";

export interface DispatchDuePortionsOptions {
  taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched">;
  connector: Pick<Connector, "sendMessage">;
  channelId: string;
  date: string;
  memberSlug?: string;
}

export async function dispatchDuePortions(
  opts: DispatchDuePortionsOptions,
): Promise<{ dispatched: number }> {
  const portions = opts.taskStore.listDuePortions({
    date: opts.date,
    memberSlug: opts.memberSlug,
  });

  for (const portion of portions) {
    await opts.connector.sendMessage({
      channelId: opts.channelId,
      text: formatDuePortion(portion),
    });
    opts.taskStore.markPortionDispatched({
      goalId: portion.goalId,
      date: portion.date,
    });
  }

  return { dispatched: portions.length };
}

export function formatDuePortion(portion: DuePortion): string {
  const title = portion.title ? `《${portion.title}》` : "目标";
  const unit =
    portion.unitFrom === portion.unitTo
      ? `第 ${portion.unitFrom} 单元`
      : `第 ${portion.unitFrom}-${portion.unitTo} 单元`;
  return `今日任务：${portion.memberSlug} 读${title}${unit}`;
}

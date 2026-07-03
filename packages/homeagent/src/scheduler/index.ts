import type { HomeagentConfig } from "../config";
import type { Connector } from "../connectors/types";
import type { MemberProfileUpdater } from "../members/profiles";
import type { MemberStore } from "../members/store";
import type { TaskStore } from "../tasks/store";
import {
  startOnThisDayScheduler,
  type OnThisDayBrain,
  type OnThisDayScheduler,
} from "./onthisday";
import {
  startBriefingScheduler,
  type BriefingBrain,
  type BriefingScheduler,
} from "./briefing";
import {
  startTaskDispatchScheduler,
  type TaskDispatchScheduler,
} from "./tasks";
import {
  startWeeklyScheduler,
  type WeeklyBrain,
  type WeeklyScheduler,
} from "./weekly";
import {
  startProfileRefreshScheduler,
  type ProfileRefreshBrain,
  type ProfileRefreshScheduler,
} from "./profiles";

export interface HomeagentSchedulerOptions {
  cfg: Pick<
    HomeagentConfig,
    | "taskDispatchChannelId"
    | "taskDispatchIntervalMs"
    | "taskDispatchOnStart"
    | "briefingChannelId"
    | "briefingIntervalMs"
    | "briefingOnStart"
    | "weeklyChannelId"
    | "weeklyIntervalMs"
    | "weeklyOnStart"
    | "onThisDayChannelId"
    | "onThisDayIntervalMs"
    | "onThisDayOnStart"
  > &
    Partial<
      Pick<
        HomeagentConfig,
        "profileRefreshEnabled" | "profileRefreshIntervalMs" | "profileRefreshOnStart"
      >
    >;
  brain: BriefingBrain & WeeklyBrain & OnThisDayBrain & ProfileRefreshBrain;
  connector: Pick<Connector, "sendMessage">;
  taskStore: Pick<TaskStore, "listDuePortions" | "markPortionDispatched">;
  memberStore?: Pick<MemberStore, "listMembers">;
  profileUpdater?: MemberProfileUpdater;
  now?: () => Date;
  setTaskTimer?: (callback: () => void, intervalMs: number) => unknown;
  clearTaskTimer?: (timerId: unknown) => void;
  setBriefingTimer?: (callback: () => void, intervalMs: number) => unknown;
  clearBriefingTimer?: (timerId: unknown) => void;
  setWeeklyTimer?: (callback: () => void, intervalMs: number) => unknown;
  clearWeeklyTimer?: (timerId: unknown) => void;
  setOnThisDayTimer?: (callback: () => void, intervalMs: number) => unknown;
  clearOnThisDayTimer?: (timerId: unknown) => void;
  setProfileRefreshTimer?: (callback: () => void, intervalMs: number) => unknown;
  clearProfileRefreshTimer?: (timerId: unknown) => void;
  onError?: (err: unknown) => void;
}

export interface HomeagentSchedulers {
  idle(): Promise<void>;
  stop(): void;
}

/** 根据配置启动后台调度；主动播报和任务派发都走同一入口。 */
export function startHomeagentSchedulers(
  opts: HomeagentSchedulerOptions,
): HomeagentSchedulers {
  const schedulers: Array<
    | TaskDispatchScheduler
    | BriefingScheduler
    | WeeklyScheduler
    | OnThisDayScheduler
    | ProfileRefreshScheduler
  > = [];

  if (opts.cfg.taskDispatchChannelId) {
    schedulers.push(
      startTaskDispatchScheduler({
        taskStore: opts.taskStore,
        connector: opts.connector,
        channelId: opts.cfg.taskDispatchChannelId,
        intervalMs: opts.cfg.taskDispatchIntervalMs,
        runOnStart: opts.cfg.taskDispatchOnStart,
        now: opts.now,
        setTimer: opts.setTaskTimer,
        clearTimer: opts.clearTaskTimer,
        onError: opts.onError,
      }),
    );
  }

  if (opts.cfg.briefingChannelId) {
    schedulers.push(
      startBriefingScheduler({
        brain: opts.brain,
        connector: opts.connector,
        channelId: opts.cfg.briefingChannelId,
        intervalMs: opts.cfg.briefingIntervalMs,
        runOnStart: opts.cfg.briefingOnStart,
        now: opts.now,
        setTimer: opts.setBriefingTimer,
        clearTimer: opts.clearBriefingTimer,
        onError: opts.onError,
      }),
    );
  }

  if (opts.cfg.weeklyChannelId) {
    schedulers.push(
      startWeeklyScheduler({
        brain: opts.brain,
        connector: opts.connector,
        channelId: opts.cfg.weeklyChannelId,
        intervalMs: opts.cfg.weeklyIntervalMs,
        runOnStart: opts.cfg.weeklyOnStart,
        now: opts.now,
        setTimer: opts.setWeeklyTimer,
        clearTimer: opts.clearWeeklyTimer,
        onError: opts.onError,
      }),
    );
  }

  if (opts.cfg.onThisDayChannelId) {
    schedulers.push(
      startOnThisDayScheduler({
        brain: opts.brain,
        connector: opts.connector,
        channelId: opts.cfg.onThisDayChannelId,
        intervalMs: opts.cfg.onThisDayIntervalMs,
        runOnStart: opts.cfg.onThisDayOnStart,
        now: opts.now,
        setTimer: opts.setOnThisDayTimer,
        clearTimer: opts.clearOnThisDayTimer,
        onError: opts.onError,
      }),
    );
  }

  if (opts.cfg.profileRefreshEnabled && opts.memberStore && opts.profileUpdater) {
    schedulers.push(
      startProfileRefreshScheduler({
        brain: opts.brain,
        memberStore: opts.memberStore,
        profileUpdater: opts.profileUpdater,
        intervalMs: opts.cfg.profileRefreshIntervalMs,
        runOnStart: opts.cfg.profileRefreshOnStart,
        now: opts.now,
        setTimer: opts.setProfileRefreshTimer,
        clearTimer: opts.clearProfileRefreshTimer,
        onError: opts.onError,
      }),
    );
  }

  return {
    idle: () => Promise.all(schedulers.map((scheduler) => scheduler.idle())).then(() => undefined),
    stop() {
      for (const scheduler of schedulers) scheduler.stop();
    },
  };
}

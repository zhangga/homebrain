import { expect, test } from "bun:test";
import { verifyCrashRecovery } from "./verify-crash-recovery.ts";

test("a SIGKILL preserves knowledge, tasks, reminders, and learning state", async () => {
  const report = await verifyCrashRecovery();

  expect(report.childExitCode).not.toBe(0);
  expect(report.rawCount).toBe(1);
  expect(report.taskRunStatus).toBe("failed");
  expect(report.reminderStatus).toBe("scheduled");
  expect(report.learningStatus).toBe("active");
});

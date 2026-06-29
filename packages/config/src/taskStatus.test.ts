import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "./defaults";
import { getTaskStatusConfig } from "./taskStatus";
import type { TaskAction } from "./schema";

describe("task status config", () => {
  it("loads task statuses and actions from config", () => {
    expect(getTaskStatusConfig().running.allowedActions).toEqual(["pause"]);
    expect(getTaskStatusConfig().failed.allowedActions).toEqual(["delete"]);
  });

  it("keeps task action labels in config instead of renderer status branches", () => {
    const taskActions = (getDefaultConfig() as { taskActions?: Record<TaskAction, { label: string }> })
      .taskActions;

    expect(taskActions?.start.label).toBe("开始");
    expect(taskActions?.pause.label).toBe("暂停");
    expect(taskActions?.resume.label).toBe("继续");
    expect(taskActions?.delete.label).toBe("删除任务");
  });
});

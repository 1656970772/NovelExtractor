import { getDefaultConfig } from "./defaults";
import type { TaskActionConfig, TaskStatusConfig } from "./schema";

export function getTaskStatusConfig(): TaskStatusConfig {
  return getDefaultConfig().taskStatus;
}

export function getTaskActionConfig(): TaskActionConfig {
  return getDefaultConfig().taskActions;
}

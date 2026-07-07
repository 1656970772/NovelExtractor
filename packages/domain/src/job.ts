import type { TaskStatus } from "@novel-extractor/config";

export type JobStatus =
  | "created"
  | "running"
  | "pause_requested"
  | "paused"
  | "failed"
  | "completed"
  | "deleted";

export type JobEventType =
  | "job.created"
  | "job.started"
  | "job.window.started"
  | "job.window.completed"
  | "job.model.call"
  | "job.tool.call"
  | "job.file.written"
  | "job.usage.updated"
  | "job.pause.requested"
  | "job.paused"
  | "job.resume.requested"
  | "job.failed"
  | "job.completed";

export interface Job {
  id: string;
  bookId: string;
  templateIds: string[];
  providerConfigId: string;
  modelId: string;
  status: JobStatus;
  progressText: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobEvent<
  TType extends JobEventType = JobEventType,
  TPayload extends object = Record<string, unknown>
> {
  type: TType;
  payload: TPayload;
  createdAt: string;
}

export interface MakeJobEventOptions {
  createdAt?: string;
}

const JOB_STATUS_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  created: ["running", "deleted"],
  running: ["pause_requested", "completed", "failed"],
  pause_requested: ["paused", "failed"],
  paused: ["running", "deleted"],
  failed: ["deleted"],
  completed: ["deleted"],
  deleted: []
};

const TASK_STATUS_BY_JOB_STATUS: Record<JobStatus, TaskStatus | null> = {
  created: "pending",
  running: "running",
  pause_requested: "pause_requested",
  paused: "paused",
  failed: "failed",
  completed: "completed",
  deleted: null
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return JOB_STATUS_TRANSITIONS[from].includes(to);
}

export function toTaskStatus(status: JobStatus): TaskStatus | null {
  return TASK_STATUS_BY_JOB_STATUS[status];
}

export function makeJobEvent<TType extends JobEventType, TPayload extends object>(
  type: TType,
  payload: TPayload,
  options: MakeJobEventOptions = {}
): JobEvent<TType, TPayload> {
  return {
    type,
    payload,
    createdAt: options.createdAt ?? new Date().toISOString()
  };
}

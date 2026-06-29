import { getTaskStatusConfig, type TaskAction } from "@novel-extractor/config";
import type { Clock } from "@novel-extractor/domain/ports";
import type { Job, JobStatus } from "@novel-extractor/domain/job";
import { toTaskStatus } from "@novel-extractor/domain/job";
import type { JobRunInput, JobRuntime, JobRuntimeError, JobRuntimeEvent, JobRuntimeResult } from "./jobRuntime";

export interface JobCommandRepository {
  createJob(input: Omit<Job, "id" | "createdAt" | "updatedAt">): Promise<Job>;
  findJobById(jobId: string): Promise<Job | null>;
  updateJob(job: Job): Promise<Job>;
}

export type JobCommandError =
  | { code: "job_not_found" }
  | { code: "invalid_job_state"; currentStatus: JobStatus; action: TaskAction }
  | { code: "job_runtime_error"; runtimeCode: string; message?: string };

export type JobCommandResult = { ok: true; job: Job } | { ok: false; error: JobCommandError };

export interface CreateJobCommandInput {
  bookId: string;
  templateIds: string[];
  providerConfigId: string;
  modelId: string;
}

export interface JobCommandService {
  create(input: CreateJobCommandInput): Promise<JobCommandResult>;
  start(jobId: string, input: JobRunInput): Promise<JobCommandResult>;
  pause(jobId: string): Promise<{ ok: true } | { ok: false; error: JobCommandError }>;
  resume(jobId: string): Promise<{ ok: true } | { ok: false; error: JobCommandError }>;
  delete(jobId: string): Promise<JobCommandResult>;
}

export interface JobCommandServiceOptions {
  repository: JobCommandRepository;
  runtime: JobRuntime;
  clock: Clock;
}

type RuntimeFailure = { ok: false; error: JobRuntimeError };

const START_SETTLE_PROBE_MS = 0;

function canRunAction(job: Job, action: TaskAction): boolean {
  const taskStatus = toTaskStatus(job.status);
  if (taskStatus === null) {
    return false;
  }

  return getTaskStatusConfig()[taskStatus].allowedActions.includes(action);
}

function invalidState(job: Job, action: TaskAction): JobCommandError {
  return { code: "invalid_job_state", currentStatus: job.status, action };
}

function mapEventStatus(event: JobRuntimeEvent): JobStatus | undefined {
  switch (event.type) {
    case "job.started":
    case "job.resume.requested":
      return "running";
    case "job.pause.requested":
      return "pause_requested";
    case "job.paused":
      return "paused";
    case "job.failed":
      return "failed";
    case "job.completed":
      return "completed";
    case "job.deleted":
      return "deleted";
    default:
      return undefined;
  }
}

function runtimeError(result: RuntimeFailure): JobCommandError {
  return {
    code: "job_runtime_error",
    runtimeCode: result.error.code,
    message: "message" in result.error ? result.error.message : undefined
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Job failed";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createJobCommandService(options: JobCommandServiceOptions): JobCommandService {
  async function updateStatus(job: Job, status: JobStatus, failureReason?: string): Promise<Job> {
    return await options.repository.updateJob({
      ...job,
      status,
      failureReason,
      updatedAt: options.clock.now()
    });
  }

  async function requireJob(jobId: string): Promise<JobCommandResult | { ok: true; job: Job }> {
    const job = await options.repository.findJobById(jobId);
    if (!job) {
      return { ok: false, error: { code: "job_not_found" } };
    }

    return { ok: true, job };
  }

  options.runtime.events.subscribe(async (event) => {
    const jobId = "jobId" in event.payload && typeof event.payload.jobId === "string" ? event.payload.jobId : undefined;
    const status = mapEventStatus(event);
    if (!jobId || !status) {
      return;
    }

    const job = await options.repository.findJobById(jobId);
    if (!job) {
      return;
    }

    const failureReason = event.type === "job.failed" && "message" in event.payload && typeof event.payload.message === "string" ? event.payload.message : job.failureReason;
    await updateStatus(job, status, failureReason);
  });

  return {
    async create(input) {
      const job = await options.repository.createJob({
        bookId: input.bookId,
        templateIds: input.templateIds,
        providerConfigId: input.providerConfigId,
        modelId: input.modelId,
        status: "created",
        progressText: "0/0"
      });

      return { ok: true, job };
    },

    async start(jobId, input) {
      const existing = await requireJob(jobId);
      if (!existing.ok) {
        return existing;
      }

      if (!canRunAction(existing.job, "start")) {
        return { ok: false, error: invalidState(existing.job, "start") };
      }

      const startPromise = options.runtime.startJob(input);
      const observedStart = startPromise.catch(async (error): Promise<JobRuntimeResult> => {
        const message = toErrorMessage(error);
        try {
          const latest = await options.repository.findJobById(jobId);
          if (latest) {
            await updateStatus(latest, "failed", message);
          }
        } catch {
          // The runtime start promise is still converted to a typed result so callers never get an unhandled rejection.
        }

        return { ok: false, error: { code: "job_failed", message } };
      });
      void observedStart.then(
        () => undefined,
        () => undefined
      );

      const firstResult = await Promise.race([
        observedStart.then((result) => ({ kind: "settled" as const, result })),
        delay(START_SETTLE_PROBE_MS).then(() => ({ kind: "pending" as const }))
      ]);

      if (firstResult.kind === "settled") {
        if (!firstResult.result.ok) {
          return { ok: false, error: runtimeError(firstResult.result) };
        }

        const job = await options.repository.findJobById(jobId);
        return job ? { ok: true, job } : { ok: false, error: { code: "job_not_found" } };
      }

      const updated = await updateStatus(existing.job, "running");
      return { ok: true, job: updated };
    },

    async pause(jobId) {
      const existing = await requireJob(jobId);
      if (!existing.ok) {
        return existing;
      }

      if (!canRunAction(existing.job, "pause")) {
        return { ok: false, error: invalidState(existing.job, "pause") };
      }

      const result = await options.runtime.pauseJob(jobId);
      return result.ok ? { ok: true } : { ok: false, error: runtimeError(result) };
    },

    async resume(jobId) {
      const existing = await requireJob(jobId);
      if (!existing.ok) {
        return existing;
      }

      if (!canRunAction(existing.job, "resume")) {
        return { ok: false, error: invalidState(existing.job, "resume") };
      }

      const result = await options.runtime.resumeJob(jobId);
      return result.ok ? { ok: true } : { ok: false, error: runtimeError(result) };
    },

    async delete(jobId) {
      const existing = await requireJob(jobId);
      if (!existing.ok) {
        return existing;
      }

      if (!canRunAction(existing.job, "delete")) {
        return { ok: false, error: invalidState(existing.job, "delete") };
      }

      const result = await options.runtime.deleteJob(jobId);
      if (!result.ok) {
        return { ok: false, error: runtimeError(result) };
      }

      const updated = await updateStatus(existing.job, "deleted");
      return { ok: true, job: updated };
    }
  };
}

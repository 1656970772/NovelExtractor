import type { JobStatus } from "@novel-extractor/domain/job";
import { createEventBus, type EventBus, type TypedEvent } from "./eventBus";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}

export interface FeeAmount {
  amount: number;
  currency: string;
}

export interface JobWindowInput {
  id: string;
  chapterIds: string[];
  prompt?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCallRequest {
  name: string;
  arguments: unknown;
}

export interface LlmWindowResult {
  content: string;
  usage: TokenUsage;
  fee: FeeAmount;
  toolCalls?: ToolCallRequest[];
}

export interface JobLlmClient {
  completeWindow(input: {
    job: JobRunInput;
    window: JobWindowInput;
    windowIndex: number;
  }): Promise<LlmWindowResult>;
}

export interface JobToolExecutor {
  execute(call: ToolCallRequest, context: { job: JobRunInput; window: JobWindowInput; windowIndex: number }): Promise<unknown>;
}

export interface JobRunInput {
  jobId: string;
  bookId: string;
  modelId: string;
  templateIds: string[];
  providerConfigId?: string;
  windows: JobWindowInput[];
  metadata?: Record<string, unknown>;
}

export type JobRuntimeEventType =
  | "job.started"
  | "job.window.started"
  | "job.window.completed"
  | "job.tool.call"
  | "job.pause.requested"
  | "job.paused"
  | "job.resume.requested"
  | "job.cancel.requested"
  | "job.cancelled"
  | "job.failed"
  | "job.completed"
  | "job.deleted";

export interface JobRuntimeEvent<TType extends JobRuntimeEventType = JobRuntimeEventType, TPayload extends object = Record<string, unknown>>
  extends TypedEvent {
  type: TType;
  payload: TPayload;
}

export interface JobRuntimeState {
  jobId: string;
  status: JobStatus | "cancelled";
  completedWindowCount: number;
  totalWindowCount: number;
  usage: TokenUsage;
  fee: FeeAmount | null;
  failureReason?: string;
}

export type JobRuntimeError =
  | { code: "job_already_running" }
  | { code: "job_not_found" }
  | { code: "invalid_job_state"; currentStatus?: JobRuntimeState["status"] }
  | { code: "job_failed"; message: string };

export type JobRuntimeResult<TValue = JobRuntimeState> = { ok: true; state: TValue } | { ok: false; error: JobRuntimeError };

export interface JobRuntimeRepository {
  appendEvent?(jobId: string, event: JobRuntimeEvent): Promise<void>;
  saveState?(state: JobRuntimeState): Promise<void>;
}

export interface JobReportRepository {
  deleteReportsForJob(jobId: string): Promise<void>;
}

export interface JobRuntimeOptions {
  maxConcurrentJobs?: number;
  llm: JobLlmClient;
  tools: JobToolExecutor;
  events?: EventBus<JobRuntimeEvent>;
  repository?: JobRuntimeRepository;
  reports?: JobReportRepository;
  clock?: {
    now(): string;
  };
}

interface MutableJobRuntimeState extends JobRuntimeState {
  input: JobRunInput;
  pauseRequested: boolean;
  cancelRequested: boolean;
  resume?: () => void;
}

export interface JobRuntime {
  events: EventBus<JobRuntimeEvent>;
  startJob(input: JobRunInput): Promise<JobRuntimeResult>;
  pauseJob(jobId: string): Promise<{ ok: true } | { ok: false; error: JobRuntimeError }>;
  resumeJob(jobId: string): Promise<{ ok: true } | { ok: false; error: JobRuntimeError }>;
  cancelJob(jobId: string): Promise<{ ok: true } | { ok: false; error: JobRuntimeError }>;
  deleteJob(jobId: string): Promise<{ ok: true } | { ok: false; error: JobRuntimeError }>;
  getJobState(jobId: string): JobRuntimeState | undefined;
}

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0
};

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cacheHitTokens: (left.cacheHitTokens ?? 0) + (right.cacheHitTokens ?? 0),
    cacheMissTokens: (left.cacheMissTokens ?? 0) + (right.cacheMissTokens ?? 0)
  };
}

function addFee(left: FeeAmount | null, right: FeeAmount): FeeAmount {
  if (left === null) {
    return { ...right };
  }

  if (left.currency !== right.currency) {
    throw new Error(`Mixed fee currencies are not supported: ${left.currency}, ${right.currency}`);
  }

  return {
    amount: Number((left.amount + right.amount).toFixed(12)),
    currency: left.currency
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Job failed";
}

function cloneState(state: MutableJobRuntimeState): JobRuntimeState {
  return {
    jobId: state.jobId,
    status: state.status,
    completedWindowCount: state.completedWindowCount,
    totalWindowCount: state.totalWindowCount,
    usage: { ...state.usage },
    fee: state.fee ? { ...state.fee } : null,
    failureReason: state.failureReason
  };
}

export function createJobRuntime(options: JobRuntimeOptions): JobRuntime {
  const maxConcurrentJobs = options.maxConcurrentJobs ?? 1;
  if (maxConcurrentJobs !== 1) {
    throw new Error("maxConcurrentJobs must be 1 in P0");
  }

  const eventBus = options.events ?? createEventBus<JobRuntimeEvent>();
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const states = new Map<string, MutableJobRuntimeState>();
  let activeJobId: string | null = null;

  async function emit<TType extends JobRuntimeEventType, TPayload extends object>(
    type: TType,
    payload: TPayload
  ): Promise<void> {
    const event: JobRuntimeEvent<TType, TPayload> = {
      type,
      payload,
      createdAt: clock.now()
    };

    await eventBus.publish(event as JobRuntimeEvent);
    const jobId = "jobId" in payload && typeof payload.jobId === "string" ? payload.jobId : undefined;
    if (jobId) {
      await options.repository?.appendEvent?.(jobId, event as JobRuntimeEvent);
    }
  }

  async function saveState(state: MutableJobRuntimeState): Promise<void> {
    await options.repository?.saveState?.(cloneState(state));
  }

  function releaseActiveJob(state: MutableJobRuntimeState): void {
    if (activeJobId === state.jobId) {
      activeJobId = null;
    }
  }

  async function markJobFailedBestEffort(state: MutableJobRuntimeState, message: string): Promise<void> {
    state.status = "failed";
    state.failureReason = message;

    try {
      await saveState(state);
    } catch {
      // Preserve the original typed failure when failure-state persistence also fails.
    }

    try {
      await emit("job.failed", { jobId: state.jobId, message });
    } catch {
      // A broken subscriber or event store must not turn a typed job failure into a rejected startJob().
    }
  }

  async function pauseAtBoundary(state: MutableJobRuntimeState): Promise<void> {
    state.status = "paused";
    state.pauseRequested = false;
    await saveState(state);
    await emit("job.paused", { jobId: state.jobId, completedWindowCount: state.completedWindowCount });

    await new Promise<void>((resolve) => {
      state.resume = resolve;
    });
  }

  async function finishCancelled(state: MutableJobRuntimeState): Promise<JobRuntimeResult> {
    state.status = "cancelled";
    await saveState(state);
    await emit("job.cancelled", { jobId: state.jobId, completedWindowCount: state.completedWindowCount });
    releaseActiveJob(state);

    return { ok: true, state: cloneState(state) };
  }

  return {
    events: eventBus,

    async startJob(input) {
      if (activeJobId !== null) {
        return { ok: false, error: { code: "job_already_running" } };
      }

      const state: MutableJobRuntimeState = {
        input,
        jobId: input.jobId,
        status: "running",
        completedWindowCount: 0,
        totalWindowCount: input.windows.length,
        usage: { ...EMPTY_USAGE },
        fee: null,
        pauseRequested: false,
        cancelRequested: false
      };
      states.set(input.jobId, state);
      activeJobId = input.jobId;

      try {
        await saveState(state);
        await emit("job.started", {
          jobId: input.jobId,
          bookId: input.bookId,
          modelId: input.modelId,
          templateIds: input.templateIds,
          totalWindowCount: input.windows.length
        });

        for (const [windowIndex, window] of input.windows.entries()) {
          if (state.cancelRequested) {
            return await finishCancelled(state);
          }

          await emit("job.window.started", { jobId: input.jobId, windowId: window.id, windowIndex });
          const llmResult = await options.llm.completeWindow({ job: input, window, windowIndex });

          for (const toolCall of llmResult.toolCalls ?? []) {
            const toolResult = await options.tools.execute(toolCall, { job: input, window, windowIndex });
            await emit("job.tool.call", {
              jobId: input.jobId,
              windowId: window.id,
              windowIndex,
              toolName: toolCall.name,
              result: toolResult
            });
          }

          state.usage = addUsage(state.usage, llmResult.usage);
          state.fee = addFee(state.fee, llmResult.fee);
          state.completedWindowCount += 1;
          await saveState(state);
          await emit("job.window.completed", {
            jobId: input.jobId,
            windowId: window.id,
            windowIndex,
            usage: llmResult.usage,
            fee: llmResult.fee
          });

          if (state.cancelRequested) {
            return await finishCancelled(state);
          }

          if (state.pauseRequested) {
            await pauseAtBoundary(state);
            if (state.status === "deleted") {
              return { ok: true, state: cloneState(state) };
            }

            if (state.cancelRequested) {
              return await finishCancelled(state);
            }
          }
        }

        state.status = "completed";
        await saveState(state);
        await emit("job.completed", {
          jobId: input.jobId,
          completedWindowCount: state.completedWindowCount,
          usage: state.usage,
          fee: state.fee
        });
        releaseActiveJob(state);

        return { ok: true, state: cloneState(state) };
      } catch (error) {
        const message = toErrorMessage(error);
        await markJobFailedBestEffort(state, message);
        releaseActiveJob(state);

        return { ok: false, error: { code: "job_failed", message } };
      }
    },

    async pauseJob(jobId) {
      const state = states.get(jobId);
      if (!state) {
        return { ok: false, error: { code: "job_not_found" } };
      }

      if (state.status !== "running") {
        return { ok: false, error: { code: "invalid_job_state", currentStatus: state.status } };
      }

      state.status = "pause_requested";
      state.pauseRequested = true;
      await saveState(state);
      await emit("job.pause.requested", { jobId });

      return { ok: true };
    },

    async resumeJob(jobId) {
      const state = states.get(jobId);
      if (!state) {
        return { ok: false, error: { code: "job_not_found" } };
      }

      if (state.status !== "paused" || !state.resume) {
        return { ok: false, error: { code: "invalid_job_state", currentStatus: state.status } };
      }

      state.status = "running";
      await saveState(state);
      await emit("job.resume.requested", { jobId });
      const resume = state.resume;
      state.resume = undefined;
      resume();

      return { ok: true };
    },

    async cancelJob(jobId) {
      const state = states.get(jobId);
      if (!state) {
        return { ok: false, error: { code: "job_not_found" } };
      }

      if (state.status !== "running" && state.status !== "pause_requested" && state.status !== "paused") {
        return { ok: false, error: { code: "invalid_job_state", currentStatus: state.status } };
      }

      state.cancelRequested = true;
      await emit("job.cancel.requested", { jobId });
      if (state.status === "paused" && state.resume) {
        const resume = state.resume;
        state.resume = undefined;
        resume();
      }

      return { ok: true };
    },

    async deleteJob(jobId) {
      const state = states.get(jobId);
      if (!state) {
        return { ok: false, error: { code: "job_not_found" } };
      }

      if (state.status === "running" || state.status === "pause_requested") {
        return { ok: false, error: { code: "invalid_job_state", currentStatus: state.status } };
      }

      state.status = "deleted";
      await saveState(state);
      await emit("job.deleted", { jobId });
      if (activeJobId === jobId) {
        activeJobId = null;
      }

      if (state.resume) {
        const resume = state.resume;
        state.resume = undefined;
        resume();
      }

      return { ok: true };
    },

    getJobState(jobId) {
      const state = states.get(jobId);
      return state ? cloneState(state) : undefined;
    }
  };
}

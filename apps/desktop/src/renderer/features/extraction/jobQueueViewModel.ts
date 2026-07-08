import type { ExtractionJob } from "./extractionViewModel";

export type JobQueueFilter = "all" | "running" | "paused" | "failed" | "completed";

export const JOB_QUEUE_FILTERS: readonly { key: JobQueueFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "running", label: "进行中" },
  { key: "paused", label: "暂停" },
  { key: "failed", label: "失败" },
  { key: "completed", label: "已完成" }
];

export function isRuntimeActiveJobStatus(status: ExtractionJob["status"]): boolean {
  return status === "running" || status === "pause_requested";
}

export interface JobCardViewModel {
  title: string;
  modelText: string;
  hasStructuredProgress: boolean;
  progressText: string;
  progressCountText?: string;
  progressPercentText?: string;
  progressWidthPercent: number;
  elapsedText: string;
  estimatedTotalText: string;
  completedAtText: string;
  failedAtText: string;
  retryPolicyText?: string;
}

export interface JobCardViewModelOptions {
  nowMs?: number;
}

export function getFilterCount(jobs: readonly ExtractionJob[], filter: JobQueueFilter): number {
  if (filter === "all") {
    return jobs.length;
  }

  return jobs.filter((job) => matchesFilter(job, filter)).length;
}

export function filterJobs(jobs: readonly ExtractionJob[], filter: JobQueueFilter): ExtractionJob[] {
  if (filter === "all") {
    return [...jobs];
  }

  return jobs.filter((job) => matchesFilter(job, filter));
}

function matchesFilter(job: ExtractionJob, filter: JobQueueFilter): boolean {
  if (filter === "running") {
    return isRuntimeActiveJobStatus(job.status);
  }

  return job.status === filter;
}

export function formatDuration(milliseconds?: number): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return "--";
  }

  const safeMilliseconds = Math.max(0, milliseconds);
  const totalSeconds = Math.floor(safeMilliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minuteText = minutes.toString().padStart(2, "0");
  const secondText = seconds.toString().padStart(2, "0");

  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minuteText}:${secondText}`;
  }

  return `${minuteText}:${secondText}`;
}

export function formatTimestamp(timestamp?: string): string {
  if (!timestamp) {
    return "--";
  }

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/u.test(timestamp)) {
    return "--";
  }

  const timestampMs = Date.parse(timestamp);
  if (Number.isNaN(timestampMs)) {
    return "--";
  }

  const date = new Date(timestampMs);
  const yearText = date.getFullYear().toString().padStart(4, "0");
  const monthText = (date.getMonth() + 1).toString().padStart(2, "0");
  const dayText = date.getDate().toString().padStart(2, "0");
  const hourText = date.getHours().toString().padStart(2, "0");
  const minuteText = date.getMinutes().toString().padStart(2, "0");
  const secondText = date.getSeconds().toString().padStart(2, "0");

  return `${yearText}-${monthText}-${dayText} ${hourText}:${minuteText}:${secondText}`;
}

function clampProgressPercent(percent?: number): number {
  if (percent === undefined || !Number.isFinite(percent)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(percent)));
}

function formatProgressPercent(percent?: number): string | undefined {
  if (percent === undefined || !Number.isFinite(percent)) {
    return undefined;
  }

  return `${clampProgressPercent(percent)}%`;
}

function formatCardDuration(milliseconds?: number): string {
  const formattedDuration = formatDuration(milliseconds);

  if (formattedDuration === "--" || formattedDuration.split(":").length === 3) {
    return formattedDuration;
  }

  return `00:${formattedDuration}`;
}

function getTimingEstimateMs(job: ExtractionJob): number | undefined {
  return job.timing?.estimatedTotalMs;
}

function getCardEstimatedTotalTimeLabel(job: ExtractionJob): string {
  if (!job.timing) {
    return getEstimatedTotalTimeLabel(job);
  }

  if (job.timing.estimateState === "frozen") {
    return `已暂停 ${formatCardDuration(getTimingEstimateMs(job))}`;
  }

  if (job.timing.estimateState === "available") {
    return formatCardDuration(getTimingEstimateMs(job));
  }

  return getEstimatedTotalTimeLabel(job);
}

export function getEstimatedTotalTimeLabel(job: ExtractionJob): string {
  if (!job.timing) {
    return "--";
  }

  if (job.timing.estimateState === "frozen") {
    return `已暂停 ${formatDuration(getTimingEstimateMs(job))}`;
  }

  if (job.timing.estimateState === "calculating") {
    return "计算中";
  }

  const estimatedTotalMs = getTimingEstimateMs(job);
  if (job.timing.estimateState === "available" && estimatedTotalMs !== undefined) {
    return formatDuration(estimatedTotalMs);
  }

  return "--";
}

function getRunningElapsedMs(job: ExtractionJob, nowMs: number | undefined): number | undefined {
  if (!isRuntimeActiveJobStatus(job.status) || !job.timing?.startedAt || nowMs === undefined) {
    return job.timing?.elapsedMs;
  }

  const startedAtMs = Date.parse(job.timing.startedAt);
  if (Number.isNaN(startedAtMs) || !Number.isFinite(nowMs)) {
    return job.timing.elapsedMs;
  }

  return Math.max(0, nowMs - startedAtMs);
}

export function getJobCardViewModel(
  job: ExtractionJob,
  options: JobCardViewModelOptions = {}
): JobCardViewModel {
  return {
    title: job.inputSummary?.bookDisplayName || job.progressText || job.id,
    modelText: job.inputSummary?.modelId ?? "--",
    hasStructuredProgress: Boolean(job.progress),
    progressText: job.progressText ?? "尚未开始",
    progressCountText: job.progress
      ? `${job.progress.completedWindowCount} / ${job.progress.totalWindowCount}`
      : undefined,
    progressPercentText: formatProgressPercent(job.progress?.percent),
    progressWidthPercent: clampProgressPercent(job.progress?.percent),
    elapsedText: formatCardDuration(getRunningElapsedMs(job, options.nowMs)),
    estimatedTotalText: getCardEstimatedTotalTimeLabel(job),
    completedAtText: formatTimestamp(job.timing?.completedAt),
    failedAtText: formatTimestamp(job.timing?.completedAt),
    retryPolicyText: job.autoRetryOnFailure
      ? job.status === "failed"
        ? "自动续跑已开启"
        : "失败后自动续跑"
      : undefined
  };
}

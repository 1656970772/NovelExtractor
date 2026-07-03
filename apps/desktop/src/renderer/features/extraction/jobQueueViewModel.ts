import type { ExtractionJob } from "./extractionViewModel";

export type JobQueueFilter = "all" | "running" | "paused" | "failed" | "completed";

export const JOB_QUEUE_FILTERS: readonly { key: JobQueueFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "running", label: "进行中" },
  { key: "paused", label: "暂停" },
  { key: "failed", label: "失败" },
  { key: "completed", label: "已完成" }
];

export interface JobCardViewModel {
  title: string;
  modelText: string;
  hasStructuredProgress: boolean;
  progressText: string;
  progressCountText?: string;
  progressPercentText?: string;
  progressWidthPercent: number;
  elapsedText: string;
  remainingText: string;
  completedAtText: string;
  failedAtText: string;
}

export function getFilterCount(jobs: readonly ExtractionJob[], filter: JobQueueFilter): number {
  if (filter === "all") {
    return jobs.length;
  }

  return jobs.filter((job) => job.status === filter).length;
}

export function filterJobs(jobs: readonly ExtractionJob[], filter: JobQueueFilter): ExtractionJob[] {
  if (filter === "all") {
    return [...jobs];
  }

  return jobs.filter((job) => job.status === filter);
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

  return timestamp.replace("T", " ").slice(0, 19);
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

function getCardRemainingTimeLabel(job: ExtractionJob): string {
  if (!job.timing) {
    return getRemainingTimeLabel(job);
  }

  if (job.timing.estimateState === "frozen") {
    return `已暂停 ${formatCardDuration(job.timing.estimatedRemainingMs)}`;
  }

  if (job.timing.estimateState === "available") {
    return formatCardDuration(job.timing.estimatedRemainingMs);
  }

  return getRemainingTimeLabel(job);
}

export function getRemainingTimeLabel(job: ExtractionJob): string {
  if (!job.timing) {
    return "--";
  }

  if (job.timing.estimateState === "frozen") {
    return `已暂停 ${formatDuration(job.timing.estimatedRemainingMs)}`;
  }

  if (job.timing.estimateState === "calculating") {
    return "计算中";
  }

  if (job.timing.estimateState === "available" && job.timing.estimatedRemainingMs !== undefined) {
    return formatDuration(job.timing.estimatedRemainingMs);
  }

  return "--";
}

export function getJobCardViewModel(job: ExtractionJob): JobCardViewModel {
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
    elapsedText: formatCardDuration(job.timing?.elapsedMs),
    remainingText: getCardRemainingTimeLabel(job),
    completedAtText: formatTimestamp(job.timing?.completedAt),
    failedAtText: formatTimestamp(job.timing?.completedAt)
  };
}

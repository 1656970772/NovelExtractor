import type { ExtractionJob } from "./extractionViewModel";

export type JobQueueFilter = "all" | "running" | "paused" | "failed" | "completed";

export const JOB_QUEUE_FILTERS: readonly { key: JobQueueFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "running", label: "进行中" },
  { key: "paused", label: "暂停" },
  { key: "failed", label: "失败" },
  { key: "completed", label: "已完成" }
];

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

function toProjectRelativePath(...segments: string[]): string {
  return segments.join("/");
}

export function toTemplateBatchCoverageRelativePath(jobId: string, batchId: string): string {
  return toProjectRelativePath("metadata", "coverage", "jobs", jobId, batchId, "coverage-index.json");
}

export function toTemplateBatchLogSegments(jobId: string, batchId: string): string[] {
  return ["runs", jobId, "logs", "batches", batchId];
}

export function toTemplateBatchTaskInfo(jobId: string, batchId: string): string {
  return `任务 ${jobId}，批次 ${batchId}`;
}

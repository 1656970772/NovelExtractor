import { useState } from "react";
import type { TaskAction } from "@novel-extractor/config";
import { getTaskActionConfig, getTaskStatusConfig } from "@novel-extractor/config";
import { JobLogPanel } from "./JobLogPanel";
import { sortExtractionJobsByCreatedAtDesc, type ExtractionJob } from "./extractionViewModel";
import {
  filterJobs,
  getFilterCount,
  JOB_QUEUE_FILTERS,
  type JobQueueFilter
} from "./jobQueueViewModel";

export interface JobListProps {
  jobs: readonly ExtractionJob[];
  onJobAction?: (jobId: string, action: TaskAction) => Promise<void>;
  onDeleteJob?: (jobId: string) => Promise<void>;
  onOpenJobLog?: (jobId: string) => Promise<void>;
  onReadJobLog?: (jobId: string) => Promise<string>;
}

const STATUS_CONFIG = getTaskStatusConfig();
const TASK_ACTION_CONFIG = getTaskActionConfig();

export function JobList({ jobs, onDeleteJob, onJobAction, onOpenJobLog, onReadJobLog }: JobListProps) {
  const [deleteCandidate, setDeleteCandidate] = useState<ExtractionJob | null>(null);
  const [activeFilter, setActiveFilter] = useState<JobQueueFilter>("all");
  const sortedJobs = sortExtractionJobsByCreatedAtDesc(jobs);
  const visibleJobs = filterJobs(sortedJobs, activeFilter);

  function runAction(job: ExtractionJob, action: TaskAction): void {
    if (action === "delete") {
      setDeleteCandidate(job);
      return;
    }

    if (!onJobAction) {
      return;
    }

    void onJobAction(job.id, action).catch(() => undefined);
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteCandidate || !onDeleteJob) {
      setDeleteCandidate(null);
      return;
    }

    try {
      await onDeleteJob(deleteCandidate.id);
      setDeleteCandidate(null);
    } catch {
      // The owning page owns the visible error state, so this boundary only prevents unhandled rejections.
    }
  }

  return (
    <section className="tool-panel tool-panel--wide jobs-panel" aria-labelledby="jobs-title">
      <div className="panel-heading">
        <h2 id="jobs-title">提取任务</h2>
        <span>{visibleJobs.length} 项</span>
      </div>
      <div className="job-filter-tabs" role="group" aria-label="任务状态筛选">
        {JOB_QUEUE_FILTERS.map((filter) => (
          <button
            aria-pressed={activeFilter === filter.key}
            className="job-filter-tab"
            key={filter.key}
            onClick={() => setActiveFilter(filter.key)}
            type="button"
          >
            <span>{filter.label}</span>
            {" "}
            <span>{getFilterCount(jobs, filter.key)}</span>
          </button>
        ))}
      </div>
      {visibleJobs.length === 0 ? (
        <p className="empty-text">{jobs.length === 0 ? "暂无提取任务" : "当前筛选暂无任务"}</p>
      ) : (
        <ul className="job-list">
          {visibleJobs.map((job) => {
            const statusConfig = STATUS_CONFIG[job.status];
            return (
              <li className="job-row" key={job.id}>
                <div className="job-row__header">
                  <div className="job-row__summary">
                    <strong>{statusConfig.label}</strong>
                    <span>{job.progressText ?? "尚未开始"}</span>
                  </div>
                  <div className="job-row__actions">
                    {statusConfig.allowedActions.map((action) => (
                      <button
                        key={action}
                        onClick={() => runAction(job, action)}
                        type="button"
                      >
                        {TASK_ACTION_CONFIG[action].label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="job-row__details">
                  {job.tokenText ? <span className="job-row__token">{job.tokenText}</span> : null}
                  {job.failureReason ? (
                    <p className="danger-text job-row__failure">{job.failureReason}</p>
                  ) : null}
                  <JobLogPanel
                    jobId={job.id}
                    logFilePath={job.logFilePath}
                    onOpenLog={onOpenJobLog}
                    onReadLog={onReadJobLog}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {deleteCandidate ? (
        <div className="delete-confirm__backdrop">
          <div
            aria-labelledby="delete-job-title"
            aria-modal="true"
            className="delete-confirm"
            role="dialog"
          >
            <h3 id="delete-job-title">确认删除任务</h3>
            <p>确认后只移除任务记录和运行日志索引。共享报告文件不在本次操作范围内。</p>
            <div className="delete-confirm__actions">
              <button
                className="button button--secondary"
                onClick={() => setDeleteCandidate(null)}
                type="button"
              >
                取消
              </button>
              <button
                className="button button--primary"
                onClick={() => {
                  void confirmDelete();
                }}
                type="button"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

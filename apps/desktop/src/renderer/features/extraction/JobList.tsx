import { useEffect, useState } from "react";
import type { TaskAction } from "@novel-extractor/config";
import { getTaskActionConfig, getTaskStatusConfig } from "@novel-extractor/config";
import { ProgressBar } from "../../components/ProgressBar";
import { JobLogPanel } from "./JobLogPanel";
import { sortExtractionJobsByCreatedAtDesc, type ExtractionJob } from "./extractionViewModel";
import {
  filterJobs,
  getJobCardViewModel,
  getFilterCount,
  JOB_QUEUE_FILTERS,
  type JobQueueFilter
} from "./jobQueueViewModel";
import { useTransientScrollbar } from "./useTransientScrollbar";

export interface JobListProps {
  jobs: readonly ExtractionJob[];
  activeJobId?: string;
  onJobAction?: (jobId: string, action: TaskAction) => Promise<void>;
  onDeleteJob?: (jobId: string) => Promise<void>;
  onOpenJobLog?: (jobId: string) => Promise<void>;
  onReadJobLog?: (jobId: string) => Promise<string>;
  onOpenOutputDirectory?: (jobId: string) => Promise<void>;
}

const STATUS_CONFIG = getTaskStatusConfig();
const TASK_ACTION_CONFIG = getTaskActionConfig();

export function JobList({
  activeJobId,
  jobs,
  onDeleteJob,
  onJobAction,
  onOpenJobLog,
  onOpenOutputDirectory,
  onReadJobLog
}: JobListProps) {
  const [deleteCandidate, setDeleteCandidate] = useState<ExtractionJob | null>(null);
  const [activeFilter, setActiveFilter] = useState<JobQueueFilter>("all");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const sortedJobs = sortExtractionJobsByCreatedAtDesc(jobs);
  const visibleJobs = filterJobs(sortedJobs, activeFilter);
  const hasRunningTimedJob = jobs.some((job) => job.status === "running" && Boolean(job.timing?.startedAt));
  const listScrollbar = useTransientScrollbar();

  useEffect(() => {
    if (!hasRunningTimedJob) {
      return undefined;
    }

    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, [hasRunningTimedJob]);

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

  function openOutputDirectory(job: ExtractionJob): void {
    if (job.status !== "completed" || !job.output?.canOpenOutputDirectory) {
      return;
    }

    void onOpenOutputDirectory?.(job.id).catch(() => undefined);
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
        <ul
          className={[
            "job-list",
            "transient-scrollbar",
            listScrollbar.isScrollbarActive ? "transient-scrollbar--active" : undefined
          ]
            .filter(Boolean)
            .join(" ")}
          onScroll={listScrollbar.onScroll}
        >
          {visibleJobs.map((job) => {
            const statusConfig = STATUS_CONFIG[job.status];
            const card = getJobCardViewModel(job, { nowMs });
            const jobRowClassName = [
              "job-row",
              "job-card",
              `job-card--${job.status}`,
              job.id === activeJobId ? "job-card--active" : undefined
            ]
              .filter(Boolean)
              .join(" ");
            const shouldShowProgress =
              card.hasStructuredProgress || card.progressText !== card.title;
            const outputDirectoryAction =
              job.status === "completed" && job.output?.canOpenOutputDirectory ? (
                <button
                  className="button button--secondary button--compact"
                  onClick={() => openOutputDirectory(job)}
                  type="button"
                >
                  打开输出目录
                </button>
              ) : null;

            return (
              <li className={jobRowClassName} key={job.id}>
                <div className="job-card__header">
                  <div className="job-card__identity">
                    <div className="job-card__title-line">
                      <h3 className="job-card__title">{card.title}</h3>
                      <span className={`job-card__status job-card__status--${job.status}`}>
                        {statusConfig.label}
                      </span>
                    </div>
                    <div className="job-card__meta">
                      <span>模型：{card.modelText}</span>
                    </div>
                  </div>
                  <div className="job-row__actions">
                    {statusConfig.allowedActions.map((action) => (
                      <button
                        className="button button--secondary button--compact"
                        key={action}
                        onClick={() => runAction(job, action)}
                        type="button"
                      >
                        {TASK_ACTION_CONFIG[action].label}
                      </button>
                    ))}
                  </div>
                </div>
                {shouldShowProgress ? (
                  <div className="job-card__progress">
                    <div className="job-card__progress-heading">
                      {card.hasStructuredProgress ? (
                        <>
                          <span>{card.progressCountText}</span>
                          {card.progressPercentText ? <strong>{card.progressPercentText}</strong> : null}
                        </>
                      ) : (
                        <span>{card.progressText}</span>
                      )}
                    </div>
                    {card.hasStructuredProgress ? (
                      <ProgressBar
                        indicatorClassName={`job-card__progress-bar--${job.status}`}
                        label={`任务进度 ${card.progressPercentText ?? "--"}`}
                        value={card.progressWidthPercent}
                      />
                    ) : null}
                  </div>
                ) : null}
                <div className="job-card__details">
                  {job.status === "completed" ? (
                    <>
                      <span>耗时：{card.elapsedText}</span>
                      <span>完成时间：{card.completedAtText}</span>
                    </>
                  ) : null}
                  {job.status === "failed" ? <span>失败时间：{card.failedAtText}</span> : null}
                  {job.status === "running" || job.status === "paused" ? (
                    <>
                      <span>已用时：{card.elapsedText}</span>
                      <span>预计总耗时：{card.estimatedTotalText}</span>
                    </>
                  ) : null}
                  {job.tokenText ? <span className="job-row__token">{job.tokenText}</span> : null}
                  {job.failureReason ? (
                    <p className="danger-text job-row__failure">{job.failureReason}</p>
                  ) : null}
                </div>
                <div className="job-card__footer">
                  <JobLogPanel
                    footerActions={outputDirectoryAction}
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

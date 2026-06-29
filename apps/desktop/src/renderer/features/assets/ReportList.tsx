import type { ReportDto } from "../../../shared/ipcTypes";
import type { ResourceState } from "./assetsViewModel";
import { getReportSummary } from "./assetsViewModel";

export interface ReportListProps {
  reports: ReportDto[];
  state: ResourceState;
  errorMessage?: string;
  selectedReportId?: string | null;
  emptyMessage?: string;
  onSelectReport?: (reportId: string) => Promise<void> | void;
}

export function ReportList({
  reports,
  state,
  errorMessage,
  selectedReportId = null,
  emptyMessage = "暂无 Markdown 报告",
  onSelectReport
}: ReportListProps) {
  if (state === "loading") {
    return (
      <div className="skeleton-list" aria-label="报告列表加载中">
        <span />
        <span />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="state-banner state-banner--danger" role="alert">
        {errorMessage ?? "读取报告失败"}
      </div>
    );
  }

  if (reports.length === 0) {
    return <p className="empty-text">{emptyMessage}</p>;
  }

  return (
    <ul className="entity-list">
      {reports.map((report) => (
        <li key={report.id}>
          <button
            aria-pressed={selectedReportId === report.id}
            className="entity-row entity-row--button"
            onClick={() => {
              void Promise.resolve(onSelectReport?.(report.id)).catch(() => undefined);
            }}
            type="button"
          >
            <strong>{report.displayName}</strong>
            <span>{getReportSummary(report)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

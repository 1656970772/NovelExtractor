import { useState } from "react";

export interface JobLogPanelProps {
  logs?: readonly string[];
}

export function JobLogPanel({ logs = [] }: JobLogPanelProps) {
  const [isOpen, setOpen] = useState(false);

  if (logs.length === 0) {
    return <p className="job-log-summary">暂无运行日志</p>;
  }

  return (
    <div className="job-log-panel">
      <button
        className="button button--quiet"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {isOpen ? "收起日志" : "展开日志"}
      </button>
      {isOpen ? (
        <ul className="job-log-list">
          {logs.map((line, index) => (
            <li key={`${index}-${line}`}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

import { useState } from "react";

export interface JobLogPanelProps {
  jobId: string;
  logFilePath?: string;
  onReadLog?: (jobId: string) => Promise<string>;
}

export function JobLogPanel({ jobId, logFilePath, onReadLog }: JobLogPanelProps) {
  const [isOpen, setOpen] = useState(false);
  const [content, setContent] = useState<string | undefined>();
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  if (!logFilePath) {
    return <p className="job-log-summary">暂无运行日志</p>;
  }

  async function toggleOpen(): Promise<void> {
    const nextOpen = !isOpen;
    setOpen(nextOpen);

    if (!nextOpen || content || state === "loading") {
      return;
    }

    if (!onReadLog) {
      setContent("日志读取入口尚未就绪。");
      return;
    }

    setState("loading");
    setErrorMessage(undefined);

    try {
      const nextContent = await onReadLog(jobId);
      setContent(nextContent || "日志文件暂无内容。");
      setState("idle");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "读取日志失败");
      setState("error");
    }
  }

  return (
    <div className="job-log-panel">
      <button
        className="button button--quiet"
        onClick={() => {
          void toggleOpen();
        }}
        type="button"
      >
        {isOpen ? "收起日志" : "展开日志"}
      </button>
      {isOpen ? (
        <div className="job-log-content">
          <p className="job-log-path">{logFilePath}</p>
          {state === "loading" ? <p className="job-log-summary">正在读取日志</p> : null}
          {state === "error" ? (
            <p className="job-log-error">{errorMessage ?? "读取日志失败"}</p>
          ) : null}
          {content ? <pre className="job-log-text">{content}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

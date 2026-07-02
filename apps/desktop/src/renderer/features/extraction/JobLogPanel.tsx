import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface JobLogPanelProps {
  jobId: string;
  logFilePath?: string;
  onReadLog?: (jobId: string) => Promise<string>;
  onOpenLog?: (jobId: string) => Promise<void>;
}

const LOG_REFRESH_MS = 2000;
const AUTO_SCROLL_EPSILON = 24;

export function JobLogPanel({ jobId, logFilePath, onOpenLog, onReadLog }: JobLogPanelProps) {
  const [isOpen, setOpen] = useState(false);
  const [content, setContent] = useState<string | undefined>();
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [isFollowing, setFollowing] = useState(true);
  const logRef = useRef<HTMLPreElement | null>(null);

  async function refreshLog(): Promise<void> {
    if (!onReadLog) {
      setContent("运行流程读取入口尚未就绪。");
      return;
    }

    setState((currentState) => (content === undefined && currentState === "idle" ? "loading" : currentState));
    setErrorMessage(undefined);

    try {
      const nextContent = await onReadLog(jobId);
      setContent(nextContent || "运行流程暂无内容。");
      setState("idle");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "运行流程读取失败，可打开完整日志查看详情。");
      setState("error");
    }
  }

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    void refreshLog();
    const timer = window.setInterval(() => {
      void refreshLog();
    }, LOG_REFRESH_MS);

    return () => window.clearInterval(timer);
  }, [isOpen, jobId, onReadLog]);

  useLayoutEffect(() => {
    if (!isOpen || !isFollowing) {
      return;
    }

    const element = logRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [content, isFollowing, isOpen]);

  function handleScroll(): void {
    const element = logRef.current;
    if (!element) {
      return;
    }

    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    setFollowing(distanceToBottom <= AUTO_SCROLL_EPSILON);
  }

  function toggleLog(): void {
    const nextOpen = !isOpen;
    setOpen(nextOpen);
    if (nextOpen) {
      setFollowing(true);
    }
  }

  if (!logFilePath) {
    return <p className="job-log-summary">暂无运行流程</p>;
  }

  return (
    <div className="job-log-panel">
      <div className="job-log-actions">
        <button
          className="button button--quiet"
          onClick={toggleLog}
          type="button"
        >
          {isOpen ? "收起流程" : "展开流程"}
        </button>
        <button
          className="button button--quiet"
          onClick={() => {
            void onOpenLog?.(jobId).catch(() => undefined);
          }}
          type="button"
        >
          打开完整日志
        </button>
      </div>
      {isOpen ? (
        <div className="job-log-content">
          {state === "loading" ? <p className="job-log-summary">正在读取运行流程</p> : null}
          {state === "error" ? (
            <p className="job-log-error">{errorMessage ?? "运行流程读取失败"}</p>
          ) : null}
          {content ? (
            <pre className="job-log-text" onScroll={handleScroll} ref={logRef}>
              {content}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

import type { SafeMarkdownPreviewDto } from "../../../shared/ipcTypes";
import type { ResourceState } from "./assetsViewModel";

export interface MarkdownPreviewProps {
  preview?: SafeMarkdownPreviewDto | null;
  state: ResourceState;
  errorMessage?: string;
}

export function MarkdownPreview({
  preview = null,
  state,
  errorMessage
}: MarkdownPreviewProps) {
  if (state === "loading") {
    return (
      <div className="paper-preview__loading" aria-label="报告预览加载中">
        正在加载报告预览
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="state-banner state-banner--danger" role="alert">
        {errorMessage ?? "读取预览失败"}
      </div>
    );
  }

  if (!preview) {
    return <p className="empty-text">选择报告后可预览内容</p>;
  }

  return (
    <article
      aria-label="安全 Markdown 预览"
      className="markdown-preview"
      dangerouslySetInnerHTML={{ __html: preview.html }}
    />
  );
}

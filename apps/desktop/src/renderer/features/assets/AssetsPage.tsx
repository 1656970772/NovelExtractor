import type { ReportDto, SafeMarkdownPreviewDto } from "../../../shared/ipcTypes";
import { MarkdownPreview } from "./MarkdownPreview";
import { ReportList } from "./ReportList";
import {
  getBookAssetTypeLabel,
  getBookSummary,
  type AssetTypeLike,
  type BookAsset,
  type ResourceState
} from "./assetsViewModel";

export type { BookAsset, ResourceState } from "./assetsViewModel";

export interface AssetsPageProps {
  books: BookAsset[];
  reports: ReportDto[];
  state: ResourceState;
  reportState?: ResourceState;
  previewState?: ResourceState;
  assetTypes?: AssetTypeLike[];
  errorMessage?: string;
  reportErrorMessage?: string;
  previewErrorMessage?: string;
  preview?: SafeMarkdownPreviewDto | null;
  selectedBookId?: string | null;
  selectedReportId?: string | null;
  onSelectBook?: (bookId: string) => Promise<void> | void;
  onSelectReport?: (reportId: string) => Promise<void> | void;
}

export function AssetsPage({
  books,
  reports,
  state,
  reportState = "ready",
  previewState = "ready",
  assetTypes,
  errorMessage,
  reportErrorMessage,
  previewErrorMessage,
  preview = null,
  selectedBookId = null,
  selectedReportId = null,
  onSelectBook,
  onSelectReport
}: AssetsPageProps) {
  const bookAssetLabel = getBookAssetTypeLabel(assetTypes);
  const reportsEmptyMessage = books.length === 0 ? "暂无 Markdown 报告" : "选择书籍后显示报告";

  return (
    <section className="page-surface" aria-labelledby="assets-title">
      <div className="page-heading">
        <div>
          <p className="section-kicker">资产库</p>
          <h1 id="assets-title">资产</h1>
        </div>
        <span className="status-chip">
          {books.length} 本 / {reports.length} 份报告
        </span>
      </div>

      {state === "error" ? (
        <div className="state-banner state-banner--danger" role="alert">
          {errorMessage ?? "读取资产失败"}
        </div>
      ) : null}

      <div className="asset-layout">
        <section className="tool-panel" aria-labelledby="books-title">
          <div className="panel-heading">
            <h2 id="books-title">{bookAssetLabel}资产</h2>
            <span>{books.length} 项</span>
          </div>
          {state === "loading" ? (
            <div className="skeleton-list" aria-label="资产列表加载中">
              <span />
              <span />
              <span />
            </div>
          ) : books.length === 0 ? (
            <p className="empty-text">暂无书籍资产</p>
          ) : (
            <ul className="entity-list">
              {books.map((book) => (
                <li key={book.id}>
                  <button
                    aria-pressed={selectedBookId === book.id}
                    className="entity-row entity-row--button"
                    onClick={() => {
                      void Promise.resolve(onSelectBook?.(book.id)).catch(() => undefined);
                    }}
                    type="button"
                  >
                    <strong>{book.displayName}</strong>
                    <span>{getBookSummary(book)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="tool-panel" aria-labelledby="reports-title">
          <div className="panel-heading">
            <h2 id="reports-title">Markdown 报告</h2>
            <span>{reports.length} 项</span>
          </div>
          <ReportList
            emptyMessage={reportsEmptyMessage}
            errorMessage={reportErrorMessage}
            reports={reports}
            selectedReportId={selectedReportId}
            state={state === "loading" ? "loading" : reportState}
            onSelectReport={onSelectReport}
          />
        </section>

        <section className="paper-preview" aria-labelledby="preview-title">
          <div className="panel-heading">
            <h2 id="preview-title">报告预览</h2>
            <span>{selectedReportId ? "已选择" : "未选择"}</span>
          </div>
          <MarkdownPreview
            errorMessage={previewErrorMessage}
            preview={preview}
            state={previewState}
          />
        </section>
      </div>
    </section>
  );
}

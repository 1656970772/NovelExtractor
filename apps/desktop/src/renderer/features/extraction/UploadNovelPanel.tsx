import { useState } from "react";
import type { ChangeEvent } from "react";
import { formatByteSize, type ExtractionBook } from "./extractionViewModel";

export type UploadState = "idle" | "uploading" | "error";

export interface UploadNovelPanelProps {
  books: readonly ExtractionBook[];
  uploadState?: UploadState;
  uploadError?: string;
  onUploadTxt?: (file: File) => Promise<void>;
}

export function UploadNovelPanel({
  books,
  uploadState = "idle",
  uploadError,
  onUploadTxt
}: UploadNovelPanelProps) {
  const [localError, setLocalError] = useState<string | undefined>();
  const isUploading = uploadState === "uploading";

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    if (!file.name.toLowerCase().endsWith(".txt")) {
      setLocalError("请选择 .txt 文件");
      return;
    }

    if (!onUploadTxt) {
      setLocalError("上传入口尚未就绪");
      return;
    }

    setLocalError(undefined);

    try {
      await onUploadTxt(file);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "上传小说失败");
    }
  }

  return (
    <section className="tool-panel upload-panel" aria-labelledby="upload-title">
      <div className="panel-heading">
        <h2 id="upload-title">上传小说</h2>
        <span>.txt</span>
      </div>

      <label className="file-upload-field">
        <span>选择 .txt 文件</span>
        <input
          accept=".txt,text/plain"
          disabled={isUploading}
          onChange={(event) => {
            void handleFileChange(event);
          }}
          type="file"
        />
      </label>

      {uploadError || localError ? (
        <p className="form-error" role="alert">
          {uploadError ?? localError}
        </p>
      ) : null}

      {books.length === 0 ? (
        <p className="empty-text">暂无书籍可提取</p>
      ) : (
        <ul className="entity-list">
          {books.map((book) => (
            <li className="entity-row entity-row--metadata" key={book.id}>
              <strong>{book.fileName}</strong>
              <span>{book.displayName}</span>
              <dl className="metadata-grid">
                <div>
                  <dt>大小</dt>
                  <dd>{formatByteSize(book.byteSize)}</dd>
                </div>
                <div>
                  <dt>编码</dt>
                  <dd>{book.encoding}</dd>
                </div>
                <div>
                  <dt>章节</dt>
                  <dd>章节数 {book.chapterCount}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

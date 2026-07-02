import { useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { formatByteSize, type ExtractionBook } from "./extractionViewModel";

const NOVEL_FILE_ACCEPT = ".txt,.md,text/plain,text/markdown";
const SUPPORTED_NOVEL_FILE_EXTENSIONS = [".txt", ".md"] as const;
const UNSUPPORTED_NOVEL_FILE_MESSAGE = "仅支持 .txt 或 .md 小说文件";

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
  const [isNovelDragActive, setNovelDragActive] = useState(false);
  const isUploading = uploadState === "uploading";

  async function uploadFile(file: File): Promise<void> {
    if (!isSupportedNovelFile(file)) {
      setLocalError(UNSUPPORTED_NOVEL_FILE_MESSAGE);
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

  async function handleSelectedFiles(fileList: FileList | readonly File[] | null): Promise<void> {
    const files = Array.from(fileList ?? []);

    if (files.length === 0) {
      return;
    }

    if (files.length > 1) {
      setLocalError("每次只能上传一本小说");
      return;
    }

    await uploadFile(files[0]);
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    await handleSelectedFiles(input.files);
    input.value = "";
  }

  function handleNovelDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setNovelDragActive(false);
    void handleSelectedFiles(event.dataTransfer.files);
  }

  function handleNovelDragEnter(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    if (!isUploading) {
      setNovelDragActive(true);
    }
  }

  return (
    <section className="tool-panel upload-panel" aria-labelledby="upload-title">
      <div className="panel-heading">
        <h2 id="upload-title">上传小说</h2>
        <span>.txt / .md</span>
      </div>

      <div
        aria-label="拖拽上传小说原文"
        className={`template-modal__upload-zone novel-upload__zone${
          isNovelDragActive ? " template-modal__upload-zone--active" : ""
        }`}
        onDragEnter={handleNovelDragEnter}
        onDragLeave={() => setNovelDragActive(false)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleNovelDrop}
        role="button"
        tabIndex={0}
      >
        <span>拖拽 .txt 或 .md 小说文件到这里</span>
        <label className="button button--secondary button--compact template-modal__upload-picker">
          <span>选择小说文件</span>
          <input
            accept={NOVEL_FILE_ACCEPT}
            aria-label="选择小说文件"
            disabled={isUploading}
            onChange={(event) => {
              void handleFileChange(event);
            }}
            type="file"
          />
        </label>
      </div>

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

function isSupportedNovelFile(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  return SUPPORTED_NOVEL_FILE_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

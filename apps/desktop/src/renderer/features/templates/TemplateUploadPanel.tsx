import { useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import type { SaveTemplateDto, TemplateDto, TemplateScope } from "../../../shared/ipcTypes";

export interface TemplateUploadPanelProps {
  projectId: string;
  templates: readonly Pick<TemplateDto, "name">[];
  isSaving?: boolean;
  footerActions?: ReactNode;
  onOpenNewTemplate?: () => void;
  onSaveTemplate: (input: SaveTemplateDto) => Promise<TemplateDto | void>;
}

function getTemplateFileExtension(fileName: string): string {
  const extensionIndex = fileName.lastIndexOf(".");
  return extensionIndex === -1 ? "" : fileName.slice(extensionIndex).toLowerCase();
}

function isSupportedTemplateFile(fileName: string): boolean {
  return [".txt", ".md"].includes(getTemplateFileExtension(fileName));
}

function createTemplateNameFromFileName(fileName: string): string {
  const extensionIndex = fileName.lastIndexOf(".");
  const name = (extensionIndex === -1 ? fileName : fileName.slice(0, extensionIndex)).trim();
  return name || "template";
}

function hasDuplicate(names: readonly string[]): boolean {
  return new Set(names).size !== names.length;
}

export function TemplateUploadPanel({
  projectId,
  templates,
  isSaving,
  footerActions,
  onOpenNewTemplate,
  onSaveTemplate
}: TemplateUploadPanelProps) {
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isGlobalTemplate, setIsGlobalTemplate] = useState(false);
  const [isUploadDragActive, setUploadDragActive] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [successMessage, setSuccessMessage] = useState<string | undefined>();

  function addFiles(fileList: FileList | readonly File[]): void {
    const files = Array.from(fileList);

    if (files.length === 0) {
      return;
    }

    if (files.some((file) => !isSupportedTemplateFile(file.name))) {
      setErrorMessage("仅支持 .txt 或 .md 文件");
      setSuccessMessage(undefined);
      return;
    }

    setPendingFiles((currentFiles) => {
      const currentNames = new Set(currentFiles.map((file) => file.name));
      const nextFiles = [...currentFiles];

      for (const file of files) {
        if (!currentNames.has(file.name)) {
          nextFiles.push(file);
          currentNames.add(file.name);
        }
      }

      return nextFiles;
    });
    setErrorMessage(undefined);
    setSuccessMessage(undefined);
  }

  function handleUploadInputChange(event: ChangeEvent<HTMLInputElement>): void {
    if (event.currentTarget.files) {
      addFiles(event.currentTarget.files);
    }
    event.currentTarget.value = "";
  }

  function handleUploadDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setUploadDragActive(false);
    addFiles(event.dataTransfer.files);
  }

  async function uploadPendingFiles(): Promise<void> {
    if (pendingFiles.length === 0) {
      return;
    }

    const pendingNames = pendingFiles.map((file) => createTemplateNameFromFileName(file.name));
    const existingTemplateNames = new Set(templates.map((template) => template.name));

    if (hasDuplicate(pendingNames) || pendingNames.some((name) => existingTemplateNames.has(name))) {
      setErrorMessage("模板名字已存在");
      setSuccessMessage(undefined);
      return;
    }

    const scope: TemplateScope = isGlobalTemplate ? "global" : "project";

    try {
      for (const file of pendingFiles) {
        const fileName = file.name.trim();
        await onSaveTemplate({
          projectId,
          scope,
          name: createTemplateNameFromFileName(fileName),
          fileName,
          body: await file.text()
        });
      }

      setSuccessMessage(`已上传 ${pendingFiles.length} 个模板`);
      setPendingFiles([]);
      setErrorMessage(undefined);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "上传模板失败");
      setSuccessMessage(undefined);
    }
  }

  return (
    <div className="template-upload">
      <div
        aria-label="拖拽上传模板"
        className={`template-modal__upload-zone${
          isUploadDragActive ? " template-modal__upload-zone--active" : ""
        }`}
        onDragEnter={(event) => {
          event.preventDefault();
          setUploadDragActive(true);
        }}
        onDragLeave={() => setUploadDragActive(false)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleUploadDrop}
        role="button"
        tabIndex={0}
      >
        <span>拖拽 .txt / .md 文件到这里</span>
        <label className="button button--secondary button--compact template-modal__upload-picker">
          <span>选择模板文件</span>
          <input
            accept=".txt,.md,text/plain,text/markdown"
            aria-label="选择模板文件"
            disabled={isSaving}
            multiple
            onChange={handleUploadInputChange}
            type="file"
          />
        </label>
      </div>

      {pendingFiles.length > 0 ? (
        <ul className="template-upload__file-list" aria-label="待上传模板">
          {pendingFiles.map((file) => (
            <li key={`${file.name}-${file.size}`}>
              <span>{file.name}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <label className="provider-form__radio">
        <input
          checked={isGlobalTemplate}
          onChange={(event) => setIsGlobalTemplate(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>是否全局模板</span>
      </label>

      {errorMessage ? (
        <p className="form-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {successMessage ? <p className="template-upload__success">{successMessage}</p> : null}

      <div className="template-upload__actions">
        <button
          className="button button--primary button--compact template-upload__submit-button"
          disabled={isSaving || pendingFiles.length === 0}
          onClick={() => {
            void uploadPendingFiles();
          }}
          type="button"
        >
          上传模板
        </button>
        {footerActions}
      </div>

      {onOpenNewTemplate ? (
        <button
          className="button button--secondary template-upload__manual-button"
          onClick={onOpenNewTemplate}
          type="button"
        >
          手动新增模板
        </button>
      ) : null}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { TemplateView } from "./templateViewModel";

export interface TemplateSelectorProps {
  templates: readonly TemplateView[];
  selectedTemplateIds: readonly string[];
  disabled?: boolean;
  onSelectionChange: (templateIds: string[]) => void;
  onOpenTemplateManager?: () => void;
}

const TEMPLATE_PREVIEW_DELAY_MS = 500;

export function TemplateSelector({
  templates,
  selectedTemplateIds,
  disabled,
  onOpenTemplateManager
}: TemplateSelectorProps) {
  const selectedCount = selectedTemplateIds.length;
  const [isPreviewOpen, setPreviewOpen] = useState(false);
  const previewTimerRef = useRef<number | undefined>();
  const selectedTemplates = useMemo(() => {
    const templatesById = new Map(templates.map((template) => [template.id, template]));
    return selectedTemplateIds
      .map((templateId) => templatesById.get(templateId))
      .filter((template): template is TemplateView => Boolean(template));
  }, [selectedTemplateIds, templates]);

  function clearPreviewTimer(): void {
    if (previewTimerRef.current !== undefined) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = undefined;
    }
  }

  function openPreviewAfterDelay(): void {
    clearPreviewTimer();
    previewTimerRef.current = window.setTimeout(() => {
      setPreviewOpen(true);
      previewTimerRef.current = undefined;
    }, TEMPLATE_PREVIEW_DELAY_MS);
  }

  function closePreview(): void {
    clearPreviewTimer();
    setPreviewOpen(false);
  }

  useEffect(() => clearPreviewTimer, []);

  return (
    <div className="template-selector" onMouseEnter={openPreviewAfterDelay} onMouseLeave={closePreview}>
      <button
        aria-haspopup="dialog"
        className="button button--secondary template-selector__trigger"
        disabled={disabled || !onOpenTemplateManager}
        onClick={onOpenTemplateManager}
        type="button"
      >
        <span className="template-selector__trigger-label">选择模板</span>
        <span className="template-selector__trigger-count">
          {selectedCount} 个已选 / {templates.length} 个模板
        </span>
      </button>
      {isPreviewOpen ? (
        <aside aria-label="已选模板预览" className="template-selector__preview" role="region">
          <div className="template-selector__preview-heading">
            <h3>已选模板</h3>
            <span>仅预览</span>
          </div>
          {selectedTemplates.length > 0 ? (
            <ul className="template-selector__preview-list">
              {selectedTemplates.map((template) => (
                <li className="template-selector__preview-item" key={template.id}>
                  <strong>{template.name}</strong>
                  <span>{template.scope === "global" ? "全局模板" : "项目模板"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-text">暂无已选模板</p>
          )}
        </aside>
      ) : null}
    </div>
  );
}

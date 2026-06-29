import type { TemplateView } from "./templateViewModel";

export interface TemplateSelectorProps {
  templates: readonly TemplateView[];
  selectedTemplateIds: readonly string[];
  disabled?: boolean;
  onSelectionChange: (templateIds: string[]) => void;
  onOpenTemplateManager?: () => void;
}

export function TemplateSelector({
  templates,
  selectedTemplateIds,
  disabled,
  onOpenTemplateManager
}: TemplateSelectorProps) {
  const selectedCount = selectedTemplateIds.length;

  return (
    <div className="template-selector">
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
    </div>
  );
}

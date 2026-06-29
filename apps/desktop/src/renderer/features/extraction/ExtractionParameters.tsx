import { TemplateSelector } from "../templates/TemplateSelector";
import type { TemplateView } from "../templates/templateViewModel";
import type { ExtractionFormState, ExtractionModel, ExtractionBook } from "./extractionViewModel";

export type CreateJobState = "idle" | "creating" | "error";

export interface ExtractionParametersProps {
  books: readonly ExtractionBook[];
  models: readonly ExtractionModel[];
  templates: readonly TemplateView[];
  formState: ExtractionFormState;
  createState?: CreateJobState;
  createError?: string;
  onFormChange: (state: ExtractionFormState) => void;
  onCreateJob: () => void;
  onOpenProviderConfig?: () => void;
  onOpenTemplateManager?: () => void;
}

function updateNumber(value: string): number {
  if (value === "") {
    return Number.NaN;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

function renderNumberValue(value: number): number | "" {
  return Number.isNaN(value) ? "" : value;
}

export function ExtractionParameters({
  books,
  models,
  templates,
  formState,
  createState = "idle",
  createError,
  onFormChange,
  onCreateJob,
  onOpenProviderConfig,
  onOpenTemplateManager
}: ExtractionParametersProps) {
  const isCreating = createState === "creating";
  const canCreate =
    books.length > 0 && models.length > 0 && formState.templateIds.length > 0 && !isCreating;

  return (
    <section className="tool-panel parameters-panel" aria-labelledby="parameters-title">
      <div className="panel-heading">
        <h2 id="parameters-title">提取参数</h2>
        <span>{templates.length} 个模板</span>
      </div>

      <label className="provider-form__field">
        <span>书籍</span>
        <select
          disabled={books.length === 0 || isCreating}
          onChange={(event) => {
            onFormChange({ ...formState, bookId: event.currentTarget.value });
          }}
          value={formState.bookId}
        >
          {books.length === 0 ? <option value="">先上传小说</option> : null}
          {books.map((book) => (
            <option key={book.id} value={book.id}>
              {book.displayName}
            </option>
          ))}
        </select>
      </label>

      <TemplateSelector
        disabled={isCreating}
        selectedTemplateIds={formState.templateIds}
        templates={templates}
        onOpenTemplateManager={onOpenTemplateManager}
        onSelectionChange={(templateIds) => {
          onFormChange({
            ...formState,
            templateIds
          });
        }}
      />

      <div className="parameter-grid">
        <label className="provider-form__field">
          <span>单次运行章节数</span>
          <input
            min={1}
            onChange={(event) => {
              onFormChange({
                ...formState,
                singleRunChapterCount: updateNumber(event.currentTarget.value)
              });
            }}
            type="number"
            value={renderNumberValue(formState.singleRunChapterCount)}
          />
        </label>
        <label className="provider-form__field">
          <span>提取章节窗口</span>
          <input
            min={1}
            onChange={(event) => {
              onFormChange({
                ...formState,
                extractionChapterCount: updateNumber(event.currentTarget.value)
              });
            }}
            type="number"
            value={renderNumberValue(formState.extractionChapterCount)}
          />
        </label>
      </div>

      <label className="provider-form__field">
        <span>模型</span>
        <select
          disabled={models.length === 0 || isCreating}
          onChange={(event) => {
            onFormChange({ ...formState, modelOptionId: event.currentTarget.value });
          }}
          value={formState.modelOptionId}
        >
          {models.length === 0 ? <option value="">未配置模型</option> : null}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName}
            </option>
          ))}
        </select>
      </label>

      {models.length === 0 ? (
        <div className="empty-action">
          <p className="empty-text">暂无可用模型</p>
          {onOpenProviderConfig ? (
            <button
              className="button button--secondary"
              onClick={onOpenProviderConfig}
              type="button"
            >
              前往大模型配置
            </button>
          ) : null}
        </div>
      ) : null}

      {createError ? (
        <p className="form-error" role="alert">
          {createError}
        </p>
      ) : null}

      <button
        className="button button--primary"
        disabled={!canCreate}
        onClick={onCreateJob}
        type="button"
      >
        创建任务
      </button>
    </section>
  );
}

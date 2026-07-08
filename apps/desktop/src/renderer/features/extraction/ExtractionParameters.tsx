import { TemplateSelector } from "../templates/TemplateSelector";
import type { TemplateView } from "../templates/templateViewModel";
import {
  AUTO_PROVIDER_OPTION_ID,
  type ExtractionProviderOption
} from "../providers/providerViewModel";
import type { ExtractionFormState, ExtractionBook } from "./extractionViewModel";

export type CreateJobState = "idle" | "creating" | "error";

export interface ExtractionParametersProps {
  books: readonly ExtractionBook[];
  providerOptions: readonly ExtractionProviderOption[];
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

function updateNonNegativeNumber(value: string): number {
  if (value === "") {
    return Number.NaN;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function renderNumberValue(value: number): number | "" {
  return Number.isNaN(value) ? "" : value;
}

type ProviderOption = Extract<ExtractionProviderOption, { kind: "provider" }>;

function isProviderOption(option: ExtractionProviderOption): option is ProviderOption {
  return option.kind === "provider";
}

export function ExtractionParameters({
  books,
  providerOptions,
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
  const providerOnlyOptions = providerOptions.filter(isProviderOption);
  const selectedProviderOption = providerOnlyOptions.find(
    (providerOption) => providerOption.id === formState.modelProviderOptionId
  );
  const providerSelectValue =
    providerOnlyOptions.length === 0
      ? ""
      : selectedProviderOption
        ? selectedProviderOption.id
        : AUTO_PROVIDER_OPTION_ID;
  const canCreate =
    books.length > 0 &&
    providerOnlyOptions.length > 0 &&
    formState.templateIds.length > 0 &&
    !isCreating;

  return (
    <section className="tool-panel parameters-panel" aria-labelledby="parameters-title">
      <div className="panel-heading">
        <h2 id="parameters-title">提取参数</h2>
        <span>{templates.length} 个模板</span>
      </div>

      <div className="parameters-panel__groups">
        <fieldset className="parameter-section">
          <legend>提取规则</legend>

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
        </fieldset>

        <fieldset className="parameter-section">
          <legend>章节识别</legend>

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
            <label className="provider-form__field">
              <span>重叠章节数</span>
              <input
                min={0}
                onChange={(event) => {
                  onFormChange({
                    ...formState,
                    overlapChapterCount: updateNonNegativeNumber(event.currentTarget.value)
                  });
                }}
                type="number"
                value={renderNumberValue(formState.overlapChapterCount)}
              />
            </label>
            <label className="provider-form__field">
              <span>单批次模板数</span>
              <input
                min={1}
                onChange={(event) => {
                  onFormChange({
                    ...formState,
                    templateBatchSize: updateNumber(event.currentTarget.value)
                  });
                }}
                type="number"
                value={renderNumberValue(formState.templateBatchSize)}
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="parameter-section">
          <legend>重复章节过滤</legend>

          <div className="provider-form__toggles parameter-section__toggles">
            <label>
              <input
                checked={formState.skipAlreadyExtracted}
                disabled={isCreating}
                onChange={(event) => {
                  onFormChange({
                    ...formState,
                    skipAlreadyExtracted: event.currentTarget.checked
                  });
                }}
                type="checkbox"
              />
              <span>跳过已提取章节</span>
            </label>
          </div>
        </fieldset>

        <fieldset className="parameter-section">
          <legend>模型设置</legend>

          <label className="provider-form__field">
            <span>模型服务</span>
            <select
              disabled={providerOnlyOptions.length === 0 || isCreating}
              onChange={(event) => {
                const providerOptionId = event.currentTarget.value;
                const providerOption = providerOnlyOptions.find(
                  (option) => option.id === providerOptionId
                );

                onFormChange({
                  ...formState,
                  modelProviderOptionId: providerOption?.id ?? AUTO_PROVIDER_OPTION_ID,
                  modelModelId:
                    providerOption?.defaultModelId ?? providerOnlyOptions[0]?.defaultModelId ?? "",
                  modelSelectionMode: providerOption ? "explicit" : "auto"
                });
              }}
              value={providerSelectValue}
            >
              {providerOnlyOptions.length === 0 ? <option value="">未配置模型</option> : null}
              {providerOptions.map((providerOption) => (
                <option key={providerOption.id} value={providerOption.id}>
                  {providerOption.displayName}
                </option>
              ))}
            </select>
          </label>

          {selectedProviderOption ? (
            <label className="provider-form__field">
              <span>子模型</span>
              <select
                disabled={isCreating}
                onChange={(event) => {
                  onFormChange({
                    ...formState,
                    modelProviderOptionId: selectedProviderOption.id,
                    modelModelId: event.currentTarget.value,
                    modelSelectionMode: "explicit"
                  });
                }}
                value={formState.modelModelId}
              >
                {selectedProviderOption.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {providerOnlyOptions.length === 0 ? (
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
        </fieldset>
      </div>

      {createError ? (
        <p className="form-error" role="alert">
          {createError}
        </p>
      ) : null}

      <button
        className="button button--primary parameters-panel__submit"
        disabled={!canCreate}
        onClick={onCreateJob}
        type="button"
      >
        创建任务
      </button>
    </section>
  );
}

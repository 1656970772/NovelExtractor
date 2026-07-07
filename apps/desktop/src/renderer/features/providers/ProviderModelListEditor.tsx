import type { ProviderModelDto } from "../../../shared/ipcTypes";

interface ProviderModelListEditorProps {
  disabled: boolean;
  modelName: string;
  models: ProviderModelDto[];
  onChange: (models: ProviderModelDto[], modelName: string) => void;
}

function createEmptyModel(): ProviderModelDto {
  return {
    id: "",
    displayName: "",
    enabled: true,
    isDefault: false
  };
}

function getModelLabel(model: ProviderModelDto, index: number): string {
  return model.displayName.trim() || model.id.trim() || `${index + 1}`;
}

function syncDefault(models: ProviderModelDto[], modelName: string): ProviderModelDto[] {
  return models.map((model) => ({
    ...model,
    isDefault: model.id === modelName
  }));
}

function resolveNextModelName(models: ProviderModelDto[], preferredModelName: string): string {
  const trimmedPreferred = preferredModelName.trim();
  if (trimmedPreferred && models.some((model) => model.id === trimmedPreferred)) {
    return trimmedPreferred;
  }

  return (
    models.find((model) => model.enabled && model.id.trim())?.id ??
    models.find((model) => model.id.trim())?.id ??
    ""
  );
}

export function ProviderModelListEditor({
  disabled,
  modelName,
  models,
  onChange
}: ProviderModelListEditorProps) {
  const rows = models.length > 0 ? models : [createEmptyModel()];

  function commit(nextRows: ProviderModelDto[], preferredModelName = modelName): void {
    const nextModelName = resolveNextModelName(nextRows, preferredModelName);
    onChange(syncDefault(nextRows, nextModelName), nextModelName);
  }

  function updateRow(index: number, patch: Partial<ProviderModelDto>): void {
    const nextRows = rows.map((model, rowIndex) =>
      rowIndex === index ? { ...model, ...patch } : model
    );
    commit(nextRows);
  }

  function updateModelId(index: number, id: string): void {
    const currentModel = rows[index] ?? createEmptyModel();
    const wasDefault = currentModel.isDefault || currentModel.id === modelName;
    const shouldMirrorDisplayName =
      !currentModel.displayName.trim() || currentModel.displayName === currentModel.id;
    const nextRows = rows.map((model, rowIndex) =>
      rowIndex === index
        ? {
            ...model,
            id,
            displayName: shouldMirrorDisplayName ? id : model.displayName
          }
        : model
    );
    if (wasDefault) {
      onChange(
        nextRows.map((model, rowIndex) => ({
          ...model,
          isDefault: rowIndex === index
        })),
        id
      );
      return;
    }

    const nextModelName = currentModel.id === modelName ? id : modelName;
    commit(nextRows, nextModelName);
  }

  function selectDefault(index: number): void {
    const nextModelName = rows[index]?.id ?? "";
    commit(rows, nextModelName);
  }

  function removeRow(index: number): void {
    const nextRows = rows.filter((_, rowIndex) => rowIndex !== index);
    commit(nextRows.length > 0 ? nextRows : [createEmptyModel()]);
  }

  return (
    <fieldset className="provider-model-editor" disabled={disabled}>
      <legend>模型列表</legend>
      <div className="provider-model-editor__rows">
        {rows.map((model, index) => {
          const label = getModelLabel(model, index);

          return (
            <div className="provider-model-editor__row" key={index}>
              <label className="provider-model-editor__default">
                <input
                  aria-label={`设为默认 ${label}`}
                  checked={model.isDefault}
                  disabled={disabled || !model.id.trim()}
                  name="provider-default-model"
                  onChange={() => selectDefault(index)}
                  type="radio"
                />
              </label>
              <label className="provider-model-editor__field">
                <span>型号</span>
                <input
                  aria-label={`模型型号 ${label}`}
                  onChange={(event) => updateModelId(index, event.target.value)}
                  value={model.id}
                />
              </label>
              <label className="provider-model-editor__field">
                <span>显示名</span>
                <input
                  aria-label={`模型显示名 ${label}`}
                  onChange={(event) => updateRow(index, { displayName: event.target.value })}
                  value={model.displayName}
                />
              </label>
              <label className="provider-model-editor__enabled">
                <input
                  aria-label={`启用 ${label}`}
                  checked={model.enabled}
                  onChange={(event) => updateRow(index, { enabled: event.target.checked })}
                  type="checkbox"
                />
              </label>
              <button
                aria-label={`删除 ${label}`}
                className="button button--quiet"
                disabled={disabled}
                onClick={() => removeRow(index)}
                type="button"
              >
                删除
              </button>
            </div>
          );
        })}
      </div>
      <button
        className="button button--secondary"
        disabled={disabled}
        onClick={() => commit([...rows, createEmptyModel()])}
        type="button"
      >
        添加模型
      </button>
    </fieldset>
  );
}

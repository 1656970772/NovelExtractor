import { getProviderPresets } from "@novel-extractor/config";
import type { FormEvent } from "react";
import {
  selectProviderPreset,
  syncDefaultModelFlags,
  validateProviderForm,
  type ProviderFormState,
  type ProviderPresetId,
  type ProviderSaveState
} from "./providerViewModel";

export interface ProviderFormProps {
  formState: ProviderFormState;
  saveState: ProviderSaveState;
  saveError?: string;
  onChange: (state: ProviderFormState) => void;
  onCancel: () => void;
  onFetchModels: () => void;
  onSubmit: () => void;
}

const PROVIDER_PRESETS = getProviderPresets();

export function ProviderForm({
  formState,
  saveState,
  saveError,
  onChange,
  onCancel,
  onFetchModels,
  onSubmit
}: ProviderFormProps) {
  const selectedPreset = PROVIDER_PRESETS.find((preset) => preset.id === formState.presetId);
  const validation = validateProviderForm(formState);
  const isSaving = saveState === "saving";
  const isFetchingModels = formState.modelFetchState === "loading";
  const isPresetLocked = !selectedPreset?.allowsUserModels;
  const shouldUseModelSelect = formState.models.length > 0;

  function updateForm(patch: Partial<ProviderFormState>): void {
    onChange({ ...formState, ...patch });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!validation.isValid || isSaving) {
      return;
    }
    onSubmit();
  }

  return (
    <form className="provider-form" onSubmit={handleSubmit}>
      <fieldset className="provider-form__presets" disabled={isSaving}>
        <legend>服务模式</legend>
        {PROVIDER_PRESETS.map((preset) => (
          <label className="provider-form__radio" key={preset.id}>
            <input
              checked={formState.presetId === preset.id}
              name="provider-preset"
              onChange={() =>
                onChange(selectProviderPreset(formState, preset.id as ProviderPresetId))
              }
              type="radio"
            />
            <span>{preset.displayName}</span>
          </label>
        ))}
      </fieldset>

      {selectedPreset ? (
        <div className="provider-form__metadata">
          {selectedPreset.websiteUrl ? (
            <a href={selectedPreset.websiteUrl} rel="noreferrer" target="_blank">
              官网
            </a>
          ) : null}
          {selectedPreset.apiKeyUrl ? (
            <a href={selectedPreset.apiKeyUrl} rel="noreferrer" target="_blank">
              API key
            </a>
          ) : null}
          <span>{selectedPreset.apiFormat}</span>
        </div>
      ) : null}

      <label className="provider-form__field">
        <span>配置名称</span>
        <input
          disabled={isSaving}
          onChange={(event) => updateForm({ displayName: event.target.value })}
          value={formState.displayName}
        />
      </label>

      <label className="provider-form__field">
        <span>Base URL</span>
        <input
          disabled={isSaving}
          onChange={(event) => updateForm({ baseUrl: event.target.value })}
          readOnly={isPresetLocked}
          value={formState.baseUrl}
        />
      </label>

      <label className="provider-form__field">
        <span>API key</span>
        <input
          autoComplete="off"
          disabled={isSaving}
          onChange={(event) => updateForm({ apiKey: event.target.value })}
          type="password"
          value={formState.apiKey}
        />
      </label>

      <label className="provider-form__field">
        <span>模型名</span>
        {shouldUseModelSelect ? (
          <select
            disabled={isSaving}
            onChange={(event) => {
              const modelName = event.target.value;
              updateForm({
                modelName,
                models: syncDefaultModelFlags(formState.models, modelName)
              });
            }}
            value={formState.modelName}
          >
            {formState.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
        ) : (
          <input
            disabled={isSaving}
            onChange={(event) => updateForm({ modelName: event.target.value })}
            value={formState.modelName}
          />
        )}
      </label>

      <div className="provider-form__model-actions">
        <button
          aria-label="获取模型列表"
          className="button button--secondary"
          disabled={isSaving || isFetchingModels}
          onClick={onFetchModels}
          type="button"
        >
          {isFetchingModels ? "获取中" : "获取模型"}
        </button>
      </div>

      {formState.modelFetchState === "error" && formState.modelFetchError ? (
        <p className="form-error" role="alert">
          {formState.modelFetchError}
        </p>
      ) : null}

      <div className="provider-form__toggles">
        <label>
          <input
            checked={formState.defaultModel}
            disabled={isSaving}
            onChange={(event) => updateForm({ defaultModel: event.target.checked })}
            type="checkbox"
          />
          <span>设为默认模型</span>
        </label>
        <label>
          <input
            checked={formState.enabled}
            disabled={isSaving}
            onChange={(event) => updateForm({ enabled: event.target.checked })}
            type="checkbox"
          />
          <span>启用配置</span>
        </label>
      </div>

      {saveState === "error" && saveError ? (
        <p className="form-error" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="provider-form__actions">
        <button className="button button--quiet" disabled={isSaving} onClick={onCancel} type="button">
          取消
        </button>
        <button
          className="button button--primary"
          disabled={isSaving || !validation.isValid}
          type="submit"
        >
          保存配置
        </button>
      </div>
    </form>
  );
}

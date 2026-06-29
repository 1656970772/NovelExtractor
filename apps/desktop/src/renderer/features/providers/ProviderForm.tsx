import { getProviderPresets } from "@novel-extractor/config";
import type { FormEvent } from "react";
import {
  selectProviderPreset,
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
  onSubmit: () => void;
}

const PROVIDER_PRESETS = getProviderPresets();

export function ProviderForm({
  formState,
  saveState,
  saveError,
  onChange,
  onCancel,
  onSubmit
}: ProviderFormProps) {
  const selectedPreset = PROVIDER_PRESETS.find((preset) => preset.id === formState.presetId);
  const validation = validateProviderForm(formState);
  const isSaving = saveState === "saving";
  const isPresetLocked = !selectedPreset?.allowsUserModels;

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
        {selectedPreset && selectedPreset.models.length > 0 ? (
          <select
            disabled={isSaving}
            onChange={(event) => updateForm({ modelName: event.target.value })}
            value={formState.modelName}
          >
            {selectedPreset.models.map((model) => (
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

import { getProviderPresets } from "@novel-extractor/config";
import type { ProviderPreset } from "@novel-extractor/config";
import type { ProviderViewDto, SaveProviderDto } from "../../../shared/ipcTypes";
import type { ExtractionModel } from "../extraction/extractionViewModel";

export type ProviderPresetId = SaveProviderDto["presetId"];
export type ProviderSaveState = "idle" | "saving" | "error";
export type ProviderResourceState = "ready" | "loading" | "error";

export interface ProviderFormState {
  providerId?: string;
  presetId: ProviderPresetId;
  displayName: string;
  kind: SaveProviderDto["kind"];
  baseUrl: string;
  apiKey: string;
  modelName: string;
  defaultModel: boolean;
  enabled: boolean;
}

export interface ProviderFormValidation {
  isValid: boolean;
  errors: Partial<Record<keyof ProviderFormState, string>>;
}

function findPreset(
  presetId: ProviderPresetId,
  presets: readonly ProviderPreset[]
): ProviderPreset {
  const preset = presets.find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw new Error(`Unknown provider preset: ${presetId}`);
  }
  return preset;
}

function getDefaultModelName(preset: ProviderPreset): string {
  if (preset.defaultModelPolicy !== "first-enabled") {
    return "";
  }

  return preset.models.find((model) => model.id)?.id ?? "";
}

export function createProviderFormState(
  presetId: ProviderPresetId = "deepseek",
  presets = getProviderPresets()
): ProviderFormState {
  const preset = findPreset(presetId, presets);

  return {
    presetId: preset.id,
    displayName: preset.displayName,
    kind: preset.kind,
    baseUrl: preset.baseUrl ?? "",
    apiKey: "",
    modelName: getDefaultModelName(preset),
    defaultModel: true,
    enabled: true
  };
}

export function selectProviderPreset(
  state: ProviderFormState,
  presetId: ProviderPresetId,
  presets = getProviderPresets()
): ProviderFormState {
  return {
    ...createProviderFormState(presetId, presets),
    providerId: state.providerId,
    defaultModel: state.defaultModel,
    enabled: state.enabled
  };
}

export function validateProviderForm(state: ProviderFormState): ProviderFormValidation {
  const errors: ProviderFormValidation["errors"] = {};

  if (!state.displayName.trim()) {
    errors.displayName = "请输入配置名称";
  }

  if (!state.baseUrl.trim()) {
    errors.baseUrl = "请输入 Base URL";
  }

  if (!state.apiKey.trim()) {
    errors.apiKey = "请输入 API key";
  }

  if (!state.modelName.trim()) {
    errors.modelName = "请输入模型名";
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors
  };
}

export function buildSaveProviderDto(state: ProviderFormState): SaveProviderDto {
  return {
    providerId: state.providerId,
    presetId: state.presetId,
    displayName: state.displayName.trim(),
    kind: state.kind,
    baseUrl: state.baseUrl.trim(),
    apiKey: state.apiKey.trim() || undefined,
    modelName: state.modelName.trim(),
    defaultModel: state.defaultModel,
    enabled: state.enabled
  };
}

export function clearProviderSecretAfterSave(state: ProviderFormState): ProviderFormState {
  return {
    ...state,
    apiKey: ""
  };
}

export function getExtractionModelsFromProviders(
  providers: readonly ProviderViewDto[]
): ExtractionModel[] {
  return providers.flatMap((provider) => {
    if (!provider.enabled) {
      return [];
    }

    return provider.models
      .filter((model) => model.enabled)
      .map((model) => ({
        id: `${provider.id}:${model.id}`,
        providerConfigId: provider.id,
        modelId: model.id,
        displayName: `${provider.displayName} / ${model.displayName}`
      }));
  });
}

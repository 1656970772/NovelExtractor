import { getProviderPresets } from "@novel-extractor/config";
import type { ProviderPreset } from "@novel-extractor/config";
import type {
  FetchedProviderModelDto,
  ProviderModelDto,
  ProviderViewDto,
  SaveProviderDto
} from "../../../shared/ipcTypes";
import type { ExtractionModel } from "../extraction/extractionViewModel";

export type ProviderPresetId = SaveProviderDto["presetId"];
export type ProviderSaveState = "idle" | "saving" | "error";
export type ProviderResourceState = "ready" | "loading" | "error";
export type ProviderModelFetchState = "idle" | "loading" | "error";

export interface ProviderFormState {
  providerId?: string;
  presetId: ProviderPresetId;
  displayName: string;
  kind: SaveProviderDto["kind"];
  baseUrl: string;
  apiKey: string;
  models: ProviderModelDto[];
  modelName: string;
  modelFetchState: ProviderModelFetchState;
  modelFetchError?: string;
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

function createPresetModelDtos(preset: ProviderPreset): ProviderModelDto[] {
  const defaultModelName = getDefaultModelName(preset);

  return preset.models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    enabled: true,
    isDefault: model.id === defaultModelName
  }));
}

function resolveModelName(models: readonly ProviderModelDto[], modelName: string): string {
  const trimmedModelName = modelName.trim();
  if (models.some((model) => model.id === trimmedModelName)) {
    return trimmedModelName;
  }

  return models[0]?.id ?? trimmedModelName;
}

export function syncDefaultModelFlags(
  models: readonly ProviderModelDto[],
  modelName: string
): ProviderModelDto[] {
  const defaultModelName = resolveModelName(models, modelName);

  return models.map((model) => ({
    ...model,
    isDefault: model.id === defaultModelName
  }));
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
    models: createPresetModelDtos(preset),
    modelName: getDefaultModelName(preset),
    modelFetchState: "idle",
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
  const modelName =
    state.models.length > 0
      ? resolveModelName(state.models, state.modelName)
      : state.modelName.trim();
  const models =
    state.models.length > 0
      ? syncDefaultModelFlags(state.models, modelName)
      : modelName
        ? [
            {
              id: modelName,
              displayName: modelName,
              enabled: true,
              isDefault: true
            }
          ]
        : [];

  return {
    providerId: state.providerId,
    presetId: state.presetId,
    displayName: state.displayName.trim(),
    kind: state.kind,
    baseUrl: state.baseUrl.trim(),
    apiKey: state.apiKey.trim() || undefined,
    modelName,
    defaultModel: state.defaultModel,
    enabled: state.enabled,
    models
  };
}

export function mergeFetchedModelsIntoForm(
  state: ProviderFormState,
  fetchedModels: readonly FetchedProviderModelDto[]
): ProviderFormState {
  const existingModelsById = new Map(state.models.map((model) => [model.id, model]));
  const nextModels = [...state.models];

  for (const fetchedModel of fetchedModels) {
    const id = fetchedModel.id.trim();
    if (!id || existingModelsById.has(id)) {
      continue;
    }

    const model: ProviderModelDto = {
      id,
      displayName: id,
      enabled: true,
      isDefault: false
    };
    existingModelsById.set(id, model);
    nextModels.push(model);
  }

  const modelName = resolveModelName(nextModels, state.modelName);

  return {
    ...state,
    models: syncDefaultModelFlags(nextModels, modelName),
    modelName,
    modelFetchState: "idle",
    modelFetchError: undefined
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

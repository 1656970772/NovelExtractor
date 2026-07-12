import { getProviderPresets } from "@novel-extractor/config";
import type { ProviderPreset } from "@novel-extractor/config";
import type {
  FetchedProviderModelDto,
  ProviderModelDto,
  ProviderViewDto,
  SaveProviderDto
} from "../../../shared/ipcTypes";

export type ProviderPresetId = SaveProviderDto["presetId"];
export type ProviderSaveState = "idle" | "saving" | "error";
export type ProviderResourceState = "ready" | "loading" | "error";
export type ProviderModelFetchState = "idle" | "loading" | "error";
export const AUTO_PROVIDER_OPTION_ID = "__auto__";

export type ExtractionModelSelectionMode = "explicit" | "auto";

export interface ExtractionProviderModelOption {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export type ExtractionProviderOption =
  | {
      id: typeof AUTO_PROVIDER_OPTION_ID;
      kind: "auto";
      displayName: string;
      models: [];
    }
  | {
      id: string;
      kind: "provider";
      displayName: string;
      providerConfigId: string;
      defaultModelId: string;
      models: ExtractionProviderModelOption[];
    };

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

function getPreferredModelName(models: readonly ProviderModelDto[]): string {
  return (
    models.find((model) => model.isDefault)?.id ??
    models.find((model) => model.enabled)?.id ??
    models[0]?.id ??
    ""
  );
}

function normalizeProviderModels(
  models: readonly ProviderModelDto[],
  modelName: string
): { models: ProviderModelDto[]; modelName: string } {
  const normalizedModels: ProviderModelDto[] = [];
  const seenModelIds = new Set<string>();

  for (const model of models) {
    const id = model.id.trim();
    if (!id || seenModelIds.has(id)) {
      continue;
    }

    seenModelIds.add(id);
    normalizedModels.push({
      id,
      displayName: model.displayName.trim() || id,
      enabled: model.enabled,
      isDefault: model.isDefault
    });
  }

  if (normalizedModels.length === 0) {
    const fallbackModelName = modelName.trim();
    return {
      modelName: fallbackModelName,
      models: fallbackModelName
        ? [
            {
              id: fallbackModelName,
              displayName: fallbackModelName,
              enabled: true,
              isDefault: true
            }
          ]
        : []
    };
  }

  const requestedModelName = modelName.trim();
  const defaultModel =
    normalizedModels.find((model) => model.id === requestedModelName) ??
    normalizedModels.find((model) => model.enabled && model.isDefault) ??
    normalizedModels.find((model) => model.enabled) ??
    normalizedModels[0];
  const defaultModelName = defaultModel?.id ?? "";

  return {
    modelName: defaultModelName,
    models: normalizedModels.map((model) => ({
      ...model,
      enabled: model.id === defaultModelName ? true : model.enabled,
      isDefault: model.id === defaultModelName
    }))
  };
}

export function syncDefaultModelFlags(
  models: readonly ProviderModelDto[],
  modelName: string
): ProviderModelDto[] {
  const defaultModelName = resolveModelName(models, modelName);

  return models.map((model) => ({
    ...model,
    enabled: model.id === defaultModelName ? true : model.enabled,
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
  _state: ProviderFormState,
  presetId: ProviderPresetId,
  presets = getProviderPresets()
): ProviderFormState {
  return createProviderFormState(presetId, presets);
}

export function createProviderFormStateFromSavedProvider(
  provider: ProviderViewDto
): ProviderFormState {
  const normalizedModels = normalizeProviderModels(
    provider.models,
    getPreferredModelName(provider.models)
  );

  return {
    providerId: provider.id,
    presetId: provider.presetId,
    displayName: provider.displayName,
    kind: provider.kind,
    baseUrl: provider.baseUrl ?? "",
    apiKey: "",
    models: normalizedModels.models,
    modelName: normalizedModels.modelName,
    modelFetchState: "idle",
    defaultModel: true,
    enabled: provider.enabled
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

  if (!state.providerId && !state.apiKey.trim()) {
    errors.apiKey = "请输入 API key";
  }

  if (!state.modelName.trim() && !state.models.some((model) => model.id.trim())) {
    errors.modelName = "请输入模型名";
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors
  };
}

export function buildSaveProviderDto(state: ProviderFormState): SaveProviderDto {
  const { modelName, models } = normalizeProviderModels(state.models, state.modelName);

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

function getEnabledProviderModels(
  provider: ProviderViewDto
): ExtractionProviderModelOption[] {
  return provider.models
    .filter((model) => model.enabled)
    .map((model) => ({
      id: model.id,
      displayName: model.displayName,
      isDefault: model.isDefault
    }));
}

function getDefaultExtractionModelId(
  models: readonly ExtractionProviderModelOption[]
): string {
  return models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? "";
}

export function getExtractionProviderOptionsFromProviders(
  providers: readonly ProviderViewDto[]
): ExtractionProviderOption[] {
  const providerOptions = providers.flatMap((provider): ExtractionProviderOption[] => {
    if (!provider.enabled || !provider.hasApiKey) {
      return [];
    }

    const models = getEnabledProviderModels(provider);
    if (models.length === 0) {
      return [];
    }

    return [
      {
        id: provider.id,
        kind: "provider",
        displayName: provider.displayName,
        providerConfigId: provider.id,
        defaultModelId: getDefaultExtractionModelId(models),
        models
      }
    ];
  });

  return providerOptions.length > 0
    ? [
        {
          id: AUTO_PROVIDER_OPTION_ID,
          kind: "auto",
          displayName: "自动",
          models: []
        },
        ...providerOptions
      ]
    : [];
}

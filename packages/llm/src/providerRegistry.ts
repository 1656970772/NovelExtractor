import type {
  ProviderApiFormat,
  ProviderPreset,
  ProviderReasoningCapability
} from "@novel-extractor/config";
import type { ApiKeyRef, ProviderConfig } from "@novel-extractor/domain";

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface LlmModelDefinition {
  id: string;
  displayName: string;
  enabled: boolean;
  isDefault: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  contextWindow?: number;
  supportsParallelToolCalls?: boolean;
  inputModalities?: Array<"text" | "image">;
  baseInstructions?: string;
  usageMapping: "openai-compatible";
}

export interface OpenAiCompatibleProviderDefinition {
  id: string;
  presetId?: string;
  displayName: string;
  kind: "openai-compatible";
  baseUrl: string;
  authScheme: "bearer";
  apiFormat: ProviderApiFormat;
  reasoning?: ProviderReasoningCapability;
  apiKeyRef?: ApiKeyRef;
  allowsUserModels: boolean;
  models: LlmModelDefinition[];
}

export interface ProviderRegistryOptions {
  presets: ProviderPreset[];
  providerConfigs?: ProviderConfig[];
}

export interface ResolvedModelRef {
  provider: OpenAiCompatibleProviderDefinition;
  modelId: string;
}

export interface ProviderRegistry {
  getProviderDefinition(providerId: string): OpenAiCompatibleProviderDefinition;
  listProviderDefinitions(): OpenAiCompatibleProviderDefinition[];
  resolveModelRef(modelRef: string): ResolvedModelRef;
}

function createPresetModelDefinition(
  preset: ProviderPreset,
  modelIndex: number
): LlmModelDefinition {
  const model = preset.models[modelIndex];
  if (!model) {
    throw new Error(`Provider preset ${preset.id} model index ${modelIndex} is not configured`);
  }

  return {
    id: model.id,
    displayName: model.displayName,
    enabled: true,
    isDefault: preset.defaultModelPolicy === "first-enabled" && modelIndex === 0,
    supportsTools: model.supportsTools,
    supportsReasoning: model.supportsReasoning,
    contextWindow: model.contextWindow,
    supportsParallelToolCalls: model.supportsParallelToolCalls,
    inputModalities: model.inputModalities ? [...model.inputModalities] : undefined,
    baseInstructions: model.baseInstructions,
    usageMapping: model.usageMapping
  };
}

export function createPresetProviderDefinition(
  preset: ProviderPreset
): OpenAiCompatibleProviderDefinition {
  if (preset.kind !== "openai-compatible") {
    throw new Error(`Provider preset ${preset.id} uses unsupported kind ${preset.kind}`);
  }

  if (!preset.baseUrl) {
    throw new Error(`Provider preset ${preset.id} requires a baseUrl`);
  }

  return {
    id: preset.id,
    presetId: preset.id,
    displayName: preset.displayName,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    authScheme: preset.authScheme,
    apiFormat: preset.apiFormat,
    reasoning: preset.reasoning ? { ...preset.reasoning } : undefined,
    allowsUserModels: preset.allowsUserModels,
    models: preset.models.map((_model, index) => createPresetModelDefinition(preset, index))
  };
}

function findPreset(presetsById: Map<string, ProviderPreset>, presetId: string): ProviderPreset {
  const preset = presetsById.get(presetId);

  if (!preset) {
    throw new Error(`Provider preset ${presetId} is not configured`);
  }

  return preset;
}

function createConfiguredModelDefinition(
  preset: ProviderPreset,
  modelConfig: ProviderConfig["models"][number]
): LlmModelDefinition {
  const presetModel = preset.models.find((model) => model.id === modelConfig.id);

  return {
    id: modelConfig.id,
    displayName: modelConfig.displayName,
    enabled: modelConfig.enabled,
    isDefault: modelConfig.isDefault,
    supportsTools: presetModel?.supportsTools ?? false,
    supportsReasoning: presetModel?.supportsReasoning ?? false,
    contextWindow: presetModel?.contextWindow,
    supportsParallelToolCalls: presetModel?.supportsParallelToolCalls,
    inputModalities: presetModel?.inputModalities ? [...presetModel.inputModalities] : undefined,
    baseInstructions: presetModel?.baseInstructions,
    usageMapping: presetModel?.usageMapping ?? "openai-compatible"
  };
}

function createConfiguredProviderDefinition(
  providerConfig: ProviderConfig,
  presetsById: Map<string, ProviderPreset>
): OpenAiCompatibleProviderDefinition {
  const preset = findPreset(presetsById, providerConfig.presetId);
  const baseUrl = providerConfig.baseUrl ?? preset.baseUrl;

  if (!baseUrl) {
    throw new Error(`Provider ${providerConfig.id} requires a baseUrl`);
  }

  return {
    id: providerConfig.id,
    presetId: providerConfig.presetId,
    displayName: providerConfig.displayName,
    kind: providerConfig.kind,
    baseUrl,
    authScheme: preset.authScheme,
    apiFormat: preset.apiFormat,
    reasoning: preset.reasoning ? { ...preset.reasoning } : undefined,
    apiKeyRef: providerConfig.apiKeyRef,
    allowsUserModels: preset.allowsUserModels,
    models: providerConfig.models
      .filter((model) => model.enabled)
      .map((model) => createConfiguredModelDefinition(preset, model))
  };
}

export function parseModelRef(modelRef: string): ModelRef {
  const separatorIndex = modelRef.indexOf("/");
  const providerId = modelRef.slice(0, separatorIndex).trim();
  const modelId = modelRef.slice(separatorIndex + 1).trim();

  if (separatorIndex <= 0 || !providerId || !modelId) {
    throw new Error(`Model reference must use provider/model format: ${modelRef}`);
  }

  return { providerId, modelId };
}

export function createProviderRegistry(options: ProviderRegistryOptions): ProviderRegistry {
  const presetsById = new Map(options.presets.map((preset) => [preset.id, preset]));
  const providersById = new Map<string, OpenAiCompatibleProviderDefinition>();

  for (const preset of options.presets) {
    if (preset.baseUrl) {
      providersById.set(preset.id, createPresetProviderDefinition(preset));
    }
  }

  for (const providerConfig of options.providerConfigs ?? []) {
    if (providerConfig.enabled) {
      providersById.set(providerConfig.id, createConfiguredProviderDefinition(providerConfig, presetsById));
    }
  }

  function getProviderDefinition(providerId: string): OpenAiCompatibleProviderDefinition {
    const provider = providersById.get(providerId);

    if (!provider) {
      throw new Error(`Provider ${providerId} is not configured`);
    }

    return provider;
  }

  return {
    getProviderDefinition,
    listProviderDefinitions: () => Array.from(providersById.values()),
    resolveModelRef: (modelRef: string) => {
      const parsed = parseModelRef(modelRef);
      const provider = getProviderDefinition(parsed.providerId);
      const hasConfiguredModel = provider.models.some((model) => model.enabled && model.id === parsed.modelId);

      if (!hasConfiguredModel && !provider.allowsUserModels) {
        throw new Error(
          `Model ${parsed.modelId} is not configured for provider ${parsed.providerId}`
        );
      }

      return { provider, modelId: parsed.modelId };
    }
  };
}

import type { ProviderViewDto } from "../shared/ipcTypes";

export interface ModelFallbackCandidate {
  providerConfigId: string;
  providerDisplayName: string;
  modelId: string;
  modelDisplayName: string;
}

export interface ModelFallbackPlan {
  current(): ModelFallbackCandidate | undefined;
  advance(): ModelFallbackCandidate | undefined;
}

type FallbackProvider = Pick<
  ProviderViewDto,
  "id" | "displayName" | "enabled" | "hasApiKey" | "models"
>;

function selectModel(provider: FallbackProvider): ProviderViewDto["models"][number] | undefined {
  const enabledModels = provider.models.filter((model) => model.enabled);

  return enabledModels.find((model) => model.isDefault) ?? enabledModels[0];
}

function toCandidate(provider: FallbackProvider): ModelFallbackCandidate | undefined {
  if (!provider.enabled || !provider.hasApiKey) {
    return undefined;
  }

  const model = selectModel(provider);
  if (!model) {
    return undefined;
  }

  return {
    providerConfigId: provider.id,
    providerDisplayName: provider.displayName,
    modelId: model.id,
    modelDisplayName: model.displayName
  };
}

export function createModelFallbackPlan(
  providers: readonly FallbackProvider[],
  initialProviderConfigId: string
): ModelFallbackPlan {
  const candidates = providers.flatMap((provider) => {
    const candidate = toCandidate(provider);
    return candidate ? [candidate] : [];
  });
  let index = Math.max(
    0,
    candidates.findIndex((candidate) => candidate.providerConfigId === initialProviderConfigId)
  );

  return {
    current: () => candidates[index],
    advance: () => {
      if (candidates.length === 0) {
        return undefined;
      }

      index = (index + 1) % candidates.length;
      return candidates[index];
    }
  };
}

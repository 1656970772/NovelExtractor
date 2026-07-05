import { randomUUID } from "node:crypto";
import { getProviderPresets } from "@novel-extractor/config";
import type { ProviderConfig } from "@novel-extractor/domain";
import type { DesktopIpcHandlers } from "./ipc";
import type { ProviderViewDto, SaveProviderDto } from "../shared/ipcTypes";
import { fetchModelsFromProvider, type FetchModelsFromProviderInput } from "./modelFetchService";
import {
  createMemoryCredentialStore,
  createProviderView,
  type MemoryCredentialStore
} from "./credentials";
import { createMemoryProviderStore, type MainProviderStore } from "./providerStore";

type ProviderHandlers = Pick<
  DesktopIpcHandlers,
  "providers:save" | "providers:list" | "providers:fetchModels"
>;

export interface ProviderIpcHandlersOptions {
  credentialStore?: MemoryCredentialStore;
  modelFetch?: Pick<FetchModelsFromProviderInput, "fetch">;
  providerStore?: MainProviderStore;
  providerIdFactory?: () => string;
}

function createDefaultProviderIdFactory(): () => string {
  let nextId = 1;
  return () => `provider-${nextId++}`;
}

function createUniqueProviderId(
  providers: readonly ProviderConfig[],
  providerIdFactory: () => string
): string {
  const existingProviderIds = new Set(providers.map((provider) => provider.id));

  for (let attempt = 0; attempt <= existingProviderIds.size; attempt += 1) {
    const providerId = providerIdFactory();
    if (!existingProviderIds.has(providerId)) {
      return providerId;
    }
  }

  let fallbackProviderId = "";
  do {
    fallbackProviderId = `provider-${randomUUID()}`;
  } while (existingProviderIds.has(fallbackProviderId));

  return fallbackProviderId;
}

function findModelDisplayName(input: SaveProviderDto): string {
  const preset = getProviderPresets().find((candidate) => candidate.id === input.presetId);
  const presetModel = preset?.models.find((model) => model.id === input.modelName);
  return presetModel?.displayName ?? input.modelName;
}

function createModelConfigs(input: SaveProviderDto): ProviderConfig["models"] {
  const defaultModelId = input.modelName.trim();
  const submittedModelIds = new Set<string>();
  const submittedModels =
    input.models?.flatMap((model) => {
      const id = model.id.trim();
      if (!id || submittedModelIds.has(id)) {
        return [];
      }
      submittedModelIds.add(id);
      const displayName = model.displayName.trim() || id;
      return [
        {
          id,
          displayName,
          enabled: model.enabled,
          isDefault: id === defaultModelId
        }
      ];
    }) ?? [];

  if (submittedModels.length) {
    return submittedModels;
  }

  const preset = getProviderPresets().find((candidate) => candidate.id === input.presetId);
  if (preset && !preset.allowsUserModels && preset.models.length > 0) {
    return preset.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      enabled: input.enabled,
      isDefault: model.id === defaultModelId
    }));
  }

  return [
    {
      id: defaultModelId,
      displayName: findModelDisplayName({ ...input, modelName: defaultModelId }),
      enabled: input.enabled,
      isDefault: input.defaultModel
    }
  ];
}

function toProviderView(provider: ProviderConfig): ProviderViewDto {
  return createProviderView({
    id: provider.id,
    presetId: provider.presetId,
    displayName: provider.displayName,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    models: provider.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      enabled: model.enabled,
      isDefault: model.isDefault
    })),
    apiKeyRef: provider.apiKeyRef,
    enabled: provider.enabled
  });
}

export function createProviderIpcHandlers(
  options: ProviderIpcHandlersOptions = {}
): ProviderHandlers {
  const credentialStore = options.credentialStore ?? createMemoryCredentialStore();
  const providerStore = options.providerStore ?? createMemoryProviderStore();
  const providerIdFactory = options.providerIdFactory ?? createDefaultProviderIdFactory();

  function findExistingProvider(
    providers: ProviderConfig[],
    input: SaveProviderDto
  ): ProviderConfig | undefined {
    if (input.providerId) {
      const providerById = providers.find((provider) => provider.id === input.providerId);
      if (providerById?.presetId === input.presetId) {
        return providerById;
      }
    }

    return providers.find((provider) => provider.presetId === input.presetId);
  }

  return {
    "providers:save": async (input) => {
      const providers = await providerStore.listProviderConfigs();
      const existingProvider = findExistingProvider(providers, input);
      const hasConflictingProviderId = input.providerId
        ? providers.some(
            (provider) => provider.id === input.providerId && provider.presetId !== input.presetId
          )
        : false;
      const providerConfigId =
        existingProvider?.id ??
        (hasConflictingProviderId ? undefined : input.providerId) ??
        createUniqueProviderId(providers, providerIdFactory);
      const trimmedApiKey = input.apiKey?.trim();
      const apiKeyRef = trimmedApiKey
        ? credentialStore.saveApiKey({ providerConfigId, apiKey: trimmedApiKey })
        : existingProvider?.apiKeyRef;

      await providerStore.saveProviderConfig({
        id: providerConfigId,
        presetId: input.presetId,
        displayName: input.displayName,
        kind: input.kind,
        baseUrl: input.baseUrl,
        models: createModelConfigs(input),
        enabled: input.enabled,
        apiKeyRef
      });
    },
    "providers:fetchModels": async (input) => {
      const trimmedApiKey = input.apiKey?.trim();
      let apiKey = trimmedApiKey;
      if (!apiKey && input.providerId) {
        const existingProvider = (await providerStore.listProviderConfigs()).find(
          (provider) => provider.id === input.providerId
        );
        apiKey = existingProvider?.apiKeyRef
          ? credentialStore.readApiKey(existingProvider.apiKeyRef)
          : undefined;
      }
      if (!apiKey) {
        throw new Error("API Key is required to fetch models");
      }

      return fetchModelsFromProvider({
        baseUrl: input.baseUrl,
        apiKey,
        modelsUrl: input.modelsUrl,
        isFullUrl: input.isFullUrl,
        userAgent: input.userAgent,
        fetch: options.modelFetch?.fetch
      });
    },
    "providers:list": async () =>
      (await providerStore.listProviderConfigs()).map((provider) => toProviderView(provider))
  };
}

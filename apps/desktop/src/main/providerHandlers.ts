import { getProviderPresets } from "@novel-extractor/config";
import type { ProviderConfig } from "@novel-extractor/domain";
import type { DesktopIpcHandlers } from "./ipc";
import type { ProviderViewDto, SaveProviderDto } from "../shared/ipcTypes";
import {
  createMemoryCredentialStore,
  createProviderView,
  type MemoryCredentialStore
} from "./credentials";
import { createMemoryProviderStore, type MainProviderStore } from "./providerStore";

type ProviderHandlers = Pick<DesktopIpcHandlers, "providers:save" | "providers:list">;

export interface ProviderIpcHandlersOptions {
  credentialStore?: MemoryCredentialStore;
  providerStore?: MainProviderStore;
  providerIdFactory?: () => string;
}

function createDefaultProviderIdFactory(): () => string {
  let nextId = 1;
  return () => `provider-${nextId++}`;
}

function findModelDisplayName(input: SaveProviderDto): string {
  const preset = getProviderPresets().find((candidate) => candidate.id === input.presetId);
  const presetModel = preset?.models.find((model) => model.id === input.modelName);
  return presetModel?.displayName ?? input.modelName;
}

function createModelConfig(input: SaveProviderDto): ProviderConfig["models"][number] {
  return {
    id: input.modelName,
    displayName: findModelDisplayName(input),
    enabled: input.enabled,
    isDefault: input.defaultModel
  };
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
      return providers.find((provider) => provider.id === input.providerId);
    }

    return providers.find((provider) => provider.presetId === input.presetId);
  }

  return {
    "providers:save": async (input) => {
      const existingProvider = findExistingProvider(await providerStore.listProviderConfigs(), input);
      const providerConfigId = existingProvider?.id ?? input.providerId ?? providerIdFactory();
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
        models: [createModelConfig(input)],
        enabled: input.enabled,
        apiKeyRef
      });
    },
    "providers:list": async () =>
      (await providerStore.listProviderConfigs()).map((provider) => toProviderView(provider))
  };
}

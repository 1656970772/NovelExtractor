import fs from "node:fs/promises";
import path from "node:path";
import type { ProviderConfig } from "@novel-extractor/domain";

export interface MainProviderStore {
  listProviderConfigs(): Promise<ProviderConfig[]>;
  saveProviderConfig(config: ProviderConfig): Promise<ProviderConfig>;
}

export interface FileProviderStoreOptions {
  filePath: string;
}

interface ProviderStoreState {
  providers: ProviderConfig[];
}

function cloneProviderConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    apiKeyRef: config.apiKeyRef ? { ...config.apiKeyRef } : undefined,
    models: config.models.map((model) => ({ ...model }))
  };
}

export function createMemoryProviderStore(): MainProviderStore {
  const providersById = new Map<string, ProviderConfig>();

  return {
    async listProviderConfigs() {
      return [...providersById.values()].map(cloneProviderConfig);
    },
    async saveProviderConfig(config) {
      const nextConfig = cloneProviderConfig(config);
      providersById.set(nextConfig.id, nextConfig);
      return cloneProviderConfig(nextConfig);
    }
  };
}

function createEmptyState(): ProviderStoreState {
  return { providers: [] };
}

function normalizeProviderState(value: unknown): ProviderStoreState {
  if (!value || typeof value !== "object") {
    return createEmptyState();
  }

  const providers = Array.isArray((value as ProviderStoreState).providers)
    ? (value as ProviderStoreState).providers
    : [];

  return {
    providers: providers.filter(
      (provider): provider is ProviderConfig =>
        Boolean(provider) &&
        typeof provider.id === "string" &&
        typeof provider.presetId === "string" &&
        typeof provider.displayName === "string" &&
        typeof provider.kind === "string" &&
        Array.isArray(provider.models) &&
        typeof provider.enabled === "boolean"
    )
  };
}

export function createFileProviderStore(options: FileProviderStoreOptions): MainProviderStore {
  let statePromise: Promise<ProviderStoreState> | null = null;

  async function loadState(): Promise<ProviderStoreState> {
    if (statePromise) {
      return statePromise;
    }

    statePromise = (async () => {
      try {
        const raw = await fs.readFile(options.filePath, "utf8");
        return normalizeProviderState(JSON.parse(raw));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        return createEmptyState();
      }
    })();

    return statePromise;
  }

  async function saveState(state: ProviderStoreState): Promise<void> {
    await fs.mkdir(path.dirname(options.filePath), { recursive: true });
    await fs.writeFile(options.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  return {
    async listProviderConfigs() {
      const state = await loadState();
      return state.providers.map(cloneProviderConfig);
    },
    async saveProviderConfig(config) {
      const state = await loadState();
      const nextConfig = cloneProviderConfig(config);
      state.providers = [
        ...state.providers.filter((provider) => provider.id !== nextConfig.id),
        nextConfig
      ];
      await saveState(state);
      return cloneProviderConfig(nextConfig);
    }
  };
}

import { describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "@novel-extractor/domain";
import { createMemoryCredentialStore } from "./credentials";
import { createIpcContract, createNotImplementedIpcHandlers } from "./ipc";
import { createProviderIpcHandlers } from "./providerHandlers";

describe("provider IPC handlers", () => {
  it("saves API keys as opaque references and never exposes raw keys from list", async () => {
    const rawApiKey = "sk-provider-handler-secret";
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers()
    };

    await contract.invoke(handlers, "providers:save", {
      presetId: "deepseek",
      displayName: "DeepSeek",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      apiKey: rawApiKey,
      modelName: "deepseek-v4-flash",
      defaultModel: true,
      enabled: true
    });

    const providers = await contract.invoke(handlers, "providers:list");

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      presetId: "deepseek",
      displayName: "DeepSeek",
      hasApiKey: true,
      models: [
        {
          id: "deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          enabled: true,
          isDefault: true
        },
        {
          id: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro",
          enabled: true,
          isDefault: false
        }
      ]
    });
    expect(providers[0]).not.toHaveProperty("apiKey");
    expect(JSON.stringify(providers)).not.toContain(rawApiKey);
  });

  it("persists provider configs into an injected shared store", async () => {
    let savedConfigs: ProviderConfig[] = [];
    const providerStore = {
      async listProviderConfigs() {
        return savedConfigs;
      },
      async saveProviderConfig(config: ProviderConfig) {
        savedConfigs = [config];
        return config;
      }
    };
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers({
        credentialStore: createMemoryCredentialStore({ idFactory: () => "api-key-1" }),
        providerIdFactory: () => "provider-shared",
        providerStore
      } as Parameters<typeof createProviderIpcHandlers>[0])
    };

    await contract.invoke(handlers, "providers:save", {
      presetId: "custom-openai-compatible",
      displayName: "Mock Provider",
      kind: "openai-compatible",
      baseUrl: "http://mock-provider.test/v1",
      apiKey: "sk-shared-store",
      modelName: "mock-model",
      defaultModel: true,
      enabled: true
    });

    expect(await providerStore.listProviderConfigs()).toMatchObject([
      {
        id: "provider-shared",
        presetId: "custom-openai-compatible",
        displayName: "Mock Provider",
        baseUrl: "http://mock-provider.test/v1",
        models: [{ id: "mock-model", enabled: true, isDefault: true }],
        enabled: true
      }
    ]);
    expect(JSON.stringify(await providerStore.listProviderConfigs())).not.toContain("sk-shared-store");
  });

  it("saves every official preset model and marks the selected model as default", async () => {
    let savedConfigs: ProviderConfig[] = [];
    const providerStore = {
      async listProviderConfigs() {
        return savedConfigs;
      },
      async saveProviderConfig(config: ProviderConfig) {
        savedConfigs = [config];
        return config;
      }
    };
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers({
        providerIdFactory: () => "provider-xiaomi",
        providerStore
      } as Parameters<typeof createProviderIpcHandlers>[0])
    };

    await contract.invoke(handlers, "providers:save", {
      presetId: "xiaomi-mimo",
      displayName: "小米 MiMo",
      kind: "openai-compatible",
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKey: "sk-xiaomi",
      modelName: "mimo-v2.5",
      defaultModel: true,
      enabled: true
    });

    expect(savedConfigs[0]?.models).toEqual([
      {
        id: "mimo-v2.5-pro",
        displayName: "MiMo V2.5 Pro",
        enabled: true,
        isDefault: false
      },
      {
        id: "mimo-v2.5",
        displayName: "MiMo V2.5",
        enabled: true,
        isDefault: true
      }
    ]);
  });

  it("saves submitted form models and marks modelName as the default", async () => {
    let savedConfigs: ProviderConfig[] = [];
    const providerStore = {
      async listProviderConfigs() {
        return savedConfigs;
      },
      async saveProviderConfig(config: ProviderConfig) {
        savedConfigs = [config];
        return config;
      }
    };
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers({
        providerIdFactory: () => "provider-form-models",
        providerStore
      } as Parameters<typeof createProviderIpcHandlers>[0])
    };

    await contract.invoke(handlers, "providers:save", {
      presetId: "custom-openai-compatible",
      displayName: "Mock Provider",
      kind: "openai-compatible",
      baseUrl: "http://mock-provider.test/v1",
      apiKey: "sk-form-models",
      modelName: "model-b",
      defaultModel: true,
      enabled: true,
      models: [
        { id: "model-a", displayName: "Model A", enabled: true, isDefault: true },
        { id: "model-b", displayName: "Model B", enabled: true, isDefault: false }
      ]
    });

    expect(savedConfigs[0]?.models).toEqual([
      { id: "model-a", displayName: "Model A", enabled: true, isDefault: false },
      { id: "model-b", displayName: "Model B", enabled: true, isDefault: true }
    ]);
  });

  it("trims submitted form models, drops blank IDs, and marks the trimmed modelName as default", async () => {
    let savedConfigs: ProviderConfig[] = [];
    const providerStore = {
      async listProviderConfigs() {
        return savedConfigs;
      },
      async saveProviderConfig(config: ProviderConfig) {
        savedConfigs = [config];
        return config;
      }
    };
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers({
        providerIdFactory: () => "provider-trimmed-form-models",
        providerStore
      } as Parameters<typeof createProviderIpcHandlers>[0])
    };

    await contract.invoke(handlers, "providers:save", {
      presetId: "custom-openai-compatible",
      displayName: "Mock Provider",
      kind: "openai-compatible",
      baseUrl: "http://mock-provider.test/v1",
      apiKey: "sk-form-models",
      modelName: "model-b",
      defaultModel: true,
      enabled: true,
      models: [
        { id: "   ", displayName: "Blank", enabled: true, isDefault: true },
        { id: " model-b ", displayName: "   ", enabled: true, isDefault: false }
      ]
    });

    expect(savedConfigs[0]?.models).toEqual([
      { id: "model-b", displayName: "model-b", enabled: true, isDefault: true }
    ]);
  });

  it("deduplicates submitted trimmed model IDs and keeps the first model as default", async () => {
    let savedConfigs: ProviderConfig[] = [];
    const providerStore = {
      async listProviderConfigs() {
        return savedConfigs;
      },
      async saveProviderConfig(config: ProviderConfig) {
        savedConfigs = [config];
        return config;
      }
    };
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers({
        providerIdFactory: () => "provider-deduplicated-form-models",
        providerStore
      } as Parameters<typeof createProviderIpcHandlers>[0])
    };

    await contract.invoke(handlers, "providers:save", {
      presetId: "custom-openai-compatible",
      displayName: "Mock Provider",
      kind: "openai-compatible",
      baseUrl: "http://mock-provider.test/v1",
      apiKey: "sk-form-models",
      modelName: " model-b ",
      defaultModel: true,
      enabled: true,
      models: [
        { id: " model-b ", displayName: "First", enabled: true, isDefault: false },
        { id: "model-b", displayName: "Second", enabled: true, isDefault: false },
        { id: "model-c", displayName: "Model C", enabled: true, isDefault: false }
      ]
    });

    expect(savedConfigs[0]?.models).toEqual([
      { id: "model-b", displayName: "First", enabled: true, isDefault: true },
      { id: "model-c", displayName: "Model C", enabled: true, isDefault: false }
    ]);
    expect(savedConfigs[0]?.models.filter((model) => model.isDefault)).toHaveLength(1);
  });

  it("marks the trimmed official preset modelName as default", async () => {
    let savedConfigs: ProviderConfig[] = [];
    const providerStore = {
      async listProviderConfigs() {
        return savedConfigs;
      },
      async saveProviderConfig(config: ProviderConfig) {
        savedConfigs = [config];
        return config;
      }
    };
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers({
        providerIdFactory: () => "provider-trimmed-xiaomi",
        providerStore
      } as Parameters<typeof createProviderIpcHandlers>[0])
    };

    await contract.invoke(handlers, "providers:save", {
      presetId: "xiaomi-mimo",
      displayName: "小米 MiMo",
      kind: "openai-compatible",
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKey: "sk-xiaomi",
      modelName: " mimo-v2.5 ",
      defaultModel: true,
      enabled: true
    });

    expect(savedConfigs[0]?.models).toEqual([
      {
        id: "mimo-v2.5-pro",
        displayName: "MiMo V2.5 Pro",
        enabled: true,
        isDefault: false
      },
      {
        id: "mimo-v2.5",
        displayName: "MiMo V2.5",
        enabled: true,
        isDefault: true
      }
    ]);
  });

  it("saves a trimmed fallback model when no submitted models are provided", async () => {
    let savedConfigs: ProviderConfig[] = [];
    const providerStore = {
      async listProviderConfigs() {
        return savedConfigs;
      },
      async saveProviderConfig(config: ProviderConfig) {
        savedConfigs = [config];
        return config;
      }
    };
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers({
        providerIdFactory: () => "provider-trimmed-fallback",
        providerStore
      } as Parameters<typeof createProviderIpcHandlers>[0])
    };

    await contract.invoke(handlers, "providers:save", {
      presetId: "custom-openai-compatible",
      displayName: "Mock Provider",
      kind: "openai-compatible",
      baseUrl: "http://mock-provider.test/v1",
      apiKey: "sk-form-models",
      modelName: " custom-live ",
      defaultModel: true,
      enabled: true
    });

    expect(savedConfigs[0]?.models).toEqual([
      { id: "custom-live", displayName: "custom-live", enabled: true, isDefault: true }
    ]);
  });

  it("falls back to official preset models when submitted form models have only blank IDs", async () => {
    let savedConfigs: ProviderConfig[] = [];
    const providerStore = {
      async listProviderConfigs() {
        return savedConfigs;
      },
      async saveProviderConfig(config: ProviderConfig) {
        savedConfigs = [config];
        return config;
      }
    };
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers({
        providerIdFactory: () => "provider-xiaomi-blank-form-models",
        providerStore
      } as Parameters<typeof createProviderIpcHandlers>[0])
    };

    await contract.invoke(handlers, "providers:save", {
      presetId: "xiaomi-mimo",
      displayName: "小米 MiMo",
      kind: "openai-compatible",
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKey: "sk-xiaomi",
      modelName: "mimo-v2.5",
      defaultModel: true,
      enabled: true,
      models: [{ id: "   ", displayName: "Blank", enabled: true, isDefault: true }]
    });

    expect(savedConfigs[0]?.models).toEqual([
      {
        id: "mimo-v2.5-pro",
        displayName: "MiMo V2.5 Pro",
        enabled: true,
        isDefault: false
      },
      {
        id: "mimo-v2.5",
        displayName: "MiMo V2.5",
        enabled: true,
        isDefault: true
      }
    ]);
  });

  it("fetches provider models with a saved API key when the request omits a new key", async () => {
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-fetch" });
    let savedConfigs: ProviderConfig[] = [];
    const providerStore = {
      async listProviderConfigs() {
        return savedConfigs;
      },
      async saveProviderConfig(config: ProviderConfig) {
        savedConfigs = [config];
        return config;
      }
    };
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        data: [{ id: "deepseek-v4-pro", owned_by: "deepseek" }]
      })
    );
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers({
        credentialStore,
        modelFetch: { fetch },
        providerIdFactory: () => "provider-fetch",
        providerStore
      } as Parameters<typeof createProviderIpcHandlers>[0])
    };

    await contract.invoke(handlers, "providers:save", {
      presetId: "deepseek",
      displayName: "DeepSeek",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-saved-fetch",
      modelName: "deepseek-v4-flash",
      defaultModel: true,
      enabled: true
    });

    await expect(
      contract.invoke(handlers, "providers:fetchModels", {
        providerId: "provider-fetch",
        presetId: "deepseek",
        baseUrl: "https://api.deepseek.com",
        modelsUrl: "https://api.deepseek.com/models"
      })
    ).resolves.toEqual([{ id: "deepseek-v4-pro", ownedBy: "deepseek" }]);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.deepseek.com/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-saved-fetch"
        })
      })
    );
  });
});

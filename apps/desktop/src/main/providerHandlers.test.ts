import { describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "@novel-extractor/domain";
import { createMemoryCredentialStore } from "./credentials";
import { createIpcContract, createNotImplementedIpcHandlers } from "./ipc";
import { createProviderIpcHandlers } from "./providerHandlers";
import { createMemoryProviderStore } from "./providerStore";

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

  it("creates independent configs when saving the same preset without a provider id", async () => {
    const providerStore = createMemoryProviderStore();
    const providerIds = ["provider-deepseek-one", "provider-deepseek-two"];
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers({
        providerIdFactory: () => providerIds.shift() ?? "provider-fallback",
        providerStore
      })
    };

    await contract.invoke(handlers, "providers:save", {
      presetId: "deepseek",
      displayName: "DeepSeek 主配置",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-deepseek-one",
      modelName: "deepseek-v4-flash",
      defaultModel: true,
      enabled: true
    });
    await contract.invoke(handlers, "providers:save", {
      presetId: "deepseek",
      displayName: "DeepSeek 备用配置",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-deepseek-two",
      modelName: "deepseek-v4-pro",
      defaultModel: true,
      enabled: true
    });

    expect(await providerStore.listProviderConfigs()).toMatchObject([
      {
        id: "provider-deepseek-one",
        presetId: "deepseek",
        displayName: "DeepSeek 主配置"
      },
      {
        id: "provider-deepseek-two",
        presetId: "deepseek",
        displayName: "DeepSeek 备用配置"
      }
    ]);
  });

  it("creates independent custom configs and only updates one by explicit provider id", async () => {
    const providerStore = createMemoryProviderStore();
    const providerIds = ["provider-custom-one", "provider-custom-two"];
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers({
        providerIdFactory: () => providerIds.shift() ?? "provider-fallback",
        providerStore
      })
    };

    for (const [displayName, baseUrl, apiKey, modelName] of [
      ["自定义一", "https://one.example.test/v1", "sk-custom-one", "model-one"],
      ["自定义二", "https://two.example.test/v1", "sk-custom-two", "model-two"]
    ] as const) {
      await contract.invoke(handlers, "providers:save", {
        presetId: "custom-openai-compatible",
        displayName,
        kind: "openai-compatible",
        baseUrl,
        apiKey,
        modelName,
        defaultModel: true,
        enabled: true
      });
    }

    await contract.invoke(handlers, "providers:save", {
      providerId: "provider-custom-one",
      presetId: "custom-openai-compatible",
      displayName: "自定义一（已编辑）",
      kind: "openai-compatible",
      baseUrl: "https://one-updated.example.test/v1",
      modelName: "model-one-updated",
      defaultModel: true,
      enabled: true
    });

    expect(await providerStore.listProviderConfigs()).toMatchObject([
      {
        id: "provider-custom-one",
        displayName: "自定义一（已编辑）",
        baseUrl: "https://one-updated.example.test/v1",
        apiKeyRef: expect.any(Object)
      },
      {
        id: "provider-custom-two",
        displayName: "自定义二",
        baseUrl: "https://two.example.test/v1",
        apiKeyRef: expect.any(Object)
      }
    ]);
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

  it("creates a new provider when a stale provider id is submitted for a different preset", async () => {
    const providerStore = createMemoryProviderStore();
    await providerStore.saveProviderConfig({
      id: "provider-deepseek",
      presetId: "deepseek",
      displayName: "DeepSeek",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      models: [
        {
          id: "deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          enabled: true,
          isDefault: true
        }
      ],
      enabled: true
    });
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers({
        providerIdFactory: () => "provider-minimax",
        providerStore
      } as Parameters<typeof createProviderIpcHandlers>[0])
    };

    await contract.invoke(handlers, "providers:save", {
      providerId: "provider-deepseek",
      presetId: "minimax",
      displayName: "MiniMax",
      kind: "openai-compatible",
      baseUrl: "https://api.minimaxi.com/v1",
      apiKey: "sk-minimax",
      modelName: "MiniMax-M3",
      defaultModel: true,
      enabled: true
    });

    expect(await providerStore.listProviderConfigs()).toMatchObject([
      {
        id: "provider-deepseek",
        presetId: "deepseek",
        displayName: "DeepSeek"
      },
      {
        id: "provider-minimax",
        presetId: "minimax",
        displayName: "MiniMax"
      }
    ]);
  });

  it("does not overwrite an existing provider after the default id factory restarts", async () => {
    const providerStore = createMemoryProviderStore();
    await providerStore.saveProviderConfig({
      id: "provider-1",
      presetId: "deepseek",
      displayName: "DeepSeek",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      models: [
        {
          id: "deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          enabled: true,
          isDefault: true
        }
      ],
      enabled: true
    });
    const contract = createIpcContract();
    const handlers = {
      ...createNotImplementedIpcHandlers(),
      ...createProviderIpcHandlers({ providerStore })
    };

    await contract.invoke(handlers, "providers:save", {
      presetId: "minimax",
      displayName: "MiniMax",
      kind: "openai-compatible",
      baseUrl: "https://api.minimaxi.com/v1",
      apiKey: "sk-minimax",
      modelName: "MiniMax-M3",
      defaultModel: true,
      enabled: true
    });

    const savedProviders = await providerStore.listProviderConfigs();
    expect(savedProviders).toHaveLength(2);
    expect(savedProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "provider-1",
          presetId: "deepseek",
          displayName: "DeepSeek"
        }),
        expect.objectContaining({
          presetId: "minimax",
          displayName: "MiniMax"
        })
      ])
    );
    expect(savedProviders.find((provider) => provider.presetId === "minimax")?.id).not.toBe(
      "provider-1"
    );
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

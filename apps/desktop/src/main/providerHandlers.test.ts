import { describe, expect, it } from "vitest";
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
});

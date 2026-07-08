import { describe, expect, it } from "vitest";
import { getProviderPresets } from "@novel-extractor/config";
import type { ProviderViewDto } from "../../../shared/ipcTypes";
import {
  AUTO_PROVIDER_OPTION_ID,
  buildSaveProviderDto,
  clearProviderSecretAfterSave,
  createProviderFormState,
  createProviderFormStateFromSavedProvider,
  getExtractionProviderOptionsFromProviders,
  mergeFetchedModelsIntoForm,
  selectProviderPreset,
  validateProviderForm
} from "./providerViewModel";

describe("providerViewModel", () => {
  it("does not export the legacy flat extraction model API", async () => {
    const providerViewModel = await import("./providerViewModel");
    const legacyApiName = ["get", "Extraction", "Models", "From", "Providers"].join("");

    expect(providerViewModel).not.toHaveProperty(legacyApiName);
  });

  it("builds a SaveProviderDto from the DeepSeek preset with config defaults", () => {
    const deepSeekPreset = getProviderPresets().find((preset) => preset.id === "deepseek");
    const state = createProviderFormState("deepseek");

    expect(deepSeekPreset).toBeDefined();
    expect(state.displayName).toBe(deepSeekPreset?.displayName);
    expect(state.baseUrl).toBe(deepSeekPreset?.baseUrl);
    expect(state.modelName).toBe(deepSeekPreset?.models[0]?.id);
    expect(state.models).toEqual(
      deepSeekPreset?.models.map((model, index) => ({
        id: model.id,
        displayName: model.displayName,
        enabled: true,
        isDefault: index === 0
      }))
    );

    const dto = buildSaveProviderDto({ ...state, apiKey: "sk-deepseek-test" });

    expect(dto).toEqual({
      presetId: "deepseek",
      displayName: "DeepSeek",
      kind: "openai-compatible",
      baseUrl: deepSeekPreset?.baseUrl,
      apiKey: "sk-deepseek-test",
      modelName: deepSeekPreset?.models[0]?.id,
      defaultModel: true,
      enabled: true,
      models: state.models
    });
  });

  it("keeps custom OpenAI-compatible base URL and model user-required", () => {
    const state = createProviderFormState("custom-openai-compatible");

    expect(state.displayName).toBe("自定义 OpenAI-compatible");
    expect(state.baseUrl).toBe("");
    expect(state.modelName).toBe("");
    expect(validateProviderForm(state).isValid).toBe(false);

    const dto = buildSaveProviderDto({
      ...state,
      baseUrl: "https://llm.example.test/v1",
      apiKey: "sk-custom-test",
      modelName: "novel-model"
    });

    expect(dto).toMatchObject({
      presetId: "custom-openai-compatible",
      displayName: "自定义 OpenAI-compatible",
      kind: "openai-compatible",
      baseUrl: "https://llm.example.test/v1",
      apiKey: "sk-custom-test",
      modelName: "novel-model",
      defaultModel: true,
      enabled: true,
      models: [
        {
          id: "novel-model",
          displayName: "novel-model",
          enabled: true,
          isDefault: true
        }
      ]
    });
  });

  it("clears raw apiKey from serialized form state after save", () => {
    const state = createProviderFormState("deepseek");
    const clearedState = clearProviderSecretAfterSave({
      ...state,
      apiKey: "sk-must-not-survive"
    });

    expect(clearedState.apiKey).toBe("");
    expect(JSON.stringify(clearedState)).not.toContain("sk-must-not-survive");
  });

  it("creates form state from saved provider without leaking api key and preserves a disabled saved default model", () => {
    const savedProvider: ProviderViewDto = {
      id: "provider-1",
      presetId: "deepseek",
      displayName: "DeepSeek 已保存",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      hasApiKey: true,
      enabled: true,
      models: [
        {
          id: "deepseek-disabled-default",
          displayName: "Disabled Default",
          enabled: false,
          isDefault: true
        },
        {
          id: "deepseek-enabled",
          displayName: "Enabled",
          enabled: true,
          isDefault: false
        }
      ]
    };

    const state = createProviderFormStateFromSavedProvider(savedProvider);

    expect(state).toMatchObject({
      providerId: "provider-1",
      presetId: "deepseek",
      displayName: "DeepSeek 已保存",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      apiKey: "",
      modelName: "deepseek-disabled-default",
      enabled: true
    });
    expect(state.models).toEqual([
      {
        id: "deepseek-disabled-default",
        displayName: "Disabled Default",
        enabled: true,
        isDefault: true
      },
      {
        id: "deepseek-enabled",
        displayName: "Enabled",
        enabled: true,
        isDefault: false
      }
    ]);
    expect(JSON.stringify(state)).not.toContain("sk-");
  });

  it("normalizes saved provider models when creating form state", () => {
    const savedProvider: ProviderViewDto = {
      id: "provider-1",
      presetId: "custom-openai-compatible",
      displayName: "Custom Saved",
      kind: "openai-compatible",
      baseUrl: "https://llm.example.test/v1",
      hasApiKey: true,
      enabled: true,
      models: [
        { id: "   ", displayName: "Empty", enabled: true, isDefault: false },
        { id: " beta ", displayName: " Beta ", enabled: false, isDefault: true },
        { id: "beta", displayName: "Beta Duplicate", enabled: true, isDefault: true },
        { id: " alpha ", displayName: " Alpha ", enabled: true, isDefault: true },
        { id: "gamma", displayName: "Gamma", enabled: true, isDefault: false }
      ]
    };

    const state = createProviderFormStateFromSavedProvider(savedProvider);

    expect(state.modelName).toBe("beta");
    expect(state.models).toEqual([
      { id: "beta", displayName: "Beta", enabled: true, isDefault: true },
      { id: "alpha", displayName: "Alpha", enabled: true, isDefault: false },
      { id: "gamma", displayName: "Gamma", enabled: true, isDefault: false }
    ]);
  });

  it("builds save dto with the default model enabled even when form state has it disabled", () => {
    const dto = buildSaveProviderDto({
      ...createProviderFormState("deepseek"),
      apiKey: "sk-deepseek-test",
      modelName: "deepseek-disabled-default",
      models: [
        {
          id: "deepseek-disabled-default",
          displayName: "Disabled Default",
          enabled: false,
          isDefault: true
        }
      ]
    });

    expect(dto).toMatchObject({
      modelName: "deepseek-disabled-default",
      models: [
        {
          id: "deepseek-disabled-default",
          displayName: "Disabled Default",
          enabled: true,
          isDefault: true
        }
      ]
    });
  });

  it("cleans empty and duplicate models while enabling the default model in save dto", () => {
    const dto = buildSaveProviderDto({
      ...createProviderFormState("custom-openai-compatible"),
      providerId: "provider-1",
      displayName: " Custom Provider ",
      baseUrl: " https://llm.example.test/v1 ",
      apiKey: "",
      modelName: " beta ",
      models: [
        { id: " alpha ", displayName: " Alpha ", enabled: true, isDefault: true },
        { id: "alpha", displayName: "Alpha Duplicate", enabled: true, isDefault: false },
        { id: "   ", displayName: "Empty", enabled: true, isDefault: false },
        { id: " beta ", displayName: " Beta ", enabled: false, isDefault: false }
      ]
    });

    expect(dto).toMatchObject({
      providerId: "provider-1",
      apiKey: undefined,
      modelName: "beta",
      models: [
        { id: "alpha", displayName: "Alpha", enabled: true, isDefault: false },
        { id: "beta", displayName: "Beta", enabled: true, isDefault: true }
      ]
    });
  });

  it("clears provider id when switching to a different preset", () => {
    const state = {
      ...createProviderFormState("deepseek"),
      providerId: "provider-deepseek"
    };

    const switchedState = selectProviderPreset(state, "minimax");

    expect(buildSaveProviderDto(switchedState)).toMatchObject({
      presetId: "minimax",
      providerId: undefined
    });
  });

  it("merges fetched models while enabling the current default model", () => {
    const state = {
      ...createProviderFormState("deepseek"),
      modelFetchState: "error" as const,
      modelFetchError: "旧错误",
      models: [
        {
          id: "deepseek-v4-flash",
          displayName: "Flash 自定义名",
          enabled: false,
          isDefault: true
        }
      ]
    };

    const merged = mergeFetchedModelsIntoForm(state, [
      { id: "deepseek-v4-flash", ownedBy: "deepseek" },
      { id: "deepseek-live", ownedBy: "deepseek" }
    ]);

    expect(merged.models).toEqual([
      {
        id: "deepseek-v4-flash",
        displayName: "Flash 自定义名",
        enabled: true,
        isDefault: true
      },
      {
        id: "deepseek-live",
        displayName: "deepseek-live",
        enabled: true,
        isDefault: false
      }
    ]);
    expect(merged.modelFetchState).toBe("idle");
    expect(merged.modelFetchError).toBeUndefined();
  });

  it("syncs default model flags when fetched models contain the current modelName", () => {
    const merged = mergeFetchedModelsIntoForm(
      {
        ...createProviderFormState("deepseek"),
        modelName: "deepseek-live",
        models: [
          {
            id: "deepseek-v4-flash",
            displayName: "Flash 自定义名",
            enabled: false,
            isDefault: true
          }
        ]
      },
      [
        { id: "deepseek-v4-flash", ownedBy: "deepseek" },
        { id: "deepseek-live", ownedBy: "deepseek" }
      ]
    );

    expect(merged.modelName).toBe("deepseek-live");
    expect(merged.models).toEqual([
      {
        id: "deepseek-v4-flash",
        displayName: "Flash 自定义名",
        enabled: false,
        isDefault: false
      },
      {
        id: "deepseek-live",
        displayName: "deepseek-live",
        enabled: true,
        isDefault: true
      }
    ]);
  });

  it("selects the first merged model when the form has no current modelName", () => {
    const merged = mergeFetchedModelsIntoForm(
      {
        ...createProviderFormState("custom-openai-compatible"),
        modelName: "",
        models: []
      },
      [{ id: "custom-live-model" }]
    );

    expect(merged.modelName).toBe("custom-live-model");
    expect(buildSaveProviderDto(merged)).toMatchObject({
      modelName: "custom-live-model",
      models: [
        {
          id: "custom-live-model",
          displayName: "custom-live-model",
          enabled: true,
          isDefault: true
        }
      ]
    });
  });

  it("selects the first merged model when the current modelName is not available", () => {
    const merged = mergeFetchedModelsIntoForm(
      {
        ...createProviderFormState("custom-openai-compatible"),
        modelName: "missing-model",
        models: []
      },
      [{ id: "custom-live-model" }, { id: "custom-second-model" }]
    );

    expect(merged.modelName).toBe("custom-live-model");
    expect(merged.models).toEqual([
      {
        id: "custom-live-model",
        displayName: "custom-live-model",
        enabled: true,
        isDefault: true
      },
      {
        id: "custom-second-model",
        displayName: "custom-second-model",
        enabled: true,
        isDefault: false
      }
    ]);
  });

  it("builds save dto with the first model when the current modelName is not available", () => {
    const dto = buildSaveProviderDto({
      ...createProviderFormState("deepseek"),
      apiKey: "sk-deepseek-test",
      modelName: "missing-model"
    });

    expect(dto.modelName).toBe("deepseek-v4-flash");
    expect(dto.models).toEqual([
      expect.objectContaining({
        id: "deepseek-v4-flash",
        isDefault: true
      }),
      expect.objectContaining({
        id: "deepseek-v4-pro",
        isDefault: false
      })
    ]);
  });

  it("builds provider-first extraction options with auto first and only usable providers", () => {
    const options = getExtractionProviderOptionsFromProviders([
      {
        id: "provider-disabled",
        presetId: "deepseek",
        displayName: "Disabled",
        kind: "openai-compatible",
        baseUrl: "https://disabled.example.test",
        hasApiKey: true,
        enabled: false,
        models: [
          { id: "disabled-model", displayName: "Disabled Model", enabled: true, isDefault: true }
        ]
      },
      {
        id: "provider-main",
        presetId: "deepseek",
        displayName: "DeepSeek",
        kind: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        hasApiKey: true,
        enabled: true,
        models: [
          { id: "model-hidden", displayName: "Hidden", enabled: false, isDefault: true },
          { id: "model-default", displayName: "默认模型", enabled: true, isDefault: true },
          { id: "model-second", displayName: "备用模型", enabled: true, isDefault: false }
        ]
      },
      {
        id: "provider-no-key",
        presetId: "minimax",
        displayName: "No Key",
        kind: "openai-compatible",
        baseUrl: "https://no-key.example.test",
        hasApiKey: false,
        enabled: true,
        models: [
          { id: "no-key-model", displayName: "No Key Model", enabled: true, isDefault: true }
        ]
      },
      {
        id: "provider-fallback",
        presetId: "custom-openai-compatible",
        displayName: "Fallback",
        kind: "openai-compatible",
        baseUrl: "https://fallback.example.test",
        hasApiKey: true,
        enabled: true,
        models: [
          { id: "fallback-first", displayName: "Fallback First", enabled: true, isDefault: false },
          { id: "fallback-disabled-default", displayName: "Disabled Default", enabled: false, isDefault: true }
        ]
      },
      {
        id: "provider-no-enabled-model",
        presetId: "deepseek",
        displayName: "No Enabled Model",
        kind: "openai-compatible",
        baseUrl: "https://no-enabled.example.test",
        hasApiKey: true,
        enabled: true,
        models: [
          { id: "off", displayName: "Off", enabled: false, isDefault: true }
        ]
      }
    ]);

    expect(options).toEqual([
      {
        id: AUTO_PROVIDER_OPTION_ID,
        kind: "auto",
        displayName: "自动",
        models: []
      },
      {
        id: "provider-main",
        kind: "provider",
        displayName: "DeepSeek",
        providerConfigId: "provider-main",
        defaultModelId: "model-default",
        models: [
          { id: "model-default", displayName: "默认模型", isDefault: true },
          { id: "model-second", displayName: "备用模型", isDefault: false }
        ]
      },
      {
        id: "provider-fallback",
        kind: "provider",
        displayName: "Fallback",
        providerConfigId: "provider-fallback",
        defaultModelId: "fallback-first",
        models: [
          { id: "fallback-first", displayName: "Fallback First", isDefault: false }
        ]
      }
    ]);
  });
});

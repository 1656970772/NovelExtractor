import { describe, expect, it } from "vitest";
import { getProviderPresets } from "@novel-extractor/config";
import {
  buildSaveProviderDto,
  clearProviderSecretAfterSave,
  createProviderFormState,
  mergeFetchedModelsIntoForm,
  selectProviderPreset,
  validateProviderForm
} from "./providerViewModel";

describe("providerViewModel", () => {
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

  it("merges fetched models without losing existing form model metadata", () => {
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
        enabled: false,
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
});

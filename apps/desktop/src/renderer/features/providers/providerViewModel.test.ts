import { describe, expect, it } from "vitest";
import { getProviderPresets } from "@novel-extractor/config";
import {
  buildSaveProviderDto,
  clearProviderSecretAfterSave,
  createProviderFormState,
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

    const dto = buildSaveProviderDto({ ...state, apiKey: "sk-deepseek-test" });

    expect(dto).toEqual({
      presetId: "deepseek",
      displayName: "DeepSeek",
      kind: "openai-compatible",
      baseUrl: deepSeekPreset?.baseUrl,
      apiKey: "sk-deepseek-test",
      modelName: deepSeekPreset?.models[0]?.id,
      defaultModel: true,
      enabled: true
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
      enabled: true
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
});

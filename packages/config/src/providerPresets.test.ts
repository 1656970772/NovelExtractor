import { describe, expect, it } from "vitest";
import { getProviderPresets } from "./providerPresets";

describe("provider presets", () => {
  it("exposes only DeepSeek and custom OpenAI-compatible providers in P0", () => {
    const presets = getProviderPresets();

    expect(presets.map((preset) => preset.id)).toEqual(["deepseek", "custom-openai-compatible"]);
    expect(presets.every((preset) => preset.kind === "openai-compatible")).toBe(true);
  });

  it("keeps model values in provider schema and lets custom providers use user models", () => {
    const presets = getProviderPresets();
    const deepseek = presets.find((preset) => preset.id === "deepseek");
    const custom = presets.find((preset) => preset.id === "custom-openai-compatible");

    expect(deepseek).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      defaultModelPolicy: "first-enabled"
    });
    expect(deepseek?.models.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro"
    ]);
    expect(deepseek?.models.map((model) => model.id)).not.toContain(["deepseek", "chat"].join("-"));
    expect(custom).toMatchObject({
      allowsUserModels: true,
      defaultModelPolicy: "user-required",
      models: []
    });
  });
});

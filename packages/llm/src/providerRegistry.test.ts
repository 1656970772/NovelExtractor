import { getProviderPresets } from "@novel-extractor/config";
import type { ProviderConfig } from "@novel-extractor/domain";
import { describe, expect, it } from "vitest";
import { createDeepSeekProviderDefinition } from "./deepseekAdapter";
import { createProviderRegistry, parseModelRef } from "./providerRegistry";
import type {
  LlmProviderDefinition,
  OpenAiCompatibleProviderDefinition
} from "./providerRegistry";

type ProviderDefinitionCompatibilityCheck =
  LlmProviderDefinition extends OpenAiCompatibleProviderDefinition
    ? OpenAiCompatibleProviderDefinition extends LlmProviderDefinition
      ? true
      : false
    : false;

describe("LLM provider registry", () => {
  it("exposes the generic provider definition type as the OpenAI-compatible alias", () => {
    const compatibilityCheck: ProviderDefinitionCompatibilityCheck = true;

    expect(compatibilityCheck).toBe(true);
  });

  it("parses provider scoped model references", () => {
    expect(parseModelRef("deepseek/novel-analysis")).toEqual({
      providerId: "deepseek",
      modelId: "novel-analysis"
    });
  });

  it("rejects model references without a provider scope", () => {
    expect(() => parseModelRef("novel-analysis")).toThrow(/provider\/model/);
  });

  it("builds provider definitions from presets and provider configs", () => {
    const presets = getProviderPresets();
    const providerConfigs: ProviderConfig[] = [
      {
        id: "deepseek-user",
        presetId: "deepseek",
        displayName: "DeepSeek 用户配置",
        kind: "openai-compatible",
        apiKeyRef: { id: "key-1", providerConfigId: "deepseek-user" },
        models: [
          {
            id: "novel-analysis",
            displayName: "Novel Analysis",
            enabled: true,
            isDefault: true
          },
          {
            id: "disabled-model",
            displayName: "Disabled",
            enabled: false,
            isDefault: false
          }
        ],
        enabled: true
      }
    ];

    const registry = createProviderRegistry({ presets, providerConfigs });
    const resolved = registry.resolveModelRef("deepseek-user/novel-analysis");

    expect(resolved.provider.id).toBe("deepseek-user");
    expect(resolved.provider.baseUrl).toBe("https://api.deepseek.com");
    expect(resolved.provider.apiKeyRef).toEqual({ id: "key-1", providerConfigId: "deepseek-user" });
    expect(resolved.provider.models.map((model) => model.id)).toEqual(["novel-analysis"]);
  });

  it("allows user models only for providers whose preset permits them", () => {
    const presets = getProviderPresets();
    const customProvider: ProviderConfig = {
      id: "custom-provider",
      presetId: "custom-openai-compatible",
      displayName: "Custom Provider",
      kind: "openai-compatible",
      baseUrl: "https://llm.example.test/v1",
      apiKeyRef: { id: "key-custom", providerConfigId: "custom-provider" },
      models: [],
      enabled: true
    };

    const registry = createProviderRegistry({ presets, providerConfigs: [customProvider] });

    expect(registry.resolveModelRef("custom-provider/model-from-connection-test")).toMatchObject({
      modelId: "model-from-connection-test"
    });
    expect(() => registry.resolveModelRef("deepseek/unknown-model")).toThrow(/not configured/);
  });

  it("resolves P1 cc-switch providers with protocol and catalog metadata", () => {
    const registry = createProviderRegistry({ presets: getProviderPresets() });

    const mimo = registry.resolveModelRef("xiaomi-mimo/mimo-v2.5");

    expect(mimo.provider.apiFormat).toBe("openai_responses");
    expect(mimo.provider.models.map((model) => model.id)).toEqual(["mimo-v2.5-pro", "mimo-v2.5"]);
    expect(mimo.provider.models[1]).toMatchObject({
      contextWindow: 1048576,
      inputModalities: ["text", "image"]
    });

    const glm = registry.resolveModelRef("zhipu-glm/glm-5.2");
    expect(glm.provider.apiFormat).toBe("openai_chat");
    expect(glm.provider.reasoning).toMatchObject({
      supportsThinking: true,
      supportsEffort: false,
      effortParam: "none",
      outputFormat: "reasoning_content"
    });
    expect(glm.provider.models[0].supportsReasoning).toBe(true);
  });

  it("converts the DeepSeek preset without duplicating model facts", () => {
    const preset = getProviderPresets().find((candidate) => candidate.id === "deepseek");

    expect(preset).toBeDefined();
    const definition = createDeepSeekProviderDefinition(preset!);

    expect(definition.baseUrl).toBe(preset!.baseUrl);
    expect(definition.authScheme).toBe(preset!.authScheme);
    expect(definition.models.map((model) => model.id)).toEqual(
      preset!.models.map((model) => model.id)
    );
  });
});

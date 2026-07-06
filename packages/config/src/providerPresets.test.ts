import { describe, expect, it } from "vitest";
import { createCcSwitchProviderPresets } from "./ccSwitchProviderPresets";
import { getProviderPresets } from "./providerPresets";

const expectedPresetIds = [
  "deepseek",
  "zhipu-glm",
  "zhipu-glm-en",
  "qwen-bailian",
  "kimi",
  "kimi-for-coding",
  "minimax",
  "minimax-en",
  "xiaomi-mimo",
  "xiaomi-mimo-token-plan",
  "custom-openai-compatible"
] as const;

describe("provider presets", () => {
  it("exposes P1 providers copied from cc-switch Codex presets", () => {
    const presets = getProviderPresets();

    expect(presets.map((preset) => preset.id)).toEqual(expectedPresetIds);
    expect(presets.every((preset) => preset.kind === "openai-compatible")).toBe(true);
  });

  it("keeps cc-switch protocol and model catalog metadata in provider schema", () => {
    const presets = getProviderPresets();
    const byId = new Map(presets.map((preset) => [preset.id, preset]));

    expect(byId.get("zhipu-glm")).toMatchObject({
      displayName: "GLM（智谱）",
      websiteUrl: "https://open.bigmodel.cn",
      apiKeyUrl: "https://www.bigmodel.cn/claude-code?ic=RRVJPB5SII",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      apiFormat: "openai_chat",
      endpointCandidates: ["https://open.bigmodel.cn/api/coding/paas/v4"]
    });
    expect(byId.get("zhipu-glm")?.models).toEqual([
      expect.objectContaining({
        id: "glm-5.2",
        displayName: "GLM-5.2",
        contextWindow: 200000
      })
    ]);
    expect(byId.get("deepseek")).toMatchObject({
      websiteUrl: "https://platform.deepseek.com",
      apiKeyUrl: "https://platform.deepseek.com/api_keys",
      icon: "deepseek",
      iconColor: "#1E88E5"
    });
    expect(byId.get("deepseek")?.models.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro"
    ]);
    expect(byId.get("deepseek")?.modelsUrl).toBe("https://api.deepseek.com/models");
    expect(byId.get("deepseek")?.reasoning).toMatchObject({
      supportsThinking: true,
      supportsEffort: true,
      thinkingParam: "thinking",
      effortParam: "reasoning_effort",
      effortValueMode: "deepseek",
      outputFormat: "reasoning_content"
    });
    expect(byId.get("zhipu-glm")?.reasoning).toMatchObject({
      supportsThinking: true,
      supportsEffort: false,
      thinkingParam: "thinking",
      effortParam: "none",
      outputFormat: "reasoning_content"
    });
    expect(byId.get("kimi")?.reasoning).toMatchObject({
      supportsThinking: true,
      supportsEffort: false,
      effortParam: "none"
    });
    expect(byId.get("kimi-for-coding")?.reasoning).toMatchObject({
      supportsThinking: true,
      supportsEffort: false,
      effortParam: "none"
    });
    expect(byId.get("qwen-bailian")).toMatchObject({
      displayName: "Qwen（通义千问 / 阿里百炼）",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiFormat: "openai_responses"
    });
    expect(byId.get("minimax")?.models).toEqual([
      expect.objectContaining({
        id: "MiniMax-M3",
        displayName: "MiniMax-M3",
        contextWindow: 1000000,
        supportsParallelToolCalls: true,
        inputModalities: ["text", "image"],
        baseInstructions: expect.stringContaining("MiniMax-M3")
      })
    ]);
    expect(byId.get("minimax")?.reasoning).toBeUndefined();
    expect(byId.get("xiaomi-mimo")).toMatchObject({
      displayName: "Xiaomi MiMo"
    });
    expect(byId.get("xiaomi-mimo")?.models.map((model) => model.id)).toEqual([
      "mimo-v2.5-pro",
      "mimo-v2.5"
    ]);
    expect(byId.get("xiaomi-mimo")?.models).toEqual([
      expect.objectContaining({
        id: "mimo-v2.5-pro",
        inputModalities: ["text"],
        baseInstructions: expect.stringContaining("You are MiMo")
      }),
      expect.objectContaining({
        id: "mimo-v2.5",
        inputModalities: ["text", "image"],
        baseInstructions: expect.stringContaining("You are MiMo")
      })
    ]);
    expect(byId.get("xiaomi-mimo-token-plan")).toMatchObject({
      displayName: "Xiaomi MiMo Token Plan（中国）",
      websiteUrl: "https://platform.xiaomimimo.com/#/token-plan",
      apiKeyUrl: "https://platform.xiaomimimo.com/#/console/plan-manage"
    });
    expect(byId.get("custom-openai-compatible")).toMatchObject({
      allowsUserModels: true,
      defaultModelPolicy: "user-required",
      models: []
    });
  });

  it("creates independent mutable provider preset snapshots", () => {
    const first = createCcSwitchProviderPresets();
    const second = createCcSwitchProviderPresets();
    const firstDeepseek = first.find((preset) => preset.id === "deepseek")!;
    const secondDeepseek = second.find((preset) => preset.id === "deepseek")!;
    const firstXiaomi = first.find((preset) => preset.id === "xiaomi-mimo")!;
    const secondXiaomi = second.find((preset) => preset.id === "xiaomi-mimo")!;

    expect(firstDeepseek.endpointCandidates).not.toBe(secondDeepseek.endpointCandidates);
    expect(firstDeepseek.reasoning).not.toBe(secondDeepseek.reasoning);
    expect(firstXiaomi.models[0].inputModalities).not.toBe(secondXiaomi.models[0].inputModalities);

    firstDeepseek.endpointCandidates?.push("https://mirror.example.com/v1");
    firstXiaomi.models[0].inputModalities?.push("image");

    expect(secondDeepseek.endpointCandidates).toEqual(["https://api.deepseek.com"]);
    expect(secondXiaomi.models[0].inputModalities).toEqual(["text"]);
  });

  it("keeps provider auth schemes compatible with their api formats", () => {
    const expectedAuthByFormat = {
      openai_chat: "bearer",
      openai_responses: "bearer",
      anthropic_messages: "anthropic-api-key",
      gemini_generate_content: "google-api-key",
      bedrock_converse: "aws-sigv4"
    } as const;

    for (const preset of createCcSwitchProviderPresets()) {
      expect(preset.authScheme).toBe(expectedAuthByFormat[preset.apiFormat]);
    }
  });
});

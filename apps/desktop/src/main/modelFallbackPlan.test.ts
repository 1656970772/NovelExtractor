import { describe, expect, it } from "vitest";
import type { ProviderViewDto } from "../shared/ipcTypes";
import { createModelFallbackPlan } from "./modelFallbackPlan";

function provider(input: Partial<ProviderViewDto> & Pick<ProviderViewDto, "id" | "displayName">): ProviderViewDto {
  const { id, displayName, ...overrides } = input;

  return {
    id,
    presetId: "custom-openai-compatible",
    displayName,
    kind: "openai-compatible",
    baseUrl: "https://example.com",
    hasApiKey: true,
    enabled: true,
    models: [
      {
        id: `${input.id}-default`,
        displayName: `${input.displayName} 默认模型`,
        enabled: true,
        isDefault: true
      }
    ],
    ...overrides
  };
}

describe("createModelFallbackPlan", () => {
  it("cycles providers in saved order starting from the initial provider", () => {
    const plan = createModelFallbackPlan(
      [
        provider({ id: "minimax", displayName: "MiniMax" }),
        provider({ id: "deepseek", displayName: "DeepSeek" }),
        provider({ id: "claude", displayName: "Claude" })
      ],
      "minimax"
    );

    expect(plan.current()?.providerConfigId).toBe("minimax");
    expect(plan.advance()?.providerConfigId).toBe("deepseek");
    expect(plan.advance()?.providerConfigId).toBe("claude");
    expect(plan.advance()?.providerConfigId).toBe("minimax");
  });

  it("filters disabled providers, providers without API keys, and providers without enabled models", () => {
    const plan = createModelFallbackPlan(
      [
        provider({ id: "disabled", displayName: "Disabled", enabled: false }),
        provider({ id: "no-api-key", displayName: "No API Key", hasApiKey: false }),
        provider({
          id: "no-enabled-model",
          displayName: "No Enabled Model",
          models: [{ id: "off", displayName: "Off", enabled: false, isDefault: true }]
        }),
        provider({
          id: "valid",
          displayName: "Valid",
          models: [
            { id: "first", displayName: "First", enabled: true, isDefault: false },
            { id: "default", displayName: "Default", enabled: true, isDefault: true }
          ]
        })
      ],
      "disabled"
    );

    expect(plan.current()).toEqual({
      providerConfigId: "valid",
      providerDisplayName: "Valid",
      modelId: "default",
      modelDisplayName: "Default"
    });
    expect(plan.advance()).toEqual(plan.current());
  });

  it("falls back to the first enabled model when no enabled default exists", () => {
    const plan = createModelFallbackPlan(
      [
        provider({
          id: "legacy",
          displayName: "Legacy",
          models: [
            { id: "first-enabled", displayName: "First Enabled", enabled: true, isDefault: false },
            { id: "disabled-default", displayName: "Disabled Default", enabled: false, isDefault: true }
          ]
        })
      ],
      "legacy"
    );

    expect(plan.current()?.modelId).toBe("first-enabled");
  });

  it("returns undefined for current and advance when there are no candidates", () => {
    const plan = createModelFallbackPlan(
      [provider({ id: "disabled", displayName: "Disabled", enabled: false })],
      "disabled"
    );

    expect(plan.current()).toBeUndefined();
    expect(plan.advance()).toBeUndefined();
  });
});

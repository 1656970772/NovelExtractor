import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, getDefaultConfig } from "./defaults";

describe("default config", () => {
  it("does not let DEFAULT_CONFIG mutation leak into getDefaultConfig copies", () => {
    const originalAccent = getDefaultConfig().themeTokens.color.accent;
    const attemptedAccent = "#ff00ff";

    const mutationResult = Reflect.set(DEFAULT_CONFIG.themeTokens.color, "accent", attemptedAccent);
    const copiedAccentAfterMutation = getDefaultConfig().themeTokens.color.accent;
    Reflect.set(DEFAULT_CONFIG.themeTokens.color, "accent", originalAccent);

    expect(mutationResult).toBe(false);
    expect(copiedAccentAfterMutation).toBe(originalAccent);
  });

  it("returns caller-owned mutable copies", () => {
    const config = getDefaultConfig();

    config.themeTokens.color.accent = "#118877";

    expect(getDefaultConfig().themeTokens.color.accent).not.toBe("#118877");
  });
});

import { describe, expect, it } from "vitest";
import { getThemeTokens } from "./themeTokens";

describe("theme tokens", () => {
  it("loads visual tokens without relying on component constants", () => {
    const tokens = getThemeTokens();
    const hexColor = /^#[0-9a-fA-F]{6}$/u;
    const requiredColorTokens = [
      "selected",
      "progress",
      "success",
      "warning",
      "danger",
      "dangerSoft",
      "borderStrong",
      "surfaceRaised",
      "accentSoft",
      "inkSoft"
    ] as const;

    for (const color of Object.values(tokens.color)) {
      expect(color).toMatch(hexColor);
    }

    for (const tokenName of requiredColorTokens) {
      expect(tokens.color[tokenName]).toMatch(hexColor);
    }

    expect(tokens.shadow.panel).not.toHaveLength(0);
    expect(tokens.shadow.control).not.toHaveLength(0);
    expect(tokens.motion.intensity).toBe(3);
  });

  it("keeps the desktop shell palette out of the old warm paper range", () => {
    const { color } = getThemeTokens();
    const oldWarmPaperColors = new Set(["#f4f0e8", "#fffaf1", "#fbf4e6", "#f6f1e8"]);

    expect(oldWarmPaperColors).not.toContain(color.appBackground.toLowerCase());
    expect(oldWarmPaperColors).not.toContain(color.surface.toLowerCase());
    expect(oldWarmPaperColors).not.toContain(color.surfacePaper.toLowerCase());
  });
});

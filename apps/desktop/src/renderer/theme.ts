import { getThemeTokens, type ThemeTokens } from "@novel-extractor/config";

const COLOR_VARIABLES: Record<keyof ThemeTokens["color"], string> = {
  appBackground: "--app-color-background",
  surface: "--app-color-surface",
  surfacePaper: "--app-color-surface-paper",
  surfaceRaised: "--app-color-surface-raised",
  textPrimary: "--app-color-ink",
  textMuted: "--app-color-ink-muted",
  inkSoft: "--app-color-ink-soft",
  accent: "--app-color-accent",
  accentHover: "--app-color-accent-hover",
  accentSoft: "--app-color-accent-soft",
  onAccent: "--app-color-on-accent",
  selected: "--app-color-selected",
  progress: "--app-color-progress",
  success: "--app-color-success",
  warning: "--app-color-warning",
  danger: "--app-color-danger",
  dangerSoft: "--app-color-danger-soft",
  infoSoft: "--app-color-info-soft",
  graphLine: "--app-color-graph-line",
  border: "--app-color-border",
  borderStrong: "--app-color-border-strong"
};

const SHADOW_VARIABLES: Record<keyof ThemeTokens["shadow"], string> = {
  panel: "--app-shadow-panel",
  control: "--app-shadow-control"
};

export function applyThemeTokens(tokens = getThemeTokens()): void {
  const root = document.documentElement;

  for (const [tokenName, variableName] of Object.entries(COLOR_VARIABLES)) {
    root.style.setProperty(variableName, tokens.color[tokenName as keyof ThemeTokens["color"]]);
  }

  for (const [tokenName, variableName] of Object.entries(SHADOW_VARIABLES)) {
    root.style.setProperty(variableName, tokens.shadow[tokenName as keyof ThemeTokens["shadow"]]);
  }

  root.style.setProperty("--app-radius-card", `${tokens.radius.card}px`);
  root.style.setProperty("--app-radius-panel", `${tokens.radius.card}px`);
  root.style.setProperty("--app-radius-control", `${tokens.radius.control}px`);
  root.style.setProperty("--app-motion-duration", `${tokens.motion.durationMs}ms`);
}

import { getDefaultConfig } from "./defaults";
import type { ThemeTokens } from "./schema";

export function getThemeTokens(): ThemeTokens {
  return getDefaultConfig().themeTokens;
}

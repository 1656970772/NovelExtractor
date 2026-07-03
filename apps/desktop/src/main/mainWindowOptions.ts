import type { BrowserWindowConstructorOptions } from "electron";

export interface MainWindowThemeInput {
  appBackground: string;
}

const DEFAULT_WINDOW_WIDTH = 1440;
const DEFAULT_WINDOW_HEIGHT = 860;
const MIN_WINDOW_WIDTH = 1080;
const MIN_WINDOW_HEIGHT = 640;

function parseWindowDimension(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createMainBrowserWindowOptions(
  theme: MainWindowThemeInput,
  env: NodeJS.ProcessEnv = process.env,
  preloadPath = ""
): BrowserWindowConstructorOptions {
  return {
    width: parseWindowDimension(env.NOVEL_EXTRACTOR_WINDOW_WIDTH, DEFAULT_WINDOW_WIDTH),
    height: parseWindowDimension(env.NOVEL_EXTRACTOR_WINDOW_HEIGHT, DEFAULT_WINDOW_HEIGHT),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: "NovelExtractor",
    frame: false,
    backgroundColor: theme.appBackground,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
}

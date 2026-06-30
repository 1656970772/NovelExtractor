import fs from "node:fs/promises";
import path from "node:path";
import type { DesktopSettingsDto, SaveDesktopSettingsDto } from "../shared/ipcTypes";
import type { DesktopIpcHandlers } from "./ipc";

export interface DesktopSettingsStore {
  getSettings(): Promise<DesktopSettingsDto>;
  saveSettings(input: SaveDesktopSettingsDto): Promise<DesktopSettingsDto>;
}

export interface FileDesktopSettingsStoreOptions {
  filePath: string;
  defaultProjectStorageDirectory: string;
}

interface DesktopSettingsState {
  projectStorageDirectory?: string;
}

type DesktopSettingsHandlers = Pick<
  DesktopIpcHandlers,
  "settings:get" | "settings:save" | "settings:chooseProjectDirectory"
>;

function normalizeDirectory(value: string | undefined): string | undefined {
  const trimmedValue = value?.trim();
  return trimmedValue ? path.resolve(trimmedValue) : undefined;
}

function normalizeState(value: unknown): DesktopSettingsState {
  if (!value || typeof value !== "object") {
    return {};
  }

  const projectStorageDirectory = normalizeDirectory(
    (value as DesktopSettingsState).projectStorageDirectory
  );
  return projectStorageDirectory ? { projectStorageDirectory } : {};
}

export function createFileDesktopSettingsStore(
  options: FileDesktopSettingsStoreOptions
): DesktopSettingsStore {
  let statePromise: Promise<DesktopSettingsState> | null = null;
  const defaultProjectStorageDirectory = path.resolve(options.defaultProjectStorageDirectory);

  async function loadState(): Promise<DesktopSettingsState> {
    if (statePromise) {
      return statePromise;
    }

    statePromise = (async () => {
      try {
        const raw = await fs.readFile(options.filePath, "utf8");
        return normalizeState(JSON.parse(raw));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        return {};
      }
    })();

    return statePromise;
  }

  function toDto(state: DesktopSettingsState): DesktopSettingsDto {
    const projectStorageDirectory = normalizeDirectory(state.projectStorageDirectory);
    return {
      defaultProjectStorageDirectory,
      effectiveProjectStorageDirectory: projectStorageDirectory ?? defaultProjectStorageDirectory,
      projectStorageDirectory
    };
  }

  async function saveState(state: DesktopSettingsState): Promise<void> {
    await fs.mkdir(path.dirname(options.filePath), { recursive: true });
    await fs.writeFile(options.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    statePromise = Promise.resolve(state);
  }

  return {
    async getSettings() {
      return toDto(await loadState());
    },

    async saveSettings(input) {
      const projectStorageDirectory = normalizeDirectory(input.projectStorageDirectory);
      const nextState: DesktopSettingsState = projectStorageDirectory
        ? { projectStorageDirectory }
        : {};
      const nextSettings = toDto(nextState);
      await fs.mkdir(nextSettings.effectiveProjectStorageDirectory, { recursive: true });
      await saveState(nextState);
      return nextSettings;
    }
  };
}

export function createDesktopSettingsIpcHandlers(options: {
  settingsStore: DesktopSettingsStore;
  onSettingsSaved?: (settings: DesktopSettingsDto) => void;
  chooseProjectDirectory?: () => Promise<string | undefined>;
}): DesktopSettingsHandlers {
  return {
    "settings:get": async () => options.settingsStore.getSettings(),
    "settings:save": async (input) => {
      const settings = await options.settingsStore.saveSettings(input);
      options.onSettingsSaved?.(settings);
      return settings;
    },
    "settings:chooseProjectDirectory": async () => options.chooseProjectDirectory?.()
  };
}

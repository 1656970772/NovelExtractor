import { app, BrowserWindow, Menu, dialog, ipcMain, net, safeStorage, shell } from "electron";
import type { OpenDialogOptions } from "electron";
import { getThemeTokens } from "@novel-extractor/config";
import { join } from "node:path";
import type { JobDto } from "../shared/ipcTypes";
import { createAppPaths } from "./appPaths";
import { createFileCredentialStore } from "./credentials";
import {
  createDesktopSettingsIpcHandlers,
  createFileDesktopSettingsStore
} from "./desktopSettings";
import { createElectronFetch } from "./electronFetch";
import { createNotImplementedIpcHandlers, registerIpcHandlers } from "./ipc";
import { createMainBrowserWindowOptions } from "./mainWindowOptions";
import { createP0IpcHandlers } from "./p0Handlers";
import { createProviderIpcHandlers } from "./providerHandlers";
import { createFileProviderStore } from "./providerStore";
import { createWindowIpcHandlers } from "./windowHandlers";

function canOpenExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function createMainWindow(): void {
  const themeTokens = getThemeTokens();
  const mainWindow = new BrowserWindow(
    createMainBrowserWindowOptions(
      { appBackground: themeTokens.color.appBackground },
      process.env,
      join(__dirname, "../preload/index.cjs")
    )
  );

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (canOpenExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
    return;
  }

  void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

function notifyRendererJobUpdated(job: JobDto): void {
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (!browserWindow.isDestroyed()) {
      browserWindow.webContents.send("jobs:updated", job);
    }
  }
}

async function chooseProjectDirectory(): Promise<string | undefined> {
  const dialogOptions: OpenDialogOptions = {
    title: "选择项目目录",
    properties: ["openDirectory", "createDirectory"]
  };
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const result = focusedWindow
    ? await dialog.showOpenDialog(focusedWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled) {
    return undefined;
  }

  return result.filePaths[0];
}

const SAFE_STORAGE_PREFIX = "safe-storage-v1:";

function createSafeStorageCredentialCodec(): {
  decodeSecret?: (encodedSecret: string) => string;
  encodeSecret?: (secret: string) => string;
} {
  if (!safeStorage.isEncryptionAvailable()) {
    return {};
  }

  return {
    encodeSecret: (secret) =>
      `${SAFE_STORAGE_PREFIX}${safeStorage.encryptString(secret).toString("base64")}`,
    decodeSecret: (encodedSecret) => {
      if (!encodedSecret.startsWith(SAFE_STORAGE_PREFIX)) {
        return encodedSecret;
      }

      return safeStorage.decryptString(
        Buffer.from(encodedSecret.slice(SAFE_STORAGE_PREFIX.length), "base64")
      );
    }
  };
}

void app.whenReady().then(async () => {
  const appPaths = createAppPaths(process.env.NOVEL_EXTRACTOR_E2E_DATA_DIR);
  const settingsStore = createFileDesktopSettingsStore({
    filePath: join(appPaths.userDataDir, "settings.json"),
    defaultProjectStorageDirectory: appPaths.projectsRoot
  });
  let projectStorageDirectory = (await settingsStore.getSettings()).effectiveProjectStorageDirectory;
  const credentialStore = createFileCredentialStore({
    filePath: join(appPaths.credentialsRoot, "api-keys.json"),
    ...createSafeStorageCredentialCodec()
  });
  const providerStore = createFileProviderStore({
    filePath: join(appPaths.userDataDir, "providers.json")
  });
  const desktopFetch = createElectronFetch(net as { fetch: typeof fetch });
  registerIpcHandlers(ipcMain, {
    ...createNotImplementedIpcHandlers(),
    ...createP0IpcHandlers({
      credentialStore,
      fetch: desktopFetch,
      providerStore,
      workspaceRoot: appPaths.userDataDir,
      projectsRoot: () => projectStorageDirectory,
      getAppVersion: () => app.getVersion(),
      shell,
      onJobUpdated: notifyRendererJobUpdated
    }),
    ...createProviderIpcHandlers({
      credentialStore,
      modelFetch: { fetch: desktopFetch },
      providerStore
    }),
    ...createWindowIpcHandlers(BrowserWindow),
    ...createDesktopSettingsIpcHandlers({
      settingsStore,
      chooseProjectDirectory,
      onSettingsSaved: (settings) => {
        projectStorageDirectory = settings.effectiveProjectStorageDirectory;
      }
    })
  });
  Menu.setApplicationMenu(null);
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

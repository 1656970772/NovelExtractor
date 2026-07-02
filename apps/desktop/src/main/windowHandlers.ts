import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import type { DesktopIpcHandlers } from "./ipc";

export type WindowControlTarget = Pick<
  ElectronBrowserWindow,
  "close" | "isMaximized" | "maximize" | "minimize" | "unmaximize"
>;

export interface WindowControlProvider {
  getAllWindows(): WindowControlTarget[];
  getFocusedWindow(): WindowControlTarget | null;
}

type WindowHandlers = Pick<
  DesktopIpcHandlers,
  "window:minimize" | "window:toggleMaximize" | "window:close"
>;

export function createWindowIpcHandlers(windowProvider: WindowControlProvider): WindowHandlers {
  const getTargetWindow = () =>
    windowProvider.getFocusedWindow() ?? windowProvider.getAllWindows()[0];

  return {
    "window:minimize": async () => {
      getTargetWindow()?.minimize();
    },
    "window:toggleMaximize": async () => {
      const window = getTargetWindow();
      if (!window) {
        return;
      }

      if (window.isMaximized()) {
        window.unmaximize();
        return;
      }

      window.maximize();
    },
    "window:close": async () => {
      getTargetWindow()?.close();
    }
  };
}

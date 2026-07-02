import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import {
  createNovelExtractorDesktopApi,
  type NovelExtractorDesktopApi
} from "./api";

const desktopApi = createNovelExtractorDesktopApi(
  (channel, input) => ipcRenderer.invoke(channel, input),
  (channel, handler) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => {
      handler(payload as Parameters<typeof handler>[0]);
    };
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
);

contextBridge.exposeInMainWorld("novelExtractor", desktopApi);

export type DesktopApi = NovelExtractorDesktopApi;

declare global {
  interface Window {
    novelExtractor: DesktopApi;
  }
}

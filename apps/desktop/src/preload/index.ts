import { contextBridge, ipcRenderer } from "electron";
import {
  createNovelExtractorDesktopApi,
  type NovelExtractorDesktopApi
} from "./api";

const desktopApi = createNovelExtractorDesktopApi((channel, input) =>
  ipcRenderer.invoke(channel, input)
);

contextBridge.exposeInMainWorld("novelExtractor", desktopApi);

export type DesktopApi = NovelExtractorDesktopApi;

declare global {
  interface Window {
    novelExtractor: DesktopApi;
  }
}

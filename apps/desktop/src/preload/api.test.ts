import { describe, expect, it, vi } from "vitest";
import type { DesktopIpcChannel, JobDto } from "../shared/ipcTypes";
import { createNovelExtractorDesktopApi } from "./api";

describe("preload desktop API", () => {
  it("maps every API method to exactly one allowed IPC channel", async () => {
    const calls: Array<{ channel: DesktopIpcChannel; input: unknown }> = [];
    const invoke = vi.fn(async (channel: DesktopIpcChannel, input?: unknown) => {
      calls.push({ channel, input });
      if (channel === "project:create") {
        return {
          id: "project-1",
          displayName: "仙途资料",
          slug: "xian-tu",
          createdAt: "2026-06-27T00:00:00.000Z"
        };
      }
      if (channel === "jobs:create") {
        return {
          id: "job-1",
          bookId: "book-1",
          status: "created",
          progressText: "0/1",
          allowedActions: ["start", "delete"],
          createdAt: "2026-06-27T00:00:00.000Z",
          updatedAt: "2026-06-27T00:00:00.000Z"
        };
      }
      return undefined;
    });
    const api = createNovelExtractorDesktopApi(invoke);

    await api.createProject({ displayName: "仙途资料" });
    await api.listProjects();
    await api.getSettings();
    await api.saveSettings({ projectStorageDirectory: "D:\\NovelExtractorProjects" });
    await api.chooseProjectDirectory();
    await api.saveProvider({
      presetId: "deepseek",
      displayName: "DeepSeek",
      kind: "openai-compatible",
      apiKey: "sk-secret",
      modelName: "model-1",
      defaultModel: true,
      enabled: true
    });
    await api.listProviders();
    await api.uploadTxt({ projectId: "project-1", filePath: "E:\\books\\novel.txt" });
    await api.listReports({ bookId: "book-1" });
    await api.previewReport({ reportId: "report-1" });
    await api.getProjectRuntime({ projectId: "project-1" });
    await api.listTemplates({ projectId: "project-1" });
    await api.saveTemplate({
      projectId: "project-1",
      scope: "project",
      name: "伏笔模板",
      fileName: "foreshadow.md",
      body: "记录伏笔。"
    });
    await api.deleteTemplate({ templateId: "template-1" });
    await api.getTemplateSelection({ projectId: "project-1" });
    await api.saveTemplateSelection({ projectId: "project-1", templateIds: ["template-1"] });
    await api.createJob({
      bookId: "book-1",
      templateIds: ["pill-analysis"],
      providerConfigId: "provider-1",
      modelId: "model-1",
      singleRunChapterCount: 1,
      extractionChapterCount: 2,
      overlapChapterCount: 0,
      skipAlreadyExtracted: true
    });
    await api.startJob({ jobId: "job-1" });
    await api.pauseJob({ jobId: "job-1" });
    await api.resumeJob({ jobId: "job-1" });
    await api.restartJob({ jobId: "job-1" });
    await api.deleteJob({ jobId: "job-1", confirm: true });
    await api.readJobLog({ jobId: "job-1" });
    await api.openJobLog({ jobId: "job-1" });
    await api.openJobOutputDirectory({ jobId: "job-1" });
    await api.minimizeWindow();
    await api.toggleMaximizeWindow();
    await api.closeWindow();

    expect(calls.map((call) => call.channel)).toEqual([
      "project:create",
      "project:list",
      "settings:get",
      "settings:save",
      "settings:chooseProjectDirectory",
      "providers:save",
      "providers:list",
      "books:uploadTxt",
      "books:listReports",
      "reports:preview",
      "projectRuntime:get",
      "templates:list",
      "templates:save",
      "templates:delete",
      "templateSelection:get",
      "templateSelection:save",
      "jobs:create",
      "jobs:start",
      "jobs:pause",
      "jobs:resume",
      "jobs:restart",
      "jobs:delete",
      "jobs:readLog",
      "jobs:openLog",
      "jobs:openOutputDirectory",
      "window:minimize",
      "window:toggleMaximize",
      "window:close"
    ]);
    expect(invoke).toHaveBeenCalledTimes(28);
  });

  it("opens the full job log through typed IPC", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const api = createNovelExtractorDesktopApi(invoke);

    await api.openJobLog({ jobId: "job-1" });

    expect(invoke).toHaveBeenCalledWith("jobs:openLog", { jobId: "job-1" });
  });

  it("opens a job output directory through typed IPC", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const api = createNovelExtractorDesktopApi(invoke);

    await api.openJobOutputDirectory({ jobId: "job-1" });

    expect(invoke).toHaveBeenCalledWith("jobs:openOutputDirectory", { jobId: "job-1" });
  });

  it("forwards window controls without payloads", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const api = createNovelExtractorDesktopApi(invoke);

    await api.minimizeWindow();
    await api.toggleMaximizeWindow();
    await api.closeWindow();

    expect(invoke).toHaveBeenNthCalledWith(1, "window:minimize", undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, "window:toggleMaximize", undefined);
    expect(invoke).toHaveBeenNthCalledWith(3, "window:close", undefined);
  });

  it("does not expose raw invoke or the raw Electron renderer bridge", () => {
    const api = createNovelExtractorDesktopApi(vi.fn());
    const rawIpcRendererName = "ipc" + "Renderer";

    expect(Object.keys(api)).toEqual([
      "createProject",
      "listProjects",
      "getSettings",
      "saveSettings",
      "chooseProjectDirectory",
      "saveProvider",
      "listProviders",
      "uploadTxt",
      "listReports",
      "previewReport",
      "getProjectRuntime",
      "listTemplates",
      "saveTemplate",
      "deleteTemplate",
      "getTemplateSelection",
      "saveTemplateSelection",
      "createJob",
      "startJob",
      "pauseJob",
      "resumeJob",
      "restartJob",
      "deleteJob",
      "readJobLog",
      "openJobLog",
      "openJobOutputDirectory",
      "minimizeWindow",
      "toggleMaximizeWindow",
      "closeWindow",
      "onJobUpdated"
    ]);
    expect(api).not.toHaveProperty("invoke");
    expect(api).not.toHaveProperty(rawIpcRendererName);
  });

  it("preload index exposes novelExtractor through contextBridge without exposing raw Electron IPC", async () => {
    vi.resetModules();
    const exposeInMainWorld = vi.fn();
    const invoke = vi.fn(async () => []);
    const on = vi.fn();
    const removeListener = vi.fn();
    const rawIpcRendererName = "ipc" + "Renderer";

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      [rawIpcRendererName]: { invoke, on, removeListener }
    }));

    await import("./index");

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(exposeInMainWorld).toHaveBeenCalledWith("novelExtractor", expect.any(Object));

    const api = exposeInMainWorld.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(api).not.toHaveProperty(rawIpcRendererName);
    expect(api).not.toHaveProperty("invoke");

    const listProjects = api.listProjects as () => Promise<unknown>;
    await listProjects();
    expect(invoke).toHaveBeenCalledWith("project:list", undefined);

    const pushedJob: JobDto = {
      id: "job-1",
      bookId: "book-1",
      status: "running",
      progressText: "进度：1/3",
      allowedActions: ["pause"],
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:01:00.000Z"
    };
    const onJobUpdated = api.onJobUpdated as (handler: (job: JobDto) => void) => () => void;
    const handler = vi.fn();
    const unsubscribe = onJobUpdated(handler);
    const listener = on.mock.calls[0]?.[1] as (event: unknown, payload: JobDto) => void;

    expect(on).toHaveBeenCalledWith("jobs:updated", expect.any(Function));
    listener({}, pushedJob);
    expect(handler).toHaveBeenCalledWith(pushedJob);

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith("jobs:updated", listener);
  });
});

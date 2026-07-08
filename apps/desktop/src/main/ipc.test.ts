import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BookUploadResultDto,
  CreateJobDto,
  DeleteJobDto,
  DesktopIpcRequestMap,
  DesktopIpcResponseMap,
  InputSummaryDto,
  JobDto,
  JobLogDto,
  JobModelSelectionMode,
  JobStatus,
  FetchProviderModelsDto,
  FetchedProviderModelDto,
  ProviderModelDto,
  ProjectDto,
  ProjectRuntimeDto,
  ProviderKind,
  ProviderPresetId,
  ProviderViewDto,
  ReportDto,
  SafeMarkdownPreviewDto,
  SaveDesktopSettingsDto,
  SaveProviderDto,
  SaveTemplateDto,
  TemplateDto,
  TemplateSelectionDto,
  UpdateJobRetryPolicyDto,
  UploadTxtDto
} from "../shared/ipcTypes";
import {
  createIpcContract,
  registerIpcHandlers,
  type DesktopIpcHandlers,
  type IpcMainLike
} from "./ipc";
import { createProviderView, createMemoryCredentialStore, redactSecrets } from "./credentials";

function createHandlers(): DesktopIpcHandlers {
  const job: JobDto = {
    id: "job-1",
    bookId: "book-1",
    status: "created",
    progressText: "0/1",
    allowedActions: ["start", "delete"],
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z"
  };
  const template: TemplateDto = {
    id: "pill-analysis",
    scope: "global",
    name: "丹药分析模板",
    fileName: "丹药分析.md",
    body: "提取丹药信息。",
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z"
  };

  return {
    "project:create": async (input) => ({
      id: "project-1",
      displayName: input.displayName,
      slug: "project-1",
      createdAt: "2026-06-27T00:00:00.000Z"
    }),
    "project:list": async () => [],
    "settings:get": async () => ({
      defaultProjectStorageDirectory: "C:\\NovelExtractor\\projects",
      effectiveProjectStorageDirectory: "C:\\NovelExtractor\\projects",
      projectStorageDirectory: undefined
    }),
    "settings:save": async (input) => ({
      defaultProjectStorageDirectory: "C:\\NovelExtractor\\projects",
      effectiveProjectStorageDirectory: input.projectStorageDirectory ?? "C:\\NovelExtractor\\projects",
      projectStorageDirectory: input.projectStorageDirectory
    }),
    "settings:chooseProjectDirectory": async () => "D:\\NovelExtractorProjects",
    "providers:save": async () => undefined,
    "providers:list": async () => [],
    "providers:fetchModels": async () => [],
    "books:uploadTxt": async (input) => ({
      bookId: "book-1",
      displayName: input.displayName ?? "book",
      sourceAssetId: "asset-1",
      sourceTextPath: "assets/books/book-1/source/original.txt",
      fileName: "book.txt",
      byteSize: 12,
      encoding: "utf-8",
      chapterCount: 1
    }),
    "books:listReports": async () => [],
    "projectRuntime:get": async () => ({ books: [], jobs: [] }),
    "templates:list": async () => ({ templates: [template] }),
    "templates:save": async (input) => ({
      ...template,
      id: input.templateId ?? "template-1",
      scope: input.scope,
      projectId: input.scope === "project" ? input.projectId : undefined,
      name: input.name,
      fileName: input.fileName,
      body: input.body
    }),
    "templates:delete": async () => undefined,
    "templateSelection:get": async (input) => ({
      projectId: input.projectId,
      templateIds: [template.id]
    }),
    "templateSelection:save": async (input) => input,
    "jobs:create": async () => job,
    "jobs:start": async () => undefined,
    "jobs:pause": async () => undefined,
    "jobs:resume": async () => undefined,
    "jobs:restart": async () => undefined,
    "jobs:updateRetryPolicy": async (input) => ({
      ...job,
      id: input.jobId,
      autoRetryOnFailure: input.autoRetryOnFailure
    }),
    "jobs:delete": async () => undefined,
    "jobs:readLog": async (input) => ({
      jobId: input.jobId,
      logFilePath: "runs/job-1/logs/20260630-153012.txt",
      content: "[2026-06-30 15:30:12][任务信息] 任务 job-1"
    }),
    "jobs:openLog": async () => undefined,
    "jobs:openOutputDirectory": async () => undefined,
    "window:minimize": async () => undefined,
    "window:toggleMaximize": async () => undefined,
    "window:close": async () => undefined,
    "reports:preview": async (input) => ({
      reportId: input.reportId,
      html: "<h1>preview</h1>",
      headings: [{ id: "preview", depth: 1, text: "preview" }],
      generatedAt: "2026-06-27T00:00:00.000Z"
    })
  };
}

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>();

  handle(channel: string, listener: (event: unknown, input?: unknown) => Promise<unknown>): void {
    this.handlers.set(channel, listener);
  }
}

describe("desktop IPC contract", () => {
  it("exposes desktop IPC channels", () => {
    expect(createIpcContract().channels).toEqual([
      "project:create",
      "project:list",
      "settings:get",
      "settings:save",
      "settings:chooseProjectDirectory",
      "providers:save",
      "providers:list",
      "providers:fetchModels",
      "books:uploadTxt",
      "books:listReports",
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
      "jobs:updateRetryPolicy",
      "jobs:delete",
      "jobs:readLog",
      "jobs:openLog",
      "jobs:openOutputDirectory",
      "window:minimize",
      "window:toggleMaximize",
      "window:close",
      "reports:preview"
    ]);
  });

  it("rejects unknown channels and missing handlers in the test harness", async () => {
    const contract = createIpcContract();
    const handlers = createHandlers();

    await expect(contract.invoke(handlers, "unknown:channel", {})).rejects.toThrow(
      "Unknown IPC channel: unknown:channel"
    );

    const missingProjectList: Partial<DesktopIpcHandlers> & Record<string, unknown> = {
      ...handlers
    };
    delete missingProjectList["project:list"];

    await expect(contract.invoke(missingProjectList, "project:list")).rejects.toThrow(
      "Missing IPC handler for channel: project:list"
    );

    expect(() =>
      registerIpcHandlers(new FakeIpcMain(), {
        ...handlers,
        "unknown:channel": async () => undefined
      })
    ).toThrow("Unknown IPC channel: unknown:channel");

    expect(() => registerIpcHandlers(new FakeIpcMain(), missingProjectList)).toThrow(
      "Missing IPC handler for channel: project:list"
    );
  });

  it("registers typed wrapper handlers through ipcMain.handle", async () => {
    const ipcMain = new FakeIpcMain();
    registerIpcHandlers(ipcMain, createHandlers());

    expect([...ipcMain.handlers.keys()]).toEqual(createIpcContract().channels);
    await expect(ipcMain.handlers.get("project:list")?.({}, undefined)).resolves.toEqual([]);
    await expect(
      ipcMain.handlers.get("project:create")?.({}, { displayName: "仙途资料" })
    ).resolves.toMatchObject({ displayName: "仙途资料" });
  });

  it("exports the desktop DTO types from the shared IPC module", () => {
    const providerKind: ProviderKind = "openai-compatible";
    const status: JobStatus = "running";
    const modelSelectionMode: JobModelSelectionMode = "auto";
    const providerView: ProviderViewDto = {
      id: "provider-1",
      presetId: "kimi",
      displayName: "DeepSeek",
      kind: providerKind,
      baseUrl: "https://api.deepseek.com",
      models: [{ id: "model-1", displayName: "模型", enabled: true, isDefault: true }],
      hasApiKey: true,
      enabled: true
    };

    expect(providerKind).toBe("openai-compatible");
    expect(status).toBe("running");
    expect(modelSelectionMode).toBe("auto");
    expect(providerView).not.toHaveProperty("apiKey");
    expectTypeOf<ProjectDto>().toMatchTypeOf<{
      id: string;
      displayName: string;
      slug: string;
      createdAt: string;
    }>();
    expectTypeOf<SaveDesktopSettingsDto>().toMatchTypeOf<{
      projectStorageDirectory?: string;
    }>();
    expectTypeOf<SaveProviderDto>().toMatchTypeOf<{
      presetId: ProviderPresetId;
      kind: ProviderKind;
      apiKey?: string;
      models?: ProviderModelDto[];
    }>();
    expectTypeOf<FetchProviderModelsDto>().toMatchTypeOf<{
      presetId: ProviderPresetId;
      baseUrl: string;
      apiKey?: string;
      modelsUrl?: string;
      isFullUrl?: boolean;
      userAgent?: string;
    }>();
    expectTypeOf<FetchedProviderModelDto>().toMatchTypeOf<{
      id: string;
      ownedBy?: string;
    }>();
    expectTypeOf<UploadTxtDto>().toMatchTypeOf<{ projectId: string; filePath: string }>();
    expectTypeOf<BookUploadResultDto>().toMatchTypeOf<{
      sourceTextPath: string;
      encoding: "utf-8" | "utf-8-bom" | "gbk" | "cp936";
    }>();
    expectTypeOf<ReportDto>().toMatchTypeOf<{ bookId: string; fileName: string }>();
    expectTypeOf<SafeMarkdownPreviewDto>().toMatchTypeOf<{ html: string; generatedAt: string }>();
    expectTypeOf<TemplateDto>().toMatchTypeOf<{
      id: string;
      scope: "global" | "project";
      name: string;
      body: string;
    }>();
    expectTypeOf<SaveTemplateDto>().toMatchTypeOf<{
      projectId: string;
      scope: "global" | "project";
      name: string;
      fileName: string;
      body: string;
    }>();
    expectTypeOf<TemplateSelectionDto>().toMatchTypeOf<{
      projectId: string;
      templateIds: string[];
    }>();
    expectTypeOf<CreateJobDto>().toMatchTypeOf<{
      bookId: string;
      templateIds: string[];
      providerConfigId: string;
      modelId: string;
      singleRunChapterCount: number;
      extractionChapterCount: number;
      overlapChapterCount: number;
      templateBatchSize: number;
      skipAlreadyExtracted: boolean;
      modelSelectionMode?: JobModelSelectionMode;
      autoRetryOnFailure?: boolean;
    }>();
    expectTypeOf<InputSummaryDto>().toMatchTypeOf<{
      modelId: string;
      modelSelectionMode?: JobModelSelectionMode;
    }>();
    expectTypeOf<JobDto>().toMatchTypeOf<{
      status: JobStatus;
      modelSelectionMode?: JobModelSelectionMode;
      autoRetryOnFailure?: boolean;
      allowedActions: Array<"start" | "pause" | "resume" | "restart" | "delete">;
    }>();
    expectTypeOf<ProjectRuntimeDto>().toMatchTypeOf<{
      books: BookUploadResultDto[];
      jobs: JobDto[];
    }>();
    expectTypeOf<JobLogDto>().toMatchTypeOf<{ jobId: string; logFilePath?: string; content: string }>();
    expectTypeOf<DeleteJobDto>().toMatchTypeOf<{ jobId: string; confirm: true }>();
    expectTypeOf<UpdateJobRetryPolicyDto>().toMatchTypeOf<{
      jobId: string;
      autoRetryOnFailure: boolean;
    }>();
    expectTypeOf<DesktopIpcRequestMap["jobs:updateRetryPolicy"]>().toEqualTypeOf<UpdateJobRetryPolicyDto>();
    expectTypeOf<DesktopIpcResponseMap["jobs:updateRetryPolicy"]>().toEqualTypeOf<JobDto>();
  });

  it("stores API keys as opaque references and redacts provider views and log text", () => {
    const apiKey = "sk-task5-secret-value";
    const store = createMemoryCredentialStore({ idFactory: () => "api-key-ref-1" });
    const apiKeyRef = store.saveApiKey({ providerConfigId: "provider-1", apiKey });

    expect(apiKeyRef).toEqual({ id: "api-key-ref-1", providerConfigId: "provider-1" });
    expect(JSON.stringify(apiKeyRef)).not.toContain(apiKey);

    const providerView = createProviderView({
      id: "provider-1",
      presetId: "deepseek",
      displayName: "DeepSeek",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      models: [{ id: "model-1", displayName: "模型", enabled: true, isDefault: true }],
      apiKeyRef,
      enabled: true
    });

    expect(providerView.hasApiKey).toBe(true);
    expect(providerView).not.toHaveProperty("apiKey");
    expect(JSON.stringify(providerView)).not.toContain(apiKey);

    const redactedLog = redactSecrets(`Authorization: Bearer ${apiKey}`, [apiKey]);
    expect(redactedLog).toContain("[REDACTED]");
    expect(redactedLog).not.toContain(apiKey);
  });
});

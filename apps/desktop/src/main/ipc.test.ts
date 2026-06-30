import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BookUploadResultDto,
  CreateJobDto,
  DeleteJobDto,
  JobDto,
  JobStatus,
  ProjectDto,
  ProviderKind,
  ProviderViewDto,
  ReportDto,
  SafeMarkdownPreviewDto,
  SaveProviderDto,
  SaveTemplateDto,
  TemplateDto,
  TemplateSelectionDto,
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
    "providers:save": async () => undefined,
    "providers:list": async () => [],
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
    "jobs:delete": async () => undefined,
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
  it("exposes only P0 channels", () => {
    expect(createIpcContract().channels).toEqual([
      "project:create",
      "project:list",
      "providers:save",
      "providers:list",
      "books:uploadTxt",
      "books:listReports",
      "templates:list",
      "templates:save",
      "templates:delete",
      "templateSelection:get",
      "templateSelection:save",
      "jobs:create",
      "jobs:start",
      "jobs:pause",
      "jobs:resume",
      "jobs:delete",
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

  it("exports the P0 DTO types from the shared IPC module", () => {
    const providerKind: ProviderKind = "openai-compatible";
    const status: JobStatus = "running";
    const providerView: ProviderViewDto = {
      id: "provider-1",
      presetId: "deepseek",
      displayName: "DeepSeek",
      kind: providerKind,
      baseUrl: "https://api.deepseek.com",
      models: [{ id: "model-1", displayName: "模型", enabled: true, isDefault: true }],
      hasApiKey: true,
      enabled: true
    };

    expect(providerKind).toBe("openai-compatible");
    expect(status).toBe("running");
    expect(providerView).not.toHaveProperty("apiKey");
    expectTypeOf<ProjectDto>().toMatchTypeOf<{
      id: string;
      displayName: string;
      slug: string;
      createdAt: string;
    }>();
    expectTypeOf<SaveProviderDto>().toMatchTypeOf<{
      presetId: "deepseek" | "custom-openai-compatible";
      kind: ProviderKind;
      apiKey?: string;
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
      skipAlreadyExtracted: boolean;
    }>();
    expectTypeOf<JobDto>().toMatchTypeOf<{ status: JobStatus; allowedActions: Array<"start" | "pause" | "resume" | "delete"> }>();
    expectTypeOf<DeleteJobDto>().toMatchTypeOf<{ jobId: string; confirm: true }>();
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

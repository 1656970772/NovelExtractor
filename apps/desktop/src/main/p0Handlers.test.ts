import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyRef, ProviderConfig } from "@novel-extractor/domain";
import { createMemoryCredentialStore, type MemoryCredentialStore } from "./credentials";
import { createIpcContract, createNotImplementedIpcHandlers } from "./ipc";
import { createP0IpcHandlers } from "./p0Handlers";

function findWorkspaceRoot(): string {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, "e2e", "fixtures"))) {
    return cwd;
  }
  return path.resolve(cwd, "../..");
}

const workspaceRoot = findWorkspaceRoot();
const utf8FixturePath = path.join(workspaceRoot, "e2e", "fixtures", "utf8-novel.txt");
const gbkFixturePath = path.join(workspaceRoot, "e2e", "fixtures", "gbk-novel.txt");
const fixedNow = "2026-06-27T00:00:00.000Z";

interface RecordedChatCompletionRequest {
  authorization?: string;
  body: unknown;
  method?: string;
  url?: string;
}

interface MockOpenAiServer {
  baseUrl: string;
  requests: RecordedChatCompletionRequest[];
  close(): Promise<void>;
}

interface MockOpenAiServerOptions {
  expectedApiKey?: string;
  expectedModel?: string;
  responseContent?: string;
  totalTokens?: number;
}

function createProviderConfig(input: {
  apiKeyRef: ApiKeyRef;
  baseUrl: string;
  modelId?: string;
}): ProviderConfig {
  const modelId = input.modelId ?? "mock-model";
  return {
    id: "provider-1",
    presetId: "custom-openai-compatible",
    displayName: "Mock Provider",
    kind: "openai-compatible",
    baseUrl: input.baseUrl,
    apiKeyRef: input.apiKeyRef,
    models: [
      {
        id: modelId,
        displayName: modelId,
        enabled: true,
        isDefault: true
      }
    ],
    enabled: true
  };
}

function createProviderStore(providerConfig: ProviderConfig) {
  return {
    async listProviderConfigs() {
      return [providerConfig];
    },
    async saveProviderConfig(config: ProviderConfig) {
      return config;
    }
  };
}

function createCredentialFixture(apiKey: string): {
  credentialStore: MemoryCredentialStore;
  apiKeyRef: ApiKeyRef;
} {
  const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
  const apiKeyRef = credentialStore.saveApiKey({
    providerConfigId: "provider-1",
    apiKey
  });
  return { credentialStore, apiKeyRef };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function startMockOpenAiServer(
  options: MockOpenAiServerOptions = {}
): Promise<MockOpenAiServer> {
  const expectedApiKey = options.expectedApiKey ?? "sk-p0-mock";
  const expectedModel = options.expectedModel ?? "mock-model";
  const responseContent =
    options.responseContent ??
    [
      "| 丹药 | 品阶 | 功效 | 材料 | 证据 |",
      "| --- | --- | --- | --- | --- |",
      "| 紫霜丹 | 筑基初期 | 稳固灵脉 | 紫霜草、月华露 | mock server 第一章 |"
    ].join("\n");
  const totalTokens = options.totalTokens ?? 37;
  const requests: RecordedChatCompletionRequest[] = [];

  const server = createServer(async (request, response) => {
    const bodyText = await readRequestBody(request);
    const body = bodyText ? JSON.parse(bodyText) : {};
    requests.push({
      authorization: request.headers.authorization,
      body,
      method: request.method,
      url: request.url
    });

    response.setHeader("Content-Type", "application/json");

    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "unexpected path" }));
      return;
    }

    if (request.headers.authorization !== `Bearer ${expectedApiKey}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: "unexpected authorization" }));
      return;
    }

    if (body.model !== expectedModel) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: `unexpected model ${String(body.model)}` }));
      return;
    }

    response.writeHead(200);
    response.end(
      JSON.stringify({
        choices: [{ message: { content: responseContent } }],
        usage: {
          prompt_tokens: 11,
          completion_tokens: totalTokens - 11,
          total_tokens: totalTokens
        }
      })
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => closeServer(server)
  };
}

describe("P0 desktop IPC handlers", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-p0-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  function createHandlers(p0Options: Record<string, unknown> = {}) {
    return {
      ...createNotImplementedIpcHandlers(),
      ...createP0IpcHandlers({
        workspaceRoot: tempRoot,
        clock: { now: () => fixedNow },
        ...p0Options
      } as Parameters<typeof createP0IpcHandlers>[0])
    };
  }

  it("uploads UTF-8 books, completes through a mock OpenAI-compatible provider, and previews sanitized markdown reports", async () => {
    const mockServer = await startMockOpenAiServer({
      responseContent: [
        "| 丹药 | 品阶 | 功效 | 材料 | 证据 |",
        "| --- | --- | --- | --- | --- |",
        "| 紫霜丹 | 筑基初期 | 稳固灵脉 | 紫霜草、月华露 | mock server 第一章 |",
        "",
        "安全预览边界：<script>window.e2eUnsafe = true</script>",
        "",
        "[危险链接](javascript:alert(1))"
      ].join("\n"),
      totalTokens: 37
    });
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture("sk-p0-mock");
    const handlers = createHandlers({
      credentialStore,
      providerStore: createProviderStore(
        createProviderConfig({
          apiKeyRef,
          baseUrl: mockServer.baseUrl
        })
      )
    });

    try {
      const book = await contract.invoke(handlers, "books:uploadTxt", {
        projectId: "project-a",
        filePath: utf8FixturePath,
        displayName: "凡人修仙传.txt"
      });

      expect(book).toMatchObject({
        displayName: "凡人修仙传.txt",
        fileName: "utf8-novel.txt",
        encoding: "utf-8",
        chapterCount: 3
      });

      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3
      });

      expect(job).toMatchObject({
        bookId: book.bookId,
        status: "created",
        allowedActions: ["start", "delete"]
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });

      expect(mockServer.requests).toHaveLength(1);
      expect(mockServer.requests[0]).toMatchObject({
        authorization: "Bearer sk-p0-mock",
        method: "POST",
        url: "/v1/chat/completions"
      });
      expect(mockServer.requests[0].body).toMatchObject({
        model: "mock-model"
      });

      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "已完成 3/3 章",
        tokenText: "Token 37 / 费用 0",
        allowedActions: ["delete"]
      });

      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });

      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        bookId: book.bookId,
        fileName: "丹药分析.md",
        displayName: "丹药分析"
      });

      const preview = await contract.invoke(handlers, "reports:preview", {
        reportId: reports[0].id
      });

      expect(preview).toMatchObject({
        reportId: reports[0].id,
        headings: [{ id: "heading-1", depth: 1, text: "丹药分析" }]
      });
      expect(preview.html).toContain("紫霜丹");
      expect(preview.html).not.toContain("<script");
      expect(preview.html).not.toContain("javascript:");
      expect(preview.html).not.toContain("onerror");
      expect(preview.html).toContain("&lt;script&gt;");
      expect(preview.html).not.toContain("sk-p0-mock");
    } finally {
      await mockServer.close();
    }
  });

  it("persists created projects across handler instances in the same workspace", async () => {
    const contract = createIpcContract();
    const firstHandlers = createHandlers();

    const createdProject = await contract.invoke(firstHandlers, "project:create", {
      displayName: "仙途资料"
    });

    const reopenedHandlers = createHandlers();
    const projects = await contract.invoke(reopenedHandlers, "project:list");

    expect(projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createdProject.id,
          displayName: "仙途资料",
          slug: createdProject.slug
        })
      ])
    );
  });

  it("redacts raw API keys echoed by successful model content before writing reports", async () => {
    const apiKey = "sk-probe-secret";
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: `模型正文恶意回显 ${apiKey}` } }],
          usage: { total_tokens: 17 }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture(apiKey);
    const handlers = createHandlers({
      credentialStore,
      providerStore: createProviderStore(
        createProviderConfig({
          apiKeyRef,
          baseUrl: "https://mock-provider.test/v1"
        })
      ),
      fetch
    });

    const book = await contract.invoke(handlers, "books:uploadTxt", {
      projectId: "project-a",
      filePath: utf8FixturePath,
      displayName: "凡人修仙传.txt"
    });
    const job = await contract.invoke(handlers, "jobs:create", {
      bookId: book.bookId,
      templateIds: ["pill-analysis"],
      providerConfigId: "provider-1",
      modelId: "mock-model",
      singleRunChapterCount: 2,
      extractionChapterCount: 3
    });

    const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
    if (!completedJob) {
      throw new Error("jobs:start returned no completed job dto");
    }
    const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
    const preview = await contract.invoke(handlers, "reports:preview", {
      reportId: reports[0].id
    });
    const reportMarkdown = await fs.readFile(
      path.join(
        tempRoot,
        "projects",
        "project-a",
        "assets",
        "books",
        book.bookId,
        "reports",
        "丹药分析.md"
      ),
      "utf8"
    );

    expect(completedJob.status).toBe("completed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reports).toHaveLength(1);
    expect(reportMarkdown).toContain("模型正文恶意回显");
    expect(reportMarkdown).not.toContain(apiKey);
    expect(preview.html).toContain("模型正文恶意回显");
    expect(preview.html).not.toContain(apiKey);
    expect(JSON.stringify(completedJob)).not.toContain(apiKey);
    expect(JSON.stringify(reports)).not.toContain(apiKey);
  });

  it("sends uploaded project template content to the model prompt", async () => {
    const mockServer = await startMockOpenAiServer();
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture("sk-p0-mock");
    const handlers = createHandlers({
      credentialStore,
      providerStore: createProviderStore(
        createProviderConfig({
          apiKeyRef,
          baseUrl: mockServer.baseUrl
        })
      )
    });

    try {
      const book = await contract.invoke(handlers, "books:uploadTxt", {
        projectId: "project-a",
        filePath: utf8FixturePath,
        displayName: "凡人修仙传.txt"
      });
      const template = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: "伏笔追踪模板",
        fileName: "foreshadow.md",
        body: "只记录当前项目专属伏笔，并输出证据章节。"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [template.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3
      });

      await contract.invoke(handlers, "jobs:start", { jobId: job.id });

      expect(mockServer.requests).toHaveLength(1);
      const requestBodyText = JSON.stringify(mockServer.requests[0].body);
      expect(requestBodyText).toContain("伏笔追踪模板");
      expect(requestBodyText).toContain("只记录当前项目专属伏笔，并输出证据章节。");
      expect(requestBodyText).not.toContain("丹药分析模板");
    } finally {
      await mockServer.close();
    }
  });

  it("marks jobs failed when the configured provider base URL is unreachable", async () => {
    const mockServer = await startMockOpenAiServer();
    const unreachableBaseUrl = mockServer.baseUrl;
    await mockServer.close();
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture("sk-p0-mock");
    const handlers = createHandlers({
      credentialStore,
      providerStore: createProviderStore(
        createProviderConfig({
          apiKeyRef,
          baseUrl: unreachableBaseUrl
        })
      )
    });

    const book = await contract.invoke(handlers, "books:uploadTxt", {
      projectId: "project-a",
      filePath: utf8FixturePath,
      displayName: "凡人修仙传.txt"
    });
    const job = await contract.invoke(handlers, "jobs:create", {
      bookId: book.bookId,
      templateIds: ["pill-analysis"],
      providerConfigId: "provider-1",
      modelId: "mock-model",
      singleRunChapterCount: 2,
      extractionChapterCount: 3
    });

    const failedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
    if (!failedJob) {
      throw new Error("jobs:start returned no failed job dto");
    }

    expect(failedJob).toMatchObject({
      id: job.id,
      status: "failed",
      allowedActions: ["delete"]
    });
    expect(failedJob.failureReason).toBeTruthy();
    expect(JSON.stringify(failedJob)).not.toContain("sk-p0-mock");
    await expect(contract.invoke(handlers, "books:listReports", { bookId: book.bookId })).resolves.toEqual([]);
  });

  it("marks jobs failed when the mock provider rejects the requested model", async () => {
    const mockServer = await startMockOpenAiServer({ expectedModel: "mock-model" });
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture("sk-p0-mock");
    const handlers = createHandlers({
      credentialStore,
      providerStore: createProviderStore(
        createProviderConfig({
          apiKeyRef,
          baseUrl: mockServer.baseUrl,
          modelId: "wrong-model"
        })
      )
    });

    try {
      const book = await contract.invoke(handlers, "books:uploadTxt", {
        projectId: "project-a",
        filePath: utf8FixturePath,
        displayName: "凡人修仙传.txt"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "wrong-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3
      });

      const failedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      if (!failedJob) {
        throw new Error("jobs:start returned no failed job dto");
      }

      expect(mockServer.requests).toHaveLength(1);
      expect(mockServer.requests[0].body).toMatchObject({
        model: "wrong-model"
      });
      expect(failedJob).toMatchObject({
        id: job.id,
        status: "failed",
        allowedActions: ["delete"]
      });
      expect(failedJob.failureReason).toContain("HTTP 400");
      await expect(contract.invoke(handlers, "books:listReports", { bookId: book.bookId })).resolves.toEqual([]);
    } finally {
      await mockServer.close();
    }
  });

  it("uploads GBK novels through the same Main boundary", async () => {
    const contract = createIpcContract();
    const handlers = createHandlers();

    const book = await contract.invoke(handlers, "books:uploadTxt", {
      projectId: "project-a",
      filePath: gbkFixturePath,
      displayName: "GBK 小说.txt"
    });

    expect(book).toMatchObject({
      displayName: "GBK 小说.txt",
      fileName: "gbk-novel.txt",
      encoding: "gbk",
      chapterCount: 2
    });
  });

  it("manages global and project templates with project selection cleanup", async () => {
    const contract = createIpcContract();
    const handlers = createHandlers();

    const initialTemplates = await contract.invoke(handlers, "templates:list", {
      projectId: "project-a"
    });
    expect(initialTemplates.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pill-analysis",
          scope: "global",
          name: "丹药分析模板"
        })
      ])
    );

    const globalTemplate = await contract.invoke(handlers, "templates:save", {
      projectId: "project-a",
      scope: "global",
      name: "世界观模板",
      fileName: "world.md",
      body: "# 世界观\n记录势力、地名与修炼体系。"
    });
    const projectTemplate = await contract.invoke(handlers, "templates:save", {
      projectId: "project-a",
      scope: "project",
      name: "网文项目模板",
      fileName: "project.txt",
      body: "只记录当前项目专属伏笔。"
    });

    expect(globalTemplate).toMatchObject({
      scope: "global",
      projectId: undefined,
      name: "世界观模板",
      fileName: "world.md",
      body: "# 世界观\n记录势力、地名与修炼体系。"
    });
    expect(projectTemplate).toMatchObject({
      scope: "project",
      projectId: "project-a",
      name: "网文项目模板",
      fileName: "project.txt"
    });

    const projectAList = await contract.invoke(handlers, "templates:list", {
      projectId: "project-a"
    });
    expect(projectAList.templates.map((template) => template.id)).toEqual(
      expect.arrayContaining([globalTemplate.id, projectTemplate.id])
    );

    const projectBList = await contract.invoke(handlers, "templates:list", {
      projectId: "project-b"
    });
    expect(projectBList.templates.map((template) => template.id)).toContain(globalTemplate.id);
    expect(projectBList.templates.map((template) => template.id)).not.toContain(projectTemplate.id);

    await contract.invoke(handlers, "templateSelection:save", {
      projectId: "project-a",
      templateIds: [globalTemplate.id, projectTemplate.id]
    });
    await expect(
      contract.invoke(handlers, "templateSelection:get", { projectId: "project-a" })
    ).resolves.toEqual({
      projectId: "project-a",
      templateIds: [globalTemplate.id, projectTemplate.id]
    });

    await contract.invoke(handlers, "templates:delete", {
      templateId: projectTemplate.id
    });

    const selectionAfterDelete = await contract.invoke(handlers, "templateSelection:get", {
      projectId: "project-a"
    });
    expect(selectionAfterDelete.templateIds).toEqual([globalTemplate.id]);
  });

  it("does not auto-select newly created templates before the user chooses them", async () => {
    const contract = createIpcContract();
    const handlers = createHandlers();

    const globalTemplate = await contract.invoke(handlers, "templates:save", {
      projectId: "project-a",
      scope: "global",
      name: "用户全局模板",
      fileName: "user-global.md",
      body: "用户新增的全局模板。"
    });
    const projectTemplate = await contract.invoke(handlers, "templates:save", {
      projectId: "project-a",
      scope: "project",
      name: "用户项目模板",
      fileName: "user-project.md",
      body: "用户新增的项目模板。"
    });

    const selection = await contract.invoke(handlers, "templateSelection:get", {
      projectId: "project-a"
    });

    expect(selection.templateIds).toContain("pill-analysis");
    expect(selection.templateIds).not.toContain(globalTemplate.id);
    expect(selection.templateIds).not.toContain(projectTemplate.id);
  });

  it("keeps template ids unique across app restarts", async () => {
    const contract = createIpcContract();
    const firstHandlers = createHandlers();

    const firstTemplate = await contract.invoke(firstHandlers, "templates:save", {
      projectId: "project-a",
      scope: "project",
      name: "测试",
      fileName: "test.md",
      body: ""
    });

    const restartedHandlers = createHandlers();
    const secondTemplate = await contract.invoke(restartedHandlers, "templates:save", {
      projectId: "project-a",
      scope: "project",
      name: "111",
      fileName: "111.md",
      body: ""
    });

    expect(secondTemplate.id).not.toBe(firstTemplate.id);

    await contract.invoke(restartedHandlers, "templateSelection:save", {
      projectId: "project-a",
      templateIds: [secondTemplate.id]
    });
    const selection = await contract.invoke(restartedHandlers, "templateSelection:get", {
      projectId: "project-a"
    });

    expect(selection.templateIds).toEqual([secondTemplate.id]);
  });

  it("migrates duplicate template ids from older template stores", async () => {
    await fs.writeFile(
      path.join(tempRoot, "templates.json"),
      `${JSON.stringify(
        {
          templates: [
            {
              id: "template-1",
              scope: "project",
              projectId: "project-a",
              name: "测试",
              fileName: "test.md",
              body: "",
              createdAt: fixedNow,
              updatedAt: fixedNow
            },
            {
              id: "template-1",
              scope: "project",
              projectId: "project-a",
              name: "111",
              fileName: "111.md",
              body: "",
              createdAt: fixedNow,
              updatedAt: fixedNow
            }
          ],
          selectionsByProjectId: {
            "project-a": ["template-1"]
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const contract = createIpcContract();
    const handlers = createHandlers();
    const list = await contract.invoke(handlers, "templates:list", {
      projectId: "project-a"
    });
    const ids = list.templates.map((template) => template.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(list.templates.find((template) => template.name === "111")?.id).not.toBe("template-1");

    const selection = await contract.invoke(handlers, "templateSelection:get", {
      projectId: "project-a"
    });
    expect(selection.templateIds).toEqual([]);
  });

  it("allows saving an empty manual template draft", async () => {
    const contract = createIpcContract();
    const handlers = createHandlers();

    const template = await contract.invoke(handlers, "templates:save", {
      projectId: "project-a",
      scope: "project",
      name: "空白模板",
      fileName: "空白模板.md",
      body: ""
    });

    expect(template).toMatchObject({
      projectId: "project-a",
      scope: "project",
      name: "空白模板",
      fileName: "空白模板.md",
      body: ""
    });
  });
});

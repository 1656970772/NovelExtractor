import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "@novel-extractor/config";
import type { ApiKeyRef, ProviderConfig } from "@novel-extractor/domain";
import type { CreateJobDto, JobDto } from "../shared/ipcTypes";
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

function requireJobDto(job: JobDto | void): JobDto {
  expect(job).toBeDefined();
  return job as JobDto;
}

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
  respond?: (input: {
    body: Record<string, unknown>;
    requestIndex: number;
  }) =>
    | {
        body?: unknown;
        responseContent?: string;
        status?: number;
        totalTokens?: number;
        usage?: unknown;
      }
    | Promise<{
        body?: unknown;
        responseContent?: string;
        status?: number;
        totalTokens?: number;
        usage?: unknown;
      }>;
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

function createToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}

function createRawToolCall(id: string, name: string, rawArguments: string): Record<string, unknown> {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: rawArguments
    }
  };
}

function createChatCompletionResponse(input: {
  content?: string;
  toolCalls?: Array<Record<string, unknown>>;
  totalTokens?: number;
} = {}): Record<string, unknown> {
  const totalTokens = input.totalTokens ?? 37;
  const message: Record<string, unknown> = {
    content: input.content ?? ""
  };

  if (input.toolCalls?.length) {
    message.tool_calls = input.toolCalls;
  }

  return {
    choices: [{ message }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: totalTokens - 11,
      total_tokens: totalTokens
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
    "NO_UPDATE";
  const totalTokens = options.totalTokens ?? 37;
  const requests: RecordedChatCompletionRequest[] = [];

  const server = createServer(async (request, response) => {
    const bodyText = await readRequestBody(request);
    const body = (bodyText ? JSON.parse(bodyText) : {}) as Record<string, unknown>;
    const requestIndex = requests.length;
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

    const responseOverride = await options.respond?.({ body, requestIndex });
    const status = responseOverride?.status ?? 200;
    const responseBody =
      responseOverride?.body ??
      (() => {
        const windowResponseContent = responseOverride?.responseContent ?? responseContent;
        const windowTotalTokens = responseOverride?.totalTokens ?? totalTokens;
        return {
          choices: [{ message: { content: windowResponseContent } }],
          usage: responseOverride?.usage ?? {
            prompt_tokens: 11,
            completion_tokens: windowTotalTokens - 11,
            total_tokens: windowTotalTokens
          }
        };
      })();

    response.writeHead(status);
    response.end(
      JSON.stringify(responseBody)
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

async function writeTempNovel(
  root: string,
  fileName: string,
  chapterCount: number
): Promise<string> {
  const filePath = path.join(root, fileName);
  const content = Array.from({ length: chapterCount }, (_, index) => {
    const chapterNumber = index + 1;
    return [
      `第${chapterNumber}章 临时章节${chapterNumber}`,
      `这是第 ${chapterNumber} 章的窗口切片测试内容。`
    ].join("\n");
  }).join("\n\n");

  await fs.writeFile(filePath, `${content}\n`, "utf8");
  return filePath;
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

  it("uploads UTF-8 books, writes template reports through tool loop, and previews sanitized markdown reports", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: ({ body }) => {
        const requestBodyText = JSON.stringify(body);
        const isFirstWindow = requestBodyText.includes("窗口序号：1/2");
        const hasToolReplay = requestBodyText.includes("\"role\":\"tool\"");

        if (isFirstWindow && !hasToolReplay && requestBodyText.includes("丹药分析模板")) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-pill", "write_file", {
                  path: "丹药分析.md",
                  content: [
                    "# 丹药分析",
                    "",
                    "| 丹药 | 品阶 | 功效 | 材料 | 证据 |",
                    "| --- | --- | --- | --- | --- |",
                    "| 紫霜丹 | 筑基初期 | 稳固灵脉 | 紫霜草、月华露 | mock server 第一章 |",
                    "",
                    "安全预览边界：<script>window.e2eUnsafe = true</script>",
                    "",
                    "[危险链接](javascript:alert(1))",
                    "",
                    "模型不应写出密钥 sk-p0-mock"
                  ].join("\n")
                })
              ]
            })
          };
        }

        if (isFirstWindow && !hasToolReplay && requestBodyText.includes("材料分析模板")) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-material", "write_file", {
                  path: "材料分析.md",
                  content: "# 材料分析\n\n紫霜草、月华露来自第一窗口。"
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({
            content: isFirstWindow ? "窗口一 tool loop 完成。" : "NO_UPDATE"
          })
        };
      }
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
        sourceTextPath: `assets/books/${book.bookId}/source/original.txt`,
        encoding: "utf-8",
        chapterCount: 3
      });

      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      expect(job).toMatchObject({
        bookId: book.bookId,
        status: "created",
        allowedActions: ["start", "delete"]
      });

      const materialTemplate = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: "材料分析模板",
        fileName: "材料分析.md",
        body: "记录当前窗口出现的炼丹材料、用途和证据。"
      });
      const jobWithTwoTemplates = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis", materialTemplate.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: jobWithTwoTemplates.id });
      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const windowsManifestPath = path.join(projectRoot, "runs", jobWithTwoTemplates.id, "windows", "manifest.json");
      const firstWindowPath = path.join(projectRoot, "runs", jobWithTwoTemplates.id, "windows", "window-0001.txt");
      const rulesSnapshotPath = path.join(projectRoot, "runs", jobWithTwoTemplates.id, "rules", "提取规则.md");
      const rulesLatestPath = path.join(projectRoot, "rules", "提取规则.md");
      const windowsManifest = JSON.parse(await fs.readFile(windowsManifestPath, "utf8")) as {
        jobId: string;
        bookId: string;
        sourceTextPath: string;
        windows: Array<{ windowHash?: string }>;
      };
      const rulesSnapshot = await fs.readFile(rulesSnapshotPath, "utf8");
      const rulesLatest = await fs.readFile(rulesLatestPath, "utf8");

      expect(windowsManifest).toMatchObject({
        jobId: jobWithTwoTemplates.id,
        bookId: book.bookId,
        sourceTextPath: book.sourceTextPath
      });
      expect(windowsManifest.windows.length).toBeGreaterThan(0);
      expect(windowsManifest.windows[0].windowHash).toMatch(/^[a-f0-9]{64}$/);
      expect((await fs.stat(firstWindowPath)).isFile()).toBe(true);
      expect(rulesSnapshot).toContain("凡人修仙传.txt");
      expect(rulesSnapshot).toContain("丹药分析模板");
      expect(rulesSnapshot).toContain("丹药分析.md");
      expect(rulesSnapshot).toContain("材料分析模板");
      expect(rulesSnapshot).toContain("材料分析.md");
      expect(rulesSnapshot).toContain("## 路由失败策略");
      expect(rulesSnapshot).toContain("## 写入规则");
      expect(rulesLatest).toBe(rulesSnapshot);

      expect(mockServer.requests).toHaveLength(6);
      for (const request of mockServer.requests) {
        expect(request).toMatchObject({
          authorization: "Bearer sk-p0-mock",
          method: "POST",
          url: "/v1/chat/completions"
        });
        expect(request.body).toMatchObject({
          model: "mock-model"
        });
        expect(request.body).toHaveProperty("tools");
        expect(request.body).not.toHaveProperty("tool_choice");
      }
      const firstRequestBody = mockServer.requests[0].body as Record<string, unknown>;
      const secondRequestBody = mockServer.requests[1].body as { messages?: Array<Record<string, unknown>> };
      const firstMaterialRequestBody = mockServer.requests[2].body as Record<string, unknown>;
      const firstMaterialReplayBody = mockServer.requests[3].body as { messages?: Array<Record<string, unknown>> };
      const secondMessages = secondRequestBody.messages ?? [];
      const firstMaterialReplayMessages = firstMaterialReplayBody.messages ?? [];
      const assistantToolCallMessage = secondMessages.find(
        (message) => message.role === "assistant" && Array.isArray(message.tool_calls)
      );
      const secondToolMessages = secondMessages.filter((message) => message.role === "tool");
      const firstMaterialToolMessages = firstMaterialReplayMessages.filter((message) => message.role === "tool");

      const firstRequestJson = JSON.stringify(firstRequestBody);
      const firstMaterialRequestJson = JSON.stringify(firstMaterialRequestBody);
      const firstWindowTextPath = `runs/${jobWithTwoTemplates.id}/windows/window-0001.txt`;

      expect(firstRequestJson).toContain("write_file");
      expect(firstRequestJson).toContain("edit_file");
      expect(firstRequestJson).toContain("multi_edit");
      expect(firstRequestJson).toContain("read_file");
      expect(firstRequestJson).toContain("grep");
      expect(firstRequestJson).toContain(`窗口文件：${firstWindowTextPath}`);
      expect(firstRequestJson).toContain(
        `read_file/grep 如需读取当前窗口文件，必须使用项目相对路径 ${firstWindowTextPath}，不要使用裸文件名 window-0001.txt`
      );
      expect(firstRequestJson).toContain("窗口序号：1/2");
      expect(firstRequestJson).toContain("丹药分析模板");
      expect(firstRequestJson).not.toContain("材料分析模板");
      expect(firstMaterialRequestJson).toContain("窗口序号：1/2");
      expect(firstMaterialRequestJson).toContain("材料分析模板");
      expect(firstMaterialRequestJson).not.toContain("丹药分析模板");
      expect(JSON.stringify(mockServer.requests[4].body)).toContain("窗口序号：2/2");
      expect(JSON.stringify(mockServer.requests[5].body)).toContain("窗口序号：2/2");
      expect(assistantToolCallMessage).toMatchObject({
        role: "assistant"
      });
      expect((assistantToolCallMessage?.tool_calls as unknown[] | undefined) ?? []).toHaveLength(1);
      expect(secondToolMessages).toHaveLength(1);
      expect(firstMaterialToolMessages).toHaveLength(1);
      expect(JSON.stringify(secondToolMessages)).toContain("丹药分析.md");
      expect(JSON.stringify(firstMaterialToolMessages)).toContain("材料分析.md");
      expect(JSON.stringify(mockServer.requests[0].body)).toContain("上下文章节范围：1-2");
      expect(JSON.stringify(mockServer.requests[0].body)).toContain("提交章节范围：1-2");
      expect(JSON.stringify(mockServer.requests[0].body)).toContain("当前运行日期：2026-06-27");
      expect(JSON.stringify(mockServer.requests[0].body)).toContain(
        "禁止使用模型对作品全书、后续章节、未读窗口或常识剧情的先验知识；只能写当前窗口文本明示或当前已有报告已证实的事实；涉及未来真相、真实身份、夺舍、寿元、后续影响等当前窗口未说明内容，必须写原文未说明或不写。"
      );
      expect(JSON.stringify(mockServer.requests[0].body)).toContain(
        "资料来源、参考范围、更新日期等元信息只能根据实际使用的当前窗口、已读取报告和当前运行日期填写；不得遗漏已使用窗口、不得声称未读取来源，更新日期不得晚于当前运行日期。"
      );
      expect(JSON.stringify(mockServer.requests[0].body)).toContain("第一章 初入坊市");
      expect(JSON.stringify(mockServer.requests[0].body)).toContain("第二章 丹房夜火");
      expect(JSON.stringify(mockServer.requests[0].body)).not.toContain("第三章 试炼归来");
      expect(JSON.stringify(mockServer.requests[4].body)).toContain("上下文章节范围：2-3");
      expect(JSON.stringify(mockServer.requests[4].body)).toContain("提交章节范围：3-3");
      expect(JSON.stringify(mockServer.requests[4].body)).not.toContain("第一章 初入坊市");
      expect(JSON.stringify(mockServer.requests[4].body)).toContain("第二章 丹房夜火");
      expect(JSON.stringify(mockServer.requests[4].body)).toContain("第三章 试炼归来");

      expect(completedJob).toMatchObject({
        id: jobWithTwoTemplates.id,
        status: "completed",
        progressText: "窗口 2/2",
        tokenText: "Token 222 / 费用 0",
        allowedActions: ["delete"]
      });

      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const reportsByFileName = [...reports].sort((left, right) =>
        left.fileName.localeCompare(right.fileName)
      );
      const pillReport = reportsByFileName.find((report) => report.fileName === "丹药分析.md");
      const materialReport = reportsByFileName.find((report) => report.fileName === "材料分析.md");

      expect(reportsByFileName).toHaveLength(2);
      expect(pillReport).toMatchObject({
        bookId: book.bookId,
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
      });
      expect(materialReport).toMatchObject({
        bookId: book.bookId,
        fileName: "材料分析.md",
        displayName: "材料分析",
        reportKind: "template-output"
      });
      expect(reportsByFileName.map((report) => report.reportKind)).not.toContain("raw-window");

      const preview = await contract.invoke(handlers, "reports:preview", {
        reportId: pillReport?.id ?? ""
      });

      expect(preview).toMatchObject({
        reportId: pillReport?.id,
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

  it("lets a later window read and edit an existing template report without duplicating its report asset", async () => {
    let uploadedBookId = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-1-write", "write_file", {
                  path: "丹药分析.md",
                  content: "# 丹药分析\n\n窗口一写入：凝气丹。"
                })
              ]
            })
          };
        }

        if (requestIndex === 2) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-read", "read_file", {
                  path: `assets/books/${uploadedBookId}/reports/丹药分析.md`
                })
              ]
            })
          };
        }

        if (requestIndex === 3) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-edit", "edit_file", {
                  path: "丹药分析.md",
                  oldText: "窗口一写入：凝气丹。",
                  newText: "窗口一写入：凝气丹。\n窗口二已更新：紫霜丹。"
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "窗口完成。" })
        };
      }
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
      uploadedBookId = book.bookId;
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });

      expect(mockServer.requests).toHaveLength(5);
      expect(JSON.stringify(mockServer.requests[3].body)).toContain("窗口一写入：凝气丹");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 2/2"
      });
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
      });
      const preview = await contract.invoke(handlers, "reports:preview", {
        reportId: reports[0].id
      });

      expect(preview.html).toContain("窗口二已更新：紫霜丹");
      expect(preview.html).not.toContain("report-2");
    } finally {
      await mockServer.close();
    }
  });

  it("allows the same tool loop to edit a report created by an earlier successful write_file", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-create-report", "write_file", {
                  path: "丹药分析.md",
                  content: "# 丹药分析\n\n待清理标记：模板占位\n\n正式内容：凝气丹。"
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-clean-template-marker", "edit_file", {
                  path: "丹药分析.md",
                  oldText: "待清理标记：模板占位\n\n",
                  newText: ""
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "同一窗口报告修正完成。" })
        };
      }
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 3,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
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

      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 1/1"
      });
      expect(mockServer.requests).toHaveLength(3);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        reportKind: "template-output"
      });
      expect(reportMarkdown).toBe("# 丹药分析\n\n正式内容：凝气丹。\n");
    } finally {
      await mockServer.close();
    }
  });

  it.each([
    {
      toolName: "edit_file",
      toolArgs: (reportPath: string) => ({
        path: reportPath,
        oldText: "窗口一记录：韩立谨慎，代表事件为墨府求生。",
        newText: "窗口一记录：韩立谨慎，代表事件为墨府求生。\n窗口二补充：韩立遇事先观察，再决定是否出手。"
      })
    },
    {
      toolName: "multi_edit",
      toolArgs: (reportPath: string) => ({
        path: reportPath,
        edits: [
          {
            oldText: "窗口一记录：韩立谨慎，代表事件为墨府求生。",
            newText:
              "窗口一记录：韩立谨慎，代表事件为墨府求生。\n窗口二补充：韩立遇事先观察，再决定是否出手。"
          }
        ]
      })
    }
  ])("normalizes project-relative report paths for later-window $toolName writes", async ({ toolName, toolArgs }) => {
    let uploadedBookId = "";
    const reportFileName = "NPC性格与代表事件.md";
    const reportPath = () => `assets/books/${uploadedBookId}/reports/${reportFileName}`;
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-1-write", "write_file", {
                  path: reportFileName,
                  content: "# NPC性格与代表事件\n\n窗口一记录：韩立谨慎，代表事件为墨府求生。"
                })
              ]
            })
          };
        }

        if (requestIndex === 2) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-read", "read_file", {
                  path: reportPath()
                })
              ]
            })
          };
        }

        if (requestIndex === 3) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [createToolCall("call-window-2-update", toolName, toolArgs(reportPath()))]
            })
          };
        }

        return {
          body: createChatCompletionResponse({
            content: requestIndex === 1 ? "第一窗口写入完成。" : "第二窗口补充完成。"
          })
        };
      }
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
      uploadedBookId = book.bookId;
      const template = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: "NPC性格与代表事件",
        fileName: reportFileName,
        body: "记录 NPC 性格、行为证据和代表事件。"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [template.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const reportMarkdown = await fs.readFile(
        path.join(
          tempRoot,
          "projects",
          "project-a",
          "assets",
          "books",
          book.bookId,
          "reports",
          reportFileName
        ),
        "utf8"
      );

      expect(completedJob?.failureReason).toBeUndefined();
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 2/2"
      });
      expect(mockServer.requests).toHaveLength(5);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: reportFileName,
        displayName: "NPC性格与代表事件",
        reportKind: "template-output"
      });
      expect(reportMarkdown).toContain("窗口一记录：韩立谨慎");
      expect(reportMarkdown).toContain("窗口二补充：韩立遇事先观察");
    } finally {
      await mockServer.close();
    }
  });

  it("allows safe write_file rewrites after reading the same existing report and preserving its full content", async () => {
    let uploadedBookId = "";
    let rewriteReplayBody = "";
    const reportFileName = "NPC性格与代表事件.md";
    const reportPath = () => `assets/books/${uploadedBookId}/reports/${reportFileName}`;
    const firstReportBody = "# NPC性格与代表事件\n\n窗口一：韩立谨慎，代表事件为墨府求生。";
    const rewrittenReportBody = [
      firstReportBody,
      "",
      "窗口二补充：韩立在黄枫谷入门前继续保持低调观察。"
    ].join("\n");
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-1-write", "write_file", {
                  path: reportFileName,
                  content: firstReportBody
                })
              ]
            })
          };
        }

        if (requestIndex === 2) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-read", "read_file", {
                  path: reportPath()
                })
              ]
            })
          };
        }

        if (requestIndex === 3) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-safe-rewrite", "write_file", {
                  path: reportPath(),
                  content: rewrittenReportBody
                })
              ]
            })
          };
        }

        if (requestIndex === 4) {
          rewriteReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({ content: "第二窗口安全重写完成。" })
          };
        }

        return {
          body: createChatCompletionResponse({
            content: requestIndex === 1 ? "第一窗口写入完成。" : "NO_UPDATE"
          })
        };
      }
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
      uploadedBookId = book.bookId;
      const template = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: "NPC性格与代表事件",
        fileName: reportFileName,
        body: "记录 NPC 性格、行为证据和代表事件。"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [template.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const reportMarkdown = await fs.readFile(
        path.join(
          tempRoot,
          "projects",
          "project-a",
          "assets",
          "books",
          book.bookId,
          "reports",
          reportFileName
        ),
        "utf8"
      );

      expect(mockServer.requests).toHaveLength(5);
      expect(rewriteReplayBody).not.toContain("已有报告不能用 write_file 覆盖");
      expect(rewriteReplayBody).toContain("operation");
      expect(rewriteReplayBody).toContain("write_file");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 2/2"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: reportFileName,
        displayName: "NPC性格与代表事件",
        reportKind: "template-output"
      });
      expect(reportMarkdown).toBe(`${rewrittenReportBody}\n`);
      expect(reportMarkdown).toContain("窗口一：韩立谨慎");
      expect(reportMarkdown).toContain("窗口二补充：韩立在黄枫谷入门前继续保持低调观察");
    } finally {
      await mockServer.close();
    }
  });

  it("returns a recoverable tool error when a later window tries to overwrite an existing template report with write_file", async () => {
    const firstReportBody = [
      "# 势力设定",
      "",
      "## 一、七玄门",
      "",
      "七玄门早期内容。"
    ].join("\n");
    const secondReportSection = [
      "## 二、野狼帮",
      "",
      "野狼帮、贾天龙与金狼相关内容。"
    ].join("\n");
    let overwriteReplayBody = "";
    let readReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-1-write", "write_file", {
                  path: "势力设定.md",
                  content: firstReportBody
                })
              ]
            })
          };
        }

        if (requestIndex === 2) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-overwrite", "write_file", {
                  path: "势力设定.md",
                  content: ["# 势力设定", "", secondReportSection].join("\n")
                })
              ]
            })
          };
        }

        if (requestIndex === 3) {
          overwriteReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-read", "read_file", {
                  path: "势力设定.md"
                })
              ]
            })
          };
        }

        if (requestIndex === 4) {
          readReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-edit", "edit_file", {
                  path: "势力设定.md",
                  oldText: firstReportBody,
                  newText: [firstReportBody, "", secondReportSection].join("\n")
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({
            content: requestIndex === 1 ? "第一窗口写入完成。" : "第二窗口追加完成。"
          })
        };
      }
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
      const factionTemplate = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: "势力设定模板",
        fileName: "势力设定.md",
        body: "记录当前窗口出现的门派、帮派、组织和关键成员。"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [factionTemplate.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reportMarkdown = await fs.readFile(
        path.join(
          tempRoot,
          "projects",
          "project-a",
          "assets",
          "books",
          book.bookId,
          "reports",
          "势力设定.md"
        ),
        "utf8"
      );

      expect(mockServer.requests).toHaveLength(6);
      expect(overwriteReplayBody).toContain("已有报告不能用 write_file 覆盖");
      expect(overwriteReplayBody).toContain("read_file/grep");
      expect(readReplayBody).toContain("## 一、七玄门");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 2/2"
      });
      expect(reportMarkdown).toContain("## 一、七玄门");
      expect(reportMarkdown).toContain("## 二、野狼帮");
      expect(reportMarkdown).toContain("贾天龙");
    } finally {
      await mockServer.close();
    }
  });

  it("normalizes reports aliases for existing report lookup while preserving write_file overwrite protection", async () => {
    const reportFileName = "势力设定.md";
    const firstReportBody = [
      "# 势力设定",
      "",
      "## 一、七玄门",
      "",
      "七玄门早期内容。"
    ].join("\n");
    const lossyRewriteBody = [
      "# 势力设定",
      "",
      "## 二、野狼帮",
      "",
      "野狼帮、贾天龙与金狼相关内容。"
    ].join("\n");
    const mergedReportBody = [firstReportBody, "", "## 二、野狼帮", "", "野狼帮、贾天龙与金狼相关内容。"].join("\n");
    const finalReportBody = mergedReportBody.replace("贾天龙与金狼", "贾天龙、金狼");
    let uploadedBookId = "";
    let grepReplayBody = "";
    let readReplayBody = "";
    let overwriteReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-1-write", "write_file", {
                  path: reportFileName,
                  content: firstReportBody
                })
              ]
            })
          };
        }

        if (requestIndex === 2) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-grep-reports", "grep", {
                  path: "reports",
                  pattern: "势力设定"
                }),
                createToolCall("call-window-2-grep-dot-reports", "grep", {
                  path: "./reports",
                  pattern: "七玄门"
                })
              ]
            })
          };
        }

        if (requestIndex === 3) {
          grepReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-read-report-alias", "read_file", {
                  path: `reports/${reportFileName}`
                })
              ]
            })
          };
        }

        if (requestIndex === 4) {
          readReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-lossy-rewrite-alias", "write_file", {
                  path: `reports/${reportFileName}`,
                  content: lossyRewriteBody
                })
              ]
            })
          };
        }

        if (requestIndex === 5) {
          overwriteReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-edit-report-alias", "edit_file", {
                  path: `reports/${reportFileName}`,
                  oldText: firstReportBody,
                  newText: mergedReportBody
                })
              ]
            })
          };
        }

        if (requestIndex === 6) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-multi-edit-dot-report-alias", "multi_edit", {
                  path: `./reports/${reportFileName}`,
                  edits: [
                    {
                      oldText: "野狼帮、贾天龙与金狼相关内容。",
                      newText: "野狼帮、贾天龙、金狼相关内容。"
                    }
                  ]
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({
            content: requestIndex === 1 ? "第一窗口写入完成。" : "第二窗口追加完成。"
          })
        };
      }
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
      uploadedBookId = book.bookId;
      const factionTemplate = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: "势力设定模板",
        fileName: reportFileName,
        body: "记录当前窗口出现的门派、帮派、组织和关键成员。"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [factionTemplate.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reportMarkdown = await fs.readFile(
        path.join(
          tempRoot,
          "projects",
          "project-a",
          "assets",
          "books",
          book.bookId,
          "reports",
          reportFileName
        ),
        "utf8"
      );

      expect(mockServer.requests).toHaveLength(8);
      expect(grepReplayBody).toContain(`assets/books/${uploadedBookId}/reports/${reportFileName}`);
      expect(grepReplayBody).toContain("# 势力设定");
      expect(grepReplayBody).not.toContain("NOT_FOUND");
      expect(grepReplayBody).not.toContain("UNSAFE_PATH");
      expect(readReplayBody).toContain("七玄门早期内容");
      expect(readReplayBody).not.toContain("NOT_FOUND");
      expect(overwriteReplayBody).toContain("不能覆盖丢失既有内容");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 2/2"
      });
      expect(reportMarkdown).toBe(`${finalReportBody}\n`);
    } finally {
      await mockServer.close();
    }
  });

  it("allows edit_file after grep reports returns a match for the same existing report", async () => {
    const reportFileName = "势力设定.md";
    const firstReportBody = [
      "# 势力设定",
      "",
      "## 一、七玄门",
      "",
      "七玄门早期内容。"
    ].join("\n");
    const updatedReportBody = firstReportBody.replace("七玄门早期内容。", "七玄门补充内容。");
    let uploadedBookId = "";
    let grepReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-1-write", "write_file", {
                  path: reportFileName,
                  content: firstReportBody
                })
              ]
            })
          };
        }

        if (requestIndex === 2) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-grep-reports", "grep", {
                  path: "reports",
                  pattern: "七玄门"
                })
              ]
            })
          };
        }

        if (requestIndex === 3) {
          grepReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-edit-report", "edit_file", {
                  path: `reports/${reportFileName}`,
                  oldText: "七玄门早期内容。",
                  newText: "七玄门补充内容。"
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({
            content: requestIndex === 1 ? "第一窗口写入完成。" : "第二窗口修改完成。"
          })
        };
      }
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
      uploadedBookId = book.bookId;
      const factionTemplate = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: "势力设定模板",
        fileName: reportFileName,
        body: "记录当前窗口出现的门派、帮派、组织和关键成员。"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [factionTemplate.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reportMarkdown = await fs.readFile(
        path.join(
          tempRoot,
          "projects",
          "project-a",
          "assets",
          "books",
          book.bookId,
          "reports",
          reportFileName
        ),
        "utf8"
      );

      expect(requireJobDto(completedJob).failureReason).toBeUndefined();
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 2/2"
      });
      expect(mockServer.requests).toHaveLength(5);
      expect(grepReplayBody).toContain(`assets/books/${uploadedBookId}/reports/${reportFileName}`);
      expect(grepReplayBody).toContain("七玄门早期内容。");
      expect(reportMarkdown).toBe(`${updatedReportBody}\n`);
    } finally {
      await mockServer.close();
    }
  });

  it("returns a recoverable tool error when write_file omits existing content after reading that report", async () => {
    const firstReportBody = [
      "# 势力设定",
      "",
      "## 一、七玄门",
      "",
      "七玄门早期内容。"
    ].join("\n");
    const lossyRewriteBody = [
      "# 势力设定",
      "",
      "## 二、野狼帮",
      "",
      "野狼帮、贾天龙与金狼相关内容。"
    ].join("\n");
    let lossyRewriteReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-1-write", "write_file", {
                  path: "势力设定.md",
                  content: firstReportBody
                })
              ]
            })
          };
        }

        if (requestIndex === 2) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-read", "read_file", {
                  path: "势力设定.md"
                })
              ]
            })
          };
        }

        if (requestIndex === 3) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-lossy-rewrite", "write_file", {
                  path: "势力设定.md",
                  content: lossyRewriteBody
                })
              ]
            })
          };
        }

        if (requestIndex === 4) {
          lossyRewriteReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-edit", "edit_file", {
                  path: "势力设定.md",
                  oldText: firstReportBody,
                  newText: [firstReportBody, "", "## 二、野狼帮", "", "野狼帮、贾天龙与金狼相关内容。"].join("\n")
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({
            content: requestIndex === 1 ? "第一窗口写入完成。" : "第二窗口追加完成。"
          })
        };
      }
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
      const factionTemplate = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: "势力设定模板",
        fileName: "势力设定.md",
        body: "记录当前窗口出现的门派、帮派、组织和关键成员。"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [factionTemplate.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reportMarkdown = await fs.readFile(
        path.join(
          tempRoot,
          "projects",
          "project-a",
          "assets",
          "books",
          book.bookId,
          "reports",
          "势力设定.md"
        ),
        "utf8"
      );

      expect(mockServer.requests).toHaveLength(6);
      expect(lossyRewriteReplayBody).toContain("不能覆盖丢失既有内容");
      expect(lossyRewriteReplayBody).toContain("edit_file/multi_edit");
      expect(lossyRewriteReplayBody).toContain("包含完整旧内容");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 2/2"
      });
      expect(reportMarkdown).toContain("## 一、七玄门");
      expect(reportMarkdown).toContain("## 二、野狼帮");
    } finally {
      await mockServer.close();
    }
  });

  it.each([
    {
      toolName: "edit_file",
      toolArgs: {
        path: "丹药分析.md",
        oldText: "不存在的旧内容。",
        newText: "不会写入的新内容。"
      }
    },
    {
      toolName: "multi_edit",
      toolArgs: {
        path: "丹药分析.md",
        edits: [{ oldText: "不存在的旧内容。", newText: "不会写入的新内容。" }]
      }
    }
  ])(
    "lets a later window recover from $toolName replacement misses by editing the previously read report",
    async ({ toolName, toolArgs }) => {
      let uploadedBookId = "";
      const mockServer = await startMockOpenAiServer({
        respond: ({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              body: createChatCompletionResponse({
                toolCalls: [
                  createToolCall("call-window-1-write", "write_file", {
                    path: "丹药分析.md",
                    content: "# 丹药分析\n\n窗口一初稿：凝气丹。"
                  })
                ]
              })
            };
          }

          if (requestIndex === 2) {
            return {
              body: createChatCompletionResponse({
                toolCalls: [
                  createToolCall("call-window-2-read", "read_file", {
                    path: `assets/books/${uploadedBookId}/reports/丹药分析.md`
                  })
                ]
              })
            };
          }

          if (requestIndex === 3) {
            return {
              body: createChatCompletionResponse({
                toolCalls: [createToolCall("call-window-2-missing-edit", toolName, toolArgs)]
              })
            };
          }

          if (requestIndex === 4) {
            return {
              body: createChatCompletionResponse({
                toolCalls: [
                  createToolCall("call-window-2-rewrite", "edit_file", {
                    path: "丹药分析.md",
                    oldText: "# 丹药分析\n\n窗口一初稿：凝气丹。",
                    newText: "# 丹药分析\n\n窗口二修正后的完整报告。"
                  })
                ]
              })
            };
          }

          return {
            body: createChatCompletionResponse({
              content: requestIndex === 1 ? "第一窗口写入完成。" : "第二窗口重写完成。"
            })
          };
        }
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
        uploadedBookId = book.bookId;
        const job = await contract.invoke(handlers, "jobs:create", {
          bookId: book.bookId,
          templateIds: ["pill-analysis"],
          providerConfigId: "provider-1",
          modelId: "mock-model",
          singleRunChapterCount: 2,
          extractionChapterCount: 3,
          overlapChapterCount: 1,
          skipAlreadyExtracted: true
        });

        const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
        const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
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

        expect(mockServer.requests).toHaveLength(6);
        expect(JSON.stringify(mockServer.requests[4].body)).toContain("Replacement text was not found");
        expect(completedJob).toMatchObject({
          id: job.id,
          status: "completed",
          progressText: "窗口 2/2"
        });
        expect(completedJob?.failureReason).toBeUndefined();
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          fileName: "丹药分析.md",
          displayName: "丹药分析",
          reportKind: "template-output"
        });
        expect(reportMarkdown).toBe("# 丹药分析\n\n窗口二修正后的完整报告。\n");
      } finally {
        await mockServer.close();
      }
    }
  );

  it("continues when read_file uses the current window file name and then a missing selected report name", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-read-window-file-name", "read_file", {
                  path: "window-0001.txt"
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-read-missing-report", "read_file", {
                  path: "丹药分析.md"
                })
              ]
            })
          };
        }

        if (requestIndex === 2) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-missing-report", "write_file", {
                  path: "丹药分析.md",
                  content: "# 丹药分析\n\n读取窗口后创建报告。"
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "窗口完成。" })
        };
      }
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });

      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 1/1"
      });
      expect(reports).toHaveLength(1);

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

      expect(mockServer.requests).toHaveLength(4);
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("第一章 初入坊市");
      expect(JSON.stringify(mockServer.requests[2].body)).toContain("NOT_FOUND");
      expect(JSON.stringify(mockServer.requests[2].body)).toContain("Path does not exist");
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
      });
      expect(reportMarkdown).toContain("读取窗口后创建报告。");
    } finally {
      await mockServer.close();
    }
  });

  it("returns read_file absolute path errors to the model so it can retry with project-relative paths", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-read-absolute-path", "read_file", {
                  path: "C:\\outside\\report.md"
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-absolute-path-error", "write_file", {
                  path: "丹药分析.md",
                  content: "# 丹药分析\n\n模型收到绝对路径错误后改用选中报告。"
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "窗口完成。" })
        };
      }
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });

      expect(mockServer.requests).toHaveLength(3);
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("UNSAFE_PATH");
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("当前窗口文本");
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("选中报告文件名");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 1/1"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
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
      expect(reportMarkdown).toContain("模型收到绝对路径错误后改用选中报告。");
    } finally {
      await mockServer.close();
    }
  });

  it("returns a recoverable error when grep targets the run root without leaking tool-loop traces", async () => {
    const leakPattern = "TRACE_LEAK_MARKER";
    const leakPayload = "SHOULD_NOT_REACH_MODEL";
    const recoveredReport = "# 丹药分析\n\nrun 根目录 grep 被拒绝后改用选中报告。";
    let createdJobId = "";
    let grepReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: async ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          const traceLeakPath = path.join(
            tempRoot,
            "projects",
            "project-a",
            "runs",
            createdJobId,
            "tool-loop-traces",
            "window-0001",
            "seed.jsonl"
          );
          await fs.mkdir(path.dirname(traceLeakPath), { recursive: true });
          await fs.writeFile(traceLeakPath, `${leakPattern}: ${leakPayload}\n`, "utf8");

          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-grep-run-root", "grep", {
                  path: `runs/${createdJobId}`,
                  pattern: leakPattern
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          grepReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-run-root-rejected", "write_file", {
                  path: "丹药分析.md",
                  content: recoveredReport
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "窗口完成。" })
        };
      }
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });
      createdJobId = job.id;

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
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
      const tracePath = path.join(
        tempRoot,
        "projects",
        "project-a",
        "runs",
        job.id,
        "tool-loop-traces",
        "window-0001",
        "batch-0001.jsonl"
      );
      const traceText = await fs.readFile(tracePath, "utf8");
      const traceEntries = traceText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const grepResultTrace = traceEntries.find(
        (entry) =>
          entry.event === "tool_result" &&
          entry.toolName === "grep" &&
          entry.toolCallId === "call-grep-run-root"
      );

      expect(mockServer.requests).toHaveLength(3);
      expect(grepReplayBody).toContain("UNSAFE_PATH");
      expect(grepReplayBody).toContain("当前窗口文本");
      expect(grepReplayBody).toContain("reports");
      expect(grepReplayBody).not.toContain(leakPayload);
      expect(grepReplayBody).not.toContain("tool-loop-traces");
      expect(grepResultTrace).toMatchObject({
        recoverableError: {
          code: "UNSAFE_PATH",
          message: "read_file/grep 路径不在当前窗口允许范围内。"
        }
      });
      expect(traceText).not.toContain(leakPayload);
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 1/1"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reportMarkdown).toBe(`${recoveredReport}\n`);
    } finally {
      await mockServer.close();
    }
  });

  it("returns a recoverable error when read_file targets a future window file", async () => {
    const recoveredReport = "# 丹药分析\n\n未来窗口读取被拒绝后改用选中报告。";
    let createdJobId = "";
    let readReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-read-future-window", "read_file", {
                  path: `runs/${createdJobId}/windows/window-0002.txt`
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          readReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-future-window-rejected", "write_file", {
                  path: "丹药分析.md",
                  content: recoveredReport
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: requestIndex === 2 ? "窗口一完成。" : "NO_UPDATE" })
        };
      }
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });
      createdJobId = job.id;

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
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

      expect(mockServer.requests).toHaveLength(4);
      expect(readReplayBody).toContain("UNSAFE_PATH");
      expect(readReplayBody).toContain("当前窗口文本");
      expect(readReplayBody).not.toContain("第三章 试炼归来");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 2/2"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reportMarkdown).toBe(`${recoveredReport}\n`);
    } finally {
      await mockServer.close();
    }
  });

  it("returns read_file maxReadBytes errors and blocks write_file overwrites of oversized reports", async () => {
    const defaultMaxReadBytes = 1024 * 1024;
    const oversizedReport = [
      "# 丹药分析",
      "",
      "窗口前已有超大报告。",
      "0123456789abcdef\n".repeat(70_000)
    ].join("\n");
    const attemptedRewrite = "# 丹药分析\n\n读取预算不足后，窗口二尝试完整重写。";
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({ content: "NO_UPDATE" })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-read-oversized-report", "read_file", {
                  path: "丹药分析.md"
                })
              ]
            })
          };
        }

        if (requestIndex === 2) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-rewrite-after-read-budget", "write_file", {
                  path: "丹药分析.md",
                  content: attemptedRewrite
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "NO_UPDATE" })
        };
      }
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
      const reportPath = path.join(
        tempRoot,
        "projects",
        "project-a",
        "assets",
        "books",
        book.bookId,
        "reports",
        "丹药分析.md"
      );
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, oversizedReport, "utf8");
      expect((await fs.stat(reportPath)).size).toBeGreaterThan(defaultMaxReadBytes);
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 2/2"
      });
      expect(completedJob?.failureReason).toBeUndefined();

      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const reportMarkdown = await fs.readFile(reportPath, "utf8");

      expect((await fs.stat(reportPath)).size).toBeGreaterThan(defaultMaxReadBytes);
      expect(Buffer.byteLength(oversizedReport, "utf8")).toBeGreaterThan(defaultMaxReadBytes);
      expect(mockServer.requests).toHaveLength(4);
      expect(JSON.stringify(mockServer.requests[2].body)).toContain("File is larger than maxReadBytes");
      expect(JSON.stringify(mockServer.requests[2].body)).toContain("INVALID_ARGUMENTS");
      expect(JSON.stringify(mockServer.requests[3].body)).toContain("已有报告不能用 write_file 覆盖");
      expect(reports).toEqual([]);
      expect(reportMarkdown).toBe(oversizedReport);
    } finally {
      await mockServer.close();
    }
  });

  it("returns read_file directory errors to the model so it can choose a file and complete the window", async () => {
    let uploadedBookId = "";
    const recoveredReport = "# 丹药分析\n\n目录不能按文件读取后，模型改为写入报告。";
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-read-reports-directory", "read_file", {
                  path: `assets/books/${uploadedBookId}/reports`
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-directory-read-error", "write_file", {
                  path: "丹药分析.md",
                  content: recoveredReport
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "窗口完成。" })
        };
      }
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
      uploadedBookId = book.bookId;
      const reportsDir = path.join(
        tempRoot,
        "projects",
        "project-a",
        "assets",
        "books",
        book.bookId,
        "reports"
      );
      await fs.mkdir(reportsDir, { recursive: true });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });

      expect(mockServer.requests).toHaveLength(3);
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("read_file path must be a file");
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("INVALID_ARGUMENTS");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 1/1"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
      });
      const reportMarkdown = await fs.readFile(path.join(reportsDir, "丹药分析.md"), "utf8");
      expect(reportMarkdown).toBe(`${recoveredReport}\n`);
    } finally {
      await mockServer.close();
    }
  });

  it("executes double-encoded JSON object tool arguments without spending a recovery round", async () => {
    const recoveredReport = "# 丹药分析\n\n双层 JSON 参数被归一化为对象后直接写入。";
    const rawArguments = JSON.stringify(JSON.stringify({
      path: "丹药分析.md",
      content: recoveredReport
    }));
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [createRawToolCall("call-write-double-json", "write_file", rawArguments)]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "窗口完成。" })
        };
      }
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const requestBodies = mockServer.requests.map((request) => JSON.stringify(request.body));

      expect(mockServer.requests).toHaveLength(2);
      expect(requestBodies.join("\n")).not.toContain("Tool arguments must be an object");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 1/1"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
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
      expect(reportMarkdown).toBe(`${recoveredReport}\n`);
    } finally {
      await mockServer.close();
    }
  });

  it("returns non-object tool arguments errors to the model so it can retry with schema-valid objects", async () => {
    const recoveredReport = "# 丹药分析\n\n非对象参数被回放后，模型改用正确 JSON 对象写入。";
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createRawToolCall(
                  "call-write-string-arguments",
                  "write_file",
                  JSON.stringify("丹药分析.md")
                )
              ]
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-non-object-arguments", "write_file", {
                  path: "丹药分析.md",
                  content: recoveredReport
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "窗口完成。" })
        };
      }
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });

      expect(mockServer.requests).toHaveLength(3);
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("Tool arguments must be an object");
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("INVALID_ARGUMENTS");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 1/1"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
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
      expect(reportMarkdown).toBe(`${recoveredReport}\n`);
    } finally {
      await mockServer.close();
    }
  });

  it("returns string field schema errors to the model so it can retry with a valid path", async () => {
    const recoveredReport = "# 丹药分析\n\npath 类型错误被回放后，模型改用正确字符串路径写入。";
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-array-path", "write_file", {
                  path: ["丹药分析.md"],
                  content: recoveredReport
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-path-type-error", "write_file", {
                  path: "丹药分析.md",
                  content: recoveredReport
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "窗口完成。" })
        };
      }
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });

      expect(mockServer.requests).toHaveLength(3);
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("path must be a string");
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("INVALID_ARGUMENTS");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 1/1"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
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
      expect(reportMarkdown).toBe(`${recoveredReport}\n`);
    } finally {
      await mockServer.close();
    }
  });

  it("writes tool-loop diagnostic traces with summarized arguments and recoverable errors", async () => {
    const apiKey = "sk-trace-secret";
    const recoveredReport = [
      "# 丹药分析",
      "",
      `${apiKey} ` + "完整报告正文".repeat(80)
    ].join("\n");
    const mockServer = await startMockOpenAiServer({
      expectedApiKey: apiKey,
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              content: "准备写入。",
              toolCalls: [
                createToolCall("call-write-array-path-trace", "write_file", {
                  path: ["丹药分析.md"],
                  content: recoveredReport
                })
              ],
              totalTokens: 31
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-trace-error", "write_file", {
                  path: "丹药分析.md",
                  content: recoveredReport
                })
              ],
              totalTokens: 29
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "窗口完成。", totalTokens: 23 })
        };
      }
    });
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture(apiKey);
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      await contract.invoke(handlers, "jobs:start", { jobId: job.id });

      const tracePath = path.join(
        tempRoot,
        "projects",
        "project-a",
        "runs",
        job.id,
        "tool-loop-traces",
        "window-0001",
        "batch-0001.jsonl"
      );
      const traceText = await fs.readFile(tracePath, "utf8");
      const traceEntries = traceText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const firstToolTrace = traceEntries.find(
        (entry) =>
          entry.event === "tool_result" &&
          entry.toolName === "write_file" &&
          entry.toolCallId === "call-write-array-path-trace"
      );

      expect(firstToolTrace).toMatchObject({
        jobId: job.id,
        window: {
          index: 1,
          total: 1,
          fileName: "window-0001.txt",
          textPath: `runs/${job.id}/windows/window-0001.txt`
        },
        batch: {
          index: 1,
          total: 1,
          templates: [{ outputFileName: "丹药分析.md" }]
        },
        roundIndex: 1,
        toolName: "write_file",
        toolCallId: "call-write-array-path-trace",
        parameters: {
          type: "object",
          fields: {
            path: { type: "array", length: 1 },
            content: { type: "string", length: recoveredReport.length }
          }
        },
        recoverableError: {
          code: "INVALID_ARGUMENTS",
          message: "path must be a string"
        },
        usageDelta: {
          inputTokens: 11,
          outputTokens: 20,
          totalTokens: 31
        }
      });
      expect(traceEntries.some((entry) => entry.event === "round_completion")).toBe(true);
      expect(traceText).toContain("\"toolName\":\"write_file\"");
      expect(traceText).toContain("\"path\":{\"type\":\"array\"");
      expect(traceText).toContain("path must be a string");
      expect(traceText).not.toContain(apiKey);
      expect(traceText).not.toContain(recoveredReport);
      expect(traceText).not.toContain("完整报告正文".repeat(20));
    } finally {
      await mockServer.close();
    }
  });

  it("fails write_file when the report path is absolute", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex !== 0) {
          return {
            body: createChatCompletionResponse({ content: "不应请求最终完成。" })
          };
        }

        return {
          body: createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-absolute-write-path", "write_file", {
                path: "C:\\outside\\丹药分析.md",
                content: "# 丹药分析\n\n绝对路径不应写入。"
              })
            ]
          })
        };
      }
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const failedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const projectRoot = path.join(tempRoot, "projects", "project-a");

      expect(mockServer.requests).toHaveLength(1);
      expect(failedJob).toMatchObject({
        id: job.id,
        status: "failed",
        progressText: "窗口 0/1",
        allowedActions: ["delete"]
      });
      expect(failedJob?.failureReason).toContain("write_file");
      expect(reports).toEqual([]);
      expect(existsSync(path.join(projectRoot, "assets", "books", book.bookId, "reports", "丹药分析.md"))).toBe(
        false
      );
    } finally {
      await mockServer.close();
    }
  });

  it("fails a job on unsafe report paths and does not request later windows", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex !== 0) {
          return {
            body: createChatCompletionResponse({ content: "不应请求后续窗口。" })
          };
        }

        return {
          body: createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-escape", "write_file", {
                path: "../escape.md",
                content: "越界内容包含密钥 sk-p0-mock"
              })
            ]
          })
        };
      }
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const failedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });

      expect(mockServer.requests).toHaveLength(1);
      expect(failedJob).toMatchObject({
        id: job.id,
        status: "failed",
        progressText: "窗口 0/2",
        allowedActions: ["delete"]
      });
      expect(failedJob?.failureReason).toContain("窗口 1/2");
      expect(failedJob?.failureReason).not.toContain("sk-p0-mock");
      expect(reports).toEqual([]);
      expect(existsSync(path.join(projectRoot, "escape.md"))).toBe(false);
      expect(existsSync(path.join(projectRoot, "assets", "books", book.bookId, "escape.md"))).toBe(false);
    } finally {
      await mockServer.close();
    }
  });

  it("fails ordinary no-tool completions after max tool-loop rounds unless the model returns NO_UPDATE", async () => {
    const maxRounds = getDefaultConfig().toolLoopDefaults.maxRounds;
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => ({
        body: createChatCompletionResponse({
          content: requestIndex === 0 ? "普通最终说明。" : "仍未精确返回 NO_UPDATE。"
        })
      })
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const failedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const requestBodies = mockServer.requests.map((request) => JSON.stringify(request.body));

      expect(mockServer.requests).toHaveLength(maxRounds);
      expect(requestBodies[1]).toContain("上一轮没有调用任何工具，也没有成功写入报告");
      expect(requestBodies[1]).toContain("必须精确返回 NO_UPDATE");
      expect(failedJob).toMatchObject({
        id: job.id,
        status: "failed",
        progressText: "窗口 0/2",
        allowedActions: ["delete"]
      });
      expect(failedJob?.failureReason).toContain("NO_UPDATE");
      expect(failedJob?.failureReason).toContain("协议");
      expect(reports).toEqual([]);
    } finally {
      await mockServer.close();
    }
  });

  it("recovers an unwritten template sub-batch when the model corrects ordinary no-tool text to NO_UPDATE", async () => {
    const firstTemplateName = "甲模板纠正测试";
    const secondTemplateName = "乙模板纠正测试";
    const firstReportName = "甲模板纠正测试.md";
    const secondReportName = "乙模板纠正测试.md";
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-first-template-write", "write_file", {
                  path: firstReportName,
                  content: "# 甲模板纠正测试\n\n第一个模板子批次已写入。"
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({ content: "甲模板子批次写入完成。" })
          };
        }

        if (requestIndex === 2) {
          return {
            body: createChatCompletionResponse({ content: "这段普通说明不能直接当成成功。" })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "NO_UPDATE" })
        };
      }
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
      const firstTemplate = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: firstTemplateName,
        fileName: firstReportName,
        body: "只记录甲模板纠正测试。"
      });
      const secondTemplate = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: secondTemplateName,
        fileName: secondReportName,
        body: "只记录乙模板纠正测试。"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [firstTemplate.id, secondTemplate.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const requestBodies = mockServer.requests.map((request) => JSON.stringify(request.body));

      expect(mockServer.requests).toHaveLength(4);
      expect(requestBodies[2]).toContain(secondTemplateName);
      expect(requestBodies[2]).not.toContain(firstTemplateName);
      expect(requestBodies[3]).toContain("上一轮没有调用任何工具，也没有成功写入报告");
      expect(requestBodies[3]).toContain("必须精确返回 NO_UPDATE");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 1/1"
      });
      expect(requireJobDto(completedJob).failureReason).toBeUndefined();
      expect(reports.map((report) => report.fileName)).toEqual([firstReportName]);
    } finally {
      await mockServer.close();
    }
  });

  it("completes a window that reaches max tool-loop rounds after an initial successful write", async () => {
    const maxRounds = getDefaultConfig().toolLoopDefaults.maxRounds;
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => ({
        body: createChatCompletionResponse({
          toolCalls: [
            createToolCall(`call-rewrite-${requestIndex}`, "write_file", {
              path: "丹药分析.md",
              content: `# 丹药分析\n\n第 ${requestIndex + 1} 轮成功写入正式报告。`
            })
          ]
        })
      })
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
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

      expect(mockServer.requests).toHaveLength(maxRounds);
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 1/1"
      });
      expect(requireJobDto(completedJob).failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
      });
      expect(JSON.stringify(mockServer.requests[2].body)).toContain("已有报告不能用 write_file 覆盖");
      expect(reportMarkdown).toContain("第 1 轮成功写入正式报告。");
      expect(reportMarkdown).not.toContain(`第 ${maxRounds} 轮成功写入正式报告。`);
    } finally {
      await mockServer.close();
    }
  });

  it("runs template sub-batches independently when one batch reaches max tool-loop rounds after a write", async () => {
    const maxRounds = getDefaultConfig().toolLoopDefaults.maxRounds;
    const firstTemplateName = "甲模板分批测试";
    const secondTemplateName = "乙模板分批测试";
    const firstReportName = "甲模板分批测试.md";
    const secondReportName = "乙模板分批测试.md";
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex < maxRounds) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall(`call-first-template-${requestIndex}`, "write_file", {
                  path: firstReportName,
                  content: `# 甲模板分批测试\n\n第 ${requestIndex + 1} 轮写入甲模板。`
                })
              ]
            })
          };
        }

        if (requestIndex === maxRounds) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-second-template-write", "write_file", {
                  path: secondReportName,
                  content: "# 乙模板分批测试\n\n甲模板触顶后仍应写入乙模板。"
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "乙模板子批次写入完成。" })
        };
      }
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
      const firstTemplate = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: firstTemplateName,
        fileName: firstReportName,
        body: "只记录甲模板信息。"
      });
      const secondTemplate = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: secondTemplateName,
        fileName: secondReportName,
        body: "只记录乙模板信息。"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [firstTemplate.id, secondTemplate.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const requestBodies = mockServer.requests.map((request) => JSON.stringify(request.body));

      expect(mockServer.requests).toHaveLength(maxRounds + 2);
      expect(requestBodies[0]).toContain(firstTemplateName);
      expect(requestBodies[0]).not.toContain(secondTemplateName);
      expect(requestBodies[maxRounds]).toContain(secondTemplateName);
      expect(requestBodies[maxRounds]).not.toContain(firstTemplateName);
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 1/1"
      });
      expect(reports.map((report) => report.fileName).sort()).toEqual([firstReportName, secondReportName].sort());
      expect(await fs.readFile(
        path.join(tempRoot, "projects", "project-a", "assets", "books", book.bookId, "reports", firstReportName),
        "utf8"
      )).toContain("第 1 轮写入甲模板。");
      expect(await fs.readFile(
        path.join(tempRoot, "projects", "project-a", "assets", "books", book.bookId, "reports", secondReportName),
        "utf8"
      )).toContain("甲模板触顶后仍应写入乙模板。");
    } finally {
      await mockServer.close();
    }
  });

  it("uses configured tool-loop rounds to recover long-form replacement misses before final update", async () => {
    let uploadedBookId = "";
    const initialReport = "# 丹药分析\n\n窗口一初稿：凝气丹。";
    const recoveredReport = `${initialReport}\n\n窗口二长程因果补充。`;
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-1-write", "write_file", {
                  path: "丹药分析.md",
                  content: initialReport
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({ content: "第一窗口写入完成。" })
          };
        }

        if (requestIndex === 2) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-read-initial", "read_file", {
                  path: `assets/books/${uploadedBookId}/reports/丹药分析.md`
                })
              ]
            })
          };
        }

        if (requestIndex === 3) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-missing-multi-edit", "multi_edit", {
                  path: "丹药分析.md",
                  edits: [{ oldText: "不存在的长文片段。", newText: "不会写入的新内容。" }]
                })
              ]
            })
          };
        }

        if (requestIndex >= 4 && requestIndex <= 9) {
          const shouldRead = requestIndex % 2 === 0;
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                shouldRead
                  ? createToolCall(`call-window-2-read-${requestIndex}`, "read_file", {
                      path: "丹药分析.md"
                    })
                  : createToolCall(`call-window-2-grep-${requestIndex}`, "grep", {
                      path: "丹药分析.md",
                      pattern: "凝气丹"
                    })
              ]
            })
          };
        }

        if (requestIndex === 10) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-safe-rewrite", "write_file", {
                  path: "丹药分析.md",
                  content: recoveredReport
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "NO_UPDATE" })
        };
      }
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
      uploadedBookId = book.bookId;
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const requestBodies = mockServer.requests.map((request) => JSON.stringify(request.body));
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

      expect(mockServer.requests).toHaveLength(12);
      expect(requestBodies[4]).toContain("Replacement text was not found");
      expect(requestBodies[4]).toContain("oldText 必须精确匹配");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 2/2"
      });
      expect(requireJobDto(completedJob).failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reportMarkdown).toBe(`${recoveredReport}\n`);
    } finally {
      await mockServer.close();
    }
  });

  it("fails a window that reaches max tool-loop rounds without successful writes", async () => {
    const maxRounds = getDefaultConfig().toolLoopDefaults.maxRounds;
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => ({
        body: createChatCompletionResponse({
          toolCalls: [
            createToolCall(`call-read-missing-${requestIndex}`, "read_file", {
              path: "丹药分析.md"
            })
          ]
        })
      })
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const failedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });

      expect(mockServer.requests).toHaveLength(maxRounds);
      expect(failedJob).toMatchObject({
        id: job.id,
        status: "failed",
        progressText: "窗口 0/1",
        allowedActions: ["delete"]
      });
      expect(requireJobDto(failedJob).failureReason).toContain("tool loop 超过最大轮次");
      expect(reports).toEqual([]);
    } finally {
      await mockServer.close();
    }
  });

  it.each([
    {
      toolName: "edit_file",
      toolArgs: {
        path: "丹药分析.md",
        oldText: "旧内容。",
        newText: "新内容。"
      }
    },
    {
      toolName: "multi_edit",
      toolArgs: {
        path: "丹药分析.md",
        edits: [{ oldText: "旧内容。", newText: "新内容。" }]
      }
    }
  ])(
    "fails direct $toolName on an existing report until this window reads or greps that report",
    async ({ toolName, toolArgs }) => {
      const mockServer = await startMockOpenAiServer({
        respond: ({ requestIndex }) => {
          if (requestIndex === 0) {
            return {
              body: createChatCompletionResponse({
                toolCalls: [
                  createToolCall("call-window-1-write", "write_file", {
                    path: "丹药分析.md",
                    content: "# 丹药分析\n\n旧内容。"
                  })
                ]
              })
            };
          }

          if (requestIndex === 2) {
            return {
              body: createChatCompletionResponse({
                toolCalls: [createToolCall("call-window-2-edit", toolName, toolArgs)]
              })
            };
          }

          return {
            body: createChatCompletionResponse({
              content: requestIndex === 1 ? "第一窗口写入完成。" : "不应完成第二窗口。"
            })
          };
        }
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
        const job = await contract.invoke(handlers, "jobs:create", {
          bookId: book.bookId,
          templateIds: ["pill-analysis"],
          providerConfigId: "provider-1",
          modelId: "mock-model",
          singleRunChapterCount: 2,
          extractionChapterCount: 3,
          overlapChapterCount: 1,
          skipAlreadyExtracted: true
        });

        const failedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
        const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
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

        expect(mockServer.requests).toHaveLength(3);
        expect(failedJob).toMatchObject({
          id: job.id,
          status: "failed",
          progressText: "窗口 1/2",
          allowedActions: ["delete"]
        });
        expect(failedJob?.failureReason).toContain("read_file");
        expect(failedJob?.failureReason).toContain("grep");
        expect(reports).toHaveLength(1);
        expect(reportMarkdown).toContain("旧内容。");
        expect(reportMarkdown).not.toContain("新内容。");
      } finally {
        await mockServer.close();
      }
    }
  );

  it("fails write_file when the report path contains a known API key without leaking the key", async () => {
    const apiKey = "sk-secret-in-path";
    const mockServer = await startMockOpenAiServer({
      expectedApiKey: apiKey,
      respond: ({ requestIndex }) => {
        if (requestIndex !== 0) {
          return {
            body: createChatCompletionResponse({ content: "不应请求最终完成。" })
          };
        }

        return {
          body: createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-secret-path", "write_file", {
                path: `${apiKey}.md`,
                content: "# 泄露路径"
              })
            ]
          })
        };
      }
    });
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture(apiKey);
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const failedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const leakedReportPath = path.join(
        projectRoot,
        "assets",
        "books",
        book.bookId,
        "reports",
        `${apiKey}.md`
      );

      expect(mockServer.requests).toHaveLength(1);
      expect(failedJob).toMatchObject({
        id: job.id,
        status: "failed",
        allowedActions: ["delete"]
      });
      expect(existsSync(leakedReportPath)).toBe(false);
      expect(reports).toEqual([]);
      expect(JSON.stringify(failedJob)).not.toContain(apiKey);
      expect(JSON.stringify(reports)).not.toContain(apiKey);
    } finally {
      await mockServer.close();
    }
  });

  it("fails write_file to a template output that was not selected for the current job", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex !== 0) {
          return {
            body: createChatCompletionResponse({ content: "不应请求最终完成。" })
          };
        }

        return {
          body: createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-unselected-output", "write_file", {
                path: "材料分析.md",
                content: "# 材料分析\n\n未选模板不应写入。"
              })
            ]
          })
        };
      }
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
      await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: "材料分析模板",
        fileName: "材料分析.md",
        body: "记录材料，但本任务未选中。"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const failedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const projectRoot = path.join(tempRoot, "projects", "project-a");

      expect(mockServer.requests).toHaveLength(1);
      expect(failedJob).toMatchObject({
        id: job.id,
        status: "failed",
        allowedActions: ["delete"]
      });
      expect(failedJob?.failureReason).toContain("材料分析.md");
      expect(failedJob?.failureReason).toContain("选中模板");
      expect(reports).toEqual([]);
      expect(
        existsSync(path.join(projectRoot, "assets", "books", book.bookId, "reports", "材料分析.md"))
      ).toBe(false);
    } finally {
      await mockServer.close();
    }
  });

  it("runs twenty tool-loop windows for a forty-one chapter extraction", async () => {
    const expectedWindowCount = 20;
    const expectedRequestCount = 2 + (expectedWindowCount - 1) * 3;
    let windowNumber = 1;
    let windowPhase = 0;
    let expectedReportContent = "";
    const mockServer = await startMockOpenAiServer({
      respond: () => {
        if (windowNumber === 1 && windowPhase === 0) {
          expectedReportContent = "# 丹药分析\n\n窗口 1 写入正式报告。";
          windowPhase = 1;
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-1-write", "write_file", {
                  path: "丹药分析.md",
                  content: expectedReportContent
                })
              ]
            })
          };
        }

        if (windowNumber === 1) {
          windowPhase = 0;
          windowNumber += 1;
          return {
            body: createChatCompletionResponse({ content: "窗口 1 完成。" })
          };
        }

        if (windowPhase === 0) {
          windowPhase = 1;
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall(`call-window-${windowNumber}-read`, "read_file", {
                  path: "丹药分析.md"
                })
              ]
            })
          };
        }

        if (windowPhase === 1) {
          const previousReportContent = expectedReportContent;
          expectedReportContent = `${expectedReportContent}\n\n窗口 ${windowNumber} 写入正式报告。`;
          windowPhase = 2;
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall(`call-window-${windowNumber}-edit`, "edit_file", {
                  path: "丹药分析.md",
                  oldText: previousReportContent,
                  newText: expectedReportContent
                })
              ]
            })
          };
        }

        const completedWindow = windowNumber;
        windowPhase = 0;
        windowNumber += 1;
        return {
          body: createChatCompletionResponse({ content: `窗口 ${completedWindow} 完成。` })
        };
      }
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
    const novelPath = await writeTempNovel(tempRoot, "forty-one-chapters.txt", 41);

    try {
      const book = await contract.invoke(handlers, "books:uploadTxt", {
        projectId: "project-a",
        filePath: novelPath,
        displayName: "长篇切片测试.txt"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 3,
        extractionChapterCount: 41,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const reportsByFileName = [...reports].sort((left, right) =>
        left.fileName.localeCompare(right.fileName)
      );
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

      expect(mockServer.requests).toHaveLength(expectedRequestCount);
      for (const request of mockServer.requests) {
        expect(request.body).toHaveProperty("tools");
        expect(request.body).not.toHaveProperty("tool_choice");
      }
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 20/20",
        tokenText: `Token ${expectedRequestCount * 37} / 费用 0`
      });
      expect(reportsByFileName).toHaveLength(1);
      expect(reportsByFileName[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
      });
      expect(reportMarkdown).toContain("窗口 1 写入正式报告。");
      expect(reportMarkdown).toContain("窗口 20 写入正式报告。");
    } finally {
      await mockServer.close();
    }
  });

  it("stops later windows after a second-window failure while keeping completed template reports", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-first-window", "write_file", {
                  path: "丹药分析.md",
                  content: "# 丹药分析\n\n第一窗口报告内容，包含可预览信息。"
                })
              ],
              totalTokens: 19
            })
          };
        }

        if (requestIndex === 2) {
          return {
            status: 500,
            body: { error: "mock second window failure" }
          };
        }

        return {
          responseContent: "第一窗口完成。",
          totalTokens: 19
        };
      }
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
    const novelPath = await writeTempNovel(tempRoot, "four-chapters.txt", 4);

    try {
      const book = await contract.invoke(handlers, "books:uploadTxt", {
        projectId: "project-a",
        filePath: novelPath,
        displayName: "失败中止测试.txt"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 4,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const failedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });

      expect(mockServer.requests).toHaveLength(3);
      expect(failedJob).toMatchObject({
        id: job.id,
        status: "failed",
        progressText: "窗口 1/3",
        allowedActions: ["delete"]
      });
      expect(failedJob?.failureReason).toContain("窗口 2");
      expect(failedJob?.failureReason).toContain("HTTP 500");
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
      });
      const preview = await contract.invoke(handlers, "reports:preview", {
        reportId: reports[0].id
      });

      expect(preview.html).toContain("第一窗口报告内容");
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

  it("redacts raw API keys from model tool arguments before writing reports", async () => {
    const apiKey = "sk-probe-secret";
    let requestIndex = 0;
    const fetch = vi.fn(async () => {
      const responseBody =
        requestIndex === 0
          ? createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-redacted-write", "write_file", {
                  path: "丹药分析.md",
                  content: `# 丹药分析\n\n模型正文恶意回显 ${apiKey}`
                })
              ],
              totalTokens: 17
            })
          : createChatCompletionResponse({
              content: "窗口完成。",
              totalTokens: 17
            });
      requestIndex += 1;

      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
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
      extractionChapterCount: 2,
      overlapChapterCount: 1,
      skipAlreadyExtracted: true
    });

    const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
    if (!completedJob) {
      throw new Error("jobs:start returned no completed job dto");
    }
    const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });

    expect(completedJob.status).toBe("completed");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      fileName: "丹药分析.md",
      reportKind: "template-output"
    });

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

    expect(reportMarkdown).toContain("模型正文恶意回显");
    expect(reportMarkdown).not.toContain(apiKey);
    expect(preview.html).toContain("模型正文恶意回显");
    expect(preview.html).not.toContain(apiKey);
    expect(JSON.stringify(completedJob)).not.toContain(apiKey);
    expect(JSON.stringify(reports)).not.toContain(apiKey);
  });

  it("rejects jobs:create payloads missing required extraction boundary fields", async () => {
    const contract = createIpcContract();
    const handlers = createHandlers();
    const book = await contract.invoke(handlers, "books:uploadTxt", {
      projectId: "project-a",
      filePath: utf8FixturePath,
      displayName: "凡人修仙传.txt"
    });
    const validPayload: CreateJobDto = {
      bookId: book.bookId,
      templateIds: ["pill-analysis"],
      providerConfigId: "provider-1",
      modelId: "mock-model",
      singleRunChapterCount: 2,
      extractionChapterCount: 3,
      overlapChapterCount: 1,
      skipAlreadyExtracted: true
    };
    const { overlapChapterCount: _overlapChapterCount, ...missingOverlap } = validPayload;
    const { skipAlreadyExtracted: _skipAlreadyExtracted, ...missingSkip } = validPayload;

    await expect(
      contract.invoke(handlers, "jobs:create", missingOverlap as unknown as CreateJobDto)
    ).rejects.toThrow(/重叠章节数/);
    await expect(
      contract.invoke(handlers, "jobs:create", missingSkip as unknown as CreateJobDto)
    ).rejects.toThrow(/跳过已提取/);

    const job = await contract.invoke(handlers, "jobs:create", validPayload);
    expect(job.id).toBe("job-1");
  });

  it("rejects jobs:create payloads with illegal cross-field extraction parameters", async () => {
    const contract = createIpcContract();
    const handlers = createHandlers();
    const book = await contract.invoke(handlers, "books:uploadTxt", {
      projectId: "project-a",
      filePath: utf8FixturePath,
      displayName: "凡人修仙传.txt"
    });
    const validPayload: CreateJobDto = {
      bookId: book.bookId,
      templateIds: ["pill-analysis"],
      providerConfigId: "provider-1",
      modelId: "mock-model",
      singleRunChapterCount: 2,
      extractionChapterCount: 3,
      overlapChapterCount: 1,
      skipAlreadyExtracted: true
    };

    await expect(
      contract.invoke(handlers, "jobs:create", {
        ...validPayload,
        singleRunChapterCount: 5,
        extractionChapterCount: 3
      })
    ).rejects.toThrow(/提取章节数/);
    await expect(
      contract.invoke(handlers, "jobs:create", {
        ...validPayload,
        overlapChapterCount: 2
      })
    ).rejects.toThrow(/重叠章节数/);

    const job = await contract.invoke(handlers, "jobs:create", validPayload);
    expect(job.id).toBe("job-1");
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
      await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: "未选中模板",
        fileName: "unselected.md",
        body: "这段未选模板内容不应进入本次窗口 prompt。"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [template.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const rulesSnapshot = await fs.readFile(
        path.join(tempRoot, "projects", "project-a", "runs", job.id, "rules", "提取规则.md"),
        "utf8"
      );

      expect(mockServer.requests).toHaveLength(2);
      for (const request of mockServer.requests) {
        const requestBodyText = JSON.stringify(request.body);
        expect(requestBodyText).toContain("伏笔追踪模板");
        expect(requestBodyText).toContain("只记录当前项目专属伏笔，并输出证据章节。");
        expect(requestBodyText).not.toContain("丹药分析模板");
        expect(requestBodyText).not.toContain("未选中模板");
        expect(requestBodyText).not.toContain("这段未选模板内容不应进入本次窗口 prompt。");
      }
      expect(rulesSnapshot).toContain("伏笔追踪模板");
      expect(rulesSnapshot).toContain("foreshadow.md");
      expect(rulesSnapshot).not.toContain("丹药分析模板");
      expect(rulesSnapshot).not.toContain("未选中模板");
    } finally {
      await mockServer.close();
    }
  });

  it("tells the model template bodies are only structure references, not report content to copy", async () => {
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
        name: "人物关系模板",
        fileName: "人物关系.md",
        body: [
          "# 人物关系模板",
          "",
          "状态：模板",
          "",
          "## 前置声明",
          "",
          "参考范围：示例窗口。",
          "",
          "## 示例/占位案例",
          "",
          "- 张三：占位案例。"
        ].join("\n")
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [template.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      await contract.invoke(handlers, "jobs:start", { jobId: job.id });

      const firstRequestBody = mockServer.requests[0].body as {
        messages?: Array<{ content?: unknown; role?: string }>;
      };
      const prompt = firstRequestBody.messages?.find((message) => message.role === "user")?.content;
      expect(prompt).toEqual(expect.any(String));
      const promptText = prompt as string;

      expect(promptText).toContain("# 人物关系模板");
      expect(promptText).toContain("状态：模板");
      expect(promptText).toContain("模板正文只作为结构、字段和写作规则参考，不是正式报告正文。");
      expect(promptText).toContain(
        "正式报告不得复制模板标题、状态：模板、前置声明、参考范围、示例或占位案例。"
      );
      expect(promptText).toContain(
        "正式报告标题必须使用 outputFileName 去掉扩展名后的报告名，不要保留或添加“模板”。"
      );
    } finally {
      await mockServer.close();
    }
  });

  it("includes material resource and public report metadata rules in actual tool-loop prompts", async () => {
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
        name: "材料分析模板",
        fileName: "材料分析.md",
        body: "记录作品中的材料、资源与产出源。"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [template.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      await contract.invoke(handlers, "jobs:start", { jobId: job.id });

      const firstRequestBody = mockServer.requests[0].body as {
        messages?: Array<{ content?: unknown; role?: string }>;
      };
      const prompt = firstRequestBody.messages?.find((message) => message.role === "user")?.content;
      expect(prompt).toEqual(expect.any(String));
      const promptText = prompt as string;

      expect(promptText).toContain(
        "未命名但能由原文稳定描述的材料、药草、药汁、药物、灵液、资源产出源也应记录"
      );
      expect(promptText).toContain("不得仅因没有专名或呈现为成品形态就直接 NO_UPDATE");
      expect(promptText).toContain("正式报告的资料来源、参考范围等公开元数据只能写窗口编号、章节范围、章节名或原文范围");
      expect(promptText).toContain("不得写 runs/job、assets/books、本机绝对路径、AppData 项目路径等内部运行/项目路径");
    } finally {
      await mockServer.close();
    }
  });

  it("includes unsupported template example and common system term rules in actual tool-loop prompts", async () => {
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
        name: "事件因果链模板",
        fileName: "事件因果链（长程因果图）.md",
        body: [
          "# 事件因果链（长程因果图）模板",
          "",
          "> 状态：模板",
          "",
          "**资源流转链：** 示例可写灵石、灵草、矿产。",
          "**长期余波：** 示例事件链可写修仙界长期影响。"
        ].join("\n")
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [template.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      await contract.invoke(handlers, "jobs:start", { jobId: job.id });

      const firstRequestBody = mockServer.requests[0].body as {
        messages?: Array<{ content?: unknown; role?: string }>;
      };
      const prompt = firstRequestBody.messages?.find((message) => message.role === "user")?.content;
      expect(prompt).toEqual(expect.any(String));
      const promptText = prompt as string;

      expect(promptText).toContain("模板示例、字段说明、示例事件链和通用体系词只作为格式参考");
      expect(promptText).toContain("不得因为出现在模板中就写入正式报告");
      expect(promptText).toContain("长期余波、可参考点等分析字段不得用模板泛化话术推导未来影响");
    } finally {
      await mockServer.close();
    }
  });

  it("returns a recoverable error when report content contains internal run paths, then accepts public source metadata", async () => {
    const dirtyReport = [
      "# 丹药分析",
      "",
      "> 资料来源：`runs/job-1/windows/window-0001.txt`（第1-2章）",
      "",
      "窗口一内容。"
    ].join("\n");
    const recoveredReport = [
      "# 丹药分析",
      "",
      "> 资料来源：窗口 1，第1-2章",
      "",
      "窗口一内容。"
    ].join("\n");
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-internal-path-content", "write_file", {
                  path: "丹药分析.md",
                  content: dirtyReport
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-public-source-content", "write_file", {
                  path: "丹药分析.md",
                  content: recoveredReport
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "窗口完成。" })
        };
      }
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
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
      const replayAfterDirtyWrite = JSON.stringify(mockServer.requests[1].body);

      expect(mockServer.requests).toHaveLength(3);
      expect(replayAfterDirtyWrite).toContain("INVALID_ARGUMENTS");
      expect(replayAfterDirtyWrite).toContain("报告正文不得包含内部运行路径");
      expect(replayAfterDirtyWrite).toContain("窗口编号/章节范围");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "窗口 1/1"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
      });
      expect(reportMarkdown).toBe(`${recoveredReport}\n`);
      expect(reportMarkdown).not.toContain("runs/job");
      expect(reportMarkdown).not.toContain("assets/books");
    } finally {
      await mockServer.close();
    }
  });

  it("returns a recoverable error when report content contains internal window file identifiers", async () => {
    const dirtyReport = [
      "# 丹药分析",
      "",
      "> 资料来源：窗口 window-0001（第1-2章）",
      "",
      "窗口一内容。"
    ].join("\n");
    const recoveredReport = [
      "# 丹药分析",
      "",
      "> 资料来源：窗口 1（第1-2章）",
      "",
      "窗口一内容。"
    ].join("\n");
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-window-file-id", "write_file", {
                  path: "丹药分析.md",
                  content: dirtyReport
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-public-window-label", "write_file", {
                  path: "丹药分析.md",
                  content: recoveredReport
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "窗口完成。" })
        };
      }
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
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
      const replayAfterDirtyWrite = JSON.stringify(mockServer.requests[1].body);

      expect(mockServer.requests).toHaveLength(3);
      expect(replayAfterDirtyWrite).toContain("INVALID_ARGUMENTS");
      expect(replayAfterDirtyWrite).toContain("报告正文不得包含运行窗口文件名或内部窗口标识");
      expect(replayAfterDirtyWrite).toContain("窗口 1（第1-2章）");
      expect(completedJob?.status).toBe("completed");
      expect(reportMarkdown).toBe(`${recoveredReport}\n`);
      expect(reportMarkdown).not.toContain("window-0001");
    } finally {
      await mockServer.close();
    }
  });

  it("returns a recoverable error when report content keeps draft or template status", async () => {
    const dirtyReport = [
      "# 事件因果链（长程因果图）",
      "",
      "> 状态：草案",
      "",
      "窗口一内容。"
    ].join("\n");
    const recoveredReport = [
      "# 事件因果链（长程因果图）",
      "",
      "> 状态：原文已复核",
      "",
      "窗口一内容。"
    ].join("\n");
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-draft-status", "write_file", {
                  path: "事件因果链（长程因果图）.md",
                  content: dirtyReport
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-reviewed-status", "write_file", {
                  path: "事件因果链（长程因果图）.md",
                  content: recoveredReport
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "窗口完成。" })
        };
      }
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
      const template = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: "事件因果链模板",
        fileName: "事件因果链（长程因果图）.md",
        body: "记录当前窗口原文明确支持的因果链。"
      });
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [template.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reportMarkdown = await fs.readFile(
        path.join(
          tempRoot,
          "projects",
          "project-a",
          "assets",
          "books",
          book.bookId,
          "reports",
          "事件因果链（长程因果图）.md"
        ),
        "utf8"
      );
      const replayAfterDirtyWrite = JSON.stringify(mockServer.requests[1].body);

      expect(mockServer.requests).toHaveLength(3);
      expect(replayAfterDirtyWrite).toContain("INVALID_ARGUMENTS");
      expect(replayAfterDirtyWrite).toContain("报告正文不得包含模板或草案状态");
      expect(completedJob?.status).toBe("completed");
      expect(reportMarkdown).toBe(`${recoveredReport}\n`);
      expect(reportMarkdown).not.toContain("状态：草案");
      expect(reportMarkdown).not.toContain("状态：模板");
    } finally {
      await mockServer.close();
    }
  });

  it("reuses the active run when the same job is started concurrently", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {};
      }
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const firstStart = contract.invoke(handlers, "jobs:start", { jobId: job.id });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const secondStart = contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const startResults = await Promise.all([firstStart, secondStart]);
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const reportFiles = reports.map((report) => report.fileName).sort();
      const completedStartResults = startResults.map((result) => {
        if (!result) {
          throw new Error("jobs:start returned no job dto");
        }
        return result;
      });

      expect(completedStartResults.map((result) => result.status)).toEqual(["completed", "completed"]);
      expect(mockServer.requests).toHaveLength(2);
      expect(reportFiles).toEqual([]);
    } finally {
      await mockServer.close();
    }
  });

  it("reuses an existing rules snapshot when the same job is started again", async () => {
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
      const job = await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      });

      const firstCompletedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const secondCompletedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      if (!firstCompletedJob || !secondCompletedJob) {
        throw new Error("jobs:start returned no completed job dto");
      }

      expect(firstCompletedJob.status).toBe("completed");
      expect(secondCompletedJob.status).toBe("completed");
      expect(mockServer.requests).toHaveLength(4);
    } finally {
      await mockServer.close();
    }
  });

  it("restores latest rules from the job snapshot when an older job is started again", async () => {
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
      const templateA = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: "Job A 规则模板",
        fileName: "job-a.md",
        body: "只输出 job A 规则快照。"
      });
      const templateB = await contract.invoke(handlers, "templates:save", {
        projectId: "project-a",
        scope: "project",
        name: "Job B 规则模板",
        fileName: "job-b.md",
        body: "只输出 job B 规则快照。"
      });
      const createJobInput = {
        bookId: book.bookId,
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      };
      const jobA = await contract.invoke(handlers, "jobs:create", {
        ...createJobInput,
        templateIds: [templateA.id]
      });
      const jobB = await contract.invoke(handlers, "jobs:create", {
        ...createJobInput,
        templateIds: [templateB.id]
      });
      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const latestRulesPath = path.join(projectRoot, "rules", "提取规则.md");
      const jobASnapshotPath = path.join(projectRoot, "runs", jobA.id, "rules", "提取规则.md");
      const jobBSnapshotPath = path.join(projectRoot, "runs", jobB.id, "rules", "提取规则.md");

      await contract.invoke(handlers, "jobs:start", { jobId: jobA.id });
      const jobASnapshot = await fs.readFile(jobASnapshotPath, "utf8");

      await contract.invoke(handlers, "jobs:start", { jobId: jobB.id });
      const latestAfterJobB = await fs.readFile(latestRulesPath, "utf8");
      const jobBSnapshot = await fs.readFile(jobBSnapshotPath, "utf8");

      expect(latestAfterJobB).toBe(jobBSnapshot);
      expect(latestAfterJobB).toContain(`> 任务：${jobB.id}`);

      await contract.invoke(handlers, "jobs:start", { jobId: jobA.id });
      const latestAfterRestartingJobA = await fs.readFile(latestRulesPath, "utf8");

      expect(latestAfterRestartingJobA).toContain(`> 任务：${jobA.id}`);
      expect(latestAfterRestartingJobA).not.toContain(`> 任务：${jobB.id}`);
      expect(latestAfterRestartingJobA).toBe(jobASnapshot);
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
      extractionChapterCount: 3,
      overlapChapterCount: 1,
      skipAlreadyExtracted: true
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
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
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

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "@novel-extractor/config";
import type { ApiKeyRef, ProviderConfig } from "@novel-extractor/domain";
import type { JobRuntimeState } from "@novel-extractor/jobs";
import { reasonixToolOrder } from "@novel-extractor/tools";
import type { CreateJobDto, JobDto } from "../shared/ipcTypes";
import { createMemoryCredentialStore, type MemoryCredentialStore } from "./credentials";
import { createIpcContract, createNotImplementedIpcHandlers } from "./ipc";
import * as p0HandlersModule from "./p0Handlers";
import { createP0IpcHandlers } from "./p0Handlers";
import type { ProjectRuntimeJobRecord } from "./projectRuntimeStore";

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

function createPowerShellCommand(script: string): string {
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${encodedScript}`;
}

function createChatCompletionResponse(input: {
  content?: string;
  toolCalls?: Array<Record<string, unknown>>;
  totalTokens?: number;
  usage?: Record<string, unknown>;
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
    usage: input.usage ?? {
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
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

  it("freezes the remaining time estimate when a runtime state pauses", () => {
    const buildPatch = (p0HandlersModule as {
      toJobPatchFromRuntimeState?: (
        state: JobRuntimeState,
        previousJob: ProjectRuntimeJobRecord,
        clock: { now(): string }
      ) => Partial<ProjectRuntimeJobRecord>;
    }).toJobPatchFromRuntimeState;
    if (!buildPatch) {
      throw new Error("toJobPatchFromRuntimeState helper is not exported");
    }
    const previousJob = {
      id: "job-1",
      bookId: "book-1",
      status: "running",
      progressText: "进度：1/4",
      tokenText: "Token 100 / 缓存命中率 75.00%",
      createdAt: "2026-07-02T10:00:00.000Z",
      updatedAt: "2026-07-02T10:02:00.000Z",
      input: {
        bookId: "book-1",
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 3,
        extractionChapterCount: 9,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      },
      timing: {
        startedAt: "2026-07-02T10:00:00.000Z",
        estimatedRemainingMs: 420000
      }
    } as ProjectRuntimeJobRecord;
    const runtimeState: JobRuntimeState = {
      jobId: "job-1",
      status: "paused",
      completedWindowCount: 2,
      totalWindowCount: 4,
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        cacheHitTokens: 60,
        cacheMissTokens: 20
      },
      fee: null
    };

    const patch = buildPatch(runtimeState, previousJob, {
      now: () => "2026-07-02T10:05:00.000Z"
    });

    expect(patch).toMatchObject({
      status: "paused",
      progress: {
        completedWindowCount: 2,
        totalWindowCount: 4
      },
      timing: {
        startedAt: "2026-07-02T10:00:00.000Z",
        estimatedRemainingMs: 420000,
        estimateFrozenAt: "2026-07-02T10:05:00.000Z"
      }
    });
  });

  it("resets the remaining time estimate when a runtime state completes all windows", () => {
    const buildPatch = (p0HandlersModule as {
      toJobPatchFromRuntimeState?: (
        state: JobRuntimeState,
        previousJob: ProjectRuntimeJobRecord,
        clock: { now(): string }
      ) => Partial<ProjectRuntimeJobRecord>;
    }).toJobPatchFromRuntimeState;
    if (!buildPatch) {
      throw new Error("toJobPatchFromRuntimeState helper is not exported");
    }
    const previousJob = {
      id: "job-1",
      bookId: "book-1",
      status: "running",
      progressText: "进度：5/6",
      tokenText: "Token 100 / 缓存命中率 75.00%",
      createdAt: "2026-07-02T01:00:00.000Z",
      updatedAt: "2026-07-02T01:06:00.000Z",
      input: {
        bookId: "book-1",
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 3,
        extractionChapterCount: 18,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      },
      timing: {
        startedAt: "2026-07-02T01:00:00.000Z",
        estimatedRemainingMs: 420000
      }
    } as ProjectRuntimeJobRecord;
    const runtimeState: JobRuntimeState = {
      jobId: "job-1",
      status: "completed",
      completedWindowCount: 6,
      totalWindowCount: 6,
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        cacheHitTokens: 60,
        cacheMissTokens: 20
      },
      fee: null
    };

    const patch = buildPatch(runtimeState, previousJob, {
      now: () => "2026-07-02T01:07:00.000Z"
    });

    expect(patch).toMatchObject({
      status: "completed",
      progress: {
        completedWindowCount: 6,
        totalWindowCount: 6
      },
      timing: {
        startedAt: "2026-07-02T01:00:00.000Z",
        completedAt: "2026-07-02T01:07:00.000Z",
        estimatedRemainingMs: 0
      }
    });
  });

  it("clears stale remaining time estimates while running before any window completes", () => {
    const buildPatch = (p0HandlersModule as {
      toJobPatchFromRuntimeState?: (
        state: JobRuntimeState,
        previousJob: ProjectRuntimeJobRecord,
        clock: { now(): string }
      ) => Partial<ProjectRuntimeJobRecord>;
    }).toJobPatchFromRuntimeState;
    if (!buildPatch) {
      throw new Error("toJobPatchFromRuntimeState helper is not exported");
    }
    const previousJob = {
      id: "job-1",
      bookId: "book-1",
      status: "running",
      progressText: "进度：0/6",
      tokenText: "Token 0 / 缓存命中率 0.00%",
      createdAt: "2026-07-02T10:00:00.000Z",
      updatedAt: "2026-07-02T10:02:00.000Z",
      input: {
        bookId: "book-1",
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 3,
        extractionChapterCount: 18,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      },
      timing: {
        startedAt: "2026-07-02T10:00:00.000Z",
        estimatedRemainingMs: 420000,
        estimateFrozenAt: "2026-07-02T10:01:00.000Z"
      }
    } as ProjectRuntimeJobRecord;
    const runtimeState: JobRuntimeState = {
      jobId: "job-1",
      status: "running",
      completedWindowCount: 0,
      totalWindowCount: 6,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0
      },
      fee: null
    };

    const patch = buildPatch(runtimeState, previousJob, {
      now: () => "2026-07-02T10:05:00.000Z"
    });

    expect(patch.timing).toMatchObject({
      startedAt: "2026-07-02T10:00:00.000Z"
    });
    expect(patch.timing?.estimatedRemainingMs).toBeUndefined();
    expect(patch.timing?.estimateFrozenAt).toBeUndefined();
  });

  it("rejects jobs whose selected templates share the same output file name", async () => {
    const contract = createIpcContract();
    const handlers = createHandlers();
    const book = await contract.invoke(handlers, "books:uploadTxt", {
      projectId: "project-a",
      filePath: utf8FixturePath,
      displayName: "凡人修仙传.txt"
    });
    const firstTemplate = await contract.invoke(handlers, "templates:save", {
      projectId: "project-a",
      scope: "project",
      name: "甲模板",
      fileName: "重复.md",
      body: "记录甲模板内容。"
    });
    const secondTemplate = await contract.invoke(handlers, "templates:save", {
      projectId: "project-a",
      scope: "project",
      name: "乙模板",
      fileName: "重复.md",
      body: "记录乙模板内容。"
    });

    await expect(
      contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: [firstTemplate.id, secondTemplate.id],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      })
    ).rejects.toThrow(/重复\.md.*甲模板.*乙模板/u);
  });

  it("uses compressed template prompt profiles while keeping full template bodies in rule snapshots", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: () => ({
        body: createChatCompletionResponse({
          content: "NO_UPDATE"
        })
      })
    });
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture("sk-profile-mock");
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
        name: "压缩验证模板",
        fileName: "压缩验证.md",
        body: [
          "# 压缩验证模板",
          "状态：模板",
          "",
          "## 字段",
          "- 条目名称",
          "- 当前窗口证据",
          "- 首次出现章节",
          "- 与人物、势力、地点的关系",
          "- 已确认事实和原文未说明事项",
          "",
          "## 禁止事项",
          "- 禁止使用后续章节或全书先验。",
          "- 没有当前窗口证据时不得把模板示例或常识体系词写入正式报告。",
          "- 公开元数据只能写窗口编号、章节范围和章节名。",
          "",
          "## 示例",
          "示例事件链：韩立未来结丹成功。",
          "",
          "## 参考范围",
          "参考范围：全书后续情节。",
          "",
          "待补充：{{条目名称}}"
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

      const firstRequest = mockServer.requests[0].body as { messages?: Array<{ content?: string; role?: string }> };
      const userPrompt = firstRequest.messages?.find((message) => message.role === "user")?.content ?? "";
      const profileSection =
        userPrompt.split("## 选中模板 Prompt Profile\n")[1]?.split("\n\n## 当前窗口文本")[0] ?? "";
      expect(profileSection).toContain("templateId:");
      expect(profileSection).toContain("outputFileName: 压缩验证.md");
      expect(profileSection).toContain("templateHash:");
      expect(profileSection).toContain("条目名称");
      expect(profileSection).toContain("禁止使用后续章节");
      expect(profileSection).not.toContain("状态：模板");
      expect(profileSection).not.toContain("示例事件链：韩立未来结丹成功");
      expect(profileSection).not.toContain("参考范围：全书后续情节");
      expect(profileSection).not.toContain("{{条目名称}}");

      const rulesSnapshot = await fs.readFile(
        path.join(tempRoot, "projects", "project-a", "runs", job.id, "rules", "提取规则.md"),
        "utf8"
      );
      expect(rulesSnapshot).toContain("状态：模板");
      expect(rulesSnapshot).toContain("示例事件链：韩立未来结丹成功");
      expect(rulesSnapshot).toContain("参考范围：全书后续情节");
      expect(rulesSnapshot).toContain("{{条目名称}}");
    } finally {
      await mockServer.close();
    }
  });

  it("skips model calls for covered templates when skipAlreadyExtracted is enabled", async () => {
    const mockServer = await startMockOpenAiServer({
      expectedApiKey: "sk-coverage-mock",
      respond: () => ({
        body: createChatCompletionResponse({
          content: "NO_UPDATE"
        })
      })
    });
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture("sk-coverage-mock");
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
      const createJobInput = {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 2,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      };

      const firstJob = await contract.invoke(handlers, "jobs:create", createJobInput);
      await contract.invoke(handlers, "jobs:start", { jobId: firstJob.id });
      expect(mockServer.requests).toHaveLength(1);

      const secondJob = await contract.invoke(handlers, "jobs:create", createJobInput);
      const completedSecondJob = await contract.invoke(handlers, "jobs:start", { jobId: secondJob.id });
      expect(completedSecondJob).toMatchObject({
        status: "completed",
        progressText: "进度：1/1"
      });
      expect(mockServer.requests).toHaveLength(1);

      const secondJobLog = await contract.invoke(handlers, "jobs:readLog", {
        jobId: secondJob.id
      });
      expect(secondJobLog.content).toContain("检查覆盖索引");
      expect(secondJobLog.content).toContain("待处理模板 0 个");
    } finally {
      await mockServer.close();
    }
  });

  it("loads persisted project runtime after handlers are recreated", async () => {
    const contract = createIpcContract();
    const handlers = createHandlers();
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

    const restartedHandlers = createHandlers();
    const runtime = await contract.invoke(restartedHandlers, "projectRuntime:get", {
      projectId: "project-a"
    });

    expect(runtime.books).toEqual([
      expect.objectContaining({
        bookId: book.bookId,
        displayName: "凡人修仙传.txt",
        fileName: path.basename(utf8FixturePath),
        chapterCount: book.chapterCount
      })
    ]);
    expect(runtime.jobs).toEqual([
      expect.objectContaining({
        id: job.id,
        bookId: book.bookId,
        status: "created",
        progressText: "进度：0/1"
      })
    ]);
  });

  it("loads persisted jobs when their selected project template was deleted later", async () => {
    const contract = createIpcContract();
    const handlers = createHandlers();
    const book = await contract.invoke(handlers, "books:uploadTxt", {
      projectId: "project-a",
      filePath: utf8FixturePath,
      displayName: "凡人修仙传.txt"
    });
    const template = await contract.invoke(handlers, "templates:save", {
      projectId: "project-a",
      scope: "project",
      name: "临时项目模板",
      fileName: "temporary-project-template.md",
      body: "# 临时项目模板\n只用于旧任务兼容性测试。"
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

    await contract.invoke(handlers, "templates:delete", {
      templateId: template.id
    });

    const restartedHandlers = createHandlers();
    const runtime = await contract.invoke(restartedHandlers, "projectRuntime:get", {
      projectId: "project-a"
    });

    expect(runtime.jobs).toEqual([
      expect.objectContaining({
        id: job.id,
        inputSummary: {
          bookDisplayName: "凡人修仙传.txt",
          modelId: "mock-model",
          templateNames: []
        }
      })
    ]);
  });

  it("recovers running persisted jobs as paused and can resume them", async () => {
    const mockServer = await startMockOpenAiServer({
      expectedApiKey: "sk-resume-persisted",
      respond: () => ({
        body: createChatCompletionResponse({
          content: "NO_UPDATE"
        })
      })
    });
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture("sk-resume-persisted");
    const providerStore = createProviderStore(
      createProviderConfig({
        apiKeyRef,
        baseUrl: mockServer.baseUrl
      })
    );
    const handlers = createHandlers({ credentialStore, providerStore });

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
      const runtimePath = path.join(tempRoot, "projects", "project-a", "state", "project-runtime.json");
      const rawRuntime = JSON.parse(await fs.readFile(runtimePath, "utf8")) as { jobs: Array<{ id: string; status: string }> };
      rawRuntime.jobs = rawRuntime.jobs.map((storedJob) =>
        storedJob.id === job.id ? { ...storedJob, status: "running" } : storedJob
      );
      await fs.writeFile(runtimePath, `${JSON.stringify(rawRuntime, null, 2)}\n`, "utf8");

      const restartedHandlers = createHandlers({ credentialStore, providerStore });
      const runtime = await contract.invoke(restartedHandlers, "projectRuntime:get", {
        projectId: "project-a"
      });
      expect(runtime.jobs).toEqual([
        expect.objectContaining({
          id: job.id,
          status: "paused",
          allowedActions: ["resume", "restart", "delete"]
        })
      ]);

      const resumedJob = await contract.invoke(restartedHandlers, "jobs:resume", { jobId: job.id });
      expect(resumedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
      });
      expect(mockServer.requests).toHaveLength(1);
    } finally {
      await mockServer.close();
    }
  });

  it("reports unknown estimate state for failed jobs with stale remaining estimates", async () => {
    const contract = createIpcContract();
    const handlers = createHandlers();
    const book = await contract.invoke(handlers, "books:uploadTxt", {
      projectId: "project-a",
      filePath: utf8FixturePath,
      displayName: "凡人修仙传.txt"
    });
    const job = requireJobDto(
      await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 2,
        extractionChapterCount: 3,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      })
    );
    const runtimePath = path.join(tempRoot, "projects", "project-a", "state", "project-runtime.json");
    const rawRuntime = JSON.parse(await fs.readFile(runtimePath, "utf8")) as {
      jobs: ProjectRuntimeJobRecord[];
    };
    rawRuntime.jobs = rawRuntime.jobs.map((storedJob) =>
      storedJob.id === job.id
        ? {
            ...storedJob,
            status: "failed",
            progressText: "进度：1/2",
            failureReason: "mock failure",
            progress: {
              completedWindowCount: 1,
              totalWindowCount: 2
            },
            timing: {
              startedAt: "2026-07-02T10:00:00.000Z",
              completedAt: "2026-07-02T10:03:00.000Z",
              estimatedRemainingMs: 420000
            }
          }
        : storedJob
    );
    await fs.writeFile(runtimePath, `${JSON.stringify(rawRuntime, null, 2)}\n`, "utf8");

    const restartedHandlers = createHandlers();
    const runtime = await contract.invoke(restartedHandlers, "projectRuntime:get", {
      projectId: "project-a"
    });
    const failedJob = runtime.jobs.find((runtimeJob) => runtimeJob.id === job.id);

    expect(failedJob?.timing).toMatchObject({
      startedAt: "2026-07-02T10:00:00.000Z",
      completedAt: "2026-07-02T10:03:00.000Z",
      estimatedRemainingMs: 420000,
      estimateState: "unknown"
    });
    expect(failedJob?.timing?.estimateState).not.toBe("available");
  });

  it("resets stale remaining time estimates for persisted completed jobs that finished all windows", async () => {
    const contract = createIpcContract();
    const handlers = createHandlers();
    const novelPath = await writeTempNovel(tempRoot, "六章完成小说.txt", 6);

    const book = await contract.invoke(handlers, "books:uploadTxt", {
      projectId: "project-a",
      filePath: novelPath,
      displayName: "六章完成小说.txt"
    });
    const job = requireJobDto(
      await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 1,
        extractionChapterCount: 6,
        overlapChapterCount: 0,
        skipAlreadyExtracted: true
      })
    );
    const runtimePath = path.join(tempRoot, "projects", "project-a", "state", "project-runtime.json");
    const rawRuntime = JSON.parse(await fs.readFile(runtimePath, "utf8")) as {
      jobs: ProjectRuntimeJobRecord[];
    };
    rawRuntime.jobs = rawRuntime.jobs.map((storedJob) =>
      storedJob.id === job.id
        ? {
            ...storedJob,
            status: "completed",
            progressText: "进度：6/6",
            progress: {
              completedWindowCount: 6,
              totalWindowCount: 6
            },
            timing: {
              startedAt: "2026-07-02T10:00:00.000Z",
              completedAt: "2026-07-02T10:06:00.000Z",
              estimatedRemainingMs: 420000
            }
          }
        : storedJob
    );
    await fs.writeFile(runtimePath, `${JSON.stringify(rawRuntime, null, 2)}\n`, "utf8");

    const restartedHandlers = createHandlers();
    const runtime = await contract.invoke(restartedHandlers, "projectRuntime:get", {
      projectId: "project-a"
    });
    const completedJob = runtime.jobs.find((runtimeJob) => runtimeJob.id === job.id);

    expect(completedJob?.timing).toMatchObject({
      startedAt: "2026-07-02T10:00:00.000Z",
      completedAt: "2026-07-02T10:06:00.000Z",
      estimatedRemainingMs: 0,
      estimateState: "available"
    });
  });

  it("restarts paused jobs without skipping already extracted coverage", async () => {
    const mockServer = await startMockOpenAiServer({
      expectedApiKey: "sk-restart-persisted",
      respond: () => ({
        body: createChatCompletionResponse({
          content: "NO_UPDATE"
        })
      })
    });
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture("sk-restart-persisted");
    const providerStore = createProviderStore(
      createProviderConfig({
        apiKeyRef,
        baseUrl: mockServer.baseUrl
      })
    );
    const handlers = createHandlers({ credentialStore, providerStore });

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
      expect(mockServer.requests).toHaveLength(1);

      const runtimePath = path.join(tempRoot, "projects", "project-a", "state", "project-runtime.json");
      const rawRuntime = JSON.parse(await fs.readFile(runtimePath, "utf8")) as { jobs: Array<{ id: string; status: string }> };
      rawRuntime.jobs = rawRuntime.jobs.map((storedJob) =>
        storedJob.id === job.id ? { ...storedJob, status: "paused" } : storedJob
      );
      await fs.writeFile(runtimePath, `${JSON.stringify(rawRuntime, null, 2)}\n`, "utf8");

      const restartedHandlers = createHandlers({ credentialStore, providerStore });
      await contract.invoke(restartedHandlers, "projectRuntime:get", { projectId: "project-a" });
      const restartedJob = await contract.invoke(restartedHandlers, "jobs:restart", { jobId: job.id });

      expect(restartedJob).toMatchObject({
        id: job.id,
        status: "completed"
      });
      expect(mockServer.requests).toHaveLength(2);
    } finally {
      await mockServer.close();
    }
  });

  it("uploads UTF-8 books, writes template reports through tool loop, and previews sanitized markdown reports", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: ({ body }) => {
        const requestBodyText = JSON.stringify(body);
        const isFirstWindow = requestBodyText.includes("窗口序号：1/2");
        const hasToolReplay = requestBodyText.includes("\"role\":\"tool\"");

        if (
          isFirstWindow &&
          !hasToolReplay &&
          requestBodyText.includes("丹药分析模板") &&
          requestBodyText.includes("材料分析模板")
        ) {
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
                }),
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
        skipAlreadyExtracted: false
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

      expect(mockServer.requests).toHaveLength(3);
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
      const secondMessages = secondRequestBody.messages ?? [];
      const assistantToolCallMessage = secondMessages.find(
        (message) => message.role === "assistant" && Array.isArray(message.tool_calls)
      );
      const secondToolMessages = secondMessages.filter((message) => message.role === "tool");

      const firstRequestJson = JSON.stringify(firstRequestBody);
      const firstWindowTextPath = `runs/${jobWithTwoTemplates.id}/windows/window-0001.txt`;
      const firstRequestTools = (firstRequestBody.tools ?? []) as Array<{
        function?: { name?: string; parameters?: { properties?: Record<string, unknown> } };
      }>;
      const firstRequestToolNames = firstRequestTools.map((tool) => tool.function?.name);
      const editFileSchema = firstRequestTools.find((tool) => tool.function?.name === "edit_file")?.function?.parameters;
      const multiEditSchema = firstRequestTools.find((tool) => tool.function?.name === "multi_edit")?.function?.parameters;
      const bashOutputSchema = firstRequestTools.find((tool) => tool.function?.name === "bash_output")?.function?.parameters;

      expect(firstRequestToolNames).toEqual([...reasonixToolOrder, "mark_no_update"]);
      expect(editFileSchema?.properties).toHaveProperty("old_string");
      expect(editFileSchema?.properties).toHaveProperty("new_string");
      expect(editFileSchema?.properties).not.toHaveProperty("oldText");
      expect(editFileSchema?.properties).not.toHaveProperty("newText");
      expect(JSON.stringify(multiEditSchema)).toContain("old_string");
      expect(JSON.stringify(multiEditSchema)).toContain("new_string");
      expect(JSON.stringify(bashOutputSchema)).toContain("job_id");
      expect(firstRequestJson).toContain(`窗口文件：${firstWindowTextPath}`);
      expect(firstRequestJson).toContain(
        `read_file/grep 如需读取当前窗口文件，必须使用项目相对路径 ${firstWindowTextPath}，不要使用裸文件名 window-0001.txt`
      );
      expect(firstRequestJson).toContain("窗口序号：1/2");
      expect(firstRequestJson).toContain("丹药分析模板");
      expect(firstRequestJson).toContain("材料分析模板");
      expect(JSON.stringify(mockServer.requests[2].body)).toContain("窗口序号：2/2");
      expect(assistantToolCallMessage).toMatchObject({
        role: "assistant"
      });
      expect((assistantToolCallMessage?.tool_calls as unknown[] | undefined) ?? []).toHaveLength(2);
      expect(secondToolMessages).toHaveLength(2);
      expect(JSON.stringify(secondToolMessages)).toContain("丹药分析.md");
      expect(JSON.stringify(secondToolMessages)).toContain("材料分析.md");
      expect(JSON.stringify(secondToolMessages)).toContain("wrote ");
      expect(JSON.stringify(secondToolMessages)).not.toContain("changedBytes");
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
      expect(JSON.stringify(mockServer.requests[2].body)).toContain("上下文章节范围：2-3");
      expect(JSON.stringify(mockServer.requests[2].body)).toContain("提交章节范围：3-3");
      expect(JSON.stringify(mockServer.requests[2].body)).not.toContain("第一章 初入坊市");
      expect(JSON.stringify(mockServer.requests[2].body)).toContain("第二章 丹房夜火");
      expect(JSON.stringify(mockServer.requests[2].body)).toContain("第三章 试炼归来");

      expect(completedJob).toMatchObject({
        id: jobWithTwoTemplates.id,
        status: "completed",
        progressText: "进度：2/2",
        tokenText: "Token 111 / 缓存命中率 0.00%",
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

  it("writes and reads a per-task plain-text log for model prompts, responses, tools, and context", async () => {
    const apiKey = "sk-text-log-secret";
    let createdJobId = "";
    const mockServer = await startMockOpenAiServer({
      expectedApiKey: apiKey,
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              content: `准备查询窗口文本 ${apiKey}`,
              toolCalls: [
                createToolCall("call-grep-window", "grep", {
                  path: `runs/${createdJobId}/windows/window-0001.txt`,
                  pattern: "初入坊市"
                })
              ],
              totalTokens: 31
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({
              content: "准备写入报告",
              toolCalls: [
                createToolCall("call-write-report", "write_file", {
                  path: "丹药分析.md",
                  content: "# 丹药分析\n\n窗口 grep 后写入的完整报告正文。"
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
    const openPath = vi.fn().mockResolvedValue("");
    const handlers = createHandlers({
      credentialStore,
      shell: { openPath },
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
      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const logFilePath = completedJob.logFilePath;

      expect(logFilePath).toMatch(new RegExp(`^runs/${job.id}/logs/20260627-000000(?:-\\d{3})?\\.txt$`));
      expect(existsSync(path.join(projectRoot, "runs", job.id, "tool-loop-traces"))).toBe(false);

      const logText = await fs.readFile(path.join(projectRoot, logFilePath ?? ""), "utf8");
      const simpleLogText = await fs.readFile(
        path.join(projectRoot, (logFilePath ?? "").replace(/\.txt$/u, ".simple.txt")),
        "utf8"
      );
      const readLog = await contract.invoke(handlers, "jobs:readLog", { jobId: job.id });

      expect(readLog).toEqual({
        jobId: job.id,
        logFilePath,
        content: simpleLogText
      });
      expect(simpleLogText).toContain("开始任务：凡人修仙传.txt");
      expect(simpleLogText).toContain("请求模型：窗口 1/1，第 1 轮");
      expect(simpleLogText).toContain("搜索文件：window-0001.txt");
      expect(simpleLogText).not.toContain("[大模型请求][Prompt]");
      expect(simpleLogText).not.toContain("role: system");
      expect(logText.split("\n")[0]).toContain("[2026-06-27 00:00:00][任务信息] 任务");
      expect(logText).toContain("[大模型请求][Prompt]");
      expect(logText).toContain("role: system");
      expect(logText).toContain("role: user");
      expect(logText).toContain("窗口序号：1/1");
      expect(logText).toContain("[大模型返回]");
      expect(logText).toContain("准备查询窗口文本 ***");
      expect(logText).toContain("call-grep-window");
      expect(logText).toContain("[工具调用][grep]");
      expect(logText).toContain("path: runs/");
      expect(logText).toContain("pattern: 初入坊市");
      expect(logText).toContain("[工具返回][grep]");
      expect(logText).toContain("[上下文][窗口]");
      expect(logText).toContain("章节范围");
      expect(logText).not.toContain(apiKey);
      expect(logText.trim()).not.toMatch(/^\{.*\}$/su);

      await contract.invoke(handlers, "jobs:openLog", { jobId: job.id });
      expect(openPath).toHaveBeenCalledWith(path.join(projectRoot, logFilePath ?? ""));
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
                  old_string: "窗口一写入：凝气丹。",
                  new_string: "窗口一写入：凝气丹。\n窗口二已更新：紫霜丹。"
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
        progressText: "进度：2/2"
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
                  old_string: "待清理标记：模板占位\n\n",
                  new_string: ""
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
        progressText: "进度：1/1"
      });
      expect(mockServer.requests).toHaveLength(3);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        reportKind: "template-output"
      });
      expect(reportMarkdown).toBe("# 丹药分析\n\n正式内容：凝气丹。");
    } finally {
      await mockServer.close();
    }
  });

  it.each([
    {
      toolName: "edit_file",
      toolArgs: (reportPath: string) => ({
        path: reportPath,
        old_string: "窗口一记录：韩立谨慎，代表事件为墨府求生。",
        new_string: "窗口一记录：韩立谨慎，代表事件为墨府求生。\n窗口二补充：韩立遇事先观察，再决定是否出手。"
      })
    },
    {
      toolName: "multi_edit",
      toolArgs: (reportPath: string) => ({
        path: reportPath,
        edits: [
          {
            old_string: "窗口一记录：韩立谨慎，代表事件为墨府求生。",
            new_string:
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
        progressText: "进度：2/2"
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
      expect(rewriteReplayBody).toContain("wrote ");
      expect(rewriteReplayBody).toContain("NPC性格与代表事件.md");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：2/2"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: reportFileName,
        displayName: "NPC性格与代表事件",
        reportKind: "template-output"
      });
      expect(reportMarkdown).toBe(rewrittenReportBody);
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
                  old_string: firstReportBody,
                  new_string: [firstReportBody, "", secondReportSection].join("\n")
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
        progressText: "进度：2/2"
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
                  old_string: firstReportBody,
                  new_string: mergedReportBody
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
                      old_string: "野狼帮、贾天龙与金狼相关内容。",
                      new_string: "野狼帮、贾天龙、金狼相关内容。"
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
        progressText: "进度：2/2"
      });
      expect(reportMarkdown).toBe(finalReportBody);
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
                  old_string: "七玄门早期内容。",
                  new_string: "七玄门补充内容。"
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
        progressText: "进度：2/2"
      });
      expect(mockServer.requests).toHaveLength(5);
      expect(grepReplayBody).toContain(`assets/books/${uploadedBookId}/reports/${reportFileName}`);
      expect(grepReplayBody).toContain("七玄门早期内容。");
      expect(reportMarkdown).toBe(updatedReportBody);
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
                  old_string: firstReportBody,
                  new_string: [firstReportBody, "", "## 二、野狼帮", "", "野狼帮、贾天龙与金狼相关内容。"].join("\n")
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
        progressText: "进度：2/2"
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
        old_string: "不存在的旧内容。",
        new_string: "不会写入的新内容。"
      }
    },
    {
      toolName: "multi_edit",
      toolArgs: {
        path: "丹药分析.md",
        edits: [{ old_string: "不存在的旧内容。", new_string: "不会写入的新内容。" }]
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
                    old_string: "# 丹药分析\n\n窗口一初稿：凝气丹。",
                    new_string: "# 丹药分析\n\n窗口二修正后的完整报告。"
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
        expect(JSON.stringify(mockServer.requests[4].body)).toContain("old_string not found");
        expect(completedJob).toMatchObject({
          id: job.id,
          status: "completed",
          progressText: "进度：2/2"
        });
        expect(completedJob?.failureReason).toBeUndefined();
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          fileName: "丹药分析.md",
          displayName: "丹药分析",
          reportKind: "template-output"
        });
        expect(reportMarkdown).toBe("# 丹药分析\n\n窗口二修正后的完整报告。");
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
        progressText: "进度：1/1"
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
        progressText: "进度：1/1"
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

  it("returns unknown tool name errors to the model so it can retry with enabled tools", async () => {
    const recoveredReport = "# 丹药分析\n\n未知工具名被回放后，模型改用已启用写工具完成。";
    let unknownToolReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-pwd", "pwd", {
                  command: "pwd"
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          unknownToolReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-unknown-tool", "write_file", {
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

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });

      expect(mockServer.requests).toHaveLength(3);
      expect(unknownToolReplayBody).toContain("UNKNOWN_TOOL");
      expect(unknownToolReplayBody).toContain("tool_not_enabled");
      expect(unknownToolReplayBody).toContain("pwd");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
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
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      await mockServer.close();
    }
  });

  it("returns recoverable errors when read tools target the run root without leaking run logs", async () => {
    const leakPattern = "TRACE_LEAK_MARKER";
    const leakPayload = "SHOULD_NOT_REACH_MODEL";
    const recoveredReport = "# 丹药分析\n\nrun 根目录读工具被拒绝后改用选中报告。";
    let createdJobId = "";
    let readToolReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-grep-run-root", "grep", {
                  path: `runs/${createdJobId}`,
                  pattern: leakPattern
                }),
                createToolCall("call-ls-run-root", "ls", {
                  path: `runs/${createdJobId}`,
                  recursive: true
                }),
                createToolCall("call-glob-run-root", "glob", {
                  pattern: `runs/${createdJobId}/**/*.txt`
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          readToolReplayBody = JSON.stringify(body);
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
      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const logText = await fs.readFile(path.join(projectRoot, completedJob.logFilePath ?? ""), "utf8");

      expect(mockServer.requests).toHaveLength(3);
      expect(readToolReplayBody).toContain("UNSAFE_PATH");
      expect(readToolReplayBody).toContain("当前窗口文本");
      expect(readToolReplayBody).toContain("reports");
      expect(readToolReplayBody).not.toContain(leakPayload);
      expect(readToolReplayBody).not.toContain("/logs/");
      expect(logText).toContain("[工具调用][grep]");
      expect(logText).toContain("[工具调用][ls]");
      expect(logText).toContain("[工具调用][glob]");
      expect(logText).toContain("call-grep-run-root");
      expect(logText).toContain("call-ls-run-root");
      expect(logText).toContain("call-glob-run-root");
      expect(logText).toContain("[工具返回][grep]");
      expect(logText).toContain("[工具返回][ls]");
      expect(logText).toContain("[工具返回][glob]");
      expect(logText).toContain("UNSAFE_PATH");
      expect(logText).toContain("读工具路径不在当前窗口允许范围内。");
      expect(logText).not.toContain(leakPayload);
      expect(existsSync(path.join(projectRoot, "runs", job.id, "tool-loop-traces"))).toBe(false);
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      await mockServer.close();
    }
  });

  it("creates jobs with structured planned window progress instead of chapter count", async () => {
    const contract = createIpcContract();
    const handlers = createHandlers();
    const novelPath = await writeTempNovel(tempRoot, "九章小说.txt", 9);

    const book = await contract.invoke(handlers, "books:uploadTxt", {
      projectId: "project-a",
      filePath: novelPath,
      displayName: "九章小说.txt"
    });
    const job = requireJobDto(
      await contract.invoke(handlers, "jobs:create", {
        bookId: book.bookId,
        templateIds: ["pill-analysis"],
        providerConfigId: "provider-1",
        modelId: "mock-model",
        singleRunChapterCount: 3,
        extractionChapterCount: 9,
        overlapChapterCount: 1,
        skipAlreadyExtracted: true
      })
    );

    expect(job).toMatchObject({
      progressText: "进度：0/4",
      progress: {
        completedWindowCount: 0,
        totalWindowCount: 4,
        percent: 0
      },
      tokenText: "Token 0 / 缓存命中率 0.00%"
    });
  });

  it("updates completed window progress and usage cache hit text while jobs run", async () => {
    const mockServer = await startMockOpenAiServer({
      expectedApiKey: "sk-usage-cache",
      respond: () => ({
        body: createChatCompletionResponse({
          content: "NO_UPDATE",
          usage: {
            prompt_tokens: 80,
            completion_tokens: 20,
            total_tokens: 100,
            prompt_cache_hit_tokens: 60,
            prompt_cache_miss_tokens: 20
          }
        })
      })
    });
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture("sk-usage-cache");
    const pushedJobs: JobDto[] = [];
    const handlers = createHandlers({
      credentialStore,
      onJobUpdated: (job: JobDto) => {
        pushedJobs.push(job);
      },
      providerStore: createProviderStore(
        createProviderConfig({
          apiKeyRef,
          baseUrl: mockServer.baseUrl
        })
      )
    });
    const novelPath = await writeTempNovel(tempRoot, "九章运行小说.txt", 9);

    try {
      const book = await contract.invoke(handlers, "books:uploadTxt", {
        projectId: "project-a",
        filePath: novelPath,
        displayName: "九章运行小说.txt"
      });
      const job = requireJobDto(
        await contract.invoke(handlers, "jobs:create", {
          bookId: book.bookId,
          templateIds: ["pill-analysis"],
          providerConfigId: "provider-1",
          modelId: "mock-model",
          singleRunChapterCount: 3,
          extractionChapterCount: 9,
          overlapChapterCount: 1,
          skipAlreadyExtracted: true
        })
      );

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));

      expect(completedJob).toMatchObject({
        status: "completed",
        progressText: "进度：4/4",
        tokenText: "Token 400 / 缓存命中率 75.00%",
        progress: {
          completedWindowCount: 4,
          totalWindowCount: 4,
          percent: 100
        },
        timing: {
          startedAt: expect.any(String),
          completedAt: expect.any(String),
          elapsedMs: expect.any(Number),
          estimatedRemainingMs: expect.any(Number),
          estimateState: "available"
        },
        output: {
          outputDirectoryLabel: "九章运行小说.txt",
          canOpenOutputDirectory: true
        },
        inputSummary: {
          bookDisplayName: "九章运行小说.txt",
          templateNames: expect.arrayContaining([expect.any(String)]),
          modelId: "mock-model"
        }
      });
      expect(completedJob.timing?.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(pushedJobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: job.id,
            status: "running",
            progressText: "进度：1/4",
            tokenText: "Token 100 / 缓存命中率 75.00%",
            logFilePath: expect.stringContaining("runs/job-"),
            progress: {
              completedWindowCount: 1,
              totalWindowCount: 4,
              percent: 25
            },
            timing: expect.objectContaining({
              startedAt: expect.any(String),
              estimateState: "available"
            }),
            inputSummary: expect.objectContaining({
              bookDisplayName: "九章运行小说.txt",
              templateNames: expect.arrayContaining([expect.any(String)]),
              modelId: "mock-model"
            })
          }),
          expect.objectContaining({
            id: job.id,
            status: "completed",
            progressText: "进度：4/4",
            tokenText: "Token 400 / 缓存命中率 75.00%",
            progress: {
              completedWindowCount: 4,
              totalWindowCount: 4,
              percent: 100
            },
            output: {
              outputDirectoryLabel: "九章运行小说.txt",
              canOpenOutputDirectory: true
            }
          })
        ])
      );
    } finally {
      await mockServer.close();
    }
  });

  it("notifies initial running jobs with calculating timing before estimates are available", async () => {
    const mockServer = await startMockOpenAiServer({
      expectedApiKey: "sk-initial-running-timing",
      respond: () => ({
        body: createChatCompletionResponse({
          content: "NO_UPDATE",
          usage: {
            prompt_tokens: 80,
            completion_tokens: 20,
            total_tokens: 100,
            prompt_cache_hit_tokens: 60,
            prompt_cache_miss_tokens: 20
          }
        })
      })
    });
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture("sk-initial-running-timing");
    const pushedJobs: JobDto[] = [];
    const handlers = createHandlers({
      credentialStore,
      onJobUpdated: (job: JobDto) => {
        pushedJobs.push(job);
      },
      providerStore: createProviderStore(
        createProviderConfig({
          apiKeyRef,
          baseUrl: mockServer.baseUrl
        })
      )
    });
    const novelPath = await writeTempNovel(tempRoot, "首条运行通知小说.txt", 9);

    try {
      const book = await contract.invoke(handlers, "books:uploadTxt", {
        projectId: "project-a",
        filePath: novelPath,
        displayName: "首条运行通知小说.txt"
      });
      const job = requireJobDto(
        await contract.invoke(handlers, "jobs:create", {
          bookId: book.bookId,
          templateIds: ["pill-analysis"],
          providerConfigId: "provider-1",
          modelId: "mock-model",
          singleRunChapterCount: 3,
          extractionChapterCount: 9,
          overlapChapterCount: 1,
          skipAlreadyExtracted: true
        })
      );

      await contract.invoke(handlers, "jobs:start", { jobId: job.id });

      const initialRunningJob = pushedJobs.find(
        (pushedJob) => pushedJob.id === job.id && pushedJob.status === "running"
      );
      expect(initialRunningJob).toMatchObject({
        progressText: "正在准备运行窗口",
        progress: {
          completedWindowCount: 0,
          totalWindowCount: 4,
          percent: 0
        },
        timing: {
          startedAt: fixedNow,
          elapsedMs: 0,
          estimateState: "calculating"
        }
      });
      expect(initialRunningJob?.timing?.estimatedRemainingMs).toBeUndefined();
    } finally {
      await mockServer.close();
    }
  });

  it("resets stale full progress on the first running restart notification", async () => {
    const mockServer = await startMockOpenAiServer({
      expectedApiKey: "sk-restart-stale-progress",
      respond: () => ({
        body: createChatCompletionResponse({
          content: "NO_UPDATE"
        })
      })
    });
    const contract = createIpcContract();
    const { credentialStore, apiKeyRef } = createCredentialFixture("sk-restart-stale-progress");
    const providerStore = createProviderStore(
      createProviderConfig({
        apiKeyRef,
        baseUrl: mockServer.baseUrl
      })
    );
    const handlers = createHandlers({ credentialStore, providerStore });
    const novelPath = await writeTempNovel(tempRoot, "重启满进度小说.txt", 9);

    try {
      const book = await contract.invoke(handlers, "books:uploadTxt", {
        projectId: "project-a",
        filePath: novelPath,
        displayName: "重启满进度小说.txt"
      });
      const job = requireJobDto(
        await contract.invoke(handlers, "jobs:create", {
          bookId: book.bookId,
          templateIds: ["pill-analysis"],
          providerConfigId: "provider-1",
          modelId: "mock-model",
          singleRunChapterCount: 3,
          extractionChapterCount: 9,
          overlapChapterCount: 1,
          skipAlreadyExtracted: true
        })
      );
      const runtimePath = path.join(tempRoot, "projects", "project-a", "state", "project-runtime.json");
      const rawRuntime = JSON.parse(await fs.readFile(runtimePath, "utf8")) as {
        jobs: ProjectRuntimeJobRecord[];
      };
      rawRuntime.jobs = rawRuntime.jobs.map((storedJob) =>
        storedJob.id === job.id
          ? {
              ...storedJob,
              status: "failed",
              progressText: "进度：4/4",
              failureReason: "mock failure after completing all windows",
              progress: {
                completedWindowCount: 4,
                totalWindowCount: 4
              },
              timing: {
                startedAt: "2026-07-02T10:00:00.000Z",
                completedAt: "2026-07-02T10:04:00.000Z",
                estimatedRemainingMs: 420000
              }
            }
          : storedJob
      );
      await fs.writeFile(runtimePath, `${JSON.stringify(rawRuntime, null, 2)}\n`, "utf8");

      const pushedJobs: JobDto[] = [];
      const restartedHandlers = createHandlers({
        credentialStore,
        onJobUpdated: (updatedJob: JobDto) => {
          pushedJobs.push(updatedJob);
        },
        providerStore
      });
      await contract.invoke(restartedHandlers, "projectRuntime:get", { projectId: "project-a" });

      await contract.invoke(restartedHandlers, "jobs:restart", { jobId: job.id });

      const initialRunningJob = pushedJobs.find(
        (pushedJob) => pushedJob.id === job.id && pushedJob.status === "running"
      );
      expect(initialRunningJob).toMatchObject({
        progressText: "正在准备运行窗口",
        progress: {
          completedWindowCount: 0,
          totalWindowCount: 4,
          percent: 0
        },
        timing: {
          startedAt: fixedNow,
          elapsedMs: 0,
          estimateState: "calculating"
        }
      });
      expect(initialRunningJob?.timing?.estimatedRemainingMs).toBeUndefined();
    } finally {
      await mockServer.close();
    }
  });

  it("returns a recoverable error when read_file targets the rules snapshot", async () => {
    const recoveredReport = "# 丹药分析\n\n规则快照读取被拒绝后改用当前模板写入。";
    let createdJobId = "";
    let readReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-read-rules-snapshot", "read_file", {
                  path: `runs/${createdJobId}/rules/提取规则.md`
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
                createToolCall("call-write-after-rules-rejected", "write_file", {
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
        templateIds: ["pill-analysis", "material-analysis"],
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

      expect(mockServer.requests).toHaveLength(3);
      expect(readReplayBody).toContain("UNSAFE_PATH");
      expect(readReplayBody).toContain("当前窗口文本");
      expect(readReplayBody).toContain("reports");
      expect(readReplayBody).not.toContain("### 材料分析");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reportMarkdown).toBe(recoveredReport);
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
        progressText: "进度：2/2"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reportMarkdown).toBe(recoveredReport);
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
        progressText: "进度：2/2"
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
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("is a directory, not a file");
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("use the ls tool");
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("INVALID_ARGUMENTS");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
      });
      const reportMarkdown = await fs.readFile(path.join(reportsDir, "丹药分析.md"), "utf8");
      expect(reportMarkdown).toBe(recoveredReport);
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
      expect(requestBodies.join("\n")).not.toContain("cannot unmarshal string into Go value");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
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
      expect(reportMarkdown).toBe(recoveredReport);
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
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("invalid args:");
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("invalid character '丹' looking for beginning of value");
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("INVALID_ARGUMENTS");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
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
      expect(reportMarkdown).toBe(recoveredReport);
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
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("invalid args:");
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("cannot unmarshal array into Go struct field .path of type string");
      expect(JSON.stringify(mockServer.requests[1].body)).toContain("INVALID_ARGUMENTS");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
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
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      await mockServer.close();
    }
  });

  it("writes task text logs with full tool arguments, full results, and recoverable errors", async () => {
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

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const logText = await fs.readFile(path.join(projectRoot, completedJob.logFilePath ?? ""), "utf8");

      expect(logText).toContain("[上下文][窗口]");
      expect(logText).toContain("窗口 1/1");
      expect(logText).toContain(`runs/${job.id}/windows/window-0001.txt`);
      expect(logText).toContain("[大模型返回]");
      expect(logText).toContain("准备写入。");
      expect(logText).toContain("[工具调用][write_file]");
      expect(logText).toContain("call-write-array-path-trace");
      expect(logText).toContain("path:");
      expect(logText).toContain("- 丹药分析.md");
      expect(logText).toContain("[工具返回][write_file]");
      expect(logText).toContain("invalid args:");
      expect(logText).toContain("cannot unmarshal array into Go struct field .path of type string");
      expect(logText).toContain("完整报告正文".repeat(20));
      expect(logText).not.toContain(apiKey);
      expect(existsSync(path.join(projectRoot, "runs", job.id, "tool-loop-traces"))).toBe(false);
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
        progressText: "进度：0/1",
        allowedActions: ["resume", "restart", "delete"]
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
        progressText: "进度：0/2",
        allowedActions: ["resume", "restart", "delete"]
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

  it("continues ordinary no-tool completions beyond the former tool-loop round limit until NO_UPDATE", async () => {
    const formerRoundLimit = 12;
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => ({
        body: createChatCompletionResponse({
          content: requestIndex < formerRoundLimit ? "普通最终说明。" : "NO_UPDATE"
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

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const requestBodies = mockServer.requests.map((request) => JSON.stringify(request.body));

      expect(mockServer.requests).toHaveLength(formerRoundLimit + 1);
      expect(requestBodies[1]).toContain("上一轮没有调用任何工具，也没有成功写入报告");
      expect(requestBodies[1]).toContain("必须精确返回 NO_UPDATE");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
      });
      expect(completedJob.failureReason).toBeUndefined();
      expect(reports).toEqual([]);
    } finally {
      await mockServer.close();
    }
  });

  it("returns recoverable errors when grep omits path or glob escapes the reports alias", async () => {
    const recoveredReport = "# 丹药分析\n\n读工具边界被拒绝后改用选中报告。";
    let readToolReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-grep-without-path", "grep", {
                  pattern: "第三章"
                }),
                createToolCall("call-glob-report-alias-escape", "glob", {
                  pattern: "reports/../source/*.txt"
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          readToolReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-read-boundary-rejected", "write_file", {
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

      expect(mockServer.requests).toHaveLength(3);
      expect(readToolReplayBody).toContain("UNSAFE_PATH");
      expect(readToolReplayBody).toContain("读工具路径不在当前窗口允许范围内。");
      expect(readToolReplayBody).not.toContain("第三章 试炼归来");
      expect(readToolReplayBody).not.toContain("source/original.txt");
      expect(readToolReplayBody).not.toContain("/logs/");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
      });
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      await mockServer.close();
    }
  });

  it("lets the model recover from editing a missing report by creating it with write_file", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-edit-missing-report", "edit_file", {
                  path: "丹药分析.md",
                  old_string: "旧内容",
                  new_string: "新内容"
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-create-report-after-missing-edit", "write_file", {
                  path: "丹药分析.md",
                  content: "# 丹药分析\n\n凝气丹：原文已复核。\n"
                })
              ]
            })
          };
        }

        return { body: createChatCompletionResponse({ content: "窗口完成。" }) };
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
        overlapChapterCount: 0,
        skipAlreadyExtracted: true
      });

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const requestBodies = mockServer.requests.map((request) => JSON.stringify(request.body));

      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed"
      });
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ fileName: "丹药分析.md" });
      expect(requestBodies[1]).toContain("Path does not exist");
      expect(requestBodies[1]).toContain("write_file");
    } finally {
      await mockServer.close();
    }
  });

  it("recovers a missing template outcome when the model marks the unwritten output as no update", async () => {
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
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-second-template-no-update", "mark_no_update", {
                  path: secondReportName,
                  reason: "乙模板在当前窗口没有新增信息。"
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "本批次两个模板均已处理。" })
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

      expect(mockServer.requests).toHaveLength(3);
      expect(requestBodies[0]).toContain(firstTemplateName);
      expect(requestBodies[0]).toContain(secondTemplateName);
      expect(requestBodies[1]).toContain("尚未为本批次所有选中模板提供处理结果");
      expect(requestBodies[1]).toContain(secondReportName);
      expect(requestBodies[2]).toContain("mark_no_update");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
      });
      expect(requireJobDto(completedJob).failureReason).toBeUndefined();
      expect(reports.map((report) => report.fileName)).toEqual([firstReportName]);
    } finally {
      await mockServer.close();
    }
  });

  it("completes a selected template batch when the model marks the output as no update", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-mark-no-update", "mark_no_update", {
                  path: "丹药分析.md",
                  reason: "当前窗口没有丹药相关新增信息。"
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "丹药分析无新增，已记录无更新。" })
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
      const firstRequest = JSON.stringify(mockServer.requests[0].body);

      expect(firstRequest).toContain("mark_no_update");
      expect(mockServer.requests).toHaveLength(2);
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
      });
      expect(requireJobDto(completedJob).failureReason).toBeUndefined();
      expect(reports).toEqual([]);
    } finally {
      await mockServer.close();
    }
  });

  it("runs Reasonix bash background jobs inside the desktop tool loop", async () => {
    let waitPromptBody = "";
    let outcomePromptBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-start-bash-job", "bash", {
                  command: "echo desktop-bg",
                  run_in_background: true
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          waitPromptBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-wait-bash-job", "wait", {
                  job_ids: ["bash-1"],
                  timeout_seconds: 5
                })
              ]
            })
          };
        }

        if (requestIndex === 2) {
          outcomePromptBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-no-update-after-bash", "mark_no_update", {
                  path: "丹药分析.md",
                  reason: "bash 背景任务已验证，当前窗口没有丹药新增信息。"
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "bash 背景任务验证完成。" })
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

      expect(mockServer.requests).toHaveLength(4);
      expect(waitPromptBody).toContain('Started background job \\"bash-1\\"');
      expect(outcomePromptBody).toContain("[bash-1");
      expect(outcomePromptBody).toContain("desktop-bg");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed"
      });
    } finally {
      await mockServer.close();
    }
  });

  it("keeps bash inside the desktop report boundary without removing the bash tool family", async () => {
    const recoveredReport = "# 丹药分析\n\nbash 边界被拒绝后改用选中报告。";
    let uploadedBookId = "";
    let bashReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-bash-read-source", "bash", {
                  command: `Get-Content assets/books/${uploadedBookId}/source/original.txt`
                }),
                createToolCall("call-bash-write-project-root", "bash", {
                  command: "echo x > ../escape.md"
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          bashReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-bash-boundary", "write_file", {
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
      const projectRoot = path.join(tempRoot, "projects", "project-a");

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reportMarkdown = await fs.readFile(
        path.join(projectRoot, "assets", "books", book.bookId, "reports", "丹药分析.md"),
        "utf8"
      );
      const firstRequestTools = (mockServer.requests[0].body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? [];
      const firstRequestToolNames = firstRequestTools.map((tool) => tool.function?.name);

      expect(firstRequestToolNames).toEqual(
        expect.arrayContaining(["bash", "bash_output", "wait", "kill_shell"])
      );
      expect(mockServer.requests).toHaveLength(3);
      expect(bashReplayBody).toContain("UNSAFE_PATH");
      expect(bashReplayBody).not.toContain("第三章 试炼归来");
      expect(await pathExists(path.join(projectRoot, "escape.md"))).toBe(false);
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed"
      });
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      await mockServer.close();
    }
  });

  it("keeps runtime-composed bash path traversal from reading outside reports", async () => {
    const sentinelText = "DESKTOP_BASH_RUNTIME_SENTINEL";
    const recoveredReport = "# 丹药分析\n\nbash 运行时拼接路径读取被隔离后改用选中报告。";
    let bashReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-bash-runtime-read-escape", "bash", {
                  command: createPowerShellCommand(
                    "$p='.'+'.'; if (Test-Path \"$p/sentinel.txt\") { Get-Content \"$p/sentinel.txt\" } else { \"sandbox-miss\" }"
                  )
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          bashReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-runtime-read-boundary", "write_file", {
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
      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const reportsParent = path.join(projectRoot, "assets", "books", book.bookId);
      await fs.writeFile(path.join(reportsParent, "sentinel.txt"), sentinelText, "utf8");

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      expect(completedJob).toMatchObject({
        id: job.id,
        failureReason: undefined,
        status: "completed"
      });
      const reportMarkdown = await fs.readFile(
        path.join(projectRoot, "assets", "books", book.bookId, "reports", "丹药分析.md"),
        "utf8"
      );

      expect(mockServer.requests).toHaveLength(3);
      expect(bashReplayBody).not.toContain(sentinelText);
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      await mockServer.close();
    }
  });

  it("keeps runtime-composed bash path traversal from writing outside reports", async () => {
    const recoveredReport = "# 丹药分析\n\nbash 运行时拼接路径写出被隔离后改用选中报告。";
    let bashReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-bash-runtime-write-escape", "bash", {
                  command: createPowerShellCommand(
                    "$p='.'+'.'; Set-Content -LiteralPath \"$p/escape.md\" -Value leaked; \"write-finished\""
                  )
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          bashReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-runtime-write-boundary", "write_file", {
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
      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const escapedReportPath = path.join(projectRoot, "assets", "books", book.bookId, "escape.md");

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      expect(completedJob).toMatchObject({
        id: job.id,
        failureReason: undefined,
        status: "completed"
      });
      const reportMarkdown = await fs.readFile(
        path.join(projectRoot, "assets", "books", book.bookId, "reports", "丹药分析.md"),
        "utf8"
      );

      expect(mockServer.requests).toHaveLength(3);
      expect(bashReplayBody).toContain("write-finished");
      expect(await pathExists(escapedReportPath)).toBe(false);
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      await mockServer.close();
    }
  });

  it("does not persist unselected reports created by bash inside sandbox reports", async () => {
    const recoveredReport = "# 丹药分析\n\nbash 未选中报告创建被隔离后继续写正式选中报告。";
    let bashReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-bash-create-report", "bash", {
                  command: createPowerShellCommand(
                    'Set-Content -LiteralPath "bash-created.md" -Value "bash synced"; "write-finished"'
                  )
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          bashReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-bash-report-sync", "write_file", {
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
      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const reportsRoot = path.join(projectRoot, "assets", "books", book.bookId, "reports");

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reportMarkdown = await fs.readFile(path.join(reportsRoot, "丹药分析.md"), "utf8");

      expect(mockServer.requests).toHaveLength(3);
      expect(bashReplayBody).toContain("write-finished");
      expect(completedJob).toMatchObject({
        id: job.id,
        failureReason: undefined,
        status: "completed"
      });
      expect(await pathExists(path.join(reportsRoot, "bash-created.md"))).toBe(false);
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      await mockServer.close();
    }
  });

  it("does not persist unselected report deletions from bash inside sandbox reports", async () => {
    const recoveredReport = "# 丹药分析\n\nbash 未选中报告删除被隔离后继续写正式选中报告。";
    let bashReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-bash-delete-report", "bash", {
                  command: createPowerShellCommand(
                    'Remove-Item -LiteralPath "bash-delete.md"; "delete-finished"'
                  )
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          bashReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-bash-report-delete", "write_file", {
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
      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const reportsRoot = path.join(projectRoot, "assets", "books", book.bookId, "reports");
      const bashDeletedReportPath = path.join(reportsRoot, "bash-delete.md");
      await fs.mkdir(reportsRoot, { recursive: true });
      await fs.writeFile(bashDeletedReportPath, "real report that bash deletes", "utf8");

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reportMarkdown = await fs.readFile(path.join(reportsRoot, "丹药分析.md"), "utf8");

      expect(mockServer.requests).toHaveLength(3);
      expect(bashReplayBody).toContain("delete-finished");
      expect(completedJob).toMatchObject({
        id: job.id,
        failureReason: undefined,
        status: "completed"
      });
      await expect(fs.readFile(bashDeletedReportPath, "utf8")).resolves.toBe("real report that bash deletes");
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      await mockServer.close();
    }
  });

  it("does not persist bash-created, overwritten, or deleted unselected reports before mark_no_update", async () => {
    const sentinelExisting = "real report must survive bash";
    const sentinelDelete = "real delete target must survive bash";
    let bashReplayBody = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-bash-unselected-side-effects", "bash", {
                  command: createPowerShellCommand(
                    [
                      'Set-Content -LiteralPath "bash-created.md" -Value "created by bash"',
                      'Set-Content -LiteralPath "其他.md" -Value "overwritten by bash"',
                      'Remove-Item -LiteralPath "bash-delete.md"',
                      '"side-effects-finished"'
                    ].join("; ")
                  )
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          bashReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-no-update-after-bash-side-effects", "mark_no_update", {
                  path: "丹药分析.md",
                  reason: "当前窗口没有丹药新增信息。"
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
      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const reportsRoot = path.join(projectRoot, "assets", "books", book.bookId, "reports");
      await fs.mkdir(reportsRoot, { recursive: true });
      await fs.writeFile(path.join(reportsRoot, "其他.md"), sentinelExisting, "utf8");
      await fs.writeFile(path.join(reportsRoot, "bash-delete.md"), sentinelDelete, "utf8");

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });

      expect(mockServer.requests).toHaveLength(3);
      expect(bashReplayBody).toContain("side-effects-finished");
      expect(completedJob).toMatchObject({
        id: job.id,
        failureReason: undefined,
        status: "completed"
      });
      expect(await pathExists(path.join(reportsRoot, "bash-created.md"))).toBe(false);
      await expect(fs.readFile(path.join(reportsRoot, "其他.md"), "utf8")).resolves.toBe(sentinelExisting);
      await expect(fs.readFile(path.join(reportsRoot, "bash-delete.md"), "utf8")).resolves.toBe(sentinelDelete);
      expect(await pathExists(path.join(reportsRoot, "丹药分析.md"))).toBe(false);
    } finally {
      await mockServer.close();
    }
  });

  it("does not let bash read real project paths leaked through inherited environment variables", async () => {
    const sentinelText = "DESKTOP_BASH_ENV_SENTINEL";
    const recoveredReport = "# 丹药分析\n\nbash 环境变量路径泄露被隔离后改用选中报告。";
    let bashReplayBody = "";
    let uploadedBookId = "";
    const previousEnv = process.env.NOVEL_EXTRACTOR_TEST_PROJECT_ROOT;
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-bash-env-derived-read", "bash", {
                  command: createPowerShellCommand(
                    [
                      "$root=$env:NOVEL_EXTRACTOR_TEST_PROJECT_ROOT",
                      "if ([string]::IsNullOrWhiteSpace($root)) { 'env-empty'; return }",
                      `$target=Join-Path $root 'assets/books/${uploadedBookId}/sentinel.txt'`,
                      "if (Test-Path -LiteralPath $target) { Get-Content -LiteralPath $target } else { 'sentinel-miss' }"
                    ].join("; ")
                  )
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          bashReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-bash-env-boundary", "write_file", {
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
      const projectRoot = path.join(tempRoot, "projects", "project-a");
      process.env.NOVEL_EXTRACTOR_TEST_PROJECT_ROOT = projectRoot;
      await fs.writeFile(path.join(projectRoot, "assets", "books", book.bookId, "sentinel.txt"), sentinelText, "utf8");

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reportMarkdown = await fs.readFile(
        path.join(projectRoot, "assets", "books", book.bookId, "reports", "丹药分析.md"),
        "utf8"
      );

      expect(mockServer.requests).toHaveLength(3);
      expect(bashReplayBody).not.toContain(sentinelText);
      expect(completedJob).toMatchObject({
        id: job.id,
        failureReason: undefined,
        status: "completed"
      });
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      if (previousEnv === undefined) {
        delete process.env.NOVEL_EXTRACTOR_TEST_PROJECT_ROOT;
      } else {
        process.env.NOVEL_EXTRACTOR_TEST_PROJECT_ROOT = previousEnv;
      }
      await mockServer.close();
    }
  });

  it("does not let bash read external paths leaked through inherited environment variables", async () => {
    const sentinelText = "DESKTOP_BASH_EXTERNAL_ENV_SENTINEL";
    const recoveredReport = "# 丹药分析\n\nbash 外部环境变量路径泄露被隔离后改用选中报告。";
    let bashReplayBody = "";
    const outsideTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-external-env-"));
    const previousEnv = process.env.NOVEL_EXTRACTOR_TEST_EXTERNAL_ROOT;
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-bash-external-env-read", "bash", {
                  command: createPowerShellCommand(
                    [
                      "$root=$env:NOVEL_EXTRACTOR_TEST_EXTERNAL_ROOT",
                      "if ([string]::IsNullOrWhiteSpace($root)) { 'env-empty'; return }",
                      "$target=Join-Path $root 'sentinel.txt'",
                      "if (Test-Path -LiteralPath $target) { Get-Content -LiteralPath $target } else { 'sentinel-miss' }",
                      '"HOME="+$env:HOME',
                      '"USERPROFILE="+$env:USERPROFILE'
                    ].join("; ")
                  )
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          bashReplayBody = JSON.stringify(body);
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-external-env-boundary", "write_file", {
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
      await fs.writeFile(path.join(outsideTempDir, "sentinel.txt"), sentinelText, "utf8");
      process.env.NOVEL_EXTRACTOR_TEST_EXTERNAL_ROOT = outsideTempDir;
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
      const projectRoot = path.join(tempRoot, "projects", "project-a");

      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reportMarkdown = await fs.readFile(
        path.join(projectRoot, "assets", "books", book.bookId, "reports", "丹药分析.md"),
        "utf8"
      );

      expect(mockServer.requests).toHaveLength(3);
      expect(bashReplayBody).not.toContain(sentinelText);
      expect(bashReplayBody).not.toContain(outsideTempDir);
      expect(bashReplayBody).not.toContain(os.homedir());
      expect(completedJob).toMatchObject({
        id: job.id,
        failureReason: undefined,
        status: "completed"
      });
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      if (previousEnv === undefined) {
        delete process.env.NOVEL_EXTRACTOR_TEST_EXTERNAL_ROOT;
      } else {
        process.env.NOVEL_EXTRACTOR_TEST_EXTERNAL_ROOT = previousEnv;
      }
      await fs.rm(outsideTempDir, { force: true, recursive: true });
      await mockServer.close();
    }
  });

  it("rejects POSIX absolute paths in bash before command execution", async () => {
    const recoveredReport = "# 丹药分析\n\nbash POSIX 绝对路径被拒绝后改用选中报告。";
    let bashToolReplayContent = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-bash-posix-absolute-path", "bash", {
                  command: "echo desktop-posix-probe /__novel_extractor_scope_probe__/outside.txt"
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          const toolMessage = ((body.messages ?? []) as Array<Record<string, unknown>>).find(
            (message) => message.role === "tool" && message.name === "bash"
          );
          bashToolReplayContent = String(toolMessage?.content ?? "");
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-posix-bash-boundary", "write_file", {
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

      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reportMarkdown = await fs.readFile(
        path.join(projectRoot, "assets", "books", book.bookId, "reports", "丹药分析.md"),
        "utf8"
      );

      expect(mockServer.requests).toHaveLength(3);
      expect(bashToolReplayContent).toContain("UNSAFE_PATH");
      expect(bashToolReplayContent).toContain("bash 命令路径不在当前窗口允许范围内。");
      expect(bashToolReplayContent).not.toContain("desktop-posix-probe");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed"
      });
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      await mockServer.close();
    }
  });

  it("rejects the POSIX root path in bash before command execution", async () => {
    const recoveredReport = "# 丹药分析\n\nbash POSIX 根路径被拒绝后改用选中报告。";
    let bashToolReplayContent = "";
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-bash-posix-root-path", "bash", {
                  command: "ls /"
                })
              ]
            })
          };
        }

        if (requestIndex === 1) {
          const toolMessage = ((body.messages ?? []) as Array<Record<string, unknown>>).find(
            (message) => message.role === "tool" && message.name === "bash"
          );
          bashToolReplayContent = String(toolMessage?.content ?? "");
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-posix-root-bash-boundary", "write_file", {
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

      const projectRoot = path.join(tempRoot, "projects", "project-a");
      const completedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });
      const reportMarkdown = await fs.readFile(
        path.join(projectRoot, "assets", "books", book.bookId, "reports", "丹药分析.md"),
        "utf8"
      );

      expect(mockServer.requests).toHaveLength(3);
      expect(bashToolReplayContent).toContain("UNSAFE_PATH");
      expect(bashToolReplayContent).toContain("bash 命令路径不在当前窗口允许范围内。");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed"
      });
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      await mockServer.close();
    }
  });

  it("replays a complete tool outcome before completing a window", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex !== 0) {
          return {
            body: createChatCompletionResponse({ content: "窗口完成。" })
          };
        }

        return {
          body: createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-rewrite-0", "write_file", {
                path: "丹药分析.md",
                content: "# 丹药分析\n\n第 1 轮成功写入正式报告。"
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

      expect(mockServer.requests).toHaveLength(2);
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
      });
      expect(requireJobDto(completedJob).failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
      });
      expect(reportMarkdown).toContain("第 1 轮成功写入正式报告。");
    } finally {
      await mockServer.close();
    }
  });

  it("completes a combined template batch with one written report and one no-update outcome", async () => {
    const firstTemplateName = "甲模板分批测试";
    const secondTemplateName = "乙模板分批测试";
    const firstReportName = "甲模板分批测试.md";
    const secondReportName = "乙模板分批测试.md";
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-first-template-write", "write_file", {
                  path: firstReportName,
                  content: "# 甲模板分批测试\n\n合并批次写入甲模板。"
                }),
                createToolCall("call-second-template-no-update", "mark_no_update", {
                  path: secondReportName,
                  reason: "乙模板当前窗口无新增信息。"
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "合并批次处理完成。" })
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

      expect(mockServer.requests).toHaveLength(2);
      expect(requestBodies[0]).toContain(firstTemplateName);
      expect(requestBodies[0]).toContain(secondTemplateName);
      expect(requestBodies[1]).toContain("mark_no_update");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
      });
      expect(reports.map((report) => report.fileName)).toEqual([firstReportName]);
      expect(await fs.readFile(
        path.join(tempRoot, "projects", "project-a", "assets", "books", book.bookId, "reports", firstReportName),
        "utf8"
      )).toContain("合并批次写入甲模板。");
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
                  edits: [{ old_string: "不存在的长文片段。", new_string: "不会写入的新内容。" }]
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
      expect(requestBodies[4]).toContain("old_string not found");
      expect(requestBodies[4]).toContain("old_string 必须精确匹配");
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：2/2"
      });
      expect(requireJobDto(completedJob).failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      await mockServer.close();
    }
  });

  it("returns a recoverable tool error when edit_file old_string matches multiple report locations", async () => {
    let uploadedBookId = "";
    const initialReport = "# 丹药分析\n\n## 一\n\n重复锚点。\n\n## 二\n\n重复锚点。";
    const recoveredReport = `${initialReport}\n\n窗口二使用完整报告保留旧内容后补充。`;
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
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
                createToolCall("call-window-2-read-existing", "read_file", {
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
                createToolCall("call-window-2-ambiguous-edit", "edit_file", {
                  path: "丹药分析.md",
                  old_string: "重复锚点。",
                  new_string: "重复锚点。\n\n窗口二不应通过模糊锚点直接写入。"
                })
              ]
            })
          };
        }

        if (requestIndex === 4) {
          expect(JSON.stringify(body)).toContain("old_string is not unique");
          expect(JSON.stringify(body)).toContain("add more surrounding context");
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-window-2-safe-rewrite-after-ambiguous-edit", "write_file", {
                  path: "丹药分析.md",
                  content: recoveredReport
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({ content: "第二窗口写入完成。" })
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
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：2/2"
      });
      expect(requireJobDto(completedJob).failureReason).toBeUndefined();
      expect(reportMarkdown).toBe(recoveredReport);
    } finally {
      await mockServer.close();
    }
  });

  it("stops after the same recoverable tool error repeats three times in one window", async () => {
    let uploadedBookId = "";
    const initialReport = "# 丹药分析\n\n## 一\n\n重复锚点。\n\n## 二\n\n重复锚点。";
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
                createToolCall("call-window-2-read-existing", "read_file", {
                  path: `assets/books/${uploadedBookId}/reports/丹药分析.md`
                })
              ]
            })
          };
        }

        return {
          body: createChatCompletionResponse({
            toolCalls: [
              createToolCall(`call-window-2-ambiguous-edit-${requestIndex}`, "edit_file", {
                path: "丹药分析.md",
                old_string: "重复锚点。",
                new_string: "重复锚点。\n\n重复错误。"
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

      const failedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });

      expect(mockServer.requests).toHaveLength(7);
      expect(requireJobDto(failedJob)).toMatchObject({
        id: job.id,
        status: "failed"
      });
      expect(requireJobDto(failedJob).failureReason).toContain("同一工具错误重复超过 3 次");
    } finally {
      await mockServer.close();
    }
  });

  it("stops after repeated read-only tool errors hit the recoverable error limit", async () => {
    const mockServer = await startMockOpenAiServer({
      respond: ({ requestIndex }) => {
        return {
          body: createChatCompletionResponse({
            toolCalls: [
              createToolCall(`call-read-missing-${requestIndex}`, "read_file", {
                path: "丹药分析.md"
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

      const failedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });

      expect(mockServer.requests).toHaveLength(4);
      expect(requireJobDto(failedJob)).toMatchObject({
        id: job.id,
        status: "failed"
      });
      expect(requireJobDto(failedJob).failureReason).toContain("同一工具错误重复超过 3 次");
    } finally {
      await mockServer.close();
    }
  });

  it("stops after the same pre-execution recoverable tool error repeats three times in one window", async () => {
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
        if (requestIndex <= 3) {
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall(`call-write-draft-status-${requestIndex}`, "write_file", {
                  path: "事件因果链（长程因果图）.md",
                  content: dirtyReport
                })
              ]
            })
          };
        }

        if (requestIndex === 4) {
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

      const failedJob = await contract.invoke(handlers, "jobs:start", { jobId: job.id });

      expect(mockServer.requests).toHaveLength(4);
      expect(requireJobDto(failedJob)).toMatchObject({
        id: job.id,
        status: "failed"
      });
      expect(requireJobDto(failedJob).failureReason).toContain("同一工具错误重复超过 3 次");
    } finally {
      await mockServer.close();
    }
  });

  it("keeps distinct unsafe glob patterns recoverable without sharing the repeated-error fingerprint", async () => {
    const recoveredReport = "# 丹药分析\n\nglob pattern 边界被拒绝后恢复写入。";
    const unsafePatterns = [
      "reports/../source/a*.txt",
      "reports/../source/b*.txt",
      "reports/../source/c*.txt",
      "reports/../source/d*.txt"
    ];
    let globReplayBody: Record<string, unknown> | undefined;
    const mockServer = await startMockOpenAiServer({
      respond: ({ body, requestIndex }) => {
        if (requestIndex === 0) {
          return {
            body: createChatCompletionResponse({
              toolCalls: unsafePatterns.map((pattern, index) =>
                createToolCall(`call-unsafe-glob-${index}`, "glob", { pattern })
              )
            })
          };
        }

        if (requestIndex === 1) {
          globReplayBody = body;
          return {
            body: createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-write-after-glob-pattern-recovery", "write_file", {
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

      const completedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
      const reports = await contract.invoke(handlers, "books:listReports", { bookId: book.bookId });
      const replayMessages = Array.isArray(globReplayBody?.messages) ? globReplayBody.messages : [];
      const globToolContents = replayMessages
        .filter((message): message is { role: string; name?: string; content?: string } =>
          typeof message === "object" &&
          message !== null &&
          (message as { role?: unknown }).role === "tool" &&
          (message as { name?: unknown }).name === "glob"
        )
        .map((message) => String(message.content));
      const joinedGlobToolContents = globToolContents.join("\n");

      expect(mockServer.requests).toHaveLength(3);
      expect(completedJob).toMatchObject({
        id: job.id,
        status: "completed",
        progressText: "进度：1/1"
      });
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ fileName: "丹药分析.md" });
      expect(globToolContents).toHaveLength(unsafePatterns.length);
      expect(joinedGlobToolContents).toContain("UNSAFE_PATH");
      expect(joinedGlobToolContents).toContain(`assets/books/${book.bookId}/reports/../source/a*.txt`);
      expect(joinedGlobToolContents).toContain(`assets/books/${book.bookId}/reports/../source/d*.txt`);
    } finally {
      await mockServer.close();
    }
  });

  it.each([
    {
      toolName: "edit_file",
      toolArgs: {
        path: "丹药分析.md",
        old_string: "旧内容。",
        new_string: "新内容。"
      }
    },
    {
      toolName: "multi_edit",
      toolArgs: {
        path: "丹药分析.md",
        edits: [{ old_string: "旧内容。", new_string: "新内容。" }]
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
          progressText: "进度：1/2",
          allowedActions: ["resume", "restart", "delete"]
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
        allowedActions: ["resume", "restart", "delete"]
      });
      expect(existsSync(leakedReportPath)).toBe(false);
      expect(reports).toEqual([]);
      expect(JSON.stringify(failedJob)).not.toContain(apiKey);
      expect(JSON.stringify(reports)).not.toContain(apiKey);
    } finally {
      await mockServer.close();
    }
  });

  it("fails read_file when the read path contains a known API key without leaking the key", async () => {
    const apiKey = "sk-p0-mock";
    const mockServer = await startMockOpenAiServer({
      expectedApiKey: apiKey,
      respond: ({ requestIndex }) => {
        if (requestIndex !== 0) {
          return {
            status: 500,
            body: { error: "read secret path fallback should not be called" }
          };
        }

        return {
          body: createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-secret-read-path", "read_file", {
                path: `${apiKey}.md`
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

      expect(mockServer.requests).toHaveLength(1);
      expect(failedJob).toMatchObject({
        id: job.id,
        status: "failed",
        allowedActions: ["resume", "restart", "delete"]
      });
      expect(failedJob?.failureReason).toContain("secret");
      expect(JSON.stringify(failedJob)).not.toContain(apiKey);
      expect(reports).toEqual([]);
      expect(JSON.stringify(reports)).not.toContain(apiKey);
    } finally {
      await mockServer.close();
    }
  });

  it("fails grep when the pattern contains a known API key without leaking the key", async () => {
    const apiKey = "sk-p0-mock";
    const mockServer = await startMockOpenAiServer({
      expectedApiKey: apiKey,
      respond: ({ requestIndex }) => {
        if (requestIndex !== 0) {
          return {
            status: 500,
            body: { error: "grep secret pattern fallback should not be called" }
          };
        }

        return {
          body: createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-secret-grep-pattern", "grep", {
                pattern: apiKey,
                path: "reports"
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

      expect(mockServer.requests).toHaveLength(1);
      expect(failedJob).toMatchObject({
        id: job.id,
        status: "failed",
        allowedActions: ["resume", "restart", "delete"]
      });
      expect(failedJob?.failureReason).toContain("secret");
      expect(JSON.stringify(failedJob)).not.toContain(apiKey);
      expect(reports).toEqual([]);
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
        allowedActions: ["resume", "restart", "delete"]
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
                  old_string: previousReportContent,
                  new_string: expectedReportContent
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
        progressText: "进度：20/20",
        tokenText: `Token ${expectedRequestCount * 37} / 缓存命中率 0.00%`
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
        progressText: "进度：1/3",
        allowedActions: ["resume", "restart", "delete"]
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

  it("creates distinct project ids across handler instances in the same workspace", async () => {
    const contract = createIpcContract();
    const firstHandlers = createHandlers();
    const firstProject = await contract.invoke(firstHandlers, "project:create", {
      displayName: "仙途资料"
    });

    const restartedHandlers = createHandlers();
    const secondProject = await contract.invoke(restartedHandlers, "project:create", {
      displayName: "网文"
    });
    const projects = await contract.invoke(restartedHandlers, "project:list");

    expect(secondProject.id).not.toBe(firstProject.id);
    expect(projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstProject.id, displayName: "仙途资料" }),
        expect.objectContaining({ id: secondProject.id, displayName: "网文" })
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

  it("does not reuse an existing run directory when handlers are recreated", async () => {
    const contract = createIpcContract();
    const firstHandlers = createHandlers();
    const project = await contract.invoke(firstHandlers, "project:create", {
      displayName: "仙途资料"
    });
    const projectRoot = path.join(tempRoot, "projects", project.slug);
    await fs.mkdir(path.join(projectRoot, "runs", "job-1", "rules"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "runs", "job-1", "rules", "提取规则.md"),
      "# 旧任务规则\n\n> 书籍 ID：book-old\n",
      "utf8"
    );

    const restartedHandlers = createHandlers();
    const book = await contract.invoke(restartedHandlers, "books:uploadTxt", {
      projectId: project.id,
      filePath: utf8FixturePath,
      displayName: "凡人修仙传.txt"
    });

    const job = await contract.invoke(restartedHandlers, "jobs:create", {
      bookId: book.bookId,
      templateIds: ["pill-analysis"],
      providerConfigId: "provider-1",
      modelId: "mock-model",
      singleRunChapterCount: 3,
      extractionChapterCount: 3,
      overlapChapterCount: 0,
      skipAlreadyExtracted: true
    });

    expect(job.id).toBe("job-2");
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
        progressText: "进度：1/1"
      });
      expect(completedJob?.failureReason).toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        reportKind: "template-output"
      });
      expect(reportMarkdown).toBe(recoveredReport);
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
      expect(reportMarkdown).toBe(recoveredReport);
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
      const replayMessages = ((mockServer.requests[1].body as { messages?: unknown[] }).messages ?? []).filter(
        (message): message is Record<string, unknown> => typeof message === "object" && message !== null
      );
      const draftStatusToolMessage = replayMessages.find(
        (message) =>
          message.role === "tool" &&
          message.name === "write_file" &&
          message.tool_call_id === "call-write-draft-status"
      );
      const draftStatusToolResult = JSON.parse(String(draftStatusToolMessage?.content ?? "{}")) as Record<
        string,
        unknown
      >;

      expect(mockServer.requests).toHaveLength(3);
      expect(draftStatusToolResult).toMatchObject({
        error: {
          code: "INVALID_ARGUMENTS",
          message: "报告正文不得包含模板或草案状态。"
        },
        classification: "recoverable_by_model",
        reason: "tool_invalid_arguments",
        path: "事件因果链（长程因果图）.md"
      });
      expect(draftStatusToolResult.hint).toContain("状态：草案");
      expect(replayAfterDirtyWrite).toContain("报告正文不得包含模板或草案状态");
      expect(completedJob?.status).toBe("completed");
      expect(reportMarkdown).toBe(recoveredReport);
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
        skipAlreadyExtracted: false
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
      allowedActions: ["resume", "restart", "delete"],
      timing: {
        startedAt: fixedNow,
        completedAt: fixedNow
      }
    });
    expect(failedJob.failureReason).toBeTruthy();
    expect(JSON.stringify(failedJob)).not.toContain("sk-p0-mock");
    await expect(contract.invoke(handlers, "books:listReports", { bookId: book.bookId })).resolves.toEqual([]);
  });

  it("freezes failed job timing when pre-run template validation fails", async () => {
    const contract = createIpcContract();
    let now = "2026-07-02T10:00:00.000Z";
    const handlers = createHandlers({
      clock: { now: () => now }
    });

    const book = await contract.invoke(handlers, "books:uploadTxt", {
      projectId: "project-a",
      filePath: utf8FixturePath,
      displayName: "凡人修仙传.txt"
    });
    const template = await contract.invoke(handlers, "templates:save", {
      projectId: "project-a",
      scope: "project",
      name: "运行前删除模板",
      fileName: "deleted-before-run.md",
      body: "# 运行前删除模板"
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
    await contract.invoke(handlers, "templates:delete", {
      templateId: template.id
    });

    const failedJob = requireJobDto(await contract.invoke(handlers, "jobs:start", { jobId: job.id }));
    const failedElapsedMs = failedJob.timing?.elapsedMs;
    now = "2026-07-02T10:05:00.000Z";
    const restartedHandlers = createHandlers({
      clock: { now: () => now }
    });
    const runtime = await contract.invoke(restartedHandlers, "projectRuntime:get", {
      projectId: "project-a"
    });
    const reloadedJob = runtime.jobs.find((runtimeJob) => runtimeJob.id === job.id);

    expect(failedJob).toMatchObject({
      id: job.id,
      status: "failed",
      timing: {
        startedAt: "2026-07-02T10:00:00.000Z",
        completedAt: "2026-07-02T10:00:00.000Z"
      }
    });
    expect(failedElapsedMs).toBe(0);
    expect(reloadedJob?.timing).toMatchObject({
      startedAt: "2026-07-02T10:00:00.000Z",
      completedAt: "2026-07-02T10:00:00.000Z",
      elapsedMs: failedElapsedMs
    });
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
        allowedActions: ["resume", "restart", "delete"]
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

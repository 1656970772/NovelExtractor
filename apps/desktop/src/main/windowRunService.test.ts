import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApiKeyRef, ProviderConfig } from "@novel-extractor/domain";
import type { JobRuntime, JobRuntimeState } from "@novel-extractor/jobs";
import { reasonixToolOrder } from "@novel-extractor/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryCredentialStore } from "./credentials";
import { createTaskTextLogger } from "./taskTextLogger";
import {
  cleanupBashSandboxAfterWindow,
  createWindowRunService,
  interceptReportDiscoveryToolCall
} from "./windowRunService";

const scratchDirs: string[] = [];
const legacyDesktopToolNames = [...reasonixToolOrder, "mark_no_update"];

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { force: true, recursive: true });
    }
  }
});

describe("window run bash sandbox cleanup", () => {
  it("records teardown and sandbox removal warnings without masking the window result", async () => {
    const append = vi.fn(async () => {});

    await expect(
      cleanupBashSandboxAfterWindow({
        bashJobManager: {
          closeWithGrace: async () => ({
            cause: "timeout",
            hasTimedOut: () => true,
            timedOut: [
              {
                id: "bash-1",
                kind: "bash",
                label: "sleep",
                waitedMs: 1000
              }
            ]
          })
        } as any,
        bashSandbox: {
          env: {},
          parentRoot: "sandbox-parent",
          reportsRoot: "sandbox-parent/reports"
        },
        removeSandbox: async () => {
          throw new Error("sandbox locked");
        },
        syncReportsToReal: async () => {},
        taskLogger: { append } as any
      })
    ).resolves.toBeUndefined();

    expect(append).toHaveBeenCalledWith(
      ["警告", "bash"],
      expect.objectContaining({
        类型: "后台任务关闭超时",
        未完成任务: expect.arrayContaining([expect.objectContaining({ id: "bash-1" })])
      })
    );
    expect(append).toHaveBeenCalledWith(
      ["警告", "bash"],
      expect.objectContaining({
        类型: "sandbox 清理失败",
        错误: "sandbox locked"
      })
    );
  });
});

describe("window run coverage context", () => {
  it("switches to the next provider default model after a switchable auto mode LLM failure", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-auto-model-switch-"));
    scratchDirs.push(projectRoot);
    await writeSingleWindowText(projectRoot);
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const minimaxKeyRef = credentialStore.saveApiKey({
      providerConfigId: "minimax-provider",
      apiKey: "sk-minimax"
    });
    const deepSeekKeyRef = credentialStore.saveApiKey({
      providerConfigId: "deepseek-provider",
      apiKey: "sk-deepseek"
    });
    const providers = [
      createProviderConfig(minimaxKeyRef, {
        id: "minimax-provider",
        baseUrl: "https://minimax.local/v1",
        modelId: "minimax-chat",
        displayName: "MiniMax"
      }),
      createProviderConfig(deepSeekKeyRef, {
        id: "deepseek-provider",
        baseUrl: "https://deepseek.local/v1",
        modelId: "deepseek-chat",
        displayName: "DeepSeek"
      })
    ];
    const requestUrls: string[] = [];
    const requestBodies: Record<string, unknown>[] = [];
    const append = vi.fn(async () => {});
    const onModelCandidateChanged = vi.fn();
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrls.push(String(url));
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);

      if (requestUrls.length === 1) {
        return new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
          headers: { "Content-Type": "application/json" },
          status: 429
        });
      }

      return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onModelCandidateChanged,
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providers),
      registerReport: () => {},
      taskLogger: { append, setSecrets: vi.fn() } as any
    });

    const result = await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
      }),
      job: createWindowRunJob({
        modelId: "minimax-chat",
        modelSelectionMode: "auto",
        providerConfigId: "minimax-provider",
        templateIds: ["template-1"]
      })
    });

    expect(result.ok).toBe(true);
    expect(requestUrls).toEqual([
      "https://minimax.local/v1/chat/completions",
      "https://deepseek.local/v1/chat/completions"
    ]);
    expect(requestBodies[1]).toMatchObject({ model: "deepseek-chat" });
    expect(append).toHaveBeenCalledWith(
      ["上下文", "模型切换"],
      expect.objectContaining({
        从: expect.stringContaining("MiniMax / minimax-chat"),
        到: expect.stringContaining("DeepSeek / deepseek-chat")
      })
    );
    expect(onModelCandidateChanged).toHaveBeenCalledWith({
      jobId: "job-1",
      candidate: {
        providerConfigId: "deepseek-provider",
        providerDisplayName: "DeepSeek",
        modelId: "deepseek-chat",
        modelDisplayName: "deepseek-chat"
      }
    });
  }, 20000);

  it("keeps auto fallback state independent for each parallel template batch", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-auto-model-batch-isolation-"));
    scratchDirs.push(projectRoot);
    await writeSingleWindowText(projectRoot);
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const providerAKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-a",
      apiKey: "sk-provider-a"
    });
    const providerBKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-b",
      apiKey: "sk-provider-b"
    });
    const providers = [
      createProviderConfig(providerAKeyRef, {
        id: "provider-a",
        baseUrl: "https://provider-a.local/v1",
        modelId: "model-a",
        displayName: "Provider A"
      }),
      createProviderConfig(providerBKeyRef, {
        id: "provider-b",
        baseUrl: "https://provider-b.local/v1",
        modelId: "model-b",
        displayName: "Provider B"
      })
    ];
    const templates = [
      createTemplate({ id: "template-1", name: "报告一", fileName: "报告一.md" }),
      createTemplate({ id: "template-2", name: "报告二", fileName: "报告二.md" })
    ];
    const requestRecords: Array<{ templateId: string; url: string; model: unknown }> = [];
    const failedInitialProviderTemplates = new Set<string>();
    const append = vi.fn(async () => {});
    const onModelCandidateChanged = vi.fn();
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const userPrompt = messagesOf(body).find((message) => message.role === "user")?.content as string | undefined;
      const templateId = userPrompt?.includes("报告二.md") ? "template-2" : "template-1";
      const record = { templateId, url: String(url), model: body.model };
      requestRecords.push(record);

      if (record.url === "https://provider-a.local/v1/chat/completions" && !failedInitialProviderTemplates.has(templateId)) {
        failedInitialProviderTemplates.add(templateId);
        return new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
          headers: { "Content-Type": "application/json" },
          status: 429
        });
      }

      return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onModelCandidateChanged,
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providers),
      registerReport: () => {},
      taskLogger: { append, setSecrets: vi.fn() } as any
    });

    const result = await service.runJobWindows({
      artifacts: createWindowArtifacts({ projectRoot, templates }),
      job: createWindowRunJob({
        modelId: "model-a",
        modelSelectionMode: "auto",
        providerConfigId: "provider-a",
        templateBatchSize: 1,
        templateIds: templates.map((template) => template.id)
      })
    });

    expect(result.ok).toBe(true);
    // If a future refactor shares RuntimeChatClient across batches, template-2's first request starts on provider B.
    for (const template of templates) {
      const records = requestRecords.filter((record) => record.templateId === template.id);
      expect(records.map((record) => ({ url: record.url, model: record.model }))).toEqual([
        { url: "https://provider-a.local/v1/chat/completions", model: "model-a" },
        { url: "https://provider-b.local/v1/chat/completions", model: "model-b" }
      ]);
    }
    expect(onModelCandidateChanged).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledWith(
      ["上下文", "模型切换"],
      expect.objectContaining({ 批次ID: "batch-0001" })
    );
    expect(append).toHaveBeenCalledWith(
      ["上下文", "模型切换"],
      expect.objectContaining({ 批次ID: "batch-0002" })
    );
  }, 20000);

  it("retries the same provider and window for a switchable LLM failure in explicit mode", async () => {
    vi.useFakeTimers();
    try {
      const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-explicit-no-switch-"));
      scratchDirs.push(projectRoot);
      await writeSingleWindowText(projectRoot);
      const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
      const minimaxKeyRef = credentialStore.saveApiKey({
        providerConfigId: "minimax-provider",
        apiKey: "sk-minimax"
      });
      const deepSeekKeyRef = credentialStore.saveApiKey({
        providerConfigId: "deepseek-provider",
        apiKey: "sk-deepseek"
      });
      const requestUrls: string[] = [];
      const requestBodies: Record<string, unknown>[] = [];
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requestUrls.push(String(url));
        requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        if (requestUrls.length === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
            headers: { "Content-Type": "application/json" },
            status: 429
          });
        }
        return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
          headers: { "Content-Type": "application/json" },
          status: 200
        });
      });

      const service = createWindowRunService({
        clock: { now: () => "2026-07-01T00:00:00.000Z" },
        credentialStore,
        fetch,
        findExistingReport: () => undefined,
        idGenerator: { createId: (prefix: string) => `${prefix}-1` },
        onRuntimeState: async () => {},
        providerStore: createProviderStore([
          createProviderConfig(minimaxKeyRef, {
            id: "minimax-provider",
            baseUrl: "https://minimax.local/v1",
            modelId: "minimax-chat"
          }),
          createProviderConfig(deepSeekKeyRef, {
            id: "deepseek-provider",
            baseUrl: "https://deepseek.local/v1",
            modelId: "deepseek-chat"
          })
        ]),
        registerReport: () => {},
        taskLogger: { append: vi.fn(async () => {}), setSecrets: vi.fn() } as any
      });

      const runPromise = service.runJobWindows({
        artifacts: createWindowArtifacts({
          projectRoot,
          templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
        }),
        job: createWindowRunJob({
          modelId: "minimax-chat",
          modelSelectionMode: "explicit",
          providerConfigId: "minimax-provider",
          templateIds: ["template-1"]
        })
      });

      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(runPromise).resolves.toMatchObject({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(requestUrls).toEqual([
        "https://minimax.local/v1/chat/completions",
        "https://minimax.local/v1/chat/completions"
      ]);
      expect(messagesOf(requestBodies[1]).find((message) => message.role === "user")?.content).toBe(
        messagesOf(requestBodies[0]).find((message) => message.role === "user")?.content
      );
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  it("preserves tool-loop messages when retrying a parameter error in the same round", async () => {
    vi.useFakeTimers();
    try {
      const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-context-retry-"));
      scratchDirs.push(projectRoot);
      await writeSingleWindowText(projectRoot);
      const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
      const apiKeyRef = credentialStore.saveApiKey({
        providerConfigId: "provider-1",
        apiKey: "sk-context-retry"
      });
      const requestBodies: Record<string, unknown>[] = [];
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        if (requestBodies.length === 1) {
          return new Response(
            JSON.stringify(
              createChatCompletionResponse({
                toolCalls: [
                  createToolCall("call-no-update", "mark_no_update", {
                    path: "人物.md",
                    reason: "当前窗口没有人物信息"
                  })
                ]
              })
            ),
            { headers: { "Content-Type": "application/json" }, status: 200 }
          );
        }
        if (requestBodies.length === 2) {
          return new Response(
            JSON.stringify({ error: { code: "invalid_parameter", message: "temperature is invalid" } }),
            { headers: { "Content-Type": "application/json" }, status: 400 }
          );
        }
        return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
          headers: { "Content-Type": "application/json" },
          status: 200
        });
      });
      const service = createWindowRunService({
        clock: { now: () => "2026-07-01T00:00:00.000Z" },
        credentialStore,
        fetch,
        findExistingReport: () => undefined,
        idGenerator: { createId: (prefix: string) => `${prefix}-1` },
        onRuntimeState: async () => {},
        providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
        registerReport: () => {},
        taskLogger: { append: vi.fn(async () => {}), setSecrets: vi.fn() } as any,
        templateBatchFailureRetryIntervalMs: 60_000
      });

      const runPromise = service.runJobWindows({
        artifacts: createWindowArtifacts({
          projectRoot,
          templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
        }),
        job: createWindowRunJob({ templateIds: ["template-1"] })
      });

      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(runPromise).resolves.toMatchObject({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(messagesOf(requestBodies[2])).toEqual(messagesOf(requestBodies[1]));
      expect(messagesOf(requestBodies[2])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "assistant" }),
          expect.objectContaining({ role: "tool", tool_call_id: "call-no-update" })
        ])
      );
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  it("fails immediately without retrying an explicit context limit error", async () => {
    vi.useFakeTimers();
    try {
      const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-context-limit-"));
      scratchDirs.push(projectRoot);
      await writeSingleWindowText(projectRoot);
      const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
      const apiKeyRef = credentialStore.saveApiKey({
        providerConfigId: "provider-1",
        apiKey: "sk-context-limit"
      });
      const fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "context_length_exceeded",
              message: "This model's maximum context length is 128000 tokens"
            }
          }),
          { headers: { "Content-Type": "application/json" }, status: 400 }
        )
      );
      const service = createWindowRunService({
        clock: { now: () => "2026-07-01T00:00:00.000Z" },
        credentialStore,
        fetch,
        findExistingReport: () => undefined,
        idGenerator: { createId: (prefix: string) => `${prefix}-1` },
        onRuntimeState: async () => {},
        providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
        registerReport: () => {},
        templateBatchFailureRetryIntervalMs: 60_000
      });

      const result = await service.runJobWindows({
        artifacts: createWindowArtifacts({
          projectRoot,
          templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
        }),
        job: createWindowRunJob({ templateIds: ["template-1"] })
      });

      expect(result).toMatchObject({ ok: false });
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  it("does not wake an unrelated batch retry sleep when another batch finishes a window", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-retry-isolation-"));
    scratchDirs.push(projectRoot);
    await writeSingleWindowText(projectRoot);
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const templates = [
      createTemplate({ id: "template-retry", name: "失败后重试", fileName: "失败后重试.md" }),
      createTemplate({ id: "template-success", name: "正常完成", fileName: "正常完成.md" })
    ];
    let retryTemplateRequests = 0;
    let successTemplateRequests = 0;
    let runtime: JobRuntime | undefined;
    const progressSnapshots: number[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const messages = messagesOf(body);
      const userPrompt = messages.find((message) => message.role === "user")?.content as string | undefined;
      const isRetryTemplate = typeof userPrompt === "string" && userPrompt.includes("失败后重试.md");

      if (isRetryTemplate) {
        retryTemplateRequests += 1;
        if (retryTemplateRequests === 1) {
          return new Response(JSON.stringify({ error: { message: "temporary provider failure" } }), {
            headers: { "Content-Type": "application/json" },
            status: 500
          });
        }
        return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
          headers: { "Content-Type": "application/json" },
          status: 200
        });
      }

      successTemplateRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });
    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeCreated: ({ runtime: nextRuntime }) => {
        runtime = nextRuntime;
      },
      onRuntimeState: async (state) => {
        progressSnapshots.push(state.completedWindowCount);
      },
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {},
      taskLogger: { append: vi.fn(async () => {}), setSecrets: vi.fn() } as any,
      templateBatchFailureRetryIntervalMs: 10_000
    });

    const runPromise = service.runJobWindows({
      artifacts: createWindowArtifacts({ projectRoot, templates }),
      job: createWindowRunJob({
        templateBatchSize: 1,
        templateIds: templates.map((template) => template.id)
      })
    });

    try {
      await vi.waitFor(() => {
        expect(retryTemplateRequests).toBe(1);
        expect(successTemplateRequests).toBe(1);
        expect(progressSnapshots).toContain(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(retryTemplateRequests).toBe(1);
    } finally {
      await runtime?.cancelJob("job-1");
      await runPromise.catch(() => undefined);
    }
  }, 20000);

  it("cycles auto fallback candidates instead of excluding failed providers permanently", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-auto-model-cycle-"));
    scratchDirs.push(projectRoot);
    await writeSingleWindowText(projectRoot);
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const providers = ["one", "two", "three"].map((name) => {
      const apiKeyRef = credentialStore.saveApiKey({
        providerConfigId: `provider-${name}`,
        apiKey: `sk-${name}`
      });
      return createProviderConfig(apiKeyRef, {
        id: `provider-${name}`,
        baseUrl: `https://${name}.local/v1`,
        modelId: `model-${name}`
      });
    });
    const requestUrls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      requestUrls.push(String(url));

      if (requestUrls.length < 4) {
        return new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
          headers: { "Content-Type": "application/json" },
          status: 429
        });
      }

      return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providers),
      registerReport: () => {},
      taskLogger: { append: vi.fn(async () => {}), setSecrets: vi.fn() } as any
    });

    const result = await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
      }),
      job: createWindowRunJob({
        modelId: "model-one",
        modelSelectionMode: "auto",
        providerConfigId: "provider-one",
        templateIds: ["template-1"]
      })
    });

    expect(result.ok).toBe(true);
    expect(requestUrls).toEqual([
      "https://one.local/v1/chat/completions",
      "https://two.local/v1/chat/completions",
      "https://three.local/v1/chat/completions",
      "https://one.local/v1/chat/completions"
    ]);
  }, 20000);

  it("computes each template rules semantic hash once per job context", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-rules-hash-cache-"));
    scratchDirs.push(projectRoot);
    const templates = Array.from({ length: 4 }, (_, index) =>
      createTemplate({
        id: `template-${index + 1}`,
        name: `模板${index + 1}`,
        fileName: `模板${index + 1}.md`
      })
    );
    const artifacts = createWindowArtifacts({ projectRoot, templates, windowCount: 10 });
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const semanticHashForTemplate = (templateId: string) => `rules-semantic-${templateId}`;
    const createRulesSemanticHash = vi.fn((hashTemplates: readonly { id: string }[]) => {
      const [template] = hashTemplates;
      if (template === undefined) {
        throw new Error("expected one template for semantic hash");
      }
      return semanticHashForTemplate(template.id);
    });
    const fetch = vi.fn(async () => {
      throw new Error("covered windows should not call the model");
    });
    await writeCoverageIndexForArtifacts({
      artifacts,
      projectRoot,
      semanticHashForTemplate
    });

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      createRulesSemanticHash,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {},
      taskLogger: { append: vi.fn(async () => {}), setSecrets: vi.fn() } as any
    });

    await service.runJobWindows({
      artifacts,
      job: createWindowRunJob({
        skipAlreadyExtracted: true,
        templateIds: templates.map((template) => template.id)
      })
    });

    expect(createRulesSemanticHash).toHaveBeenCalledTimes(4);
    expect(createRulesSemanticHash.mock.calls.map(([hashTemplates]) => hashTemplates[0]?.id)).toEqual([
      "template-1",
      "template-2",
      "template-3",
      "template-4"
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("window run report inventory", () => {
  const reportInventory = [
    { outputFileName: "NPC性格与代表事件.md", exists: true, source: "selected_template" as const },
    { outputFileName: "势力设定.md", exists: true, source: "selected_template" as const },
    { outputFileName: "材料分析.md", exists: true, source: "selected_template" as const },
    { outputFileName: "事件因果链（长程因果图）.md", exists: false, source: "selected_template" as const }
  ];

  it("intercepts only report-discovery tool calls covered by the host inventory", () => {
    expect(
      interceptReportDiscoveryToolCall({
        toolName: "glob",
        args: { pattern: "**/材料分析.md" },
        reportInventory
      })
    ).toMatchObject({
      code: "REPORT_INVENTORY_ALREADY_PROVIDED",
      error: {
        code: "REPORT_INVENTORY_ALREADY_PROVIDED",
        message: expect.stringContaining("报告清单已提供")
      }
    });

    expect(
      interceptReportDiscoveryToolCall({
        toolName: "glob",
        args: { pattern: "templates/*.md" },
        reportInventory
      })
    ).toBeUndefined();
  });

  it("intercepts bash report discovery from the sandbox reports root", () => {
    const commands = [
      "ls",
      "dir",
      "find . -name \"*.md\"",
      "Get-ChildItem .",
      "Get-ChildItem",
      "wc -l *.md",
      "wc -l 材料分析.md"
    ];

    for (const command of commands) {
      expect(
        interceptReportDiscoveryToolCall({
          toolName: "bash",
          args: { command },
          reportDirectoryPaths: ["assets/books/book-1/reports", "reports"],
          reportInventory
        })
      ).toMatchObject({
        code: "REPORT_INVENTORY_ALREADY_PROVIDED",
        error: {
          code: "REPORT_INVENTORY_ALREADY_PROVIDED",
          message: expect.stringContaining("报告清单已提供")
        }
      });
    }

    expect(
      interceptReportDiscoveryToolCall({
        toolName: "bash",
        args: { command: "pnpm test" },
        reportDirectoryPaths: ["assets/books/book-1/reports", "reports"],
        reportInventory
      })
    ).toBeUndefined();
  });

  it("intercepts report discovery path variants without blocking unrelated markdown globs", () => {
    const interceptedCalls = [
      { toolName: "ls", args: { path: "reports/" } },
      { toolName: "ls", args: { path: "assets/books/book-1/reports/" } },
      { toolName: "glob", args: { pattern: "**/材料分析.MD" } }
    ];

    for (const call of interceptedCalls) {
      expect(
        interceptReportDiscoveryToolCall({
          ...call,
          reportDirectoryPaths: ["assets/books/book-1/reports", "reports"],
          reportInventory
        })
      ).toMatchObject({
        code: "REPORT_INVENTORY_ALREADY_PROVIDED",
        error: {
          message: expect.stringContaining("报告清单已提供")
        }
      });
    }

    expect(
      interceptReportDiscoveryToolCall({
        toolName: "glob",
        args: { pattern: "templates/*.md" },
        reportDirectoryPaths: ["assets/books/book-1/reports", "reports"],
        reportInventory
      })
    ).toBeUndefined();
  });

  it("adds the host-provided report inventory to the window prompt", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-report-inventory-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const requestBodies: Record<string, unknown>[] = [];
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角发现新的材料线索。", "utf8");
    await fs.writeFile(path.join(reportsRoot, "NPC性格与代表事件.md"), "# NPC性格与代表事件\n", "utf8");
    await fs.writeFile(path.join(reportsRoot, "势力设定.md"), "# 势力设定\n", "utf8");
    await fs.writeFile(path.join(reportsRoot, "材料分析.md"), "# 材料分析\n", "utf8");

    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const responseBody =
        requestBodies.length === 1
          ? createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-no-update-npc", "mark_no_update", {
                  path: "NPC性格与代表事件.md",
                  reason: "当前窗口没有新增 NPC 性格事件。"
                }),
                createToolCall("call-no-update-faction", "mark_no_update", {
                  path: "势力设定.md",
                  reason: "当前窗口没有新增势力设定。"
                }),
                createToolCall("call-no-update-material", "mark_no_update", {
                  path: "材料分析.md",
                  reason: "当前窗口没有新增材料信息。"
                }),
                createToolCall("call-no-update-causal", "mark_no_update", {
                  path: "事件因果链（长程因果图）.md",
                  reason: "当前窗口没有新增事件因果链。"
                })
              ]
            })
          : createChatCompletionResponse({ content: "窗口完成。" });
      return new Response(
        JSON.stringify(responseBody),
        {
          headers: { "Content-Type": "application/json" },
          status: 200
        }
      );
    });

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {},
      taskLogger: { append: vi.fn(async () => {}), setSecrets: vi.fn() } as any
    });

    await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [
          createTemplate({ id: "template-1", name: "NPC性格与代表事件", fileName: "NPC性格与代表事件.md" }),
          createTemplate({ id: "template-2", name: "势力设定", fileName: "势力设定.md" }),
          createTemplate({ id: "template-3", name: "材料分析", fileName: "材料分析.md" }),
          createTemplate({
            id: "template-4",
            name: "事件因果链（长程因果图）",
            fileName: "事件因果链（长程因果图）.md"
          })
        ]
      }),
      job: createWindowRunJob({
        templateBatchSize: 4,
        templateIds: ["template-1", "template-2", "template-3", "template-4"]
      })
    });

    const promptMessages = messagesOf(requestBodies[0]);
    const userPrompt = promptMessages.find((message) => message.role === "user")?.content;
    expect(userPrompt).toContain("已有报告：NPC性格与代表事件.md、势力设定.md、材料分析.md");
    expect(userPrompt).toContain("待创建报告：事件因果链（长程因果图）.md");
    expect(userPrompt).toContain("不要再调用搜索、目录或 shell 类工具查找这些报告是否存在");
    expect(userPrompt).toContain("已有报告先用 grep 在已知报告内定位关键词");
    expect(userPrompt).toMatch(/outputFileName: NPC性格与代表事件\.md[\s\S]*reportStatus: 已存在/u);
    expect(userPrompt).toMatch(/outputFileName: 事件因果链（长程因果图）\.md[\s\S]*reportStatus: 待创建/u);
    expect(userPrompt).toContain(
      "已有报告先用 grep 在已知报告内定位关键词或字段，再用 read_file 的 offset/limit 读取命中附近上下文，最后用 edit_file 或 multi_edit 做精确替换。"
    );
    expect(userPrompt).toContain(
      "待创建报告有可写入内容时，直接用 write_file 创建完整且合规的报告正文。"
    );
    expect(userPrompt).toContain("不要调用 read_report_excerpt 或 upsert_report_section。");
    expect(userPrompt).not.toContain("add_card");
    expect(userPrompt).not.toContain("replace_field");
  }, 20000);

  it("uses formal report file names instead of template file names when creating reports", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-formal-report-name-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const requestBodies: Record<string, unknown>[] = [];
    const registerReport = vi.fn(async () => {});
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-write-npc", "write_file", {
                path: "[报告]NPC性格与代表事件.md",
                content: "# NPC性格与代表事件\n\n### 韩立\n\n- 角色定位：山村少年。"
              }),
              createToolCall("call-write-world", "write_file", {
                path: "世界观.md",
                content: "# 世界观\n\n### 山村\n\n- 设定说明：故事起点。"
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      return new Response(
        JSON.stringify(createChatCompletionResponse({ content: "窗口完成。" })),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n韩立从山村出发。", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport,
      taskLogger: { append: vi.fn(async () => {}), setSecrets: vi.fn() } as any
    });

    await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [
          createTemplate({ id: "template-1", name: "NPC性格与代表事件模板", fileName: "NPC性格与代表事件模板.md" }),
          createTemplate({ id: "template-2", name: "世界观", fileName: "世界观.md" })
        ]
      }),
      job: createWindowRunJob({ templateBatchSize: 2, templateIds: ["template-1", "template-2"] })
    });

    const firstPrompt = messagesOf(requestBodies[0]).find((message) => message.role === "user")?.content;
    expect(firstPrompt).toContain("待创建报告：[报告]NPC性格与代表事件.md、世界观.md");
    expect(firstPrompt).toContain("outputFileName: [报告]NPC性格与代表事件.md");
    expect(firstPrompt).toContain("outputFileName: 世界观.md");
    await expect(fs.readFile(path.join(reportsRoot, "[报告]NPC性格与代表事件.md"), "utf8")).resolves.toContain("韩立");
    await expect(fs.readFile(path.join(reportsRoot, "世界观.md"), "utf8")).resolves.toContain("山村");
    expect(registerReport).toHaveBeenCalledWith({
      path: path.join(reportsRoot, "[报告]NPC性格与代表事件.md"),
      report: expect.objectContaining({
        fileName: "[报告]NPC性格与代表事件.md",
        reportKind: "template-output"
      })
    });
  }, 20000);

  it("limits each batched prompt report inventory to that batch", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-report-inventory-batch-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const requestBodies: Record<string, unknown>[] = [];
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const templates = [
      createTemplate({ id: "template-1", name: "报告一", fileName: "报告一.md" }),
      createTemplate({ id: "template-2", name: "报告二", fileName: "报告二.md" }),
      createTemplate({ id: "template-3", name: "报告三", fileName: "报告三.md" }),
      createTemplate({ id: "template-4", name: "报告四", fileName: "报告四.md" }),
      createTemplate({ id: "template-5", name: "报告五", fileName: "报告五.md" })
    ];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);
      const messages = messagesOf(body);
      const userPrompt = messages.find((message) => message.role === "user")?.content as string | undefined;
      const hasToolMessage = messages.some((message) => message.role === "tool");

      if (!hasToolMessage && typeof userPrompt === "string" && userPrompt.includes("报告一.md")) {
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: templates.slice(0, 3).map((template) =>
              createToolCall(`call-no-update-${template.id}`, "mark_no_update", {
                path: template.fileName,
                reason: `${template.name}当前窗口无新增。`
              })
            )
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      if (!hasToolMessage && typeof userPrompt === "string" && userPrompt.includes("报告四.md")) {
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: templates.slice(3).map((template) =>
              createToolCall(`call-no-update-${template.id}`, "mark_no_update", {
                path: template.fileName,
                reason: `${template.name}当前窗口无新增。`
              })
            )
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      return new Response(
        JSON.stringify(createChatCompletionResponse({ content: "窗口完成。" })),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {},
      taskLogger: { append: vi.fn(async () => {}), setSecrets: vi.fn() } as any
    });

    await service.runJobWindows({
      artifacts: createWindowArtifacts({ projectRoot, templates }),
      job: createWindowRunJob({ templateBatchSize: 3, templateIds: templates.map((template) => template.id) })
    });

    expect(requestBodies).toHaveLength(4);
    const promptTexts = requestBodies
      .map((body) => messagesOf(body).find((message) => message.role === "user")?.content)
      .filter((content): content is string => typeof content === "string");
    const firstPrompt = promptTexts.find((content) => content.includes("报告一.md"));
    const secondBatchPrompt = promptTexts.find((content) => content.includes("报告四.md"));
    expect(firstPrompt).toContain("报告一.md");
    expect(firstPrompt).toContain("报告三.md");
    expect(firstPrompt).not.toContain("报告四.md");
    expect(firstPrompt).not.toContain("报告五.md");
    expect(secondBatchPrompt).toContain("报告四.md");
    expect(secondBatchPrompt).toContain("报告五.md");
    expect(secondBatchPrompt).not.toContain("报告一.md");
  }, 20000);
});

describe("window run parallel template batches", () => {
  it("lets an unblocked batch enter window 2 while another batch is still finishing window 1", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-parallel-batches-"));
    scratchDirs.push(projectRoot);
    await fs.mkdir(path.join(projectRoot, "runs", "job-1", "windows"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt"), "第一章\n\n韩立出场。", "utf8");
    await fs.writeFile(path.join(projectRoot, "runs", "job-1", "windows", "window-0002.txt"), "第二章\n\n韩立继续前进。", "utf8");
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const templates = [
      createTemplate({ id: "template-1", name: "报告一", fileName: "报告一.md" }),
      createTemplate({ id: "template-2", name: "报告二", fileName: "报告二.md" })
    ];
    const delayedSecondBatchWindowOne = createDeferred<void>();
    const startedPromptKeys: string[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const messages = messagesOf(body);
      const userPrompt = messages.find((message) => message.role === "user")?.content as string | undefined;
      const hasToolMessage = messages.some((message) => message.role === "tool");
      if (!hasToolMessage && typeof userPrompt === "string" && userPrompt.includes("## 当前窗口文本")) {
        const template = userPrompt.includes("报告二.md") ? templates[1] : templates[0];
        const windowKey = userPrompt.includes("窗口序号：2/2") ? "window-2" : "window-1";
        const key = `${template.fileName}:${windowKey}`;
        startedPromptKeys.push(key);
        if (key === "报告二.md:window-1") {
          await delayedSecondBatchWindowOne.promise;
        }
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall(`call-no-update-${template.id}-${windowKey}`, "mark_no_update", {
                path: template.fileName,
                reason: `${template.name}在${windowKey}无新增。`
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      return new Response(JSON.stringify(createChatCompletionResponse({ content: "窗口完成。" })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });
    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {}
    });

    const runPromise = service.runJobWindows({
      artifacts: createWindowArtifacts({ projectRoot, templates, windowCount: 2 }),
      job: createWindowRunJob({ templateBatchSize: 1, templateIds: templates.map((template) => template.id) })
    });
    let assertionError: unknown;
    try {
      await vi.waitFor(() => expect(startedPromptKeys).toContain("报告一.md:window-2"));
    } catch (error) {
      assertionError = error;
    } finally {
      delayedSecondBatchWindowOne.resolve();
      await runPromise.catch(() => undefined);
    }

    if (assertionError) {
      throw assertionError;
    }
    expect(startedPromptKeys).toEqual(
      expect.arrayContaining([
        "报告一.md:window-1",
        "报告二.md:window-1",
        "报告一.md:window-2",
        "报告二.md:window-2"
      ])
    );
    expect(startedPromptKeys.indexOf("报告一.md:window-2")).toBeLessThan(
      startedPromptKeys.indexOf("报告二.md:window-2")
    );
  }, 20000);

  it("uses the service-level template batch retry interval for ordinary batch failures", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-batch-retry-"));
    scratchDirs.push(projectRoot);
    await writeSingleWindowText(projectRoot);
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const retryIntervalMs = 50;
    let requestCount = 0;
    let loggedRetryDelayMs: unknown;
    const fetch = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ error: { message: "temporary provider failure" } }), {
          headers: { "Content-Type": "application/json" },
          status: 500
        });
      }
      return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });
    const taskLogger = {
      append: vi.fn(async (sections: string[], entry?: Record<string, unknown>) => {
        if (sections.includes("批次重试")) {
          loggedRetryDelayMs = entry?.下次重试延迟毫秒;
        }
      }),
      setSecrets: vi.fn()
    };
    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {},
      taskLogger: taskLogger as any,
      templateBatchFailureRetryIntervalMs: retryIntervalMs
    });

    const runPromise = service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(loggedRetryDelayMs).toBe(retryIntervalMs));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), { timeout: 1000 });
    await expect(runPromise).resolves.toMatchObject({ ok: true });
  }, 20000);

  it("uses the Token Plan reset delay instead of the fixed batch retry interval", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-token-plan-retry-"));
    scratchDirs.push(projectRoot);
    await writeSingleWindowText(projectRoot);
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    let requestCount = 0;
    let loggedRetryDelayMs: unknown;
    const fetch = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(
          JSON.stringify({ error: { message: "已达到 Token Plan 用量上限" } }),
          { headers: { "Content-Type": "application/json" }, status: 500 }
        );
      }
      return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });
    const tokenPlanWaitGate = {
      getRemainingDelayMs: vi.fn(() => undefined),
      recordFailure: vi.fn(async () => 75)
    };
    let monotonicMs = 0;
    const runtimeStates: JobRuntimeState[] = [];
    const onTokenPlanWaitStarted = vi.fn(() => {
      monotonicMs = 75;
    });
    const onTokenPlanWaitEnded = vi.fn();
    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      monotonicNow: () => monotonicMs,
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async (state) => {
        runtimeStates.push(structuredClone(state));
      },
      onTokenPlanWaitStarted,
      onTokenPlanWaitEnded,
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {},
      taskLogger: {
        append: vi.fn(async (sections: string[], entry?: Record<string, unknown>) => {
          if (sections.includes("批次重试")) {
            loggedRetryDelayMs = entry?.下次重试延迟毫秒;
          }
        }),
        setSecrets: vi.fn()
      } as any,
      templateBatchFailureRetryIntervalMs: 10,
      tokenPlanWaitGate
    });

    await expect(
      service.runJobWindows({
        artifacts: createWindowArtifacts({
          projectRoot,
          templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
        }),
        job: createWindowRunJob({ templateIds: ["template-1"] })
      })
    ).resolves.toMatchObject({ ok: true });

    expect(tokenPlanWaitGate.recordFailure).toHaveBeenCalledTimes(1);
    expect(onTokenPlanWaitStarted).toHaveBeenCalledOnce();
    expect(onTokenPlanWaitEnded).toHaveBeenCalledOnce();
    expect(loggedRetryDelayMs).toBe(75);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(runtimeStates.at(-1)?.executedWindowElapsedMs).toBe(0);
  }, 20000);

  it("freezes each job independently when concurrent jobs wait for Token Plan reset", async () => {
    const projectRoots = await Promise.all([
      fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-token-plan-job-a-")),
      fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-token-plan-job-b-"))
    ]);
    scratchDirs.push(...projectRoots);
    await Promise.all(projectRoots.map(writeSingleWindowText));
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    let requestCount = 0;
    const fetch = vi.fn(async () => {
      requestCount += 1;
      if (requestCount <= 2) {
        return new Response(
          JSON.stringify({ error: { message: "已达到 Token Plan 用量上限" } }),
          { headers: { "Content-Type": "application/json" }, status: 500 }
        );
      }
      return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });
    const startedJobIds: string[] = [];
    const endedJobIds: string[] = [];
    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      onTokenPlanWaitStarted: ({ jobId }) => {
        startedJobIds.push(jobId);
      },
      onTokenPlanWaitEnded: ({ jobId }) => {
        endedJobIds.push(jobId);
      },
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {},
      tokenPlanWaitGate: {
        getRemainingDelayMs: vi.fn(() => undefined),
        recordFailure: vi.fn(async () => 200)
      }
    });

    await Promise.all(
      projectRoots.map((projectRoot, index) =>
        service.runJobWindows({
          artifacts: createWindowArtifacts({
            projectRoot,
            templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
          }),
          job: {
            ...createWindowRunJob({ templateIds: ["template-1"] }),
            id: `job-${index + 1}`
          }
        })
      )
    );

    expect(startedJobIds.sort()).toEqual(["job-1", "job-2"]);
    expect(endedJobIds.sort()).toEqual(["job-1", "job-2"]);
  }, 20000);

  it("writes separate batch coverage indexes and batch log files while preserving the global coverage index", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-batch-artifacts-"));
    scratchDirs.push(projectRoot);
    await writeSingleWindowText(projectRoot);
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const templates = [
      createTemplate({ id: "template-1", name: "报告一", fileName: "报告一.md" }),
      createTemplate({ id: "template-2", name: "报告二", fileName: "报告二.md" })
    ];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const messages = messagesOf(body);
      const userPrompt = messages.find((message) => message.role === "user")?.content as string | undefined;
      const hasToolMessage = messages.some((message) => message.role === "tool");
      if (!hasToolMessage && typeof userPrompt === "string" && userPrompt.includes("## 当前窗口文本")) {
        const template = userPrompt.includes("报告二.md") ? templates[1] : templates[0];
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall(`call-no-update-${template.id}`, "mark_no_update", {
                path: template.fileName,
                reason: `${template.name}当前窗口无新增。`
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      return new Response(JSON.stringify(createChatCompletionResponse({ content: "窗口完成。" })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });
    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {}
    });

    await service.runJobWindows({
      artifacts: createWindowArtifacts({ projectRoot, templates }),
      job: createWindowRunJob({ templateBatchSize: 1, templateIds: templates.map((template) => template.id) })
    });

    const globalCoverageIndex = JSON.parse(
      await fs.readFile(path.join(projectRoot, "metadata", "coverage", "coverage-index.json"), "utf8")
    ) as { records?: Array<{ outputFileName?: unknown; templateId?: unknown }> };
    expect(globalCoverageIndex.records?.map((record) => record.templateId)).toEqual(
      expect.arrayContaining(["template-1", "template-2"])
    );
    expect(globalCoverageIndex.records?.map((record) => record.outputFileName)).toEqual(
      expect.arrayContaining(["报告一.md", "报告二.md"])
    );
    await expect(
      fs.readFile(path.join(projectRoot, "metadata", "coverage", "jobs", "job-1", "batch-0001", "coverage-index.json"), "utf8")
    ).resolves.toContain("template-1");
    await expect(
      fs.readFile(path.join(projectRoot, "metadata", "coverage", "jobs", "job-1", "batch-0002", "coverage-index.json"), "utf8")
    ).resolves.toContain("template-2");

    const firstBatchLogDir = path.join(projectRoot, "runs", "job-1", "logs", "batches", "batch-0001");
    const secondBatchLogDir = path.join(projectRoot, "runs", "job-1", "logs", "batches", "batch-0002");
    await expect(fs.readdir(firstBatchLogDir)).resolves.toEqual(
      expect.arrayContaining([expect.stringContaining("batch-0001")])
    );
    await expect(fs.readdir(secondBatchLogDir)).resolves.toEqual(
      expect.arrayContaining([expect.stringContaining("batch-0002")])
    );
  }, 20000);

  it("mirrors concise parallel batch events into the job simple log with concrete chapter ranges", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-batch-brief-log-"));
    scratchDirs.push(projectRoot);
    await writeSingleWindowText(projectRoot);
    const clock = { now: () => "2026-07-01T00:00:00.000Z" };
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const templates = [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })];
    const artifacts = createWindowArtifacts({ projectRoot, templates });
    artifacts.runtimeWindowManifest.windows[0] = {
      ...artifacts.runtimeWindowManifest.windows[0],
      contextChapterRange: "1-10",
      submittedChapterRange: "1-10",
      contextChapterTitles: ["第一章", "第十章"],
      submittedChapterTitles: ["第一章", "第十章"]
    };
    const taskLogger = await createTaskTextLogger({
      clock,
      jobId: "job-1",
      projectRoot,
      taskInfo: "任务 job-1，书籍 测试小说，模型 mock-model，模板 1 个"
    });
    let requestCount = 0;
    const fetch = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
          headers: { "Content-Type": "application/json" },
          status: 429
        });
      }

      return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });
    const service = createWindowRunService({
      clock,
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {},
      taskLogger,
      templateBatchFailureRetryIntervalMs: 10
    });

    await expect(
      service.runJobWindows({
        artifacts,
        job: createWindowRunJob({ templateBatchSize: 1, templateIds: templates.map((template) => template.id) })
      })
    ).resolves.toMatchObject({ ok: true });

    const jobSimpleLog = await fs.readFile(taskLogger.simpleAbsolutePath, "utf8");
    expect(jobSimpleLog).toContain("覆盖索引预检：1 个窗口，0 个已覆盖，1 个待处理（[第1章-第10章]）");
    expect(jobSimpleLog).toContain("[执行中]：人物模板的[第1章-第10章]开始分析");
    expect(jobSimpleLog).toContain("[限流]：人物模板的[第1章-第10章]执行限流，1秒后再次尝试");
    expect(jobSimpleLog).toContain("[执行成功]：人物模板的[第1章-第10章]执行成功");
    expect(jobSimpleLog).not.toContain("请求模型：窗口");
    expect(jobSimpleLog).not.toContain("模型返回");

    const batchLogDir = path.join(projectRoot, "runs", "job-1", "logs", "batches", "batch-0001");
    const batchSimpleLogFile = (await fs.readdir(batchLogDir)).find((fileName) => fileName.endsWith(".simple.txt"));
    expect(batchSimpleLogFile).toBeDefined();
    const batchSimpleLog = await fs.readFile(path.join(batchLogDir, batchSimpleLogFile!), "utf8");
    expect(batchSimpleLog).toContain("请求模型：窗口 1/1，第 1 轮");
  }, 20000);
});

describe("window run Runtime facade controls", () => {
  it("pauses at a completed batch window boundary and resumes without starting a new window while paused", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-pause-boundary-"));
    scratchDirs.push(projectRoot);
    await fs.mkdir(path.join(projectRoot, "runs", "job-1", "windows"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt"), "第一章\n\n韩立出场。", "utf8");
    await fs.writeFile(path.join(projectRoot, "runs", "job-1", "windows", "window-0002.txt"), "第二章\n\n韩立继续前进。", "utf8");
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const firstWindowCanFinish = createDeferred<void>();
    const startedPrompts: string[] = [];
    const runtimeStates: JobRuntimeState[] = [];
    let monotonicMs = 0;
    let runtime!: JobRuntime;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const messages = messagesOf(body);
      const userPrompt = messages.find((message) => message.role === "user")?.content as string | undefined;
      const hasToolMessage = messages.some((message) => message.role === "tool");
      if (!hasToolMessage && typeof userPrompt === "string" && userPrompt.includes("## 当前窗口文本")) {
        const windowLabel = userPrompt.includes("窗口序号：2/2") ? "window-2" : "window-1";
        startedPrompts.push(windowLabel);
        if (windowLabel === "window-1") {
          await firstWindowCanFinish.promise;
        } else {
          monotonicMs += 120000;
        }
        return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
          headers: { "Content-Type": "application/json" },
          status: 200
        });
      }
      return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });
    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      monotonicNow: () => monotonicMs,
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeCreated: ({ runtime: createdRuntime }) => {
        runtime = createdRuntime;
      },
      onRuntimeState: async (state) => {
        runtimeStates.push(state);
      },
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {}
    });
    const runPromise = service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })],
        windowCount: 2
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    await vi.waitFor(() => expect(startedPrompts).toEqual(["window-1"]));
    await expect(runtime.pauseJob("job-1")).resolves.toEqual({ ok: true });
    monotonicMs = 90000;
    firstWindowCanFinish.resolve();
    await vi.waitFor(() => expect(runtime.getJobState("job-1")?.status).toBe("paused"));
    expect(startedPrompts).toEqual(["window-1"]);

    monotonicMs = 1000000;
    await expect(runtime.resumeJob("job-1")).resolves.toEqual({ ok: true });
    await expect(runPromise).resolves.toMatchObject({ ok: true });
    expect(startedPrompts).toEqual(["window-1", "window-2"]);
    expect(runtimeStates.at(-1)).toMatchObject({
      executedWindowCount: 2,
      executedWindowElapsedMs: 210000
    });
  }, 20000);

  it("defers delete terminal state until all parallel batch windows drain", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-delete-drain-"));
    scratchDirs.push(projectRoot);
    await writeSingleWindowText(projectRoot);
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const templates = [
      createTemplate({ id: "template-1", name: "报告一", fileName: "报告一.md" }),
      createTemplate({ id: "template-2", name: "报告二", fileName: "报告二.md" })
    ];
    const firstBatchStarted = createDeferred<void>();
    const firstBatchCanFinish = createDeferred<void>();
    const deleteRequestFinished = createDeferred<void>();
    const runtimeStatuses: string[] = [];
    const settledStatuses: string[] = [];
    let runtime!: JobRuntime;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const messages = messagesOf(body);
      const userPrompt = messages.find((message) => message.role === "user")?.content as string | undefined;
      const hasToolMessage = messages.some((message) => message.role === "tool");
      if (!hasToolMessage && typeof userPrompt === "string" && userPrompt.includes("## 当前窗口文本")) {
        if (userPrompt.includes("报告一.md")) {
          firstBatchStarted.resolve();
          await firstBatchCanFinish.promise;
        } else if (userPrompt.includes("报告二.md")) {
          await firstBatchStarted.promise;
          await expect(runtime.deleteJob("job-1")).resolves.toEqual({ ok: true });
          deleteRequestFinished.resolve();
        }
      }

      return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });
    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeCreated: ({ runtime: createdRuntime }) => {
        runtime = createdRuntime;
      },
      onRuntimeSettled: ({ jobId, runtime: settledRuntime }) => {
        settledStatuses.push(settledRuntime.getJobState(jobId)?.status ?? "missing");
      },
      onRuntimeState: async (state) => {
        runtimeStatuses.push(state.status);
      },
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {}
    });
    const runPromise = service.runJobWindows({
      artifacts: createWindowArtifacts({ projectRoot, templates }),
      job: createWindowRunJob({ templateBatchSize: 1, templateIds: templates.map((template) => template.id) })
    });

    let assertionError: unknown;
    await deleteRequestFinished.promise;
    try {
      expect(runtimeStatuses).not.toContain("deleted");
      expect(settledStatuses).toEqual([]);
    } catch (error) {
      assertionError = error;
    }
    firstBatchCanFinish.resolve();
    const result = await runPromise;
    if (assertionError) {
      throw assertionError;
    }

    expect(result).toMatchObject({ ok: true, state: { status: "deleted" } });
    expect(runtimeStatuses.filter((status) => status === "deleted")).toHaveLength(1);
    expect(settledStatuses).toEqual(["deleted"]);
  }, 20000);

  it.each([
    {
      action: "cancelJob" as const,
      requestedEvent: "job.cancel.requested",
      terminalEvent: "job.cancelled",
      terminalStatus: "cancelled"
    },
    {
      action: "deleteJob" as const,
      requestedEvent: undefined,
      terminalEvent: "job.deleted",
      terminalStatus: "deleted"
    }
  ])("does not let $action during batch retry sleep be swallowed by retry", async (caseInput) => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), `novel-extractor-window-${caseInput.action}-retry-`));
    scratchDirs.push(projectRoot);
    await writeSingleWindowText(projectRoot);
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    let runtime!: JobRuntime;
    const eventTypes: string[] = [];
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "temporary provider failure" } }), {
        headers: { "Content-Type": "application/json" },
        status: 500
      })
    );
    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeCreated: ({ runtime: createdRuntime }) => {
        runtime = createdRuntime;
        runtime.events.subscribe((event) => {
          eventTypes.push(event.type);
        });
      },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {},
      templateBatchFailureRetryIntervalMs: 60_000
    });

    const runPromise = service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await expect(runtime[caseInput.action]("job-1")).resolves.toEqual({ ok: true });
    const result = await runPromise;

    expect(result).toMatchObject({
      ok: true,
      state: { status: caseInput.terminalStatus }
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(eventTypes).toContain("job.started");
    if (caseInput.requestedEvent) {
      expect(eventTypes).toContain(caseInput.requestedEvent);
    }
    expect(eventTypes).toContain(caseInput.terminalEvent);
  }, 20000);

  it("waits for delete during batch retry sleep to settle before resolving deleteJob", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-delete-retry-settle-"));
    scratchDirs.push(projectRoot);
    await writeSingleWindowText(projectRoot);
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    let runtime!: JobRuntime;
    let deleteResolved = false;
    const runtimeStatuses: string[] = [];
    const allowDeletedStateSave = createDeferred<void>();
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "temporary provider failure" } }), {
        headers: { "Content-Type": "application/json" },
        status: 500
      })
    );
    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeCreated: ({ runtime: createdRuntime }) => {
        runtime = createdRuntime;
      },
      onRuntimeState: async (state) => {
        runtimeStatuses.push(state.status);
        if (state.status === "deleted") {
          await allowDeletedStateSave.promise;
        }
      },
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {},
      templateBatchFailureRetryIntervalMs: 60_000
    });

    const runPromise = service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    const deletePromise = runtime.deleteJob("job-1").then((result) => {
      deleteResolved = true;
      return result;
    });
    await vi.waitFor(() => expect(runtimeStatuses).toContain("deleted"));
    expect(deleteResolved).toBe(false);

    allowDeletedStateSave.resolve();
    await expect(deletePromise).resolves.toEqual({ ok: true });
    await expect(runPromise).resolves.toMatchObject({
      ok: true,
      state: { status: "deleted" }
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  }, 20000);

  it("wakes batch retry sleep when another batch fails with fatal_config", async () => {
    vi.useFakeTimers();
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-fatal-config-wake-"));
    scratchDirs.push(projectRoot);
    await writeSingleWindowText(projectRoot);
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const templates = [
      createTemplate({ id: "template-1", name: "报告一", fileName: "报告一.md" }),
      createTemplate({ id: "template-2", name: "报告二", fileName: "报告二.md" })
    ];
    const releaseFatalBatch = createDeferred<void>();
    const retryLogAppendEntered = createDeferred<void>();
    const retryLogAppendCanFinish = createDeferred<void>();
    const runtimeStatuses: string[] = [];
    const settledStatuses: string[] = [];
    const runResults: unknown[] = [];
    let firstBatchRetryLogCalls = 0;
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "temporary provider failure" } }), {
        headers: { "Content-Type": "application/json" },
        status: 500
      })
    );
    const append = vi.fn(async (tags: readonly string[], value: unknown) => {
      const record = value as { [key: string]: unknown };
      if (
        tags[0] === "上下文" &&
        tags[1] === "窗口" &&
        Array.isArray(record.模板) &&
        record.模板.some((template) => (template as { 模板ID?: unknown }).模板ID === "template-2")
      ) {
        await releaseFatalBatch.promise;
        throw new Error("task log failed");
      }
      if (tags[0] === "错误" && tags[1] === "批次重试" && record.批次ID === "batch-0001") {
        firstBatchRetryLogCalls += 1;
        if (firstBatchRetryLogCalls === 1) {
          retryLogAppendEntered.resolve();
          await retryLogAppendCanFinish.promise;
        }
      }
    });
    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeSettled: ({ jobId, runtime: settledRuntime }) => {
        settledStatuses.push(settledRuntime.getJobState(jobId)?.status ?? "missing");
      },
      onRuntimeState: async (state) => {
        runtimeStatuses.push(state.status);
      },
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {},
      taskLogger: { append, setSecrets: vi.fn() } as any,
      templateBatchFailureRetryIntervalMs: 60_000
    });

    const runPromise = service.runJobWindows({
      artifacts: createWindowArtifacts({ projectRoot, templates }),
      job: createWindowRunJob({ templateBatchSize: 1, templateIds: templates.map((template) => template.id) })
    });
    runPromise.then((result) => {
      runResults.push(result);
    });

    let assertionError: unknown;
    try {
      await retryLogAppendEntered.promise;
      retryLogAppendCanFinish.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(settledStatuses).toEqual([]);

      releaseFatalBatch.resolve();
      await vi.waitFor(() => expect(runResults).toHaveLength(1), { timeout: 1000 });

      expect(runResults[0]).toMatchObject({
        ok: false,
        error: {
          code: "job_failed",
          message: expect.stringContaining("task log failed")
        }
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(runtimeStatuses).toContain("failed");
      expect(settledStatuses).toEqual(["failed"]);
    } catch (error) {
      assertionError = error;
    } finally {
      releaseFatalBatch.resolve();
      retryLogAppendCanFinish.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
      await runPromise.catch(() => undefined);
      vi.useRealTimers();
    }

    if (assertionError) {
      throw assertionError;
    }
  }, 20000);

  it("wakes a paused batch gate when runtime progress persistence fails in another batch", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-progress-pause-wake-"));
    scratchDirs.push(projectRoot);
    await fs.mkdir(path.join(projectRoot, "runs", "job-1", "windows"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt"), "第一章\n\n主角整理旧资料。", "utf8");
    await fs.writeFile(path.join(projectRoot, "runs", "job-1", "windows", "window-0002.txt"), "第二章\n\n主角继续整理资料。", "utf8");
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const templates = [
      createTemplate({ id: "template-1", name: "报告一", fileName: "报告一.md" }),
      createTemplate({ id: "template-2", name: "报告二", fileName: "报告二.md" })
    ];
    const firstBatchWindowOneStarted = createDeferred<void>();
    const secondBatchWindowOneStarted = createDeferred<void>();
    const releaseFirstBatchWindowOne = createDeferred<void>();
    const releaseSecondBatchWindowOne = createDeferred<void>();
    const firstBatchProgressSaved = createDeferred<void>();
    const pausedStateSaved = createDeferred<void>();
    const progressStateSaveFailed = createDeferred<void>();
    const runResults: unknown[] = [];
    const runtimeStatuses: string[] = [];
    let runtime: JobRuntime | undefined;
    let progressStateFailureThrown = false;
    const requestKeys: string[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const userPrompt = messagesOf(body).find((message) => message.role === "user")?.content as string | undefined;
      const batchKey = typeof userPrompt === "string" && userPrompt.includes("报告二.md") ? "batch-0002" : "batch-0001";
      const windowKey = typeof userPrompt === "string" && userPrompt.includes("窗口序号：2/2") ? "window-2" : "window-1";
      requestKeys.push(`${batchKey}:${windowKey}`);
      if (batchKey === "batch-0001" && windowKey === "window-1") {
        firstBatchWindowOneStarted.resolve();
        await releaseFirstBatchWindowOne.promise;
      } else if (batchKey === "batch-0002" && windowKey === "window-1") {
        secondBatchWindowOneStarted.resolve();
        await releaseSecondBatchWindowOne.promise;
      }
      return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });
    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeCreated: ({ runtime: createdRuntime }) => {
        runtime = createdRuntime;
      },
      onRuntimeState: async (state) => {
        runtimeStatuses.push(state.status);
        if (state.status === "pause_requested" && state.completedWindowCount === 1) {
          firstBatchProgressSaved.resolve();
        }
        if (state.status === "paused") {
          pausedStateSaved.resolve();
        }
        if (!progressStateFailureThrown && state.completedWindowCount > 1) {
          await pausedStateSaved.promise;
          progressStateFailureThrown = true;
          progressStateSaveFailed.resolve();
          throw new Error("progress save failed");
        }
      },
      providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
      registerReport: () => {},
      templateBatchFailureRetryIntervalMs: 60_000
    });

    const runPromise = service.runJobWindows({
      artifacts: createWindowArtifacts({ projectRoot, templates, windowCount: 2 }),
      job: createWindowRunJob({ templateBatchSize: 1, templateIds: templates.map((template) => template.id) })
    });
    runPromise.then((result) => {
      runResults.push(result);
    });

    let assertionError: unknown;
    try {
      await firstBatchWindowOneStarted.promise;
      await secondBatchWindowOneStarted.promise;
      await expect(runtime?.pauseJob("job-1")).resolves.toEqual({ ok: true });
      releaseFirstBatchWindowOne.resolve();
      await firstBatchProgressSaved.promise;
      releaseSecondBatchWindowOne.resolve();
      await progressStateSaveFailed.promise;
      await vi.waitFor(() => expect(runResults).toHaveLength(1), { timeout: 100 });

      expect(runResults[0]).toMatchObject({
        ok: false,
        error: {
          code: "job_failed",
          message: expect.stringContaining("progress save failed")
        }
      });
      expect(requestKeys).toHaveLength(2);
      expect(requestKeys).toEqual(expect.arrayContaining(["batch-0001:window-1", "batch-0002:window-1"]));
      expect(requestKeys).not.toContain("batch-0001:window-2");
      expect(requestKeys).not.toContain("batch-0002:window-2");
      expect(runtimeStatuses).toContain("failed");
    } catch (error) {
      assertionError = error;
    } finally {
      releaseFirstBatchWindowOne.resolve();
      releaseSecondBatchWindowOne.resolve();
      if (runResults.length === 0) {
        await runtime?.cancelJob("job-1");
      }
      await runPromise.catch(() => undefined);
    }

    if (assertionError) {
      throw assertionError;
    }
  }, 20000);
});

describe("window run Reasonix tool loop integration", () => {
  it("returns a recoverable tool error when array arguments do not match the tool schema", async () => {
    const result = await runWindowWithMockToolCall({
      existingReports: {
        "[报告]NPC性格与代表事件.md": "# NPC性格与代表事件\n\n### 韩立\n\n- 核心性格：旧内容。\n"
      },
      toolCall: createToolCall("call-bad-updates", "upsert_report_section", {
        outputFileName: "[报告]NPC性格与代表事件.md",
        updates: "韩立,核心性格"
      }),
      expectToolResult: {
        toolName: "upsert_report_section",
        toolCallId: "call-bad-updates",
        assertContent: (content) => {
          const parsed = JSON.parse(content) as { hint?: string };
          expect(content).toContain("tool_schema_invalid_arguments");
          expect(content).toContain("$.updates 必须是数组");
          expect(content).not.toContain("updates must be a non-empty array");
          expect(parsed.hint).toContain("正确格式示例");
          expect(parsed.hint).toContain("edits 必须是真 JSON 数组");
          expect(parsed.hint).toContain('"path":"[报告]NPC性格与代表事件.md"');
          expect(parsed.hint).toContain("不要把数组写成字符串");
        }
      },
      enabledToolNames: legacyDesktopToolNames
    });

    expect(result.logText).toContain("tool_schema_invalid_arguments");
    expect(result.logText).toContain("$.updates 必须是数组");
    expect(result.logText).not.toContain("updates must be a non-empty array");
    expect(result.logText).toContain("正确格式示例");
    expect(result.logText).toContain("edits 必须是真 JSON 数组");
    expect(result.logText).toContain("edit_file");
    expect(result.logText).toContain("不要把数组写成字符串");
    expect(result.reportContents["[报告]NPC性格与代表事件.md"]).toBe(
      "# NPC性格与代表事件\n\n### 韩立\n\n- 核心性格：旧内容。\n"
    );
  });

  it("executes upsert_report_section when array arguments are JSON-stringified by the provider", async () => {
    const result = await runWindowWithMockToolCall({
      toolCall: createToolCall("call-stringified-updates", "upsert_report_section", {
        outputFileName: "[报告]NPC性格与代表事件.md",
        updates: JSON.stringify([
          {
            operation: "add_card",
            cardName: "韩立",
            content: "### 韩立\n\n- 核心性格：谨慎行事。"
          }
        ])
      }),
      expectToolResult: {
        toolName: "upsert_report_section",
        toolCallId: "call-stringified-updates",
        assertContent: (content) => {
          expect(content).toContain("\"changed\":true");
          expect(content).toContain("created_report_and_card");
          expect(content).not.toContain("tool_schema_invalid_arguments");
        }
      },
      enabledToolNames: legacyDesktopToolNames
    });

    expect(result.requestBodies).toHaveLength(2);
    expect(result.logText).not.toContain("$.updates 必须是数组");
    expect(result.reportContents["[报告]NPC性格与代表事件.md"]).toBe(
      "# [报告]NPC性格与代表事件\n\n### 韩立\n\n- 核心性格：谨慎行事。\n"
    );
  });

  it("executes edit_file when object arguments are concatenated JSON chunks", async () => {
    const result = await runWindowWithMockToolCall({
      existingReports: {
        "[报告]NPC性格与代表事件.md": "# NPC性格与代表事件\n\n### 韩立\n\n- 核心性格：旧内容。\n"
      },
      toolCalls: [
        createToolCall("call-grep-core-personality", "grep", {
          path: "[报告]NPC性格与代表事件.md",
          pattern: "核心性格"
        }),
        createRawToolCall(
          "call-edit-concatenated-json",
          "edit_file",
          '{}{"path":"[报告]NPC性格与代表事件.md","old_string":"- 核心性格：旧内容。","new_string":"- 核心性格：谨慎行事。"}'
        )
      ],
      expectToolResult: {
        toolName: "edit_file",
        toolCallId: "call-edit-concatenated-json",
        assertContent: (content) => {
          expect(content).toContain("edited ");
          expect(content).not.toContain("tool_schema_invalid_arguments");
          expect(content).not.toContain("$ 必须是对象");
        }
      }
    });

    expect(result.requestBodies).toHaveLength(2);
    expect(result.logText).not.toContain("tool_schema_invalid_arguments");
    expect(result.logText).not.toContain("$ 必须是对象");
    expect(result.reportContents["[报告]NPC性格与代表事件.md"]).toBe(
      "# NPC性格与代表事件\n\n### 韩立\n\n- 核心性格：谨慎行事。\n"
    );
  });

  it("redacts full current-window read_file results from detailed logs only", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-read-log-redaction-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const outputFileName = "人物.md";
    const requestBodies: Record<string, unknown>[] = [];
    const append = vi.fn(async () => {});
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-read-current-window", "read_file", {
                path: "window-0001.txt"
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      if (requestBodies.length === 2) {
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-mark-no-update", "mark_no_update", {
                path: outputFileName,
                reason: "当前窗口无新增。"
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      return new Response(
        JSON.stringify(createChatCompletionResponse({ content: "窗口完成。" })),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport: () => {},
      taskLogger: { append, setSecrets: vi.fn() } as any
    });

    const result = await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "人物", fileName: outputFileName })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(result).toMatchObject({ ok: true });
    expect(requestBodies).toHaveLength(3);
    expect(JSON.stringify(requestBodies[1])).toContain("1→第一章");
    expect(JSON.stringify(requestBodies[1])).toContain("3→主角整理旧资料。");

    const detailedLogCalls = JSON.stringify(append.mock.calls);
    expect(detailedLogCalls).toContain("[窗口原文见 window-0001.txt]");
    expect(detailedLogCalls).not.toContain("1→第一章");
    expect(detailedLogCalls).not.toContain("3→主角整理旧资料。");
    expect(detailedLogCalls).not.toContain("主角整理旧资料。");
  }, 20000);

  it("requires read_report_excerpt to read the same card field before field upsert on an existing report", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-field-upsert-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const outputFileName = "NPC性格与代表事件.md";
    const requestBodies: Record<string, unknown>[] = [];
    let blockedUpdateResult = "";
    const registerReport = vi.fn(async () => {});
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      const responseBody = (() => {
        if (requestBodies.length === 1) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-read-core-personality", "read_report_excerpt", {
                outputFileName,
                queries: [{ cardName: "韩立", fields: ["核心性格"] }]
              }),
              createToolCall("call-update-behavior-without-read", "upsert_report_section", {
                outputFileName,
                updates: [
                  {
                    cardName: "韩立",
                    fieldName: "代表行为",
                    content: "- 代表行为：本窗口新增的精准行为。"
                  }
                ]
              })
            ]
          });
        }

        if (requestBodies.length === 2) {
          blockedUpdateResult = requireToolResult(
            body,
            "upsert_report_section",
            "call-update-behavior-without-read"
          );
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-read-behavior", "read_report_excerpt", {
                outputFileName,
                queries: [{ cardName: "韩立", fields: ["代表行为"] }]
              }),
              createToolCall("call-update-behavior-after-read", "upsert_report_section", {
                outputFileName,
                updates: [
                  {
                    cardName: "韩立",
                    fieldName: "代表行为",
                    content: "- 代表行为：本窗口新增的精准行为。"
                  }
                ]
              })
            ]
          });
        }

        return createChatCompletionResponse({ content: "窗口完成。" });
      })();

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n韩立做出新的行动。", "utf8");
    await fs.writeFile(
      path.join(reportsRoot, outputFileName),
      "### 韩立\n- 角色定位：旧定位\n- 核心性格：旧性格\n- 代表行为：旧行为\n",
      "utf8"
    );

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => ({
        id: "report-1",
        bookId: "book-1",
        fileName: outputFileName,
        displayName: "NPC性格与代表事件",
        relativePath: `assets/books/book-1/reports/${outputFileName}`,
        reportKind: "template-output",
        templateId: "template-1",
        byteSize: 100,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }),
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport
    });

    await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "NPC性格与代表事件", fileName: outputFileName })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(requestBodies).toHaveLength(3);
    expect(blockedUpdateResult).toContain("已有报告不能直接更新字段");
    await expect(fs.readFile(path.join(reportsRoot, outputFileName), "utf8")).resolves.toContain(
      "- 代表行为：本窗口新增的精准行为。"
    );
    expect(registerReport).toHaveBeenCalledWith({
      path: path.join(reportsRoot, outputFileName),
      report: expect.objectContaining({
        fileName: outputFileName,
        reportKind: "template-output"
      })
    });
  }, 20000);

  it("requires read_report_excerpt before explicit replace_field upsert on an existing report", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-replace-field-upsert-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const outputFileName = "NPC性格与代表事件.md";
    const originalReport = "### 韩立\n- 角色定位：旧定位\n- 核心性格：旧性格\n- 代表行为：旧行为\n";
    const requestBodies: Record<string, unknown>[] = [];
    let blockedUpdateResult = "";
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-replace-behavior-without-read", "upsert_report_section", {
                outputFileName,
                updates: [
                  {
                    operation: "replace_field",
                    cardName: "韩立",
                    fieldName: "代表行为",
                    content: "- 代表行为：未预读时不应写入的新行为。"
                  }
                ]
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      if (requestBodies.length === 2) {
        blockedUpdateResult = requireToolResult(
          body,
          "upsert_report_section",
          "call-replace-behavior-without-read"
        );
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-mark-no-update-after-blocked-replace", "mark_no_update", {
                path: outputFileName,
                reason: "未预读既有字段，本窗口不更新。"
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      return new Response(
        JSON.stringify(createChatCompletionResponse({ content: "窗口完成。" })),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n韩立做出新的行动。", "utf8");
    await fs.writeFile(path.join(reportsRoot, outputFileName), originalReport, "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => ({
        id: "report-1",
        bookId: "book-1",
        fileName: outputFileName,
        displayName: "NPC性格与代表事件",
        relativePath: `assets/books/book-1/reports/${outputFileName}`,
        reportKind: "template-output",
        templateId: "template-1",
        byteSize: 100,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }),
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport: () => {}
    });

    const result = await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "NPC性格与代表事件", fileName: outputFileName })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(result).toMatchObject({ ok: true });
    expect(requestBodies).toHaveLength(3);
    expect(blockedUpdateResult).toContain("已有报告不能直接更新字段");
    expect(blockedUpdateResult).toContain("请先用 read_report_excerpt");
    await expect(fs.readFile(path.join(reportsRoot, outputFileName), "utf8")).resolves.toBe(originalReport);
  }, 20000);

  it("allows add_field on an existing report without pre-reading the same field", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-add-field-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const outputFileName = "NPC性格与代表事件.md";
    const requestBodies: Record<string, unknown>[] = [];
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-add-field-without-read", "upsert_report_section", {
                outputFileName,
                updates: [
                  {
                    operation: "add_field",
                    cardName: "韩立",
                    fieldName: "变化与后果",
                    content: "- 变化与后果：谨慎行动带来新的连锁后果。"
                  }
                ]
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      return new Response(
        JSON.stringify(createChatCompletionResponse({ content: "窗口完成。" })),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n韩立的谨慎行动带来新后果。", "utf8");
    await fs.writeFile(path.join(reportsRoot, outputFileName), "### 韩立\n- 核心性格：谨慎\n", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => ({
        id: "report-1",
        bookId: "book-1",
        fileName: outputFileName,
        displayName: "NPC性格与代表事件",
        relativePath: `assets/books/book-1/reports/${outputFileName}`,
        reportKind: "template-output",
        templateId: "template-1",
        byteSize: 100,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }),
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport: async () => {}
    });

    const result = await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "NPC性格与代表事件", fileName: outputFileName })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(result).toMatchObject({ ok: true });
    expect(requestBodies).toHaveLength(2);
    await expect(fs.readFile(path.join(reportsRoot, outputFileName), "utf8")).resolves.toContain(
      "- 变化与后果：谨慎行动带来新的连锁后果。"
    );
  }, 20000);

  it("does not let read_report_excerpt unlock edit_file for the whole existing report", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-field-read-edit-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const outputFileName = "NPC性格与代表事件.md";
    const initialReport = "### 韩立\n- 核心性格：旧性格\n- 代表行为：旧行为\n";
    const requestBodies: Record<string, unknown>[] = [];
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(
        JSON.stringify(createChatCompletionResponse({
          toolCalls: [
            createToolCall("call-read-core-personality", "read_report_excerpt", {
              outputFileName,
              queries: [{ cardName: "韩立", fields: ["核心性格"] }]
            }),
            createToolCall("call-edit-other-field", "edit_file", {
              path: outputFileName,
              old_string: "- 代表行为：旧行为",
              new_string: "- 代表行为：不应通过 edit_file 修改"
            })
          ]
        })),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n韩立做出新的行动。", "utf8");
    await fs.writeFile(path.join(reportsRoot, outputFileName), initialReport, "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => ({
        id: "report-1",
        bookId: "book-1",
        fileName: outputFileName,
        displayName: "NPC性格与代表事件",
        relativePath: `assets/books/book-1/reports/${outputFileName}`,
        reportKind: "template-output",
        templateId: "template-1",
        byteSize: Buffer.byteLength(initialReport, "utf8"),
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }),
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport: () => {}
    });

    const result = await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "NPC性格与代表事件", fileName: outputFileName })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(requestBodies).toHaveLength(1);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "job_failed",
        message: expect.stringContaining("请先用 grep")
      }
    });
    await expect(fs.readFile(path.join(reportsRoot, outputFileName), "utf8")).resolves.toBe(initialReport);
  }, 20000);

  it("rejects legacy read_report_excerpt keywords containing secrets without logging the raw secret", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-read-secret-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const outputFileName = "NPC性格与代表事件.md";
    const secret = "sk-window-loop";
    const append = vi.fn(async () => {});
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: secret
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify(createChatCompletionResponse({
          toolCalls: [
            createToolCall("call-read-secret-keyword", "read_report_excerpt", {
              outputFileName,
              keywords: [secret]
            })
          ]
        })),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      )
    );

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n韩立做出新的行动。", "utf8");
    await fs.writeFile(path.join(reportsRoot, outputFileName), "### 韩立\n- 核心性格：旧性格\n", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport: () => {},
      taskLogger: { append, setSecrets: vi.fn() } as any
    });

    const result = await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "NPC性格与代表事件", fileName: outputFileName })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "job_failed",
        message: expect.stringContaining("参数包含已知 secret")
      }
    });
    expect(JSON.stringify(append.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(append.mock.calls)).toContain("[REDACTED]");
  }, 20000);

  it("scans and redacts legacy upsert_report_section top-level content before rejecting the call", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-upsert-legacy-content-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const outputFileName = "NPC性格与代表事件.md";
    const secret = "sk-window-loop";
    const requestBodies: Record<string, unknown>[] = [];
    const append = vi.fn(async () => {});
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: secret
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      const responseBody = (() => {
        if (requestBodies.length === 1) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-legacy-upsert-content", "upsert_report_section", {
                outputFileName,
                sectionId: "NPC性格与代表事件/韩立",
                writeMode: "replace_section",
                content: `资料来自 runs/job-1，secret=${secret}`
              })
            ]
          });
        }

        if (requestBodies.length === 2) {
          return createChatCompletionResponse({
              toolCalls: [
                createToolCall("call-mark-no-update-after-legacy-upsert", "mark_no_update", {
                  path: outputFileName,
                  reason: "旧参数写入被内容守卫拒绝，本窗口不更新。"
                })
              ]
            });
        }

        return createChatCompletionResponse({ content: "窗口完成。" });
      })();

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n韩立做出新的行动。", "utf8");
    await fs.writeFile(path.join(reportsRoot, outputFileName), "### 韩立\n- 核心性格：旧性格\n", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport: () => {},
      taskLogger: { append, setSecrets: vi.fn() } as any
    });

    const result = await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "NPC性格与代表事件", fileName: outputFileName })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(result).toMatchObject({ ok: true });
    expect(requestBodies).toHaveLength(3);
    expect(JSON.stringify(requestBodies[1])).toContain("报告正文不得包含内部运行路径");
    expect(JSON.stringify(requestBodies[1])).toContain("正确格式示例");
    expect(JSON.stringify(requestBodies[1])).toContain("edits 必须是真 JSON 数组");
    expect(JSON.stringify(requestBodies[1])).toContain("不要把数组写成字符串");
    expect(JSON.stringify(requestBodies)).not.toContain(secret);
    expect(JSON.stringify(append.mock.calls)).not.toContain(secret);
  }, 20000);

  it("runs report content guard before returning existing add_field content", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-upsert-existing-secret-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const outputFileName = "NPC性格与代表事件.md";
    const secret = "sk-window-loop";
    const existingFieldContent = "既有字段正文不应被返回给模型";
    const requestBodies: Record<string, unknown>[] = [];
    const append = vi.fn(async () => {});
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: secret
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-add-existing-field-with-secret", "upsert_report_section", {
                outputFileName,
                updates: [
                  {
                    operation: "add_field",
                    cardName: "韩立",
                    fieldName: "核心性格",
                    content: `- 核心性格：资料来自 runs/job-1，secret=${secret}`
                  }
                ]
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      if (requestBodies.length === 2) {
        expect(requireToolResult(body, "upsert_report_section", "call-add-existing-field-with-secret")).toContain(
          "报告正文不得包含内部运行路径"
        );
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-mark-no-update-after-secret", "mark_no_update", {
                path: outputFileName,
                reason: "内容守卫拒绝，本窗口不更新。"
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      return new Response(
        JSON.stringify(createChatCompletionResponse({ content: "窗口完成。" })),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n韩立继续谨慎行事。", "utf8");
    await fs.writeFile(path.join(reportsRoot, outputFileName), `### 韩立\n- 核心性格：${existingFieldContent}\n`, "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport: () => {},
      taskLogger: { append, setSecrets: vi.fn() } as any
    });

    const result = await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "NPC性格与代表事件", fileName: outputFileName })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(result).toMatchObject({ ok: true });
    expect(requestBodies).toHaveLength(3);
    expect(JSON.stringify(requestBodies)).not.toContain(existingFieldContent);
    expect(JSON.stringify(append.mock.calls)).not.toContain(existingFieldContent);
    expect(JSON.stringify(requestBodies)).not.toContain(secret);
    expect(JSON.stringify(append.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(requestBodies)).toContain("报告正文不得包含内部运行路径");
    expect(JSON.stringify(append.mock.calls)).toContain("[REDACTED]");
  }, 20000);

  it("does not register unchanged add_field as a completed report write", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-add-field-unchanged-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const outputFileName = "NPC性格与代表事件.md";
    const requestBodies: Record<string, unknown>[] = [];
    const registerReport = vi.fn(async () => {});
    let firstToolResult = "";
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-add-existing-field", "upsert_report_section", {
                outputFileName,
                updates: [
                  {
                    operation: "add_field",
                    cardName: "韩立",
                    fieldName: "核心性格",
                    content: "- 核心性格：不应覆盖。"
                  }
                ]
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      if (requestBodies.length === 2) {
        firstToolResult = requireToolResult(body, "upsert_report_section", "call-add-existing-field");
        expect(firstToolResult).toContain("\"changed\":false");
        expect(firstToolResult).toContain("field_already_exists");
        expect(registerReport).toHaveBeenCalledTimes(0);
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-read-existing-field", "read_report_excerpt", {
                outputFileName,
                queries: [{ cardName: "韩立", fields: ["核心性格"] }]
              }),
              createToolCall("call-replace-existing-field", "upsert_report_section", {
                outputFileName,
                updates: [
                  {
                    operation: "replace_field",
                    cardName: "韩立",
                    fieldName: "核心性格",
                    content: "- 核心性格：更新后的内容"
                  }
                ]
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      return new Response(
        JSON.stringify(createChatCompletionResponse({ content: "窗口完成。" })),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n韩立的谨慎程度发生变化。", "utf8");
    await fs.writeFile(path.join(reportsRoot, outputFileName), "### 韩立\n- 核心性格：谨慎\n", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => ({
        id: "report-1",
        bookId: "book-1",
        fileName: outputFileName,
        displayName: "NPC性格与代表事件",
        relativePath: `assets/books/book-1/reports/${outputFileName}`,
        reportKind: "template-output",
        templateId: "template-1",
        byteSize: 100,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }),
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport
    });

    const result = await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "NPC性格与代表事件", fileName: outputFileName })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(firstToolResult).toContain("\"changed\":false");
    expect(firstToolResult).toContain("field_already_exists");
    expect(result).toMatchObject({ ok: true });
    expect(requestBodies).toHaveLength(3);
    expect(registerReport).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(path.join(reportsRoot, outputFileName), "utf8")).resolves.toContain(
      "- 核心性格：更新后的内容"
    );
  }, 20000);

  it("does not return benign existing add_field content to the model or task log", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-add-field-existing-safe-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const outputFileName = "NPC性格与代表事件.md";
    const existingFieldContent = "既有字段正文不应进入模型";
    const requestBodies: Record<string, unknown>[] = [];
    const append = vi.fn(async () => {});
    let firstToolResult = "";
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-add-existing-field-safe", "upsert_report_section", {
                outputFileName,
                updates: [
                  {
                    operation: "add_field",
                    cardName: "韩立",
                    fieldName: "核心性格",
                    content: "- 核心性格：本窗口只有安全新增文本。"
                  }
                ]
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      if (requestBodies.length === 2) {
        firstToolResult = requireToolResult(body, "upsert_report_section", "call-add-existing-field-safe");
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-mark-no-update-after-existing-field", "mark_no_update", {
                path: outputFileName,
                reason: "字段已存在，本窗口不覆盖。"
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      return new Response(
        JSON.stringify(createChatCompletionResponse({ content: "窗口完成。" })),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n韩立继续谨慎行事。", "utf8");
    await fs.writeFile(path.join(reportsRoot, outputFileName), `### 韩立\n- 核心性格：${existingFieldContent}\n`, "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => ({
        id: "report-1",
        bookId: "book-1",
        fileName: outputFileName,
        displayName: "NPC性格与代表事件",
        relativePath: `assets/books/book-1/reports/${outputFileName}`,
        reportKind: "template-output",
        templateId: "template-1",
        byteSize: 100,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }),
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport: () => {},
      taskLogger: { append, setSecrets: vi.fn() } as any
    });

    const result = await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "NPC性格与代表事件", fileName: outputFileName })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(result).toMatchObject({ ok: true });
    expect(firstToolResult).toContain("\"changed\":false");
    expect(firstToolResult).toContain("field_already_exists");
    expect(firstToolResult).toContain("\"existingContentRedacted\":true");
    expect(firstToolResult).toContain(`"existingContentLength":${`- 核心性格：${existingFieldContent}\n`.length}`);
    expect(firstToolResult).not.toContain(existingFieldContent);
    expect(JSON.stringify(requestBodies)).not.toContain(existingFieldContent);
    expect(JSON.stringify(append.mock.calls)).not.toContain(existingFieldContent);
  }, 20000);

  it("uses upsert operations in the correction message after unchanged add_field without a final outcome", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-add-field-correction-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const outputFileName = "NPC性格与代表事件.md";
    const requestBodies: Record<string, unknown>[] = [];
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-add-existing-field", "upsert_report_section", {
                outputFileName,
                updates: [
                  {
                    operation: "add_field",
                    cardName: "韩立",
                    fieldName: "核心性格",
                    content: "- 核心性格：不应覆盖。"
                  }
                ]
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      if (requestBodies.length === 2) {
        expect(requireToolResult(body, "upsert_report_section", "call-add-existing-field")).toContain(
          "\"changed\":false"
        );
        return new Response(
          JSON.stringify(createChatCompletionResponse({ content: "窗口完成。" })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      if (requestBodies.length === 3) {
        return new Response(
          JSON.stringify(createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-mark-no-update-after-correction", "mark_no_update", {
                path: outputFileName,
                reason: "本窗口没有可写入的新信息。"
              })
            ]
          })),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        );
      }

      return new Response(
        JSON.stringify(createChatCompletionResponse({ content: "窗口完成。" })),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n韩立继续谨慎行事。", "utf8");
    await fs.writeFile(path.join(reportsRoot, outputFileName), "### 韩立\n- 核心性格：谨慎\n", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => ({
        id: "report-1",
        bookId: "book-1",
        fileName: outputFileName,
        displayName: "NPC性格与代表事件",
        relativePath: `assets/books/book-1/reports/${outputFileName}`,
        reportKind: "template-output",
        templateId: "template-1",
        byteSize: 100,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }),
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport: async () => {}
    });

    await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "NPC性格与代表事件", fileName: outputFileName })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(requestBodies).toHaveLength(4);
    const correctionPrompt = JSON.stringify(requestBodies[2]);
    expect(correctionPrompt).toContain("upsert_report_section");
    expect(correctionPrompt).toContain("add_card");
    expect(correctionPrompt).toContain("add_field");
    expect(correctionPrompt).toContain("replace_field");
    expect(correctionPrompt).not.toContain("write_file/edit_file/multi_edit 写入正式报告");
  }, 20000);

  it("sends the full Reasonix tool protocol to the model and executes the bash job family through the desktop loop", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-loop-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const requestBodies: Record<string, unknown>[] = [];
    const append = vi.fn(async () => {});
    let backgroundJobId = "";
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = {
      id: "provider-1",
      presetId: "custom-openai-compatible" as const,
      displayName: "Mock Provider",
      kind: "openai-compatible" as const,
      baseUrl: "https://mock.local/v1",
      apiKeyRef,
      models: [{ id: "mock-model", displayName: "mock-model", enabled: true, isDefault: true }],
      enabled: true
    };
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      const responseBody = (() => {
        if (requestBodies.length === 1) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-bash", "bash", {
                command: "node -e \"console.log('desktop-bash-ready'); setInterval(() => {}, 1000)\"",
                run_in_background: true
              })
            ]
          });
        }

        if (requestBodies.length === 2) {
          const bashResult = requireToolResult(body, "bash", "call-bash");
          backgroundJobId = extractBackgroundJobId(bashResult);
          return createChatCompletionResponse({
            toolCalls: [createToolCall("call-bash-output", "bash_output", { job_id: backgroundJobId })]
          });
        }

        if (requestBodies.length === 3) {
          requireToolResult(body, "bash_output", "call-bash-output");
          return createChatCompletionResponse({
            toolCalls: [createToolCall("call-kill-shell", "kill_shell", { job_id: backgroundJobId })]
          });
        }

        if (requestBodies.length === 4) {
          requireToolResult(body, "kill_shell", "call-kill-shell");
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-mark-no-update", "mark_no_update", {
                path: "人物.md",
                reason: "bash 背景任务族已完成验证，当前窗口没有人物新增信息。"
              })
            ]
          });
        }

        return createChatCompletionResponse({ content: "窗口完成。" });
      })();

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: {
        async listProviderConfigs() {
          return [providerConfig];
        },
        async saveProviderConfig(config) {
          return config;
        }
      },
      registerReport: () => {},
      taskLogger: { append, setSecrets: vi.fn() } as any
    });

    await service.runJobWindows({
      artifacts: {
        book: {
          id: "book-1",
          projectId: "project-1",
          displayName: "测试小说",
          sourceAssetId: "source-1",
          sourceTextPath: "assets/books/book-1/source/original.txt",
          chapterCount: 1,
          createdAt: "2026-07-01T00:00:00.000Z"
        },
        project: {
          id: "project-1",
          displayName: "测试项目",
          slug: "test-project",
          rootPath: projectRoot,
          createdAt: "2026-07-01T00:00:00.000Z"
        },
        runtimeWindowManifest: {
          jobId: "job-1",
          bookId: "book-1",
          sourceTextPath: "assets/books/book-1/source/original.txt",
          sourceTextHash: sha256("source"),
          splitConfigHash: sha256("split"),
          splitterVersion: "test",
          generatedAt: "2026-07-01T00:00:00.000Z",
          totalDetectedChapterCount: 1,
          windows: [
            {
              windowId: "window-1",
              index: 0,
              fileName: "window-0001.txt",
              textPath: "runs/job-1/windows/window-0001.txt",
              windowHash: sha256("第一章\n\n主角整理旧资料。"),
              contextChapterRange: "1",
              submittedChapterRange: "1",
              contextChapterTitles: ["第一章"],
              submittedChapterTitles: ["第一章"],
              characterCount: "第一章\n\n主角整理旧资料。".length
            }
          ]
        },
        rulesSnapshotPath: "runs/job-1/rules.json",
        templates: [
          {
            id: "template-1",
            scope: "project",
            projectId: "project-1",
            name: "人物",
            fileName: "人物.md",
            body: "记录人物变化。",
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z"
          }
        ]
      },
      job: {
        id: "job-1",
        bookId: "book-1",
        input: {
          modelId: "mock-model",
          providerConfigId: "provider-1",
          skipAlreadyExtracted: false,
          templateBatchSize: 1,
          templateIds: ["template-1"]
        }
      }
    });

    expect(requestBodies).toHaveLength(5);
    const expectedToolNames = [...reasonixToolOrder, "mark_no_update"];
    const firstTools = requestBodies[0].tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
    expect(firstTools.map((tool) => tool.function.name)).toEqual(expectedToolNames);
    const toolsByName = new Map(firstTools.map((tool) => [tool.function.name, tool.function]));
    expect(toolsByName.get("bash")?.parameters).toMatchObject({
      properties: {
        command: { type: "string" },
        run_in_background: { type: "boolean" },
        preserve_background_processes: { type: "boolean" }
      },
      required: ["command"],
      type: "object"
    });
    expect(toolsByName.get("bash_output")?.parameters).toMatchObject({ required: ["job_id"] });
    expect(toolsByName.get("wait")?.parameters).toMatchObject({ properties: { job_ids: { items: { type: "string" } } } });
    expect(toolsByName.get("kill_shell")?.parameters).toMatchObject({ required: ["job_id"] });

    expect(backgroundJobId).toMatch(/^bash-\d+$/u);

    const secondMessages = messagesOf(requestBodies[1]);
    expect(secondMessages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        name: "bash",
        tool_call_id: "call-bash",
        content: expect.stringContaining(`Started background job "${backgroundJobId}"`)
      })
    );

    const thirdMessages = messagesOf(requestBodies[2]);
    expect(thirdMessages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        name: "bash_output",
        tool_call_id: "call-bash-output",
        content: expect.stringContaining(`[${backgroundJobId}]`)
      })
    );

    const fourthMessages = messagesOf(requestBodies[3]);
    expect(fourthMessages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        name: "kill_shell",
        tool_call_id: "call-kill-shell",
        content: expect.stringContaining(`background job "${backgroundJobId}"`)
      })
    );

    const fifthMessages = messagesOf(requestBodies[4]);
    expect(fifthMessages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        name: "mark_no_update",
        tool_call_id: "call-mark-no-update",
        content: expect.stringContaining("marked no update for 人物.md")
      })
    );
    expect(append).toHaveBeenCalledWith(
      ["大模型请求", "Prompt"],
      expect.objectContaining({
        窗口: "1/1",
        批次: "1/1",
        轮次: 1,
        模型: "mock-model"
      })
    );
    expect(append).toHaveBeenCalledWith(
      ["工具返回", "mark_no_update"],
      expect.objectContaining({
        实际执行输入: expect.objectContaining({ path: "人物.md" }),
        是否可恢复错误: false
      })
    );
    expect(append).toHaveBeenCalledWith(
      ["上下文", "批次结果"],
      expect.objectContaining({
        窗口: "1/1",
        处理结果: expect.any(Array)
      })
    );
  }, 20000);

  it("returns foreground bash failure output to the model so the desktop loop can recover", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-bash-failure-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const requestBodies: Record<string, unknown>[] = [];
    const registerReport = vi.fn(async () => {});
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = {
      id: "provider-1",
      presetId: "custom-openai-compatible" as const,
      displayName: "Mock Provider",
      kind: "openai-compatible" as const,
      baseUrl: "https://mock.local/v1",
      apiKeyRef,
      models: [{ id: "mock-model", displayName: "mock-model", enabled: true, isDefault: true }],
      enabled: true
    };
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      const responseBody = (() => {
        if (requestBodies.length === 1) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-bash-fails", "bash", {
                command: "node -e \"console.log('before'); process.exit(7)\""
              })
            ]
          });
        }

        if (requestBodies.length === 2) {
          const bashResult = requireToolResult(body, "bash", "call-bash-fails");
          expect(bashResult).toContain("before");
          expect(bashResult).toContain("command exited");
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-write-after-bash-failure", "write_file", {
                path: "人物.md",
                content: "# 人物\n\nbash 失败输出可见后改用写文件收口。\n"
              })
            ]
          });
        }

        return createChatCompletionResponse({ content: "窗口完成。" });
      })();

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: {
        async listProviderConfigs() {
          return [providerConfig];
        },
        async saveProviderConfig(config) {
          return config;
        }
      },
      registerReport
    });

    await service.runJobWindows({
      artifacts: {
        book: {
          id: "book-1",
          projectId: "project-1",
          displayName: "测试小说",
          sourceAssetId: "source-1",
          sourceTextPath: "assets/books/book-1/source/original.txt",
          chapterCount: 1,
          createdAt: "2026-07-01T00:00:00.000Z"
        },
        project: {
          id: "project-1",
          displayName: "测试项目",
          slug: "test-project",
          rootPath: projectRoot,
          createdAt: "2026-07-01T00:00:00.000Z"
        },
        runtimeWindowManifest: {
          jobId: "job-1",
          bookId: "book-1",
          sourceTextPath: "assets/books/book-1/source/original.txt",
          sourceTextHash: sha256("source"),
          splitConfigHash: sha256("split"),
          splitterVersion: "test",
          generatedAt: "2026-07-01T00:00:00.000Z",
          totalDetectedChapterCount: 1,
          windows: [
            {
              windowId: "window-1",
              index: 0,
              fileName: "window-0001.txt",
              textPath: "runs/job-1/windows/window-0001.txt",
              windowHash: sha256("第一章\n\n主角整理旧资料。"),
              contextChapterRange: "1",
              submittedChapterRange: "1",
              contextChapterTitles: ["第一章"],
              submittedChapterTitles: ["第一章"],
              characterCount: "第一章\n\n主角整理旧资料。".length
            }
          ]
        },
        rulesSnapshotPath: "runs/job-1/rules.json",
        templates: [
          {
            id: "template-1",
            scope: "project",
            projectId: "project-1",
            name: "人物",
            fileName: "人物.md",
            body: "记录人物变化。",
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z"
          }
        ]
      },
      job: {
        id: "job-1",
        bookId: "book-1",
        input: {
          modelId: "mock-model",
          providerConfigId: "provider-1",
          skipAlreadyExtracted: false,
          templateBatchSize: 1,
          templateIds: ["template-1"]
        }
      }
    });

    expect(requestBodies).toHaveLength(3);
    await expect(fs.readFile(path.join(reportsRoot, "人物.md"), "utf8")).resolves.toContain("bash 失败输出可见");
    expect(registerReport).toHaveBeenCalledWith({
      path: path.join(reportsRoot, "人物.md"),
      report: expect.objectContaining({
        fileName: "人物.md",
        reportKind: "template-output"
      })
    });
  }, 20000);

  it("does not mask the original window error when reason-summary logging fails", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-summary-failure-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async () => {
      const responseBody = createChatCompletionResponse({
        toolCalls: [
          createToolCall("call-absolute-write", "write_file", {
            path: "C:\\outside\\人物.md",
            content: "# 人物\n\n不应写入。"
          })
        ]
      });

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });
    const append = vi.fn(async (tags: readonly string[]) => {
      if (tags[0] === "上下文" && tags[1] === "多轮原因汇总") {
        throw new Error("summary log failed");
      }
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport: () => {},
      taskLogger: { append, setSecrets: vi.fn() } as any
    });

    const result = await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "job_failed",
        message: expect.stringMatching(/写工具 write_file 的 path 必须属于本轮选中模板 outputFileName/u)
      }
    });
    const errorMessage = result.ok === false && result.error.code === "job_failed" ? result.error.message : "";
    expect(errorMessage).not.toContain("summary log failed");
  }, 20000);

  it("does not expose real reports symlink targets inside the initial bash sandbox", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-bash-symlink-"));
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-external-"));
    scratchDirs.push(projectRoot, externalRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const externalSecretPath = path.join(externalRoot, "secret.txt");
    const requestBodies: Record<string, unknown>[] = [];
    let bashReadResult = "";
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      const responseBody = (() => {
        if (requestBodies.length === 1) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-read-symlink-report", "bash", {
                command:
                  "node -e \"const fs=require('fs'); try { console.log(fs.readFileSync('人物.md','utf8')); } catch (error) { console.log('READ_FAILED:' + (error.code || error.message)); } try { fs.unlinkSync('人物.md'); } catch {}\""
              })
            ]
          });
        }

        if (requestBodies.length === 2) {
          bashReadResult = requireToolResult(body, "bash", "call-read-symlink-report");
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-mark-no-update-after-symlink-read", "mark_no_update", {
                path: "人物.md",
                reason: "当前窗口没有人物新增信息。"
              })
            ]
          });
        }

        return createChatCompletionResponse({ content: "窗口完成。" });
      })();

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");
    await fs.writeFile(externalSecretPath, "SECRET_OUTSIDE_REPORTS", "utf8");
    await fs.symlink(externalSecretPath, path.join(reportsRoot, "人物.md"), "file");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport: () => {}
    });

    await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(requestBodies).toHaveLength(3);
    expect(bashReadResult).toContain("READ_FAILED");
    expect(bashReadResult).not.toContain("SECRET_OUTSIDE_REPORTS");
  }, 20000);

  it("does not let unselected unsafe real reports break bash report resync after a selected write", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-unselected-symlink-"));
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-external-"));
    scratchDirs.push(projectRoot, externalRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const externalSecretPath = path.join(externalRoot, "secret.txt");
    const requestBodies: Record<string, unknown>[] = [];
    let bashWriteResult = "";
    const registerReport = vi.fn(async () => {});
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      const responseBody = (() => {
        if (requestBodies.length === 1) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-bash-write-selected-report", "bash", {
                command: "node -e \"require('fs').writeFileSync('人物.md','OK'); console.log('BASH_OK')\""
              })
            ]
          });
        }

        if (requestBodies.length === 2) {
          bashWriteResult = requireToolResult(body, "bash", "call-bash-write-selected-report");
          return createChatCompletionResponse({ content: "窗口完成。" });
        }

        return createChatCompletionResponse({ content: "窗口完成。" });
      })();

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");
    await fs.writeFile(externalSecretPath, "SECRET_OUTSIDE_REPORTS", "utf8");
    await fs.symlink(externalSecretPath, path.join(reportsRoot, "地点.md"), "file");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport
    });

    await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(requestBodies).toHaveLength(2);
    expect(bashWriteResult).toContain("BASH_OK");
    await expect(fs.readFile(path.join(reportsRoot, "人物.md"), "utf8")).resolves.toBe("OK");
    await expect(fs.readFile(externalSecretPath, "utf8")).resolves.toBe("SECRET_OUTSIDE_REPORTS");
    expect(registerReport).toHaveBeenCalledWith({
      path: path.join(reportsRoot, "人物.md"),
      report: expect.objectContaining({
        fileName: "人物.md",
        reportKind: "template-output"
      })
    });
  }, 20000);

  it("returns report sync rejection with foreground bash output when selected real report is unsafe", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-selected-symlink-"));
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-external-"));
    scratchDirs.push(projectRoot, externalRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const externalSecretPath = path.join(externalRoot, "secret.txt");
    const requestBodies: Record<string, unknown>[] = [];
    let bashWriteResult = "";
    const registerReport = vi.fn(async () => {});
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      const responseBody = (() => {
        if (requestBodies.length === 1) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-bash-write-selected-symlink-report", "bash", {
                command: "node -e \"require('fs').writeFileSync('人物.md','NEW'); console.log('BASH_WROTE')\""
              })
            ]
          });
        }

        if (requestBodies.length === 2) {
          bashWriteResult = requireToolResult(body, "bash", "call-bash-write-selected-symlink-report");
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-mark-no-update-after-sync-rejection", "mark_no_update", {
                path: "人物.md",
                reason: "bash report_sync 拒绝后本轮不再更新人物。"
              })
            ]
          });
        }

        return createChatCompletionResponse({ content: "窗口完成。" });
      })();

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");
    await fs.writeFile(externalSecretPath, "SECRET_OUTSIDE_REPORTS", "utf8");
    await fs.symlink(externalSecretPath, path.join(reportsRoot, "人物.md"), "file");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport
    });

    await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(requestBodies).toHaveLength(3);
    expect(bashWriteResult).toContain("BASH_WROTE");
    expect(bashWriteResult).toContain("report_sync");
    expect(bashWriteResult).toContain("拒绝覆盖 reports 中的非普通文件");
    await expect(fs.readFile(externalSecretPath, "utf8")).resolves.toBe("SECRET_OUTSIDE_REPORTS");
    expect(registerReport).not.toHaveBeenCalled();
  }, 20000);

  it("removes rejected selected unsafe report writes from the bash sandbox before later bash reads", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-selected-symlink-refresh-"));
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-external-"));
    scratchDirs.push(projectRoot, externalRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const externalSecretPath = path.join(externalRoot, "secret.txt");
    const requestBodies: Record<string, unknown>[] = [];
    let bashWriteResult = "";
    let bashReadAfterRejectedSync = "";
    const registerReport = vi.fn(async () => {});
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      const responseBody = (() => {
        if (requestBodies.length === 1) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-bash-write-selected-symlink-report", "bash", {
                command: "node -e \"require('fs').writeFileSync('人物.md','NEW_REJECTED'); console.log('BASH_WROTE')\""
              })
            ]
          });
        }

        if (requestBodies.length === 2) {
          bashWriteResult = requireToolResult(body, "bash", "call-bash-write-selected-symlink-report");
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-bash-read-after-rejected-sync", "bash", {
                command:
                  "node -e \"const fs=require('fs'); try { console.log(fs.readFileSync('人物.md','utf8')); } catch (error) { console.log('READ_FAILED:' + (error.code || error.message)); }\""
              })
            ]
          });
        }

        if (requestBodies.length === 3) {
          bashReadAfterRejectedSync = requireToolResult(body, "bash", "call-bash-read-after-rejected-sync");
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-mark-no-update-after-rejected-read", "mark_no_update", {
                path: "人物.md",
                reason: "bash 拒绝同步后 sandbox 已恢复不可读，本窗口不更新人物。"
              })
            ]
          });
        }

        return createChatCompletionResponse({ content: "窗口完成。" });
      })();

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");
    await fs.writeFile(externalSecretPath, "SECRET_OUTSIDE_REPORTS", "utf8");
    await fs.symlink(externalSecretPath, path.join(reportsRoot, "人物.md"), "file");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport
    });

    await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(requestBodies).toHaveLength(4);
    expect(bashWriteResult).toContain("BASH_WROTE");
    expect(bashWriteResult).toContain("report_sync");
    expect(bashWriteResult).toContain("拒绝覆盖 reports 中的非普通文件");
    expect(bashReadAfterRejectedSync).toContain("READ_FAILED");
    expect(bashReadAfterRejectedSync).not.toContain("NEW_REJECTED");
    expect(bashReadAfterRejectedSync).not.toContain("report_sync");
    await expect(fs.readFile(externalSecretPath, "utf8")).resolves.toBe("SECRET_OUTSIDE_REPORTS");
    expect(registerReport).not.toHaveBeenCalled();
  }, 20000);

  it("returns a recoverable tool result when non-bash write targets a selected unsafe real report", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-nonbash-symlink-"));
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-external-"));
    scratchDirs.push(projectRoot, externalRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const externalSecretPath = path.join(externalRoot, "secret.txt");
    const requestBodies: Record<string, unknown>[] = [];
    let writeResult = "";
    const registerReport = vi.fn(async () => {});
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      const responseBody = (() => {
        if (requestBodies.length === 1) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-write-selected-symlink-report", "write_file", {
                path: "人物.md",
                content: "# 人物\n\nNEW"
              })
            ]
          });
        }

        if (requestBodies.length === 2) {
          writeResult = requireToolResult(body, "write_file", "call-write-selected-symlink-report");
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-mark-no-update-after-unsafe-write", "mark_no_update", {
                path: "人物.md",
                reason: "非 bash 写入 unsafe 真实报告被拒绝，本窗口不更新人物。"
              })
            ]
          });
        }

        return createChatCompletionResponse({ content: "窗口完成。" });
      })();

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");
    await fs.writeFile(externalSecretPath, "SECRET_OUTSIDE_REPORTS", "utf8");
    await fs.symlink(externalSecretPath, path.join(reportsRoot, "人物.md"), "file");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport
    });

    await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" })]
      }),
      job: createWindowRunJob({ templateIds: ["template-1"] })
    });

    expect(requestBodies).toHaveLength(3);
    expect(writeResult).toContain("UNSAFE_PATH");
    await expect(fs.readFile(externalSecretPath, "utf8")).resolves.toBe("SECRET_OUTSIDE_REPORTS");
    expect(registerReport).not.toHaveBeenCalled();
  }, 20000);

  it("preserves pending background bash report edits when a non-bash write updates another report", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-bg-preserve-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const requestBodies: Record<string, unknown>[] = [];
    let backgroundJobId = "";
    let bashReadAfterNonBashWrite = "";
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = createProviderConfig(apiKeyRef);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      const responseBody = await (async () => {
        if (requestBodies.length === 1) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-start-pending-bash-write", "bash", {
                command:
                  "node -e \"const fs=require('fs'); setTimeout(()=>fs.writeFileSync('人物.md','BG_PENDING'),250); setInterval(()=>{},1000);\"",
                run_in_background: true
              })
            ]
          });
        }

        if (requestBodies.length === 2) {
          const bashResult = requireToolResult(body, "bash", "call-start-pending-bash-write");
          backgroundJobId = extractBackgroundJobId(bashResult);
          await new Promise((resolve) => setTimeout(resolve, 600));
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-write-other-report", "write_file", {
                path: "地点.md",
                content: "# 地点\n\nNON_BASH_WRITE\n"
              })
            ]
          });
        }

        if (requestBodies.length === 3) {
          requireToolResult(body, "write_file", "call-write-other-report");
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-read-pending-bash-report", "bash", {
                command: "node -e \"const fs=require('fs'); console.log(fs.readFileSync('人物.md','utf8'))\""
              })
            ]
          });
        }

        if (requestBodies.length === 4) {
          bashReadAfterNonBashWrite = requireToolResult(body, "bash", "call-read-pending-bash-report");
          return createChatCompletionResponse({
            toolCalls: [createToolCall("call-kill-pending-bash-write", "kill_shell", { job_id: backgroundJobId })]
          });
        }

        if (requestBodies.length === 5) {
          requireToolResult(body, "kill_shell", "call-kill-pending-bash-write");
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-mark-person-no-update", "mark_no_update", {
                path: "人物.md",
                reason: "后台 bash 暂存改动已对模型可见，当前窗口不写入人物报告。"
              })
            ]
          });
        }

        return createChatCompletionResponse({ content: "窗口完成。" });
      })();

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");
    await fs.writeFile(path.join(reportsRoot, "人物.md"), "OLD_REAL", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: ({ fileName }) =>
        fileName === "人物.md"
          ? {
              id: "report-1",
              bookId: "book-1",
              fileName: "人物.md",
              displayName: "人物",
              relativePath: "assets/books/book-1/reports/人物.md",
              reportKind: "template-output",
              templateId: "template-1",
              byteSize: Buffer.byteLength("OLD_REAL", "utf8"),
              createdAt: "2026-07-01T00:00:00.000Z",
              updatedAt: "2026-07-01T00:00:00.000Z"
            }
          : undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: createProviderStore(providerConfig),
      registerReport: () => {}
    });

    await service.runJobWindows({
      artifacts: createWindowArtifacts({
        projectRoot,
        templates: [
          createTemplate({ id: "template-1", name: "人物", fileName: "人物.md" }),
          createTemplate({ id: "template-2", name: "地点", fileName: "地点.md" })
        ]
      }),
      job: createWindowRunJob({ templateBatchSize: 2, templateIds: ["template-1", "template-2"] })
    });

    expect(requestBodies).toHaveLength(6);
    expect(bashReadAfterNonBashWrite).toContain("BG_PENDING");
    expect(bashReadAfterNonBashWrite).not.toContain("OLD_REAL");
    await expect(fs.readFile(path.join(reportsRoot, "地点.md"), "utf8")).resolves.toContain("NON_BASH_WRITE");
  }, 20000);

  it("does not let final bash cleanup persist report changes after returned no-update outcomes", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-bash-cleanup-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const requestBodies: Record<string, unknown>[] = [];
    const registerReport = vi.fn(async () => {});
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = {
      id: "provider-1",
      presetId: "custom-openai-compatible" as const,
      displayName: "Mock Provider",
      kind: "openai-compatible" as const,
      baseUrl: "https://mock.local/v1",
      apiKeyRef,
      models: [{ id: "mock-model", displayName: "mock-model", enabled: true, isDefault: true }],
      enabled: true
    };
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      const responseBody = await (async () => {
        if (requestBodies.length === 1) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-delayed-bash-write", "bash", {
                command:
                  "node -e \"const fs=require('fs'); setTimeout(()=>fs.writeFileSync('人物.md','# 人物\\\\n\\\\ncleanup should not persist'),500); setTimeout(()=>process.exit(0),550);\"",
                run_in_background: true
              })
            ]
          });
        }

        if (requestBodies.length === 2) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-mark-no-update-before-bg-finishes", "mark_no_update", {
                path: "人物.md",
                reason: "当前窗口没有人物新增信息。"
              })
            ]
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 700));
        return createChatCompletionResponse({ content: "窗口完成。" });
      })();

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => undefined,
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: {
        async listProviderConfigs() {
          return [providerConfig];
        },
        async saveProviderConfig(config) {
          return config;
        }
      },
      registerReport
    });

    const result = await service.runJobWindows({
      artifacts: {
        book: {
          id: "book-1",
          projectId: "project-1",
          displayName: "测试小说",
          sourceAssetId: "source-1",
          sourceTextPath: "assets/books/book-1/source/original.txt",
          chapterCount: 1,
          createdAt: "2026-07-01T00:00:00.000Z"
        },
        project: {
          id: "project-1",
          displayName: "测试项目",
          slug: "test-project",
          rootPath: projectRoot,
          createdAt: "2026-07-01T00:00:00.000Z"
        },
        runtimeWindowManifest: {
          jobId: "job-1",
          bookId: "book-1",
          sourceTextPath: "assets/books/book-1/source/original.txt",
          sourceTextHash: sha256("source"),
          splitConfigHash: sha256("split"),
          splitterVersion: "test",
          generatedAt: "2026-07-01T00:00:00.000Z",
          totalDetectedChapterCount: 1,
          windows: [
            {
              windowId: "window-1",
              index: 0,
              fileName: "window-0001.txt",
              textPath: "runs/job-1/windows/window-0001.txt",
              windowHash: sha256("第一章\n\n主角整理旧资料。"),
              contextChapterRange: "1",
              submittedChapterRange: "1",
              contextChapterTitles: ["第一章"],
              submittedChapterTitles: ["第一章"],
              characterCount: "第一章\n\n主角整理旧资料。".length
            }
          ]
        },
        rulesSnapshotPath: "runs/job-1/rules.json",
        templates: [
          {
            id: "template-1",
            scope: "project",
            projectId: "project-1",
            name: "人物",
            fileName: "人物.md",
            body: "记录人物变化。",
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z"
          }
        ]
      },
      job: {
        id: "job-1",
        bookId: "book-1",
        input: {
          modelId: "mock-model",
          providerConfigId: "provider-1",
          skipAlreadyExtracted: false,
          templateBatchSize: 1,
          templateIds: ["template-1"]
        }
      }
    });

    expect(result).toMatchObject({ ok: true });
    expect(requestBodies).toHaveLength(3);
    expect(registerReport).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(reportsRoot, "人物.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20000);

  it("returns report sync rejection together with foreground bash failure output", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-bash-sync-failure-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const requestBodies: Record<string, unknown>[] = [];
    let failedBashToolResult = "";
    const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
    const apiKeyRef = credentialStore.saveApiKey({
      providerConfigId: "provider-1",
      apiKey: "sk-window-loop"
    });
    const providerConfig = {
      id: "provider-1",
      presetId: "custom-openai-compatible" as const,
      displayName: "Mock Provider",
      kind: "openai-compatible" as const,
      baseUrl: "https://mock.local/v1",
      apiKeyRef,
      models: [{ id: "mock-model", displayName: "mock-model", enabled: true, isDefault: true }],
      enabled: true
    };
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requestBodies.push(body);

      const responseBody = (() => {
        if (requestBodies.length === 1) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-bash-overwrite-fails", "bash", {
                command:
                  "node -e \"const fs=require('fs'); fs.writeFileSync('人物.md','bad'); console.log('before'); process.exit(7);\""
              })
            ]
          });
        }

        if (requestBodies.length === 2) {
          const bashResult = requireToolResult(body, "bash", "call-bash-overwrite-fails");
          failedBashToolResult = bashResult;
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-read-existing-report", "read_file", {
                path: "人物.md"
              })
            ]
          });
        }

        if (requestBodies.length === 3) {
          return createChatCompletionResponse({
            toolCalls: [
              createToolCall("call-edit-after-visible-sync-rejection", "edit_file", {
                path: "人物.md",
                old_string: "# 人物\n\n旧报告。",
                new_string: "# 人物\n\n旧报告。\n\nbash sync 拒绝可见后追加。"
              })
            ]
          });
        }

        return createChatCompletionResponse({ content: "窗口完成。" });
      })();

      return new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });

    await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
    await fs.mkdir(reportsRoot, { recursive: true });
    await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");
    await fs.writeFile(path.join(reportsRoot, "人物.md"), "# 人物\n\n旧报告。", "utf8");

    const service = createWindowRunService({
      clock: { now: () => "2026-07-01T00:00:00.000Z" },
      credentialStore,
      enabledToolNames: legacyDesktopToolNames,
      fetch,
      findExistingReport: () => ({
        id: "report-1",
        bookId: "book-1",
        fileName: "人物.md",
        displayName: "人物",
        relativePath: "assets/books/book-1/reports/人物.md",
        reportKind: "template-output",
        templateId: "template-1",
        byteSize: Buffer.byteLength("# 人物\n\n旧报告。", "utf8"),
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }),
      idGenerator: { createId: (prefix: string) => `${prefix}-1` },
      onRuntimeState: async () => {},
      providerStore: {
        async listProviderConfigs() {
          return [providerConfig];
        },
        async saveProviderConfig(config) {
          return config;
        }
      },
      registerReport: () => {}
    });

    await service.runJobWindows({
      artifacts: {
        book: {
          id: "book-1",
          projectId: "project-1",
          displayName: "测试小说",
          sourceAssetId: "source-1",
          sourceTextPath: "assets/books/book-1/source/original.txt",
          chapterCount: 1,
          createdAt: "2026-07-01T00:00:00.000Z"
        },
        project: {
          id: "project-1",
          displayName: "测试项目",
          slug: "test-project",
          rootPath: projectRoot,
          createdAt: "2026-07-01T00:00:00.000Z"
        },
        runtimeWindowManifest: {
          jobId: "job-1",
          bookId: "book-1",
          sourceTextPath: "assets/books/book-1/source/original.txt",
          sourceTextHash: sha256("source"),
          splitConfigHash: sha256("split"),
          splitterVersion: "test",
          generatedAt: "2026-07-01T00:00:00.000Z",
          totalDetectedChapterCount: 1,
          windows: [
            {
              windowId: "window-1",
              index: 0,
              fileName: "window-0001.txt",
              textPath: "runs/job-1/windows/window-0001.txt",
              windowHash: sha256("第一章\n\n主角整理旧资料。"),
              contextChapterRange: "1",
              submittedChapterRange: "1",
              contextChapterTitles: ["第一章"],
              submittedChapterTitles: ["第一章"],
              characterCount: "第一章\n\n主角整理旧资料。".length
            }
          ]
        },
        rulesSnapshotPath: "runs/job-1/rules.json",
        templates: [
          {
            id: "template-1",
            scope: "project",
            projectId: "project-1",
            name: "人物",
            fileName: "人物.md",
            body: "记录人物变化。",
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z"
          }
        ]
      },
      job: {
        id: "job-1",
        bookId: "book-1",
        input: {
          modelId: "mock-model",
          providerConfigId: "provider-1",
          skipAlreadyExtracted: false,
          templateBatchSize: 1,
          templateIds: ["template-1"]
        }
      }
    });

    expect(requestBodies).toHaveLength(4);
    expect(failedBashToolResult).toContain("before");
    expect(failedBashToolResult).toContain("command exited");
    expect(failedBashToolResult).toContain("report_sync");
    expect(failedBashToolResult).toContain("已有报告不能用 write_file 直接覆盖");
    expect(failedBashToolResult).toContain("正确格式示例");
    await expect(fs.readFile(path.join(reportsRoot, "人物.md"), "utf8")).resolves.toContain(
      "bash sync 拒绝可见后追加。"
    );
  }, 20000);
});

function createToolCall(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
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
} = {}): Record<string, unknown> {
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
      completion_tokens: 7,
      total_tokens: 18
    }
  };
}

function messagesOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body.messages as Array<Record<string, unknown>>;
}

function requireToolResult(body: Record<string, unknown>, name: string, toolCallId: string): string {
  const message = messagesOf(body).find(
    (item) => item.role === "tool" && item.name === name && item.tool_call_id === toolCallId
  );
  if (message === undefined || typeof message.content !== "string") {
    throw new Error(`missing ${name} tool result for ${toolCallId}`);
  }
  return message.content;
}

function extractBackgroundJobId(content: string): string {
  const match = /Started background job "([^"]+)"/u.exec(content);
  if (match === null) {
    throw new Error(`missing background job id in bash result: ${content}`);
  }
  return match[1];
}

function createProviderConfig(
  apiKeyRef: ApiKeyRef,
  input: {
    baseUrl?: string;
    displayName?: string;
    id?: string;
    modelId?: string;
  } = {}
): ProviderConfig {
  const id = input.id ?? "provider-1";
  const modelId = input.modelId ?? "mock-model";
  return {
    id,
    presetId: "custom-openai-compatible" as const,
    displayName: input.displayName ?? "Mock Provider",
    kind: "openai-compatible" as const,
    baseUrl: input.baseUrl ?? "https://mock.local/v1",
    apiKeyRef,
    models: [{ id: modelId, displayName: modelId, enabled: true, isDefault: true }],
    enabled: true
  };
}

function createProviderStore(providerConfig: ProviderConfig | ProviderConfig[]) {
  const providerConfigs = Array.isArray(providerConfig) ? providerConfig : [providerConfig];
  return {
    async listProviderConfigs() {
      return providerConfigs;
    },
    async saveProviderConfig(config: ProviderConfig) {
      return config;
    }
  };
}

function createTemplate(input: { fileName: string; id: string; name: string }) {
  return {
    id: input.id,
    scope: "project" as const,
    projectId: "project-1",
    name: input.name,
    fileName: input.fileName,
    body: `记录${input.name}变化。`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z"
  };
}

function createWindowArtifacts(input: {
  projectRoot: string;
  templates: Array<ReturnType<typeof createTemplate>>;
  windowCount?: number;
}) {
  const windowCount = input.windowCount ?? 1;
  const windows = Array.from({ length: windowCount }, (_, index) => {
    const chapterTitle = index === 0 ? "第一章" : `第${index + 1}章`;
    const chapterText = index === 0 ? "第一章\n\n主角整理旧资料。" : `${chapterTitle}\n\n主角整理旧资料 ${index + 1}。`;
    return {
      windowId: `window-${index + 1}`,
      index,
      fileName: `window-${String(index + 1).padStart(4, "0")}.txt`,
      textPath: `runs/job-1/windows/window-${String(index + 1).padStart(4, "0")}.txt`,
      windowHash: sha256(chapterText),
      contextChapterRange: `${index + 1}`,
      submittedChapterRange: `${index + 1}`,
      contextChapterTitles: [chapterTitle],
      submittedChapterTitles: [chapterTitle],
      characterCount: chapterText.length
    };
  });

  return {
    book: {
      id: "book-1",
      projectId: "project-1",
      displayName: "测试小说",
      sourceAssetId: "source-1",
      sourceTextPath: "assets/books/book-1/source/original.txt",
      chapterCount: 1,
      createdAt: "2026-07-01T00:00:00.000Z"
    },
    project: {
      id: "project-1",
      displayName: "测试项目",
      slug: "test-project",
      rootPath: input.projectRoot,
      createdAt: "2026-07-01T00:00:00.000Z"
    },
    runtimeWindowManifest: {
      jobId: "job-1",
      bookId: "book-1",
      sourceTextPath: "assets/books/book-1/source/original.txt",
      sourceTextHash: sha256("source"),
      splitConfigHash: sha256("split"),
      splitterVersion: "test",
      generatedAt: "2026-07-01T00:00:00.000Z",
      totalDetectedChapterCount: windowCount,
      windows
    },
    rulesSnapshotPath: "runs/job-1/rules.json",
    templates: input.templates
  };
}

function createWindowRunJob(input: {
  modelId?: string;
  modelSelectionMode?: "explicit" | "auto";
  providerConfigId?: string;
  skipAlreadyExtracted?: boolean;
  templateBatchSize?: number;
  templateIds: string[];
}) {
  return {
    id: "job-1",
    bookId: "book-1",
    input: {
      modelId: input.modelId ?? "mock-model",
      providerConfigId: input.providerConfigId ?? "provider-1",
      ...(input.modelSelectionMode ? { modelSelectionMode: input.modelSelectionMode } : {}),
      skipAlreadyExtracted: input.skipAlreadyExtracted ?? false,
      templateBatchSize: input.templateBatchSize ?? 1,
      templateIds: input.templateIds
    }
  };
}

async function writeSingleWindowText(projectRoot: string): Promise<void> {
  const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
  await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
  await fs.writeFile(windowTextPath, "第一章\n\n主角整理旧资料。", "utf8");
}

async function runWindowWithMockToolCall(input: {
  enabledToolNames?: readonly string[];
  existingReports?: Record<string, string>;
  expectToolResult?: {
    toolName: string;
    toolCallId: string;
    assertContent(content: string): void;
  };
  toolCall?: Record<string, unknown>;
  toolCalls?: Array<Record<string, unknown>>;
}): Promise<{
  logText: string;
  reportContents: Record<string, string>;
  requestBodies: Record<string, unknown>[];
}> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-schema-validation-"));
  scratchDirs.push(projectRoot);
  const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
  const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
  const append = vi.fn(async () => {});
  const requestBodies: Record<string, unknown>[] = [];
  const credentialStore = createMemoryCredentialStore({ idFactory: () => "api-key-1" });
  const apiKeyRef = credentialStore.saveApiKey({
    providerConfigId: "provider-1",
    apiKey: "sk-window-loop"
  });
  const templates = [createTemplate({ id: "npc", name: "NPC", fileName: "[报告]NPC性格与代表事件.md" })];
  const artifacts = createWindowArtifacts({ projectRoot, templates, windowCount: 1 });

  await fs.mkdir(path.dirname(windowTextPath), { recursive: true });
  await fs.mkdir(reportsRoot, { recursive: true });
  await fs.writeFile(windowTextPath, "第一章 韩立谨慎行事。", "utf8");
  await Promise.all(
    Object.entries(input.existingReports ?? {}).map(async ([fileName, content]) => {
      await fs.writeFile(path.join(reportsRoot, fileName), content, "utf8");
    })
  );

  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requestBodies.push(body);

    if (requestBodies.length === 1) {
      const toolCalls = input.toolCalls ?? (input.toolCall !== undefined ? [input.toolCall] : []);
      return new Response(JSON.stringify(createChatCompletionResponse({ toolCalls })), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    }

    const expectedToolResult = input.expectToolResult ?? {
      toolName: "upsert_report_section",
      toolCallId: "call-bad-updates",
      assertContent: (toolResult: string) => {
        expect(toolResult).toContain("tool_schema_invalid_arguments");
        expect(toolResult).toContain("$.updates 必须是数组");
        expect(toolResult).not.toContain("updates must be a non-empty array");
      }
    };
    expectedToolResult.assertContent(
      requireToolResult(body, expectedToolResult.toolName, expectedToolResult.toolCallId)
    );
    return new Response(JSON.stringify(createChatCompletionResponse({ content: "NO_UPDATE" })), {
      headers: { "Content-Type": "application/json" },
      status: 200
    });
  });

  const service = createWindowRunService({
    clock: { now: () => "2026-07-01T00:00:00.000Z" },
    credentialStore,
    enabledToolNames: input.enabledToolNames,
    fetch,
    findExistingReport: () => undefined,
    idGenerator: { createId: (prefix: string) => `${prefix}-1` },
    onRuntimeState: async () => {},
    providerStore: createProviderStore(createProviderConfig(apiKeyRef)),
    registerReport: async () => {},
    taskLogger: { append, setSecrets: vi.fn(), absolutePath: "", relativePath: "", simpleAbsolutePath: "", simpleRelativePath: "" } as any
  });

  await service.runJobWindows({
    artifacts,
    job: createWindowRunJob({ templateIds: ["npc"] })
  });

  const reportContents = Object.fromEntries(
    await Promise.all(
      Array.from(new Set(["[报告]NPC性格与代表事件.md", ...Object.keys(input.existingReports ?? {})])).map(
        async (fileName) => [
          fileName,
          await fs.readFile(path.join(reportsRoot, fileName), "utf8").catch(() => undefined)
        ]
      )
    )
  );

  return {
    logText: JSON.stringify(append.mock.calls),
    reportContents,
    requestBodies
  };
}

async function writeCoverageIndexForArtifacts(input: {
  artifacts: ReturnType<typeof createWindowArtifacts>;
  projectRoot: string;
  semanticHashForTemplate(templateId: string): string;
}): Promise<void> {
  const records = input.artifacts.runtimeWindowManifest.windows.flatMap((window) =>
    input.artifacts.templates.map((template) => ({
      bookId: input.artifacts.book.id,
      templateId: template.id,
      outputFileName: template.fileName,
      templateHash: createTemplatePromptHashForTest(template),
      windowHash: window.windowHash,
      rulesSemanticHash: input.semanticHashForTemplate(template.id),
      submittedChapterRange: window.submittedChapterRange,
      status: "written" as const,
      updatedAt: "2026-07-01T00:00:00.000Z"
    }))
  );
  const indexPath = path.join(input.projectRoot, "metadata", "coverage", "coverage-index.json");
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, "utf8");
}

function createTemplatePromptHashForTest(template: ReturnType<typeof createTemplate>): string {
  return sha256(
    JSON.stringify({
      outputFileName: template.fileName,
      templateBody: template.body,
      templateId: template.id,
      templateName: template.name
    })
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

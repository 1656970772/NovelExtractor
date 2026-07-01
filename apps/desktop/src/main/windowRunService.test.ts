import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApiKeyRef, ProviderConfig } from "@novel-extractor/domain";
import { reasonixToolOrder } from "@novel-extractor/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryCredentialStore } from "./credentials";
import { cleanupBashSandboxAfterWindow, createWindowRunService } from "./windowRunService";

const scratchDirs: string[] = [];

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

describe("window run Reasonix tool loop integration", () => {
  it("sends the full Reasonix tool protocol to the model and executes the bash job family through the desktop loop", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-loop-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const requestBodies: Record<string, unknown>[] = [];
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
      job: createWindowRunJob({ templateIds: ["template-1", "template-2"] })
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
          templateIds: ["template-1"]
        }
      }
    });

    expect(requestBodies).toHaveLength(4);
    expect(failedBashToolResult).toContain("before");
    expect(failedBashToolResult).toContain("command exited");
    expect(failedBashToolResult).toContain("report_sync");
    expect(failedBashToolResult).toContain("已有报告不能用 write_file 覆盖");
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

function createProviderConfig(apiKeyRef: ApiKeyRef): ProviderConfig {
  return {
    id: "provider-1",
    presetId: "custom-openai-compatible" as const,
    displayName: "Mock Provider",
    kind: "openai-compatible" as const,
    baseUrl: "https://mock.local/v1",
    apiKeyRef,
    models: [{ id: "mock-model", displayName: "mock-model", enabled: true, isDefault: true }],
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
}) {
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
    templates: input.templates
  };
}

function createWindowRunJob(input: { templateIds: string[] }) {
  return {
    id: "job-1",
    bookId: "book-1",
    input: {
      modelId: "mock-model",
      providerConfigId: "provider-1",
      skipAlreadyExtracted: false,
      templateIds: input.templateIds
    }
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

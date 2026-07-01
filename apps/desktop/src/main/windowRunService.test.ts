import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig } from "@novel-extractor/config";
import { getEnabledTools } from "@novel-extractor/tools";
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
  it("sends the full Reasonix tool protocol to the model and executes bash through the desktop loop", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-window-loop-"));
    scratchDirs.push(projectRoot);
    const reportsRoot = path.join(projectRoot, "assets", "books", "book-1", "reports");
    const windowTextPath = path.join(projectRoot, "runs", "job-1", "windows", "window-0001.txt");
    const requestBodies: Record<string, unknown>[] = [];
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

      const responseBody =
        requestBodies.length === 1
          ? createChatCompletionResponse({
              toolCalls: [
                {
                  id: "call-bash",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command: "node -e \"console.log('desktop-bash-ok')\""
                    })
                  }
                }
              ]
            })
          : createChatCompletionResponse({ content: "NO_UPDATE" });

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

    expect(requestBodies).toHaveLength(2);
    const expectedToolNames = getEnabledTools([...getDefaultConfig().toolLoopDefaults.enabledToolNames]).map((tool) => tool.name);
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

    const secondMessages = requestBodies[1].messages as Array<Record<string, unknown>>;
    expect(secondMessages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        name: "bash",
        tool_call_id: "call-bash",
        content: expect.stringContaining("desktop-bash-ok")
      })
    );
  }, 20000);
});

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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

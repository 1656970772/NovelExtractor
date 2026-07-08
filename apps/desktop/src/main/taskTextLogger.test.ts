import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatCompletionMessage } from "@novel-extractor/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTaskTextLogger,
  replaceWindowTextReferencesForTaskLog,
  serializeModelRequestForTaskLog
} from "./taskTextLogger";

function createSequenceClock(values: string[]) {
  let index = 0;
  return {
    now() {
      const value = values[Math.min(index, values.length - 1)];
      index += 1;
      return value;
    }
  };
}

describe("task text logger", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-task-log-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("writes timestamped plain-text entries with readable tags and redacted secrets", async () => {
    const logger = await createTaskTextLogger({
      clock: createSequenceClock([
        "2026-06-30T15:30:12.000Z",
        "2026-06-30T15:30:13.000Z",
        "2026-06-30T15:30:14.000Z"
      ]),
      jobId: "job-1",
      projectRoot: tempRoot,
      secrets: ["sk-task-log-secret"],
      appVersion: "1.2.3-test",
      taskInfo: "任务 job-1，书籍 book-1，模型 mock-model，模板 1 个，窗口 1 个"
    });

    await logger.append(["工具调用", "grep"], {
      apiKey: "raw-field-secret",
      输入参数: {
        path: "丹药分析.md",
        pattern: "筑基丹"
      }
    });
    await logger.append(["大模型返回"], "模型返回 sk-task-log-secret 和完整正文");

    const content = await fs.readFile(path.join(tempRoot, logger.relativePath), "utf8");
    const simpleContent = await fs.readFile(path.join(tempRoot, logger.simpleRelativePath), "utf8");

    expect(logger.relativePath).toBe("runs/job-1/logs/20260630-153012.txt");
    expect(logger.simpleRelativePath).toBe("runs/job-1/logs/20260630-153012.simple.txt");
    expect(content).toContain("App Version: 1.2.3-test");
    expect(content).toContain("Build Commit:");
    expect(content).toContain("Build Time:");
    expect(content.split("\n").find((line) => line.includes("[任务信息]"))).toBe(
      "[2026-06-30 15:30:12][任务信息] 任务 job-1，书籍 book-1，模型 mock-model，模板 1 个，窗口 1 个"
    );
    expect(content).toContain("[2026-06-30 15:30:13][工具调用][grep]");
    expect(content).toContain("输入参数:");
    expect(content).toContain("path: 丹药分析.md");
    expect(content).toContain("pattern: 筑基丹");
    expect(content).toContain("apiKey: ***");
    expect(content).toContain("[2026-06-30 15:30:14][大模型返回] 模型返回 *** 和完整正文");
    expect(content).not.toContain("sk-task-log-secret");
    expect(content).not.toContain("raw-field-secret");
    expect(content.trim()).not.toMatch(/^\{.*\}$/su);
    expect(simpleContent).toContain("构建信息：已记录");
    expect(simpleContent).toContain("00:00:00 开始任务：book-1，1 个模板，模型 mock-model");
    expect(simpleContent).toContain("00:00:01 搜索文件：丹药分析.md");
    expect(simpleContent).toContain("00:00:02 模型返回");
    expect(simpleContent).not.toContain("输入参数");
    expect(simpleContent).not.toContain("筑基丹");
    expect(simpleContent).not.toContain("sk-task-log-secret");
    expect(simpleContent).not.toContain("raw-field-secret");
  });

  it("allocates a unique timestamp file when the same task starts twice in one second", async () => {
    const first = await createTaskTextLogger({
      clock: createSequenceClock(["2026-06-30T15:30:12.000Z"]),
      jobId: "job-1",
      projectRoot: tempRoot,
      taskInfo: "任务 job-1 第一次启动"
    });
    const second = await createTaskTextLogger({
      clock: createSequenceClock(["2026-06-30T15:30:12.000Z"]),
      jobId: "job-1",
      projectRoot: tempRoot,
      taskInfo: "任务 job-1 第二次启动"
    });

    expect(first.relativePath).toBe("runs/job-1/logs/20260630-153012.txt");
    expect(second.relativePath).toBe("runs/job-1/logs/20260630-153012-001.txt");
    expect(first.simpleRelativePath).toBe("runs/job-1/logs/20260630-153012.simple.txt");
    expect(second.simpleRelativePath).toBe("runs/job-1/logs/20260630-153012-001.simple.txt");
  });

  it("can allocate logs under custom batch directories", async () => {
    const logger = await createTaskTextLogger({
      clock: createSequenceClock(["2026-06-30T15:30:12.000Z"]),
      jobId: "job-1",
      projectRoot: tempRoot,
      taskInfo: "批次日志",
      logDirectorySegments: ["runs", "job-1", "logs", "batches", "batch-0001"],
      baseFileNamePrefix: "batch-0001"
    });

    expect(logger.relativePath).toBe(
      "runs/job-1/logs/batches/batch-0001/batch-0001-20260630-153012.txt"
    );
    expect(logger.simpleRelativePath).toBe(
      "runs/job-1/logs/batches/batch-0001/batch-0001-20260630-153012.simple.txt"
    );
  });

  it("logs model requests with provider-native tool schemas instead of flattened tool tables", async () => {
    const windowText = "这里是很长很长的窗口原文。\n第二行仍然属于窗口原文。";
    const messages: ChatCompletionMessage[] = [
      {
        role: "system",
        content: "系统指令保留"
      },
      {
        role: "user",
        content: `模板说明保留。\n\n${windowText}\n\n结尾指令保留。`
      },
      {
        role: "assistant",
        content: "准备读取窗口",
        toolCalls: [
          {
            id: "call-read-window",
            name: "read_file",
            arguments: {
              path: "runs/job-1/windows/window-0005.txt"
            }
          }
        ]
      },
      {
        role: "tool",
        toolCallId: "call-read-window",
        name: "read_file",
        content: "1→这里是很长很长的窗口原文。\n2→第二行仍然属于窗口原文。\n"
      }
    ];
    const providerRequestBody = {
      model: "gpt-test",
      messages: [{ role: "user", content: `## 当前窗口文本\n${windowText}` }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_report_excerpt",
            description: "读取本批允许报告中的卡片字段块。",
            parameters: {
              type: "object",
              properties: {
                queries: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      fields: { type: "array", items: { type: "string" } }
                    }
                  }
                }
              }
            }
          }
        }
      ]
    };
    const originalMessages = JSON.parse(JSON.stringify(messages));
    const logger = await createTaskTextLogger({
      clock: createSequenceClock([
        "2026-06-30T15:30:12.000Z",
        "2026-06-30T15:30:13.000Z"
      ]),
      jobId: "job-1",
      projectRoot: tempRoot,
      taskInfo: "任务 job-1"
    });

    const loggedRequest = serializeModelRequestForTaskLog({
      value: {
        轮次: 1,
        messages,
        协议: "openai_chat",
        providerBody: providerRequestBody
      },
      windowFileName: "window-0005.txt",
      windowText
    });
    await logger.append(["大模型请求", "ProviderBody"], loggedRequest);

    const content = await fs.readFile(path.join(tempRoot, logger.relativePath), "utf8");
    expect(messages).toEqual(originalMessages);
    expect(loggedRequest.messages).not.toBe(messages);
    expect(content).toContain("[大模型请求][ProviderBody]");
    expect(content).toContain("messages:");
    expect(content).toContain("role: system");
    expect(content).toContain("role: user");
    expect(content).toContain("role: tool");
    expect(content).toContain("[窗口原文见 window-0005.txt]");
    expect(content).toContain("模板说明保留");
    expect(content).toContain("结尾指令保留");
    expect(content).not.toContain("1→这里是很长很长的窗口原文");
    expect(content).not.toContain("这里是很长很长的窗口原文");
    expect(content).toContain("providerBody:");
    expect(content).toContain("type: function");
    expect(content).toContain("function:");
    expect(content).toContain("name: read_report_excerpt");
    expect(content).toContain("description: 读取本批允许报告中的卡片字段块。");
    expect(content).toContain("queries:");
    expect(content).toContain("type: array");
    expect(content).toContain("parameters:");
    expect(content).not.toContain("name: read_report_excerpt\n    parameters:");
  });

  it("logs the current-window prompt section as a window file reference even when text matching would be brittle", async () => {
    const windowText = "第一章 山边小村\r\n这里是当前窗口原文，不能出现在日志里。";
    const messages: ChatCompletionMessage[] = [
      {
        role: "user",
        content: [
          "模板说明保留。",
          "",
          "## 当前窗口文本",
          windowText,
          "",
          "这行模拟后续对话内容。"
        ].join("\n")
      }
    ];
    const originalMessages = JSON.parse(JSON.stringify(messages));

    const loggedRequest = serializeModelRequestForTaskLog({
      value: {
        messages
      },
      windowFileName: "window-0001.txt",
      windowText
    });

    expect(messages).toEqual(originalMessages);
    expect(loggedRequest.messages).toEqual([
      {
        role: "user",
        content: [
          "模板说明保留。",
          "",
          "## 当前窗口文本",
          "[窗口原文见 window-0001.txt]",
          "",
          "这行模拟后续对话内容。"
        ].join("\n")
      }
    ]);
    expect(JSON.stringify(loggedRequest)).not.toContain("这里是当前窗口原文");
  });

  it("replaces paginated current-window read_file results with the window file reference", () => {
    const windowText = [
      "第一章",
      "",
      "这里是很长很长的窗口原文第一段。",
      "这里是很长很长的窗口原文第二段。",
      "这里是很长很长的窗口原文第三段。"
    ].join("\n");

    const output = replaceWindowTextReferencesForTaskLog({
      value: {
        返回内容:
          "1→第一章\n2→\n3→这里是很长很长的窗口原文第一段。\n\n[more lines below; pass offset=3 to continue]\n"
      },
      windowFileName: "window-0001.txt",
      windowText
    });

    expect(output).toEqual({ 返回内容: "[窗口原文见 window-0001.txt]" });
  });
});

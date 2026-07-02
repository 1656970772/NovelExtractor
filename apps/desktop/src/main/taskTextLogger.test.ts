import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskTextLogger } from "./taskTextLogger";

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
    expect(content.split("\n")[0]).toBe(
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
    expect(simpleContent).toContain("15:30:12 开始任务：book-1，1 个模板，模型 mock-model");
    expect(simpleContent).toContain("15:30:13 搜索文件：丹药分析.md");
    expect(simpleContent).toContain("15:30:14 模型返回");
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
});

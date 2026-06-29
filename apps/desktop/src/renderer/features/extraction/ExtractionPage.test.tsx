/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateDto } from "../../../shared/ipcTypes";
import { ExtractionPage } from "./ExtractionPage";

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.doUnmock("@novel-extractor/config");
});

const modelForTest = {
  id: "provider-1:model-a",
  providerConfigId: "provider-1",
  modelId: "model-a",
  displayName: "DeepSeek / 模型 A"
};

const uploadedBookForTest = {
  id: "book-1",
  displayName: "凡人修仙传",
  fileName: "凡人修仙传.txt",
  byteSize: 2048,
  encoding: "utf-8" as const,
  chapterCount: 3
};

const globalTemplateForTest: TemplateDto = {
  id: "global-world",
  scope: "global",
  name: "世界观模板",
  fileName: "world.md",
  body: "记录势力、地名与修炼体系。",
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedAt: "2026-06-28T00:00:00.000Z"
};

const projectTemplateForTest: TemplateDto = {
  id: "project-foreshadow",
  scope: "project",
  projectId: "project-a",
  name: "伏笔模板",
  fileName: "foreshadow.txt",
  body: "记录当前项目专属伏笔。",
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedAt: "2026-06-28T00:00:00.000Z"
};

describe("ExtractionPage", () => {
  it("accepts only txt uploads and shows uploaded book metadata", async () => {
    const user = userEvent.setup();
    const onUploadTxt = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[]}
        state="ready"
        onUploadTxt={onUploadTxt}
      />
    );

    const file = new File(["第一章 初入仙途"], "凡人修仙传.txt", { type: "text/plain" });
    const fileInput = screen.getByLabelText("选择 .txt 文件");

    expect(fileInput).toHaveAttribute("accept", ".txt,text/plain");

    await user.upload(fileInput, file);

    expect(onUploadTxt).toHaveBeenCalledWith(file);

    rerender(
      <ExtractionPage
        models={[modelForTest]}
        books={[uploadedBookForTest]}
        jobs={[]}
        state="ready"
        onUploadTxt={onUploadTxt}
      />
    );

    expect(screen.getByText("凡人修仙传.txt")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();
    expect(screen.getByText("utf-8")).toBeInTheDocument();
    expect(screen.getByText("章节数 3")).toBeInTheDocument();
  });

  it("builds createJob dto from configured templates, editable windows, and selected model", async () => {
    const user = userEvent.setup();
    const onCreateJob = vi.fn().mockResolvedValue(undefined);
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[uploadedBookForTest]}
        jobs={[]}
        state="ready"
        onCreateJob={onCreateJob}
      />
    );

    expect(screen.getByRole("button", { name: /1 个已选/ })).toBeInTheDocument();

    await user.clear(screen.getByRole("spinbutton", { name: "单次运行章节数" }));
    await user.type(screen.getByRole("spinbutton", { name: "单次运行章节数" }), "4");
    await user.clear(screen.getByRole("spinbutton", { name: "提取章节窗口" }));
    await user.type(screen.getByRole("spinbutton", { name: "提取章节窗口" }), "12");
    await user.selectOptions(screen.getByLabelText("模型"), "provider-1:model-a");
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    expect(onCreateJob).toHaveBeenCalledWith({
      bookId: "book-1",
      templateIds: ["pill-analysis"],
      providerConfigId: "provider-1",
      modelId: "model-a",
      singleRunChapterCount: 4,
      extractionChapterCount: 12
    });
  });

  it("opens template selection in a dedicated dialog entry", async () => {
    const user = userEvent.setup();
    const onTemplateSelectionChange = vi.fn();
    const onOpenTemplateManager = vi.fn();
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[uploadedBookForTest]}
        jobs={[]}
        state="ready"
        templates={[globalTemplateForTest, projectTemplateForTest]}
        selectedTemplateIds={[globalTemplateForTest.id]}
        onTemplateSelectionChange={onTemplateSelectionChange}
        onOpenTemplateManager={onOpenTemplateManager}
      />
    );

    await user.click(screen.getByRole("button", { name: /选择模板/ }));

    expect(onOpenTemplateManager).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "模板选择" })).not.toBeInTheDocument();
  });

  it("shows empty books, empty models, empty jobs, and opens provider config", async () => {
    const user = userEvent.setup();
    const onOpenProviderConfig = vi.fn();
    render(
      <ExtractionPage
        models={[]}
        books={[]}
        jobs={[]}
        state="ready"
        onOpenProviderConfig={onOpenProviderConfig}
      />
    );

    expect(screen.getByText("暂无书籍可提取")).toBeInTheDocument();
    expect(screen.getByText("暂无可用模型")).toBeInTheDocument();
    expect(screen.getByText("暂无提取任务")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建任务" })).toBeDisabled();
    expect(screen.getByText("模型状态待确认")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "前往大模型配置" }));

    expect(onOpenProviderConfig).toHaveBeenCalledTimes(1);
  });

  it("shows upload and task loading states", () => {
    render(<ExtractionPage models={[]} books={[]} jobs={[]} state="loading" />);

    expect(screen.getByLabelText("上传和任务加载中")).toBeInTheDocument();
  });

  it("shows loading error", () => {
    render(
      <ExtractionPage
        models={[]}
        books={[]}
        jobs={[]}
        state="error"
        errorMessage="读取任务失败"
      />
    );

    expect(screen.getByText("读取任务失败")).toBeInTheDocument();
  });

  it("shows pause when a task is running", () => {
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[{ id: "job-1", status: "running", progressText: "1/3", tokenText: "输入 10 / 输出 5" }]}
        state="ready"
      />
    );

    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续" })).not.toBeInTheDocument();
  });

  it("shows continue when a task is paused", () => {
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[{ id: "job-2", status: "paused", progressText: "1/3", tokenText: "输入 10 / 输出 5" }]}
        state="ready"
      />
    );

    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
  });

  it("shows failure reason and delete entry when a task failed", () => {
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[{ id: "job-3", status: "failed", progressText: "2/3", failureReason: "模型返回格式无效" }]}
        state="ready"
      />
    );

    expect(screen.getByText("模型返回格式无效")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除任务" })).toBeInTheDocument();
  });

  it("shows start when a task is pending", () => {
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[{ id: "job-4", status: "pending", progressText: "等待排队" }]}
        state="ready"
      />
    );

    expect(screen.getByRole("button", { name: "开始" })).toBeInTheDocument();
  });

  it("renders task action labels from config allowed actions", async () => {
    vi.resetModules();
    vi.doMock("@novel-extractor/config", () => ({
      getTaskStatusConfig: () => ({
        pending: { label: "待开始", allowedActions: ["start"] },
        running: { label: "运行中", allowedActions: ["pause"] },
        paused: { label: "已暂停", allowedActions: ["resume"] },
        completed: { label: "已完成", allowedActions: ["delete"] },
        failed: { label: "失败", allowedActions: ["delete"] }
      }),
      getTaskActionConfig: () => ({
        start: { label: "配置开始" },
        pause: { label: "配置暂停" },
        resume: { label: "配置继续" },
        delete: { label: "配置删除" }
      }),
      getBuiltInTemplates: () => [
        {
          id: "pill-analysis",
          name: "丹药分析模板",
          description: "提取丹药信息。",
          defaultOutputFileName: "丹药分析.md"
        }
      ],
      getExtractionParameterDefaults: () => ({
        singleRunChapterCount: 3,
        extractionChapterCount: 9
      })
    }));
    const { ExtractionPage: ConfiguredExtractionPage } = await import("./ExtractionPage");

    render(
      <ConfiguredExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[
          { id: "job-running", status: "running" },
          { id: "job-paused", status: "paused" },
          { id: "job-failed", status: "failed" },
          { id: "job-pending", status: "pending" }
        ]}
        state="ready"
      />
    );

    expect(screen.getByRole("button", { name: "配置暂停" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "配置继续" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "配置删除" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "配置开始" })).toBeInTheDocument();
  });

  it("calls configured task actions from job rows", async () => {
    const user = userEvent.setup();
    const onJobAction = vi.fn().mockResolvedValue(undefined);
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[uploadedBookForTest]}
        jobs={[
          { id: "job-running", status: "running", progressText: "窗口 1/3" },
          { id: "job-paused", status: "paused", progressText: "窗口 1/3" }
        ]}
        state="ready"
        onJobAction={onJobAction}
      />
    );

    await user.click(screen.getByRole("button", { name: "暂停" }));
    await user.click(screen.getByRole("button", { name: "继续" }));

    expect(onJobAction).toHaveBeenNthCalledWith(1, "job-running", "pause");
    expect(onJobAction).toHaveBeenNthCalledWith(2, "job-paused", "resume");
  });

  it("confirms deletion without claiming shared report files are deleted", async () => {
    const user = userEvent.setup();
    const onDeleteJob = vi.fn().mockResolvedValue(undefined);
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[uploadedBookForTest]}
        jobs={[{ id: "job-failed", status: "failed", progressText: "2/3", failureReason: "模型返回格式无效" }]}
        state="ready"
        onDeleteJob={onDeleteJob}
      />
    );

    await user.click(screen.getByRole("button", { name: "删除任务" }));

    const dialog = screen.getByRole("dialog", { name: "确认删除任务" });
    expect(dialog).toHaveTextContent("只移除任务记录和运行日志索引");
    expect(dialog).toHaveTextContent("共享报告文件不在本次操作范围内");
    expect(dialog).not.toHaveTextContent("删除共享报告文件");

    await user.click(screen.getByRole("button", { name: "确认删除" }));

    expect(onDeleteJob).toHaveBeenCalledWith("job-failed");
  });

  it("expands job logs", async () => {
    const user = userEvent.setup();
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[uploadedBookForTest]}
        jobs={[
          {
            id: "job-running",
            status: "running",
            progressText: "窗口 1/3",
            logs: ["已读取第 1 章", "等待模型返回"]
          }
        ]}
        state="ready"
      />
    );

    expect(screen.queryByText("已读取第 1 章")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开日志" }));

    expect(screen.getByText("已读取第 1 章")).toBeInTheDocument();
    expect(screen.getByText("等待模型返回")).toBeInTheDocument();
  });
});

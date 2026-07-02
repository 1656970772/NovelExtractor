/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    const dropZone = screen.getByRole("button", { name: "拖拽上传小说原文" });

    expect(fileInput).toHaveAttribute("accept", ".txt,text/plain");
    expect(fileInput).not.toHaveAttribute("multiple");

    await user.upload(fileInput, file);

    expect(onUploadTxt).toHaveBeenCalledWith(file);

    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [new File(["第二本"], "第二本.txt", { type: "text/plain" })]
      }
    });

    expect(onUploadTxt).toHaveBeenCalledWith(expect.objectContaining({ name: "第二本.txt" }));

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

  it("rejects dropping more than one novel file at a time", () => {
    const onUploadTxt = vi.fn().mockResolvedValue(undefined);
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[]}
        state="ready"
        onUploadTxt={onUploadTxt}
      />
    );

    fireEvent.drop(screen.getByRole("button", { name: "拖拽上传小说原文" }), {
      dataTransfer: {
        files: [
          new File(["第一本"], "第一本.txt", { type: "text/plain" }),
          new File(["第二本"], "第二本.txt", { type: "text/plain" })
        ]
      }
    });

    expect(screen.getByRole("alert")).toHaveTextContent("每次只能上传一本小说");
    expect(onUploadTxt).not.toHaveBeenCalled();
  });

  it("builds createJob dto from configured templates, editable windows, ledger strategy, and selected model", async () => {
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
    expect(screen.getByRole("checkbox", { name: "跳过已提取章节" })).toBeChecked();
    await user.clear(screen.getByRole("spinbutton", { name: "重叠章节数" }));
    await user.type(screen.getByRole("spinbutton", { name: "重叠章节数" }), "0");
    await user.click(screen.getByRole("checkbox", { name: "跳过已提取章节" }));
    await user.selectOptions(screen.getByLabelText("模型"), "provider-1:model-a");
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    expect(onCreateJob).toHaveBeenCalledWith({
      bookId: "book-1",
      templateIds: ["pill-analysis"],
      providerConfigId: "provider-1",
      modelId: "model-a",
      singleRunChapterCount: 4,
      extractionChapterCount: 12,
      overlapChapterCount: 0,
      skipAlreadyExtracted: false
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

  it("previews selected templates after hovering the selector for half a second", () => {
    vi.useFakeTimers();
    try {
      render(
        <ExtractionPage
          models={[modelForTest]}
          books={[uploadedBookForTest]}
          jobs={[]}
          state="ready"
          templates={[globalTemplateForTest, projectTemplateForTest]}
          selectedTemplateIds={[globalTemplateForTest.id, projectTemplateForTest.id]}
        />
      );

      const trigger = screen.getByRole("button", { name: /选择模板/ });
      const selector = trigger.closest(".template-selector");
      expect(selector).toBeInstanceOf(HTMLElement);

      fireEvent.mouseEnter(selector as HTMLElement);
      act(() => {
        vi.advanceTimersByTime(499);
      });
      expect(screen.queryByRole("region", { name: "已选模板预览" })).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1);
      });

      const preview = screen.getByRole("region", { name: "已选模板预览" });
      expect(within(preview).getByText("世界观模板")).toBeInTheDocument();
      expect(within(preview).getByText("伏笔模板")).toBeInTheDocument();
      expect(preview).toHaveTextContent("仅预览");

      fireEvent.mouseLeave(selector as HTMLElement);
      expect(screen.queryByRole("region", { name: "已选模板预览" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uploads templates from the extraction page after explicit confirmation", async () => {
    const user = userEvent.setup();
    const onSaveTemplate = vi.fn().mockResolvedValue(undefined);
    const onOpenNewTemplate = vi.fn();
    render(
      <ExtractionPage
        projectId="project-a"
        models={[modelForTest]}
        books={[uploadedBookForTest]}
        jobs={[]}
        state="ready"
        templates={[globalTemplateForTest]}
        selectedTemplateIds={[]}
        onOpenNewTemplate={onOpenNewTemplate}
        onSaveTemplate={onSaveTemplate}
      />
    );

    const uploadPanel = screen.getByRole("region", { name: "上传模板" });
    const fileInput = within(uploadPanel).getByLabelText("选择模板文件");

    expect(fileInput).toHaveAttribute("multiple");
    expect(within(uploadPanel).getByRole("button", { name: "上传模板" })).toBeDisabled();

    await user.upload(fileInput, [
      new File(["# 世界规则"], "世界规则.md", { type: "text/markdown" }),
      new File(["伏笔字段"], "伏笔字段.txt", { type: "text/plain" })
    ]);

    expect(onSaveTemplate).not.toHaveBeenCalled();
    expect(within(uploadPanel).getByText("世界规则.md")).toBeInTheDocument();
    expect(within(uploadPanel).getByText("伏笔字段.txt")).toBeInTheDocument();

    await user.click(within(uploadPanel).getByRole("checkbox", { name: "是否全局模板" }));
    await user.click(within(uploadPanel).getByRole("button", { name: "上传模板" }));

    await screen.findByText("已上传 2 个模板");
    expect(onSaveTemplate).toHaveBeenNthCalledWith(1, {
      projectId: "project-a",
      scope: "global",
      name: "世界规则",
      fileName: "世界规则.md",
      body: "# 世界规则"
    });
    expect(onSaveTemplate).toHaveBeenNthCalledWith(2, {
      projectId: "project-a",
      scope: "global",
      name: "伏笔字段",
      fileName: "伏笔字段.txt",
      body: "伏笔字段"
    });

    await user.click(within(uploadPanel).getByRole("button", { name: "手动新增模板" }));

    expect(onOpenNewTemplate).toHaveBeenCalledTimes(1);
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

  it("shows continue and restart when a task is paused", () => {
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[{ id: "job-2", status: "paused", progressText: "1/3", tokenText: "输入 10 / 输出 5" }]}
        state="ready"
      />
    );

    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新开始" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
  });

  it("shows failure reason and retry entries when a task failed", () => {
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[{ id: "job-3", status: "failed", progressText: "2/3", failureReason: "模型返回格式无效" }]}
        state="ready"
      />
    );

    expect(screen.getByText("模型返回格式无效")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新开始" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除任务" })).toBeInTheDocument();
  });

  it("orders task rows by creation time with the newest task first", () => {
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[
          {
            id: "job-old",
            status: "completed",
            progressText: "旧任务",
            createdAt: "2026-06-27T09:00:00.000Z"
          },
          {
            id: "job-new",
            status: "failed",
            progressText: "新任务",
            failureReason: "最新失败",
            createdAt: "2026-07-02T09:00:00.000Z"
          },
          {
            id: "job-middle",
            status: "running",
            progressText: "中间任务",
            createdAt: "2026-06-30T09:00:00.000Z"
          }
        ]}
        state="ready"
      />
    );

    const jobPanel = screen.getByRole("region", { name: "提取任务" });
    const rows = within(jobPanel).getAllByRole("listitem");

    expect(rows[0]).toHaveTextContent("新任务");
    expect(rows[1]).toHaveTextContent("中间任务");
    expect(rows[2]).toHaveTextContent("旧任务");
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
        failed: { label: "失败", allowedActions: ["resume", "restart", "delete"] }
      }),
      getTaskActionConfig: () => ({
        start: { label: "配置开始" },
        pause: { label: "配置暂停" },
        resume: { label: "配置继续" },
        restart: { label: "配置重试" },
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
        extractionChapterCount: 9,
        overlapChapterCount: 1
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
    expect(screen.getAllByRole("button", { name: "配置继续" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "配置重试" })).toBeInTheDocument();
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

  it("routes failed task continue and restart actions", async () => {
    const user = userEvent.setup();
    const onJobAction = vi.fn().mockResolvedValue(undefined);
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[uploadedBookForTest]}
        jobs={[
          { id: "job-failed", status: "failed", progressText: "窗口 7/10", failureReason: "窗口执行失败" }
        ]}
        state="ready"
        onJobAction={onJobAction}
      />
    );

    const failedRow = screen.getByText("窗口执行失败").closest("li");
    expect(failedRow).toBeInstanceOf(HTMLElement);

    await user.click(within(failedRow as HTMLElement).getByRole("button", { name: "继续" }));
    await user.click(within(failedRow as HTMLElement).getByRole("button", { name: "重新开始" }));

    expect(onJobAction).toHaveBeenNthCalledWith(1, "job-failed", "resume");
    expect(onJobAction).toHaveBeenNthCalledWith(2, "job-failed", "restart");
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

  it("expands a job progress log and opens the full log on demand", async () => {
    const user = userEvent.setup();
    const onReadJobLog = vi.fn().mockResolvedValue(
      "15:30:12 开始任务：凡人修仙传.txt\n15:30:13 请求模型：窗口 1/3，第 1 轮"
    );
    const onOpenJobLog = vi.fn().mockResolvedValue(undefined);
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[uploadedBookForTest]}
        jobs={[
          {
            id: "job-running",
            status: "running",
            progressText: "窗口 1/3",
            logFilePath: "runs/job-running/logs/20260630-153012.txt"
          }
        ]}
        state="ready"
        onOpenJobLog={onOpenJobLog}
        onReadJobLog={onReadJobLog}
      />
    );

    expect(screen.queryByText(/开始任务/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开流程" }));

    expect(onReadJobLog).toHaveBeenCalledWith("job-running");
    expect(await screen.findByText(/开始任务/)).toBeInTheDocument();
    expect(screen.getByText(/请求模型/)).toBeInTheDocument();
    expect(screen.queryByText(/\[大模型请求\]\[Prompt\]/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开完整日志" }));
    expect(onOpenJobLog).toHaveBeenCalledWith("job-running");
  });

  it("scrolls the progress log to the bottom every time it is expanded", async () => {
    const user = userEvent.setup();
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.tagName === "PRE" ? 900 : 0;
      }
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.tagName === "PRE" ? 120 : 0;
      }
    });

    const onReadJobLog = vi.fn().mockResolvedValue(
      Array.from({ length: 40 }, (_, index) => `15:30:${String(index).padStart(2, "0")} 流程 ${index}`).join("\n")
    );

    try {
      render(
        <ExtractionPage
          models={[modelForTest]}
          books={[uploadedBookForTest]}
          jobs={[
            {
              id: "job-running",
              status: "running",
              progressText: "窗口 1/3",
              logFilePath: "runs/job-running/logs/20260630-153012.txt"
            }
          ]}
          state="ready"
          onReadJobLog={onReadJobLog}
        />
      );

      await user.click(screen.getByRole("button", { name: "展开流程" }));
      const logText = await screen.findByText(/流程 39/);
      const logElement = logText.closest("pre");
      expect(logElement).not.toBeNull();
      expect(logElement?.scrollTop).toBe(900);

      if (!logElement) {
        return;
      }

      logElement.scrollTop = 240;
      fireEvent.scroll(logElement);
      await user.click(screen.getByRole("button", { name: "收起流程" }));
      await user.click(screen.getByRole("button", { name: "展开流程" }));

      const reopenedLogElement = await screen.findByText(/流程 39/).then((node) => node.closest("pre"));
      expect(reopenedLogElement?.scrollTop).toBe(900);
    } finally {
      if (scrollHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      }
      if (clientHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
      }
    }
  });
});

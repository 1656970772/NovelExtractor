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
  it("omits legacy daily summary cards from the extraction page", () => {
    const { container } = render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[
          { id: "job-running", status: "running", progressText: "运行中" },
          { id: "job-completed", status: "completed", progressText: "已完成" },
          { id: "job-failed", status: "failed", progressText: "失败" }
        ]}
        state="ready"
      />
    );

    const summaryCards = Array.from(container.querySelectorAll(".summary-card"));

    expect(screen.queryByText("今日任务")).not.toBeInTheDocument();
    expect(summaryCards).toHaveLength(0);
    expect(
      summaryCards.some((card) =>
        ["进行中", "已完成", "失败"].some((label) => card.textContent?.includes(label))
      )
    ).toBe(false);
  });

  it("renders novel upload before template upload and keeps their regions distinct", () => {
    const { container } = render(
      <ExtractionPage
        projectId="project-a"
        models={[modelForTest]}
        books={[]}
        jobs={[]}
        state="ready"
        onSaveTemplate={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const novelUploadPanel = screen.getByRole("region", { name: "上传小说" });
    const templateUploadPanel = screen.getByRole("region", { name: "上传模板" });
    const dropZone = within(novelUploadPanel).getByRole("button", { name: "拖拽上传小说原文" });

    expect(dropZone).toHaveClass("novel-upload__zone");
    expect(container.querySelector(".extraction-layout")).toBeInTheDocument();
    expect(novelUploadPanel.compareDocumentPosition(templateUploadPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("groups extraction parameters without disabling key inputs", () => {
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[uploadedBookForTest]}
        jobs={[]}
        state="ready"
        templates={[globalTemplateForTest, projectTemplateForTest]}
        selectedTemplateIds={[globalTemplateForTest.id]}
        onOpenTemplateManager={vi.fn()}
      />
    );

    const parametersPanel = screen.getByRole("region", { name: "提取参数" });
    const ruleGroup = within(parametersPanel).getByRole("group", { name: "提取规则" });
    const chapterGroup = within(parametersPanel).getByRole("group", { name: "章节识别" });
    const duplicateFilterGroup = within(parametersPanel).getByRole("group", { name: "重复章节过滤" });
    const modelGroup = within(parametersPanel).getByRole("group", { name: "模型设置" });

    expect(within(ruleGroup).getByLabelText("书籍")).toBeEnabled();
    expect(within(ruleGroup).getByRole("button", { name: /选择模板/ })).toBeEnabled();
    expect(within(chapterGroup).getByRole("spinbutton", { name: "单次运行章节数" })).toBeEnabled();
    expect(within(chapterGroup).getByRole("spinbutton", { name: "提取章节窗口" })).toBeEnabled();
    expect(within(chapterGroup).getByRole("spinbutton", { name: "重叠章节数" })).toBeEnabled();
    expect(within(duplicateFilterGroup).getByRole("checkbox", { name: "跳过已提取章节" })).toBeEnabled();
    expect(within(modelGroup).getByLabelText("模型")).toBeEnabled();
  });

  it("accepts txt and markdown uploads and shows uploaded book metadata", async () => {
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

    const file = createMockFile("markdown.md", "text/markdown", "# 第一章");
    const fileInput = screen.getByLabelText("选择小说文件");
    const dropZone = screen.getByRole("button", { name: "拖拽上传小说原文" });

    expect(fileInput).toHaveAttribute("accept", ".txt,.md,text/plain,text/markdown");
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

  it("rejects unsupported source files before sending upload request", async () => {
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
        files: [createMockFile("book.epub", "application/epub+zip", "data")]
      }
    });

    expect(onUploadTxt).not.toHaveBeenCalled();
    expect(screen.getByText("仅支持 .txt 或 .md 小说文件")).toBeInTheDocument();
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

  it("renders queue filter buttons with counts and excludes bulk clear completed", async () => {
    const user = userEvent.setup();
    const onJobAction = vi.fn().mockResolvedValue(undefined);
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[
          {
            id: "job-running",
            status: "running",
            progressText: "运行窗口",
            createdAt: "2026-07-02T10:00:00.000Z"
          },
          {
            id: "job-paused",
            status: "paused",
            progressText: "暂停窗口",
            createdAt: "2026-07-02T09:00:00.000Z"
          },
          {
            id: "job-failed",
            status: "failed",
            progressText: "失败窗口",
            failureReason: "失败原因",
            createdAt: "2026-07-02T08:00:00.000Z"
          },
          {
            id: "job-completed",
            status: "completed",
            progressText: "完成窗口",
            createdAt: "2026-07-02T07:00:00.000Z"
          },
          {
            id: "job-pending",
            status: "pending",
            progressText: "等待队列",
            createdAt: "2026-07-02T06:00:00.000Z"
          }
        ]}
        state="ready"
        onJobAction={onJobAction}
      />
    );

    const jobPanel = screen.getByRole("region", { name: "提取任务" });
    const filterGroup = within(jobPanel).getByRole("group", { name: "任务状态筛选" });

    expect(within(filterGroup).getAllByRole("button").map((button) => button.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "全部 5",
      "进行中 1",
      "暂停 1",
      "失败 1",
      "已完成 1"
    ]);
    expect(within(filterGroup).getByRole("button", { name: "全部 5" })).toHaveAttribute("aria-pressed", "true");
    expect(within(jobPanel).getByText("5 项")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清空已完成" })).not.toBeInTheDocument();

    await user.click(within(filterGroup).getByRole("button", { name: "暂停 1" }));

    expect(within(filterGroup).getByRole("button", { name: "暂停 1" })).toHaveAttribute("aria-pressed", "true");
    expect(within(jobPanel).getByText("1 项")).toBeInTheDocument();
    expect(within(jobPanel).getByText("暂停窗口")).toBeInTheDocument();
    expect(within(jobPanel).queryByText("等待队列")).not.toBeInTheDocument();
    expect(within(jobPanel).queryByText("运行窗口")).not.toBeInTheDocument();
    expect(within(jobPanel).queryByText("失败窗口")).not.toBeInTheDocument();
    expect(within(jobPanel).queryByText("完成窗口")).not.toBeInTheDocument();
    expect(within(jobPanel).queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();

    await user.click(within(jobPanel).getByRole("button", { name: "继续" }));

    expect(onJobAction).toHaveBeenCalledWith("job-paused", "resume");
  });

  it("renders advanced job cards with structured progress, timing, summary, and output action", async () => {
    const user = userEvent.setup();
    const onOpenOutputDirectory = vi.fn().mockResolvedValue(undefined);
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[
          {
            id: "job-running",
            status: "running",
            progressText: "窗口 2/6",
            progress: { completedWindowCount: 2, totalWindowCount: 5, percent: 40 },
            timing: {
              startedAt: "2026-07-02T11:00:00.000Z",
              elapsedMs: 332_000,
              estimatedRemainingMs: 478_000,
              estimateState: "available"
            },
            inputSummary: {
              bookDisplayName: "凡人修仙传",
              templateNames: ["丹药分析", "人物关系"],
              modelId: "deepseek-chat"
            },
            logFilePath: "runs/job-running/logs/live.txt",
            createdAt: "2026-07-02T11:00:00.000Z"
          },
          {
            id: "job-completed",
            status: "completed",
            progressText: "完成窗口",
            progress: { completedWindowCount: 4, totalWindowCount: 4, percent: 100 },
            timing: {
              startedAt: "2026-07-02T10:00:00.000Z",
              completedAt: "2026-07-02T10:12:48.000Z",
              elapsedMs: 768_000,
              estimateState: "unknown"
            },
            output: { outputDirectoryLabel: "凡人修仙传", canOpenOutputDirectory: true },
            inputSummary: {
              bookDisplayName: "已完成的书",
              templateNames: ["世界观模板"],
              modelId: "deepseek-reasoner"
            },
            createdAt: "2026-07-02T10:00:00.000Z"
          }
        ]}
        state="ready"
        onOpenOutputDirectory={onOpenOutputDirectory}
      />
    );

    expect(screen.getByRole("heading", { name: "凡人修仙传" })).toBeInTheDocument();
    expect(screen.queryByText(/模板：/)).not.toBeInTheDocument();
    expect(screen.queryByText("丹药分析、人物关系")).not.toBeInTheDocument();
    expect(screen.getByText("模型：deepseek-chat")).toBeInTheDocument();
    expect(screen.getByText("2 / 5")).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.getByText("已用时：00:05:32")).toBeInTheDocument();
    expect(screen.getByText("预计剩余：00:07:58")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "已完成的书" })).toBeInTheDocument();
    expect(screen.queryByText("世界观模板")).not.toBeInTheDocument();
    expect(screen.getByText("模型：deepseek-reasoner")).toBeInTheDocument();
    expect(screen.getByText("完成时间：2026-07-02 10:12:48")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开输出目录" }));

    expect(onOpenOutputDirectory).toHaveBeenCalledWith("job-completed");
  });

  it("only renders output directory action for completed jobs", () => {
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[
          {
            id: "job-running-output",
            status: "running",
            progressText: "窗口 1/4",
            output: { outputDirectoryLabel: "未完成输出", canOpenOutputDirectory: true },
            createdAt: "2026-07-02T11:00:00.000Z"
          }
        ]}
        state="ready"
        onOpenOutputDirectory={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.queryByRole("button", { name: "打开输出目录" })).not.toBeInTheDocument();
  });

  it("renders paused remaining time and failed reason with failure timestamp", () => {
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[
          {
            id: "job-paused",
            status: "paused",
            progressText: "窗口 1/4",
            progress: { completedWindowCount: 1, totalWindowCount: 4, percent: 25 },
            timing: {
              elapsedMs: 180_000,
              estimatedRemainingMs: 420_000,
              estimateState: "frozen"
            },
            inputSummary: {
              bookDisplayName: "暂停的书",
              templateNames: [],
              modelId: "model-paused"
            },
            createdAt: "2026-07-02T09:00:00.000Z"
          },
          {
            id: "job-failed",
            status: "failed",
            progressText: "窗口 3/5",
            failureReason: "模型返回格式无效",
            timing: {
              completedAt: "2026-07-02T09:40:30.000Z",
              elapsedMs: 930_000,
              estimateState: "unknown"
            },
            inputSummary: {
              bookDisplayName: "失败的书",
              templateNames: ["失败模板"],
              modelId: "model-failed"
            },
            createdAt: "2026-07-02T09:20:00.000Z"
          }
        ]}
        state="ready"
      />
    );

    expect(screen.getByRole("heading", { name: "暂停的书" })).toBeInTheDocument();
    expect(screen.queryByText(/模板：/)).not.toBeInTheDocument();
    expect(screen.getByText("预计剩余：已暂停 00:07:00")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "失败的书" })).toBeInTheDocument();
    expect(screen.getByText("模型返回格式无效")).toBeInTheDocument();
    expect(screen.getByText("失败时间：2026-07-02 09:40:30")).toBeInTheDocument();
  });

  it("marks job cards with status-specific classes for visual state colors", () => {
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[
          {
            id: "job-running",
            status: "running",
            progressText: "窗口 1/4",
            inputSummary: { bookDisplayName: "运行中的书", templateNames: [], modelId: "model-running" }
          },
          {
            id: "job-failed",
            status: "failed",
            progressText: "窗口 2/4",
            failureReason: "窗口执行失败",
            inputSummary: { bookDisplayName: "失败的书", templateNames: [], modelId: "model-failed" }
          },
          {
            id: "job-completed",
            status: "completed",
            progressText: "完成",
            inputSummary: { bookDisplayName: "完成的书", templateNames: [], modelId: "model-completed" }
          }
        ]}
        state="ready"
      />
    );

    expect(screen.getByRole("heading", { name: "运行中的书" }).closest("li")).toHaveClass(
      "job-card--running"
    );
    expect(screen.getByRole("heading", { name: "失败的书" }).closest("li")).toHaveClass(
      "job-card--failed"
    );
    expect(screen.getByRole("heading", { name: "完成的书" }).closest("li")).toHaveClass(
      "job-card--completed"
    );
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

  it("orders task rows by creation time with the newest task first inside the active filter", () => {
    render(
      <ExtractionPage
        models={[modelForTest]}
        books={[]}
        jobs={[
          {
            id: "job-old",
            status: "failed",
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
            status: "failed",
            progressText: "中间任务",
            createdAt: "2026-06-30T09:00:00.000Z"
          },
          {
            id: "job-running",
            status: "running",
            progressText: "运行任务",
            createdAt: "2026-07-03T09:00:00.000Z"
          }
        ]}
        state="ready"
      />
    );

    const jobPanel = screen.getByRole("region", { name: "提取任务" });
    const filterGroup = within(jobPanel).getByRole("group", { name: "任务状态筛选" });
    fireEvent.click(within(filterGroup).getByRole("button", { name: "失败 3" }));
    const rows = within(jobPanel).getAllByRole("listitem");

    expect(rows[0]).toHaveTextContent("新任务");
    expect(rows[1]).toHaveTextContent("中间任务");
    expect(rows[2]).toHaveTextContent("旧任务");
    expect(within(jobPanel).queryByText("运行任务")).not.toBeInTheDocument();
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

  it("shows local scrollbars while extraction panes scroll and hides them after half a second", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <ExtractionPage
          models={[modelForTest]}
          books={[]}
          jobs={[
            { id: "job-1", status: "completed", progressText: "完成 1" },
            { id: "job-2", status: "completed", progressText: "完成 2" }
          ]}
          state="ready"
        />
      );

      const layout = container.querySelector(".extraction-layout");
      const jobList = container.querySelector(".jobs-panel > .job-list");
      expect(layout).toBeInstanceOf(HTMLElement);
      expect(jobList).toBeInstanceOf(HTMLElement);
      expect(layout).toHaveClass("transient-scrollbar");
      expect(jobList).toHaveClass("transient-scrollbar");
      expect(layout).not.toHaveClass("transient-scrollbar--active");
      expect(jobList).not.toHaveClass("transient-scrollbar--active");

      fireEvent.scroll(layout as HTMLElement);
      fireEvent.scroll(jobList as HTMLElement);

      expect(layout).toHaveClass("transient-scrollbar--active");
      expect(jobList).toHaveClass("transient-scrollbar--active");

      act(() => {
        vi.advanceTimersByTime(499);
      });
      expect(layout).toHaveClass("transient-scrollbar--active");
      expect(jobList).toHaveClass("transient-scrollbar--active");

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(layout).not.toHaveClass("transient-scrollbar--active");
      expect(jobList).not.toHaveClass("transient-scrollbar--active");
    } finally {
      vi.useRealTimers();
    }
  });
});

function createMockFile(fileName: string, type: string, content: string): File {
  return new File([content], fileName, { type });
}

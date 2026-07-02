/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobDto, ProjectDto, TemplateDto } from "../shared/ipcTypes";
import { App } from "./App";
import { getDefaultTemplateViews } from "./features/templates/templateViewModel";
import { applyThemeTokens } from "./theme";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.removeAttribute("style");
  Reflect.deleteProperty(window, "novelExtractor");
});

function installDesktopApiMock() {
  const defaultTemplates = getDefaultTemplateViews();
  const defaultProject: ProjectDto = {
    id: "project-a",
    displayName: "仙途资料",
    slug: "xian-tu-zi-liao",
    createdAt: "2026-06-28T00:00:00.000Z"
  };
  const api = {
    createProject: vi.fn().mockResolvedValue(defaultProject),
    listProjects: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({
      defaultProjectStorageDirectory: "C:\\Users\\Administrator\\AppData\\Roaming\\@novel-extractor\\desktop\\projects",
      effectiveProjectStorageDirectory: "C:\\Users\\Administrator\\AppData\\Roaming\\@novel-extractor\\desktop\\projects",
      projectStorageDirectory: undefined
    }),
    saveSettings: vi.fn().mockResolvedValue({
      defaultProjectStorageDirectory: "C:\\Users\\Administrator\\AppData\\Roaming\\@novel-extractor\\desktop\\projects",
      effectiveProjectStorageDirectory: "D:\\NovelExtractorProjects",
      projectStorageDirectory: "D:\\NovelExtractorProjects"
    }),
    chooseProjectDirectory: vi.fn().mockResolvedValue("D:\\NovelExtractorProjects"),
    saveProvider: vi.fn().mockResolvedValue(undefined),
    listProviders: vi.fn().mockResolvedValue([]),
    uploadTxt: vi.fn(),
    listReports: vi.fn(),
    previewReport: vi.fn(),
    listTemplates: vi.fn().mockResolvedValue({ templates: defaultTemplates }),
    saveTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    getTemplateSelection: vi.fn().mockResolvedValue({ projectId: "project-a", templateIds: ["pill-analysis"] }),
    saveTemplateSelection: vi.fn(),
    getProjectRuntime: vi.fn().mockResolvedValue({ books: [], jobs: [] }),
    createJob: vi.fn(),
    startJob: vi.fn(),
    pauseJob: vi.fn(),
    resumeJob: vi.fn(),
    restartJob: vi.fn(),
    deleteJob: vi.fn(),
    readJobLog: vi.fn(),
    openJobLog: vi.fn(),
    onJobUpdated: vi.fn()
  };

  Object.defineProperty(window, "novelExtractor", {
    value: api,
    configurable: true
  });

  return api;
}

const appGlobalTemplate: TemplateDto = {
  id: "global-world",
  scope: "global",
  name: "世界观模板",
  fileName: "world.md",
  body: "记录势力、地名与修炼体系。",
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedAt: "2026-06-28T00:00:00.000Z"
};

const appProjectTemplate: TemplateDto = {
  id: "project-foreshadow",
  scope: "project",
  projectId: "project-a",
  name: "伏笔模板",
  fileName: "foreshadow.txt",
  body: "记录当前项目专属伏笔。",
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedAt: "2026-06-28T00:00:00.000Z"
};

describe("desktop workbench shell", () => {
  it("shows project creation before a project exists", () => {
    render(<App initialState={{ project: null }} />);

    expect(screen.getByRole("textbox", { name: "项目名称" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建项目" })).toBeInTheDocument();
  });

  it("creates a project through the desktop api and shows workbench navigation", async () => {
    const user = userEvent.setup();
    const api = installDesktopApiMock();
    render(<App initialState={{ project: null }} />);

    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "仙途资料");
    await user.click(screen.getByRole("button", { name: "创建项目" }));

    await waitFor(() => {
      expect(api.createProject).toHaveBeenCalledWith({ displayName: "仙途资料" });
    });
    expect(screen.getByRole("button", { name: "功能" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "语言" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "用户菜单" })).toBeInTheDocument();
  });

  it("loads persisted local projects before creating a new one", async () => {
    const user = userEvent.setup();
    const api = installDesktopApiMock();
    api.listProjects.mockResolvedValue([
      {
        id: "project-a",
        displayName: "仙途资料",
        slug: "xian-tu-zi-liao",
        createdAt: "2026-06-28T00:00:00.000Z"
      }
    ]);

    render(<App initialState={{ project: null }} />);

    expect(await screen.findByRole("heading", { name: "选择工作项目" })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "已有项目" }), "project-a");
    await user.click(screen.getByRole("button", { name: "打开项目" }));

    expect(screen.getByRole("heading", { name: "资产" })).toBeInTheDocument();
  });

  it("opens storage settings from the left rail gear, picks a directory, and saves it", async () => {
    const user = userEvent.setup();
    const api = installDesktopApiMock();
    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    await user.click(screen.getByRole("button", { name: "设置" }));

    expect(await screen.findByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "存储" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("项目目录")).toHaveValue(
      "C:\\Users\\Administrator\\AppData\\Roaming\\@novel-extractor\\desktop\\projects"
    );
    expect(screen.queryByText("默认")).not.toBeInTheDocument();
    expect(screen.queryByText("当前")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "浏览" }));

    expect(api.chooseProjectDirectory).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("项目目录")).toHaveValue("D:\\NovelExtractorProjects");

    await user.click(screen.getByRole("button", { name: "保存设置" }));

    expect(api.saveSettings).toHaveBeenCalledWith({
      projectStorageDirectory: "D:\\NovelExtractorProjects"
    });
    expect(await screen.findByText("已保存")).toBeInTheDocument();
  });

  it("switches between workbench pages from navigation", async () => {
    const user = userEvent.setup();
    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    expect(screen.getByRole("heading", { name: "资产" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );
    expect(screen.getByRole("heading", { name: "小说提取" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "关系图谱"
      })
    );
    expect(screen.getByRole("heading", { name: "关系图谱" })).toBeInTheDocument();
  });

  it("opens the same provider config dialog from user entry and empty extraction models", async () => {
    const user = userEvent.setup();
    installDesktopApiMock();
    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    await user.click(screen.getByRole("button", { name: "用户菜单" }));
    await user.click(screen.getByRole("button", { name: "大模型配置" }));

    expect(screen.getByRole("dialog", { name: "大模型配置" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );
    await user.click(screen.getByRole("button", { name: "前往大模型配置" }));

    expect(screen.getByRole("dialog", { name: "大模型配置" })).toBeInTheDocument();
  });

  it("keeps provider form retryable when saving fails", async () => {
    const user = userEvent.setup();
    const api = installDesktopApiMock();
    api.saveProvider.mockRejectedValueOnce(new Error("ipc failed"));
    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    await user.click(screen.getByRole("button", { name: "用户菜单" }));
    await user.click(screen.getByRole("button", { name: "大模型配置" }));

    await user.type(screen.getByLabelText("API key"), "sk-retry-after-failure");
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ipc failed");
    expect(screen.getByLabelText("API key")).toHaveValue("sk-retry-after-failure");
  });

  it("uploads a txt book, creates a job, and starts it through the desktop api", async () => {
    const user = userEvent.setup();
    const api = installDesktopApiMock();
    api.listProviders.mockResolvedValue([
      {
        id: "provider-1",
        presetId: "deepseek",
        displayName: "DeepSeek",
        kind: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        models: [{ id: "model-a", displayName: "模型 A", enabled: true, isDefault: true }],
        hasApiKey: true,
        enabled: true
      }
    ]);
    api.uploadTxt.mockResolvedValue({
      bookId: "book-1",
      displayName: "凡人修仙传",
      sourceAssetId: "asset-1",
      sourceTextPath: "assets/books/book-1/source/original.txt",
      fileName: "凡人修仙传.txt",
      byteSize: 2048,
      encoding: "utf-8",
      chapterCount: 3
    });
    api.createJob.mockResolvedValue({
      id: "job-1",
      bookId: "book-1",
      status: "created",
      progressText: "进度：0/3",
      tokenText: "Token 0 / 缓存命中率 0.00%",
      allowedActions: ["start", "delete"],
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z"
    });
    api.startJob.mockResolvedValue({
      id: "job-1",
      bookId: "book-1",
      status: "completed",
      progressText: "进度：1/1",
      tokenText: "Token 37 / 缓存命中率 0.00%",
      logFilePath: "runs/job-1/logs/20260630-153012.txt",
      allowedActions: ["delete"],
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z"
    });
    api.readJobLog.mockResolvedValue({
      jobId: "job-1",
      logFilePath: "runs/job-1/logs/20260630-153012.txt",
      content: "15:30:12 开始任务：凡人修仙传.txt\n15:30:13 模型返回：无工具调用"
    });
    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );

    expect(await screen.findByText("DeepSeek / 模型 A")).toBeInTheDocument();

    const file = new File(["第一章 初入仙途"], "凡人修仙传.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("选择小说文件"), file);

    expect(await screen.findByText("凡人修仙传.txt")).toBeInTheDocument();
    expect(api.uploadTxt).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-a",
        displayName: "凡人修仙传.txt"
      })
    );

    await user.clear(screen.getByRole("spinbutton", { name: "单次运行章节数" }));
    await user.type(screen.getByRole("spinbutton", { name: "单次运行章节数" }), "4");
    await user.clear(screen.getByRole("spinbutton", { name: "提取章节窗口" }));
    await user.type(screen.getByRole("spinbutton", { name: "提取章节窗口" }), "12");
    expect(screen.getByRole("checkbox", { name: "跳过已提取章节" })).toBeChecked();
    await user.clear(screen.getByRole("spinbutton", { name: "重叠章节数" }));
    await user.type(screen.getByRole("spinbutton", { name: "重叠章节数" }), "0");
    await user.click(screen.getByRole("checkbox", { name: "跳过已提取章节" }));
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    await waitFor(() => {
      expect(api.createJob).toHaveBeenCalledWith({
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
    expect(await screen.findByText("待开始")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始" }));

    expect(api.startJob).toHaveBeenCalledWith({ jobId: "job-1" });
    await user.click(await screen.findByRole("button", { name: "展开流程" }));
    expect(api.readJobLog).toHaveBeenCalledWith({ jobId: "job-1" });
    expect(await screen.findByText(/开始任务：凡人修仙传/)).toBeInTheDocument();
  });

  it("shows running immediately after starting a long-running job", async () => {
    const user = userEvent.setup();
    const api = installDesktopApiMock();
    api.listProviders.mockResolvedValue([
      {
        id: "provider-1",
        presetId: "deepseek",
        displayName: "DeepSeek",
        kind: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        models: [{ id: "model-a", displayName: "模型 A", enabled: true, isDefault: true }],
        hasApiKey: true,
        enabled: true
      }
    ]);
    api.uploadTxt.mockResolvedValue({
      bookId: "book-1",
      displayName: "凡人修仙传",
      sourceAssetId: "asset-1",
      sourceTextPath: "assets/books/book-1/source/original.txt",
      fileName: "凡人修仙传.txt",
      byteSize: 2048,
      encoding: "utf-8",
      chapterCount: 3
    });
    api.createJob.mockResolvedValue({
      id: "job-1",
      bookId: "book-1",
      status: "created",
      progressText: "进度：0/3",
      tokenText: "Token 0 / 缓存命中率 0.00%",
      allowedActions: ["start", "delete"],
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z"
    });
    api.startJob.mockReturnValue(new Promise(() => undefined));

    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );
    expect(await screen.findByText("DeepSeek / 模型 A")).toBeInTheDocument();

    const file = new File(["第一章 初入仙途"], "凡人修仙传.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("选择小说文件"), file);
    await user.click(screen.getByRole("button", { name: "创建任务" }));
    expect(await screen.findByText("待开始")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始" }));

    expect(api.startJob).toHaveBeenCalledWith({ jobId: "job-1" });
    expect(await screen.findByText("运行中")).toBeInTheDocument();
  });

  it("loads persisted project runtime and routes paused job resume and restart actions", async () => {
    const user = userEvent.setup();
    const api = installDesktopApiMock();
    api.listProviders.mockResolvedValue([
      {
        id: "provider-1",
        presetId: "deepseek",
        displayName: "DeepSeek",
        kind: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        models: [{ id: "model-a", displayName: "模型 A", enabled: true, isDefault: true }],
        hasApiKey: true,
        enabled: true
      }
    ]);
    api.getProjectRuntime.mockResolvedValue({
      books: [
        {
          bookId: "book-1",
          displayName: "凡人修仙传",
          sourceAssetId: "asset-1",
          sourceTextPath: "assets/books/book-1/source/original.txt",
          fileName: "凡人修仙传.txt",
          byteSize: 2048,
          encoding: "utf-8",
          chapterCount: 3
        }
      ],
      jobs: [
        {
          id: "job-1",
          bookId: "book-1",
          status: "paused",
          progressText: "进度：1/3",
          tokenText: "Token 100 / 缓存命中率 75.00%",
          logFilePath: "runs/job-1/logs/live.txt",
          allowedActions: ["resume", "restart", "delete"],
          createdAt: "2026-06-27T00:00:00.000Z",
          updatedAt: "2026-06-27T00:01:00.000Z"
        }
      ]
    });
    api.resumeJob.mockResolvedValue({
      id: "job-1",
      bookId: "book-1",
      status: "running",
      progressText: "进度：1/3",
      tokenText: "Token 100 / 缓存命中率 75.00%",
      logFilePath: "runs/job-1/logs/live.txt",
      allowedActions: ["pause"],
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:02:00.000Z"
    });
    api.restartJob.mockResolvedValue({
      id: "job-1",
      bookId: "book-1",
      status: "running",
      progressText: "正在准备运行窗口",
      tokenText: "Token 0 / 缓存命中率 0.00%",
      logFilePath: "runs/job-1/logs/restart.txt",
      allowedActions: ["pause"],
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:03:00.000Z"
    });

    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );

    expect(await screen.findByText("凡人修仙传.txt")).toBeInTheDocument();
    expect(screen.getByText("已暂停")).toBeInTheDocument();
    expect(screen.getByText("进度：1/3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新开始" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "继续" }));
    expect(api.resumeJob).toHaveBeenCalledWith({ jobId: "job-1" });

    api.resumeJob.mockClear();
    api.getProjectRuntime.mockResolvedValueOnce({
      books: [
        {
          bookId: "book-1",
          displayName: "凡人修仙传",
          sourceAssetId: "asset-1",
          sourceTextPath: "assets/books/book-1/source/original.txt",
          fileName: "凡人修仙传.txt",
          byteSize: 2048,
          encoding: "utf-8",
          chapterCount: 3
        }
      ],
      jobs: [
        {
          id: "job-1",
          bookId: "book-1",
          status: "paused",
          progressText: "进度：1/3",
          tokenText: "Token 100 / 缓存命中率 75.00%",
          logFilePath: "runs/job-1/logs/live.txt",
          allowedActions: ["resume", "restart", "delete"],
          createdAt: "2026-06-27T00:00:00.000Z",
          updatedAt: "2026-06-27T00:01:00.000Z"
        }
      ]
    });

    cleanup();
    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);
    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );
    await user.click(await screen.findByRole("button", { name: "重新开始" }));
    expect(api.restartJob).toHaveBeenCalledWith({ jobId: "job-1" });
  });

  it("refreshes a long-running job from pushed desktop snapshots before start resolves", async () => {
    const user = userEvent.setup();
    const api = installDesktopApiMock();
    let pushedJobHandler: ((job: JobDto) => void) | undefined;
    api.onJobUpdated.mockImplementation((handler: (job: JobDto) => void) => {
      pushedJobHandler = handler;
      return () => {
        if (pushedJobHandler === handler) {
          pushedJobHandler = undefined;
        }
      };
    });
    api.listProviders.mockResolvedValue([
      {
        id: "provider-1",
        presetId: "deepseek",
        displayName: "DeepSeek",
        kind: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        models: [{ id: "model-a", displayName: "模型 A", enabled: true, isDefault: true }],
        hasApiKey: true,
        enabled: true
      }
    ]);
    api.uploadTxt.mockResolvedValue({
      bookId: "book-1",
      displayName: "凡人修仙传",
      sourceAssetId: "asset-1",
      sourceTextPath: "assets/books/book-1/source/original.txt",
      fileName: "凡人修仙传.txt",
      byteSize: 2048,
      encoding: "utf-8",
      chapterCount: 3
    });
    api.createJob.mockResolvedValue({
      id: "job-1",
      bookId: "book-1",
      status: "created",
      progressText: "进度：0/3",
      tokenText: "Token 0 / 缓存命中率 0.00%",
      allowedActions: ["start", "delete"],
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z"
    });
    api.startJob.mockReturnValue(new Promise(() => undefined));
    api.readJobLog.mockResolvedValue({
      jobId: "job-1",
      logFilePath: "runs/job-1/logs/live.txt",
      content: "15:30:12 窗口 1/3：处理第 1-3 章，模板 1 个"
    });

    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );
    expect(await screen.findByText("DeepSeek / 模型 A")).toBeInTheDocument();

    const file = new File(["第一章 初入仙途"], "凡人修仙传.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("选择小说文件"), file);
    await user.click(screen.getByRole("button", { name: "创建任务" }));
    expect(await screen.findByText("待开始")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始" }));

    expect(api.startJob).toHaveBeenCalledWith({ jobId: "job-1" });
    await waitFor(() => expect(api.onJobUpdated).toHaveBeenCalledTimes(1));
    expect(pushedJobHandler).toBeDefined();

    act(() => {
      pushedJobHandler?.({
        id: "job-1",
        bookId: "book-1",
        status: "running",
        progressText: "进度：1/3",
        tokenText: "Token 99 / 缓存命中率 50.00%",
        logFilePath: "runs/job-1/logs/live.txt",
        allowedActions: ["pause"],
        createdAt: "2026-06-27T00:00:00.000Z",
        updatedAt: "2026-06-27T00:01:00.000Z"
      });
    });

    expect(await screen.findByText("进度：1/3")).toBeInTheDocument();
    expect(screen.getByText("Token 99 / 缓存命中率 50.00%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开流程" }));
    expect(api.readJobLog).toHaveBeenCalledWith({ jobId: "job-1" });
    expect(await screen.findByText(/窗口 1\/3/)).toBeInTheDocument();
  });

  it("shows a live simplified progress log and opens the full log on demand", async () => {
    const user = userEvent.setup();
    const api = installDesktopApiMock();
    api.getProjectRuntime.mockResolvedValue({
      books: [],
      jobs: [
        {
          id: "job-1",
          bookId: "book-1",
          status: "running",
          progressText: "1/4",
          logFilePath: "runs/job-1/logs/20260702-043645.txt",
          allowedActions: ["pause"],
          createdAt: "2026-07-02T04:36:45.000Z",
          updatedAt: "2026-07-02T04:36:45.000Z"
        }
      ]
    });
    api.readJobLog
      .mockResolvedValueOnce({
        jobId: "job-1",
        logFilePath: "runs/job-1/logs/20260702-043645.txt",
        content: "04:36:45 开始任务：凡人修仙传.txt\n"
      })
      .mockResolvedValueOnce({
        jobId: "job-1",
        logFilePath: "runs/job-1/logs/20260702-043645.txt",
        content: "04:36:45 开始任务：凡人修仙传.txt\n04:36:49 读取文件：window-0001.txt\n"
      });
    api.openJobLog.mockResolvedValue(undefined);

    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );

    await user.click(await screen.findByRole("button", { name: "展开流程" }));
    expect(await screen.findByText(/开始任务：凡人修仙传/)).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2100));
    });
    expect(await screen.findByText(/读取文件/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开完整日志" }));
    expect(api.openJobLog).toHaveBeenCalledWith({ jobId: "job-1" });
  });

  it("loads project template selection, saves changes, and opens template management", async () => {
    const user = userEvent.setup();
    const api = installDesktopApiMock();
    api.listTemplates.mockResolvedValue({
      templates: [appGlobalTemplate, appProjectTemplate]
    });
    api.getTemplateSelection.mockResolvedValue({
      projectId: "project-a",
      templateIds: [appGlobalTemplate.id]
    });
    api.saveTemplateSelection.mockResolvedValue({
      projectId: "project-a",
      templateIds: [appGlobalTemplate.id, appProjectTemplate.id]
    });
    api.saveTemplate.mockResolvedValue({
      id: "template-3",
      scope: "global",
      name: "人物关系模板",
      fileName: "关系.md",
      body: "记录人物关系与阵营变化。",
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z"
    });
    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );

    await user.click(await screen.findByRole("button", { name: /选择模板/ }));

    const templateDialog = screen.getByRole("dialog", { name: "模板选择与编辑" });
    expect(within(templateDialog).getByRole("checkbox", { name: "使用 世界观模板" })).toBeChecked();
    expect(within(templateDialog).getByRole("checkbox", { name: "使用 伏笔模板" })).not.toBeChecked();

    await user.click(within(templateDialog).getByRole("checkbox", { name: "使用 伏笔模板" }));

    await waitFor(() => {
      expect(api.saveTemplateSelection).toHaveBeenCalledWith({
        projectId: "project-a",
        templateIds: [appGlobalTemplate.id, appProjectTemplate.id]
      });
    });

    await user.click(within(templateDialog).getByRole("button", { name: "预览编辑 伏笔模板" }));
    await user.clear(within(templateDialog).getByRole("textbox", { name: "模板正文" }));
    await user.type(within(templateDialog).getByRole("textbox", { name: "模板正文" }), "记录人物关系与阵营变化。");
    await user.click(within(templateDialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(api.saveTemplate).toHaveBeenCalledWith({
        templateId: appProjectTemplate.id,
        projectId: "project-a",
        scope: "project",
        name: "伏笔模板",
        fileName: "foreshadow.txt",
        body: "记录人物关系与阵营变化。"
      });
    });
    expect(api.listTemplates).toHaveBeenCalledWith({ projectId: "project-a" });
  });

  it("opens the template manager with the new-template dialog from the extraction upload panel", async () => {
    const user = userEvent.setup();
    const api = installDesktopApiMock();
    api.listTemplates.mockResolvedValue({
      templates: [appGlobalTemplate, appProjectTemplate]
    });
    api.saveTemplate.mockResolvedValue({
      id: "template-manual",
      scope: "project",
      projectId: "project-a",
      name: "手动新增模板",
      fileName: "手动新增模板.md",
      body: "",
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z"
    });
    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );

    await user.click(await screen.findByRole("button", { name: "手动新增模板" }));

    const templateDialog = screen.getByRole("dialog", { name: "模板选择与编辑" });
    const nameDialog = within(templateDialog).getByRole("dialog", { name: "新增模板" });
    expect(nameDialog).toBeInTheDocument();

    await user.type(within(nameDialog).getByRole("textbox", { name: "新模板名字" }), "手动新增模板");
    await user.click(within(nameDialog).getByRole("button", { name: "创建模板" }));

    await waitFor(() => {
      expect(api.saveTemplate).toHaveBeenCalledWith({
        projectId: "project-a",
        scope: "project",
        name: "手动新增模板",
        fileName: "手动新增模板.md",
        body: ""
      });
    });
    expect(screen.getByRole("dialog", { name: "模板选择与编辑" })).toBeInTheDocument();
  });

  it("loads uploaded book reports and previews safe report html through the desktop api", async () => {
    const user = userEvent.setup();
    const api = installDesktopApiMock();
    api.uploadTxt.mockResolvedValue({
      bookId: "book-1",
      displayName: "凡人修仙传",
      sourceAssetId: "asset-1",
      sourceTextPath: "assets/books/book-1/source/original.txt",
      fileName: "凡人修仙传.txt",
      byteSize: 2048,
      encoding: "utf-8",
      chapterCount: 3
    });
    api.listReports.mockResolvedValue([
      {
        id: "report-1",
        bookId: "book-1",
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        byteSize: 1024,
        createdAt: "2026-06-27T00:00:00.000Z",
        updatedAt: "2026-06-27T00:00:00.000Z"
      }
    ]);
    api.previewReport.mockResolvedValue({
      reportId: "report-1",
      html: '<h1 id="heading-1">丹药分析</h1><p>安全预览正文</p>',
      headings: [{ id: "heading-1", depth: 1, text: "丹药分析" }],
      generatedAt: "2026-06-27T00:00:00.000Z"
    });
    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );
    const file = new File(["第一章 初入仙途"], "凡人修仙传.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("选择小说文件"), file);
    expect(await screen.findByText("凡人修仙传.txt")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "资源" }));
    await user.click(screen.getByRole("button", { name: /凡人修仙传/ }));
    expect(api.listReports).toHaveBeenCalledWith({ bookId: "book-1" });

    await user.click(await screen.findByRole("button", { name: /丹药分析/ }));
    expect(api.previewReport).toHaveBeenCalledWith({ reportId: "report-1" });
    expect(await screen.findByRole("heading", { name: "丹药分析" })).toBeInTheDocument();
    expect(screen.getByText("安全预览正文")).toBeInTheDocument();
  });

  it("shows preview errors without unhandled rejections", async () => {
    const user = userEvent.setup();
    const api = installDesktopApiMock();
    api.uploadTxt.mockResolvedValue({
      bookId: "book-1",
      displayName: "凡人修仙传",
      sourceAssetId: "asset-1",
      sourceTextPath: "assets/books/book-1/source/original.txt",
      fileName: "凡人修仙传.txt",
      byteSize: 2048,
      encoding: "utf-8",
      chapterCount: 3
    });
    api.listReports.mockResolvedValue([
      {
        id: "report-1",
        bookId: "book-1",
        fileName: "丹药分析.md",
        displayName: "丹药分析",
        byteSize: 1024,
        createdAt: "2026-06-27T00:00:00.000Z",
        updatedAt: "2026-06-27T00:00:00.000Z"
      }
    ]);
    api.previewReport.mockRejectedValueOnce(new Error("预览失败"));
    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );
    const file = new File(["第一章 初入仙途"], "凡人修仙传.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("选择小说文件"), file);
    await screen.findByText("凡人修仙传.txt");

    await user.click(screen.getByRole("button", { name: "资源" }));
    await user.click(screen.getByRole("button", { name: /凡人修仙传/ }));
    await user.click(await screen.findByRole("button", { name: /丹药分析/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("预览失败");
    expect(screen.getByRole("button", { name: /丹药分析/ })).toBeInTheDocument();
  });
});

describe("theme token application", () => {
  it("writes the CSS variables used by renderer styles", () => {
    applyThemeTokens({
      color: {
        appBackground: "#101112",
        surface: "#202122",
        surfacePaper: "#303132",
        surfaceRaised: "#333435",
        textPrimary: "#404142",
        textMuted: "#505152",
        inkSoft: "#525354",
        accent: "#606162",
        accentHover: "#616263",
        accentSoft: "#646566",
        onAccent: "#ffffff",
        selected: "#656667",
        progress: "#666768",
        success: "#676869",
        warning: "#68696a",
        danger: "#696a6b",
        dangerSoft: "#6a6b6c",
        infoSoft: "#626364",
        graphLine: "#636465",
        border: "#707172",
        borderStrong: "#717273"
      },
      shadow: {
        panel: "0 3px 9px rgb(1 2 3 / 0.4)",
        control: "0 1px 2px rgb(4 5 6 / 0.2)"
      },
      radius: {
        card: 10,
        control: 4
      },
      motion: {
        intensity: 3,
        durationMs: 120
      }
    });

    const rootStyle = document.documentElement.style;

    expect(rootStyle.getPropertyValue("--app-color-ink")).toBe("#404142");
    expect(rootStyle.getPropertyValue("--app-color-ink-muted")).toBe("#505152");
    expect(rootStyle.getPropertyValue("--app-color-selected")).toBe("#656667");
    expect(rootStyle.getPropertyValue("--app-color-progress")).toBe("#666768");
    expect(rootStyle.getPropertyValue("--app-color-danger-soft")).toBe("#6a6b6c");
    expect(rootStyle.getPropertyValue("--app-color-border-strong")).toBe("#717273");
    expect(rootStyle.getPropertyValue("--app-color-surface-raised")).toBe("#333435");
    expect(rootStyle.getPropertyValue("--app-color-accent-soft")).toBe("#646566");
    expect(rootStyle.getPropertyValue("--app-color-ink-soft")).toBe("#525354");
    expect(rootStyle.getPropertyValue("--app-shadow-panel")).toBe("0 3px 9px rgb(1 2 3 / 0.4)");
    expect(rootStyle.getPropertyValue("--app-shadow-control")).toBe("0 1px 2px rgb(4 5 6 / 0.2)");
    expect(rootStyle.getPropertyValue("--app-radius-panel")).toBe("10px");
  });
});

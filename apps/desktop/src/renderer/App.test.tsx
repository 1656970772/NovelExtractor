/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDto, TemplateDto } from "../shared/ipcTypes";
import { App } from "./App";
import { getDefaultTemplateViews } from "./features/templates/templateViewModel";
import { applyThemeTokens } from "./theme";

afterEach(() => {
  cleanup();
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
    createJob: vi.fn(),
    startJob: vi.fn(),
    pauseJob: vi.fn(),
    resumeJob: vi.fn(),
    deleteJob: vi.fn()
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
      progressText: "窗口 0/3",
      tokenText: "Token 0 / 费用 0",
      allowedActions: ["start", "delete"],
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z"
    });
    api.startJob.mockResolvedValue(undefined);
    render(<App initialState={{ project: { id: "project-a", displayName: "仙途资料" } }} />);

    await user.click(screen.getByRole("button", { name: "功能" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "功能入口" })).getByRole("button", {
        name: "小说提取"
      })
    );

    expect(await screen.findByText("DeepSeek / 模型 A")).toBeInTheDocument();

    const file = new File(["第一章 初入仙途"], "凡人修仙传.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("选择 .txt 文件"), file);

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
    await user.upload(screen.getByLabelText("选择 .txt 文件"), file);
    expect(await screen.findByText("凡人修仙传.txt")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "资产" }));
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
    await user.upload(screen.getByLabelText("选择 .txt 文件"), file);
    await screen.findByText("凡人修仙传.txt");

    await user.click(screen.getByRole("button", { name: "资产" }));
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

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { startMockOpenAiCompatibleServer } from "./fixtures/mock-openai-compatible";

const workspaceRoot = process.cwd();
const desktopRoot = path.join(workspaceRoot, "apps", "desktop");
const screenshotsRoot = path.join(workspaceRoot, "e2e", "screenshots");
const utf8FixturePath = path.join(workspaceRoot, "e2e", "fixtures", "utf8-novel.txt");

interface ViewportSpec {
  name: "wide" | "laptop" | "narrow";
  width: number;
  height: number;
}

const viewports: ViewportSpec[] = [
  { name: "wide", width: 1440, height: 900 },
  { name: "laptop", width: 1366, height: 768 },
  { name: "narrow", width: 390, height: 844 }
];

function resolveElectronPath(): string {
  const desktopRequire = createRequire(path.join(desktopRoot, "package.json"));
  return desktopRequire("electron") as string;
}

async function launchDesktop(viewport: Pick<ViewportSpec, "width" | "height">): Promise<{
  app: ElectronApplication;
  page: Page;
  userDataRoot: string;
}> {
  const userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-extractor-e2e-"));
  const app = await electron.launch({
    executablePath: resolveElectronPath(),
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVEL_EXTRACTOR_E2E: "1",
      NOVEL_EXTRACTOR_E2E_DATA_DIR: userDataRoot,
      NOVEL_EXTRACTOR_WINDOW_WIDTH: String(viewport.width),
      NOVEL_EXTRACTOR_WINDOW_HEIGHT: String(viewport.height)
    }
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.waitForLoadState("domcontentloaded");
  return { app, page, userDataRoot };
}

async function closeDesktop(app: ElectronApplication, userDataRoot: string): Promise<void> {
  await app.close();
  await fs.rm(userDataRoot, { force: true, recursive: true });
}

async function openFunction(page: Page, name: "小说提取" | "关系图谱"): Promise<void> {
  await page.getByRole("button", { name: "功能" }).click();
  await page.getByRole("navigation", { name: "功能入口" }).getByRole("button", { name }).click();
}

async function openAssets(page: Page): Promise<void> {
  await page.getByLabel("资产入口").getByRole("button", { name: "资产" }).click();
}

async function createProject(page: Page): Promise<void> {
  await page.getByRole("textbox", { name: "项目名称" }).fill("仙途资料");
  await page.getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByRole("button", { name: "用户菜单" })).toBeVisible();
}

async function configureMockProvider(page: Page, baseUrl: string): Promise<void> {
  await page.getByRole("button", { name: "用户菜单" }).click();
  await page.getByRole("button", { name: "大模型配置" }).click();
  await expect(page.getByRole("dialog", { name: "大模型配置" })).toBeVisible();
  await page.getByLabel("自定义 OpenAI-compatible").check();
  await page.getByLabel("配置名称").fill("Mock Provider");
  await page.getByLabel("Base URL").fill(baseUrl);
  await page.getByLabel("API key").fill("sk-e2e-mock");
  await page.getByLabel("模型名").fill("mock-model");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText("API key 已保存")).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();
}

async function runExtractionLoop(page: Page): Promise<void> {
  await openFunction(page, "小说提取");
  await expect(page.getByRole("heading", { name: "小说提取" })).toBeVisible();
  await expect(page.getByLabel("模型")).toHaveValue("provider-1:mock-model");

  await page.getByLabel("选择小说文件").setInputFiles(utf8FixturePath);
  const uploadPanel = page.getByRole("region", { name: "上传小说" });
  await expect(uploadPanel.getByText("utf8-novel.txt").first()).toBeVisible();
  await expect(uploadPanel.getByText("章节数 3")).toBeVisible();

  await page.getByRole("button", { name: "创建任务" }).click();
  await expect(page.getByText("待开始")).toBeVisible();
  await page.getByRole("button", { name: "开始" }).click();
  await expect(page.getByText("已完成", { exact: true })).toBeVisible();
}

async function previewReport(page: Page): Promise<void> {
  await openAssets(page);
  await expect(page.getByRole("heading", { name: "资产", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /utf8-novel\.txt/ }).click();
  await expect(page.getByRole("button", { name: /丹药分析/ })).toBeVisible();
  await page.getByRole("button", { name: /丹药分析/ }).click();
  const preview = page.getByRole("article", { name: "安全 Markdown 预览" });
  await expect(preview.getByRole("heading", { name: "丹药分析" })).toBeVisible();
  await expect(preview).toContainText("凝气丹");
  const html = await preview.evaluate((node) => node.innerHTML);
  expect(html).not.toContain("<script");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("onerror");
}

async function assertWorkbenchLayout(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflowingButtons = [...document.querySelectorAll("button")].filter(
      (button) => button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1
    );
    const modalActions = document.querySelector(".provider-form__actions");
    const modalRect = modalActions?.getBoundingClientRect();
    return {
      bodyOverflow: doc.scrollWidth - doc.clientWidth,
      overflowingButtonLabels: overflowingButtons.map((button) => button.textContent?.trim() ?? ""),
      modalActionsVisible:
        !modalRect || (modalRect.top >= 0 && modalRect.bottom <= window.innerHeight && modalRect.height > 0)
    };
  });

  expect(metrics.bodyOverflow).toBeLessThanOrEqual(2);
  expect(metrics.overflowingButtonLabels).toEqual([]);
  expect(metrics.modalActionsVisible).toBe(true);
}

async function assertFunctionPanelLayout(page: Page, viewport: ViewportSpec): Promise<void> {
  const metrics = await page.getByRole("navigation", { name: "功能入口" }).evaluate((node) => {
    const panel = node.closest(".top-nav__function-panel");
    const panelRect = panel?.getBoundingClientRect();
    const cardRects = [...node.querySelectorAll(".top-nav__feature-card")].map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        height: rect.height,
        width: rect.width
      };
    });

    return {
      cardRects,
      panelHeight: panelRect?.height ?? 0,
      panelWidth: panelRect?.width ?? 0
    };
  });

  expect(metrics.cardRects).toHaveLength(2);
  if (viewport.width > 640) {
    expect(metrics.panelWidth).toBeLessThanOrEqual(410);
    for (const rect of metrics.cardRects) {
      expect(rect.width).toBeLessThanOrEqual(170);
      expect(rect.height).toBeLessThanOrEqual(140);
    }
  } else {
    expect(metrics.panelWidth).toBeLessThanOrEqual(280);
    for (const rect of metrics.cardRects) {
      expect(rect.height).toBeLessThanOrEqual(140);
    }
  }
  expect(metrics.panelHeight).toBeLessThanOrEqual(viewport.width > 640 ? 190 : 330);
}

async function assertTemplateModalLayout(page: Page): Promise<void> {
  const modelSelect = page.getByLabel("模型");
  const modelTopBeforeOpen = await modelSelect.evaluate((node) => node.getBoundingClientRect().top);

  await page
    .getByRole("region", { name: "提取参数" })
    .getByRole("button", { name: /选择模板/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "模板选择与编辑" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("complementary", { name: "模板列表" })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "模板预览编辑" })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "模板正文" })).toBeVisible();

  const modelTopAfterOpen = await modelSelect.evaluate((node) => node.getBoundingClientRect().top);
  const dialogRect = await dialog.evaluate((node) => {
    const dialogRect = node.getBoundingClientRect();
    return {
      dialogBottom: dialogRect.bottom,
      dialogTop: dialogRect.top,
      dialogWidth: dialogRect.width
    };
  });

  expect(Math.abs(modelTopAfterOpen - modelTopBeforeOpen)).toBeLessThanOrEqual(2);
  expect(dialogRect.dialogTop).toBeLessThan(modelTopAfterOpen);
  expect(dialogRect.dialogBottom).toBeGreaterThan(modelTopAfterOpen);
  expect(dialogRect.dialogWidth).toBeGreaterThan(320);
}

async function captureCheckedScreenshot(page: Page, fileName: string, viewport: ViewportSpec): Promise<void> {
  const outputPath = path.join(screenshotsRoot, fileName);
  const buffer = await page.screenshot({ path: outputPath });
  const stat = await fs.stat(outputPath);
  const pngWidth = buffer.readUInt32BE(16);
  const pngHeight = buffer.readUInt32BE(20);
  expect(stat.size).toBeGreaterThan(8_000);
  expect(pngWidth).toBe(viewport.width);
  expect(pngHeight).toBe(viewport.height);
}

test("P0 desktop extraction loop", async () => {
  const mockServer = await startMockOpenAiCompatibleServer();
  let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    desktop = await launchDesktop({ width: 1180, height: 760 });
    const { page } = desktop;
    await createProject(page);
    await configureMockProvider(page, mockServer.baseUrl);
    await runExtractionLoop(page);
    expect(mockServer.requests).toHaveLength(2);
    expect(mockServer.requests[0]).toMatchObject({
      authorization: "Bearer sk-e2e-mock",
      method: "POST",
      url: "/v1/chat/completions"
    });
    expect(mockServer.requests[0].body).toMatchObject({ model: "mock-model" });
    expect(JSON.stringify(mockServer.requests[0].body)).toContain("write_file");
    await previewReport(page);
    await openFunction(page, "关系图谱");
    await expect(page.getByRole("heading", { name: "关系图谱" })).toBeVisible();
    await expect(page.getByText("当前书籍暂无图谱资产")).toBeVisible();
  } finally {
    if (desktop) {
      await closeDesktop(desktop.app, desktop.userDataRoot);
    }
    await mockServer.close();
  }
});

test("P0 visual screenshots", async () => {
  await fs.mkdir(screenshotsRoot, { recursive: true });
  const mockServer = await startMockOpenAiCompatibleServer();

  try {
    for (const viewport of viewports) {
      const { app, page, userDataRoot } = await launchDesktop(viewport);
      try {
        await createProject(page);
        await configureMockProvider(page, mockServer.baseUrl);
        await runExtractionLoop(page);

        await assertTemplateModalLayout(page);
        await captureCheckedScreenshot(page, `${viewport.name}-template-modal.png`, viewport);
        await page.getByRole("button", { name: "关闭模板选择" }).click();
        await expect(page.getByRole("dialog", { name: "模板选择与编辑" })).toHaveCount(0);

        await page.getByRole("button", { name: "功能" }).click();
        const functionEntry = page.getByRole("navigation", { name: "功能入口" });
        await expect(functionEntry.getByRole("button", { name: "小说提取" })).toBeVisible();
        await expect(functionEntry.getByRole("button", { name: "关系图谱" })).toBeVisible();
        await expect(functionEntry.getByRole("button", { name: "资产" })).toHaveCount(0);
        await expect(functionEntry.locator(".top-nav__feature-image")).toHaveCount(2);
        await assertFunctionPanelLayout(page, viewport);
        await assertWorkbenchLayout(page);
        await captureCheckedScreenshot(page, `${viewport.name}-function-panel.png`, viewport);
        await functionEntry.getByRole("button", { name: "小说提取" }).click();

        await assertWorkbenchLayout(page);
        await captureCheckedScreenshot(page, `${viewport.name}-extraction.png`, viewport);

        await openAssets(page);
        await page.getByRole("button", { name: /utf8-novel\.txt/ }).click();
        await page.getByRole("button", { name: /丹药分析/ }).click();
        await assertWorkbenchLayout(page);
        await captureCheckedScreenshot(page, `${viewport.name}-assets.png`, viewport);

        await page.getByRole("button", { name: "用户菜单" }).click();
        await page.getByRole("button", { name: "大模型配置" }).click();
        await assertWorkbenchLayout(page);
        await captureCheckedScreenshot(page, `${viewport.name}-provider-modal.png`, viewport);
      } finally {
        await closeDesktop(app, userDataRoot);
      }
    }

    expect(mockServer.requests).toHaveLength(viewports.length * 2);
  } finally {
    await mockServer.close();
  }
});

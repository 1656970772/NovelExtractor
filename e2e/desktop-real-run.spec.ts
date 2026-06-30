import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import {
  REAL_RUN_WINDOW_PARAMS,
  assertHarnessUploadChapterCoverage,
  buildHarnessCreateJobInput,
  createExpectedWindowPlanSummary,
  resolveDesktopRunHarnessConfig,
  resolveHarnessRunMode,
  selectHarnessModel,
  toSafeHarnessError,
  validateHarnessTemplateOutputReports,
  validateRuntimeWindowManifest,
  type HarnessModelSelection
} from "../apps/desktop/src/main/desktopRunHarnessConfig";
import type {
  BookUploadResultDto,
  JobDto,
  ProjectDto,
  ReportDto,
  SafeMarkdownPreviewDto,
  TemplateDto,
  TemplateListDto
} from "../apps/desktop/src/shared/ipcTypes";

const workspaceRoot = process.cwd();
const desktopRoot = path.join(workspaceRoot, "apps", "desktop");
const runMode = resolveHarnessRunMode(process.env);
const harnessConfig = resolveDesktopRunHarnessConfig(process.env);

test.skip(
  runMode === "disabled",
  "Set NOVEL_EXTRACTOR_PREPARE_ONLY=1 for prepare-only or NOVEL_EXTRACTOR_REAL_RUN=1 for the real model run."
);
test.setTimeout(runMode === "real-run" ? 60 * 60 * 1000 : 180_000);

interface LaunchedDesktop {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
}

interface SavedTemplate {
  template: TemplateDto;
  sourcePath: string;
}

function resolveElectronPath(): string {
  const desktopRequire = createRequire(path.join(desktopRoot, "package.json"));
  return desktopRequire("electron") as string;
}

function createRealAppEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NOVEL_EXTRACTOR_E2E_DATA_DIR;
  delete env.ELECTRON_RENDERER_URL;
  return env;
}

async function launchDesktop(): Promise<LaunchedDesktop> {
  const app = await electron.launch({
    executablePath: resolveElectronPath(),
    args: [desktopRoot],
    env: createRealAppEnv()
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
  return { app, page, userDataDir };
}

async function invokeDesktopApi<T>(page: Page, method: string, input?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method: methodName, input: apiInput }) => {
      const api = window.novelExtractor as unknown as Record<string, (input?: unknown) => Promise<unknown>>;
      const handler = api[methodName];
      if (typeof handler !== "function") {
        throw new Error(`preload API method not found: ${methodName}`);
      }
      return apiInput === undefined ? handler() : handler(apiInput);
    },
    { method, input }
  ) as Promise<T>;
}

async function assertFileExists(filePath: string, label: string): Promise<void> {
  const stat = await fs.stat(filePath);
  expect(stat.isFile(), `${label} should be a file: ${filePath}`).toBe(true);
}

async function assertDirExists(dirPath: string, label: string): Promise<void> {
  const stat = await fs.stat(dirPath);
  expect(stat.isDirectory(), `${label} should be a directory: ${dirPath}`).toBe(true);
}

async function ensureHarnessInputsExist(): Promise<void> {
  await assertFileExists(harnessConfig.sourceTextPath, "source txt");
  await assertDirExists(harnessConfig.templateDir, "template directory");
  await assertDirExists(harnessConfig.qualityStandardDir, "quality standard directory");

  for (const templateFile of harnessConfig.templateFiles) {
    await assertFileExists(path.join(harnessConfig.templateDir, templateFile), `template ${templateFile}`);
  }
}

async function findOrCreateProject(page: Page): Promise<ProjectDto> {
  const projects = await invokeDesktopApi<ProjectDto[]>(page, "listProjects");
  const existingProject = projects.find((project) => project.displayName === harnessConfig.projectName);

  if (existingProject) {
    return existingProject;
  }

  return invokeDesktopApi<ProjectDto>(page, "createProject", {
    displayName: harnessConfig.projectName
  });
}

function templateNameFromFileName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

async function importHarnessTemplates(page: Page, projectId: string): Promise<SavedTemplate[]> {
  let templateList = await invokeDesktopApi<TemplateListDto>(page, "listTemplates", { projectId });
  const savedTemplates: SavedTemplate[] = [];

  for (const [index, fileName] of harnessConfig.templateFiles.entries()) {
    const outputFileName = harnessConfig.templateOutputFileNames[index];
    const sourcePath = path.join(harnessConfig.templateDir, fileName);
    const body = await fs.readFile(sourcePath, "utf8");
    const existingTemplate = templateList.templates.find(
      (template) =>
        template.scope === "project" && template.projectId === projectId && template.fileName === outputFileName
    );
    const template = await invokeDesktopApi<TemplateDto>(page, "saveTemplate", {
      templateId: existingTemplate?.id,
      projectId,
      scope: "project",
      name: templateNameFromFileName(fileName),
      fileName: outputFileName,
      body
    });

    savedTemplates.push({ template, sourcePath });
    templateList = {
      templates: [
        ...templateList.templates.filter((currentTemplate) => currentTemplate.id !== template.id),
        template
      ]
    };
  }

  await invokeDesktopApi(page, "saveTemplateSelection", {
    projectId,
    templateIds: savedTemplates.map(({ template }) => template.id)
  });

  return savedTemplates;
}

async function uploadHarnessBook(page: Page, projectId: string): Promise<BookUploadResultDto> {
  const upload = await invokeDesktopApi<BookUploadResultDto>(page, "uploadTxt", {
    projectId,
    filePath: harnessConfig.sourceTextPath,
    displayName: "凡人修仙传真实运行样本"
  });

  assertHarnessUploadChapterCoverage(
    upload.chapterCount,
    harnessConfig.windowParams.extractionChapterCount
  );
  return upload;
}

async function createHarnessJob(input: {
  page: Page;
  upload: BookUploadResultDto;
  templates: readonly SavedTemplate[];
  model: HarnessModelSelection;
}): Promise<JobDto> {
  return invokeDesktopApi<JobDto>(
    input.page,
    "createJob",
    buildHarnessCreateJobInput({
      bookId: input.upload.bookId,
      templateIds: input.templates.map(({ template }) => template.id),
      model: input.model,
      windowParams: harnessConfig.windowParams
    })
  );
}

function projectRootFrom(userDataDir: string, project: ProjectDto): string {
  return path.join(userDataDir, "projects", project.slug);
}

function manifestPathFor(projectRoot: string, jobId: string): string {
  return path.join(projectRoot, "runs", jobId, "windows", "manifest.json");
}

function reportPathFor(projectRoot: string, bookId: string, report: ReportDto): string {
  return path.join(projectRoot, "assets", "books", bookId, "reports", report.fileName);
}

async function validateReports(input: {
  page: Page;
  projectRoot: string;
  upload: BookUploadResultDto;
  templates: readonly SavedTemplate[];
}): Promise<Array<{ fileName: string; path: string; byteSize: number }>> {
  const reports = await invokeDesktopApi<ReportDto[]>(input.page, "listReports", {
    bookId: input.upload.bookId
  });
  const templateReports = validateHarnessTemplateOutputReports(
    reports,
    input.templates.map(({ template }) => template.fileName),
    {
      requireAllExpectedReports:
        harnessConfig.windowParams.extractionChapterCount >= REAL_RUN_WINDOW_PARAMS.extractionChapterCount
    }
  );

  for (const report of templateReports) {
    const preview = await invokeDesktopApi<SafeMarkdownPreviewDto>(input.page, "previewReport", {
      reportId: report.id
    });
    expect(preview.reportId).toBe(report.id);
    expect(preview.generatedAt).toBeTruthy();
  }

  return templateReports.map((report) => ({
    fileName: report.fileName,
    path: reportPathFor(input.projectRoot, input.upload.bookId, report),
    byteSize: report.byteSize
  }));
}

test("controlled real AppData desktop extraction harness", async () => {
  let desktop: LaunchedDesktop | undefined;

  try {
    await ensureHarnessInputsExist();
    desktop = await launchDesktop();

    const { page, userDataDir } = desktop;
    const appDataDirOverride = await desktop.app.evaluate(
      () => process.env.NOVEL_EXTRACTOR_E2E_DATA_DIR
    );
    expect(appDataDirOverride).toBeUndefined();

    const project = await findOrCreateProject(page);
    const projectRoot = projectRootFrom(userDataDir, project);
    const templates = await importHarnessTemplates(page, project.id);
    const providers = await invokeDesktopApi(page, "listProviders");
    const model = selectHarnessModel(providers, harnessConfig.preferredModelId);
    const upload = await uploadHarnessBook(page, project.id);
    const job = await createHarnessJob({ page, upload, templates, model });
    const expectedWindowSummary = createExpectedWindowPlanSummary(
      harnessConfig.windowParams.extractionChapterCount,
      harnessConfig.windowParams
    );
    const expectedManifestPath = manifestPathFor(projectRoot, job.id);

    if (runMode === "prepare-only") {
      console.log(
        JSON.stringify(
          {
            mode: runMode,
            userDataDir,
            project: { id: project.id, displayName: project.displayName, slug: project.slug },
            projectRoot,
            bookId: upload.bookId,
            jobId: job.id,
            selectedModel: model,
            sourceTextPath: harnessConfig.sourceTextPath,
            templateSourcePaths: templates.map(({ sourcePath }) => sourcePath),
            expectedManifestPath,
            expectedWindowSummary
          },
          null,
          2
        )
      );
      return;
    }

    const startedJob = await invokeDesktopApi<JobDto>(page, "startJob", { jobId: job.id });
    expect(startedJob.status, startedJob.failureReason).toBe("completed");

    const manifest = JSON.parse(await fs.readFile(expectedManifestPath, "utf8")) as unknown;
    const manifestSummary = validateRuntimeWindowManifest(manifest, expectedWindowSummary);
    const reportOutputs = await validateReports({ page, projectRoot, upload, templates });

    console.log(
      JSON.stringify(
        {
          mode: runMode,
          userDataDir,
          project: { id: project.id, displayName: project.displayName, slug: project.slug },
          projectRoot,
          bookId: upload.bookId,
          jobId: job.id,
          selectedModel: model,
          manifestPath: expectedManifestPath,
          manifestSummary,
          reportOutputs
        },
        null,
        2
      )
    );
  } catch (error) {
    throw new Error(toSafeHarnessError(error));
  } finally {
    await desktop?.app.close();
  }
});

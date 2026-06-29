import { useEffect, useMemo, useState } from "react";
import type { TaskAction } from "@novel-extractor/config";
import type {
  CreateJobDto,
  JobDto,
  ProjectDto,
  ProviderViewDto,
  ReportDto,
  SafeMarkdownPreviewDto,
  SaveProviderDto,
  SaveTemplateDto,
  TemplateDto
} from "../shared/ipcTypes";
import { AssetsPage } from "./features/assets/AssetsPage";
import type { ResourceState } from "./features/assets/AssetsPage";
import { ExtractionPage } from "./features/extraction/ExtractionPage";
import type { CreateJobState } from "./features/extraction/ExtractionParameters";
import type { UploadState } from "./features/extraction/UploadNovelPanel";
import {
  getNextTaskStatusForAction,
  mapJobDtoToExtractionJob,
  mapUploadResultToBook,
  type ExtractionBook,
  type ExtractionJob
} from "./features/extraction/extractionViewModel";
import { GraphPlaceholderPage } from "./features/graph/GraphPlaceholderPage";
import { WorkbenchNav, type WorkbenchPage } from "./features/navigation/WorkbenchNav";
import { ProviderConfigModal } from "./features/providers/ProviderConfigModal";
import { UserMenu } from "./features/providers/UserMenu";
import {
  getExtractionModelsFromProviders,
  type ProviderSaveState
} from "./features/providers/providerViewModel";
import { ProjectGate, type ProjectSummary } from "./features/project/ProjectGate";
import { TemplateManagementModal } from "./features/templates/TemplateManagementModal";
import type { TemplateSaveState } from "./features/templates/TemplateManagementModal";
import { getDefaultTemplateViews } from "./features/templates/templateViewModel";

export interface AppState {
  project: ProjectSummary | null;
}

export interface AppProps {
  initialState?: AppState;
}

const DEFAULT_STATE: AppState = {
  project: null
};

function createLocalProject(displayName: string): ProjectSummary {
  return {
    id: `local-${displayName.trim().toLowerCase().replace(/\s+/g, "-") || "project"}`,
    displayName
  };
}

function mapProjectDtoToSummary(project: ProjectDto): ProjectSummary {
  return {
    id: project.id,
    displayName: project.displayName
  };
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function appendJobLog(job: ExtractionJob, line: string): ExtractionJob {
  return {
    ...job,
    logs: [...(job.logs ?? []), line]
  };
}

export function App({ initialState = DEFAULT_STATE }: AppProps) {
  const [project, setProject] = useState<ProjectSummary | null>(initialState.project);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectState, setProjectState] = useState<ResourceState>("ready");
  const [projectError, setProjectError] = useState<string | undefined>();
  const [activePage, setActivePage] = useState<WorkbenchPage>("assets");
  const [isProviderModalOpen, setProviderModalOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderViewDto[]>([]);
  const [providerState, setProviderState] = useState<ResourceState>("ready");
  const [providerError, setProviderError] = useState<string | undefined>();
  const [saveState, setSaveState] = useState<ProviderSaveState>("idle");
  const [saveError, setSaveError] = useState<string | undefined>();
  const [books, setBooks] = useState<ExtractionBook[]>([]);
  const [assetReports, setAssetReports] = useState<ReportDto[]>([]);
  const [selectedAssetBookId, setSelectedAssetBookId] = useState<string | null>(null);
  const [reportState, setReportState] = useState<ResourceState>("ready");
  const [reportError, setReportError] = useState<string | undefined>();
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [reportPreview, setReportPreview] = useState<SafeMarkdownPreviewDto | null>(null);
  const [previewState, setPreviewState] = useState<ResourceState>("ready");
  const [previewError, setPreviewError] = useState<string | undefined>();
  const [jobs, setJobs] = useState<ExtractionJob[]>([]);
  const [extractionError, setExtractionError] = useState<string | undefined>();
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [createState, setCreateState] = useState<CreateJobState>("idle");
  const [createError, setCreateError] = useState<string | undefined>();
  const [templates, setTemplates] = useState<TemplateDto[]>(() => getDefaultTemplateViews());
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>(() =>
    getDefaultTemplateViews().map((template) => template.id)
  );
  const [isTemplateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateSaveState, setTemplateSaveState] = useState<TemplateSaveState>("idle");
  const [templateSaveError, setTemplateSaveError] = useState<string | undefined>();

  const extractionModels = useMemo(
    () => getExtractionModelsFromProviders(providers),
    [providers]
  );

  async function refreshProjects(): Promise<void> {
    const api = window.novelExtractor;
    if (!api?.listProjects) {
      setProjectState("ready");
      return;
    }

    setProjectState("loading");
    setProjectError(undefined);

    try {
      const nextProjects = await api.listProjects();
      setProjects(nextProjects.map(mapProjectDtoToSummary));
      setProjectState("ready");
    } catch (error) {
      setProjectError(getErrorMessage(error, "读取项目失败"));
      setProjectState("error");
    }
  }

  async function refreshProviders(): Promise<void> {
    const api = window.novelExtractor;
    if (!api?.listProviders) {
      setProviderState("ready");
      return;
    }

    setProviderState("loading");
    setProviderError(undefined);

    try {
      const nextProviders = await api.listProviders();
      setProviders(nextProviders);
      setProviderState("ready");
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : "读取大模型配置失败");
      setProviderState("error");
    }
  }

  async function refreshTemplates(projectId = project?.id): Promise<void> {
    const api = window.novelExtractor;
    if (!projectId || !api?.listTemplates || !api?.getTemplateSelection) {
      return;
    }

    try {
      const [templateList, selection] = await Promise.all([
        api.listTemplates({ projectId }),
        api.getTemplateSelection({ projectId })
      ]);
      const nextTemplates = templateList.templates;
      const availableTemplateIds = new Set(nextTemplates.map((template) => template.id));
      setTemplates(nextTemplates);
      setSelectedTemplateIds(
        selection.templateIds.filter((templateId) => availableTemplateIds.has(templateId))
      );
    } catch (error) {
      setExtractionError(getErrorMessage(error, "读取模板失败"));
    }
  }

  useEffect(() => {
    if (!project) {
      return;
    }

    void refreshProviders();
    void refreshTemplates(project.id);
  }, [project]);

  useEffect(() => {
    if (project) {
      return;
    }

    void refreshProjects();
  }, []);

  async function createProject(displayName: string): Promise<ProjectSummary> {
    const api = window.novelExtractor;

    if (!api?.createProject) {
      const localProject = createLocalProject(displayName);
      setProjects((currentProjects) => [
        localProject,
        ...currentProjects.filter((currentProject) => currentProject.id !== localProject.id)
      ]);
      setProject(localProject);
      return localProject;
    }

    const createdProject = mapProjectDtoToSummary(
      await api.createProject({
        displayName
      })
    );
    setProjects((currentProjects) => [
      createdProject,
      ...currentProjects.filter((currentProject) => currentProject.id !== createdProject.id)
    ]);
    setProject(createdProject);
    return createdProject;
  }

  async function saveProvider(input: SaveProviderDto): Promise<void> {
    const api = window.novelExtractor;
    if (!api?.saveProvider) {
      throw new Error("保存大模型配置失败");
    }

    setSaveState("saving");
    setSaveError(undefined);

    try {
      await api.saveProvider(input);
      await refreshProviders();
      setSaveState("idle");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存大模型配置失败");
      setSaveState("error");
      throw error;
    }
  }

  async function saveTemplateSelection(templateIds: string[]): Promise<void> {
    const api = window.novelExtractor;
    if (!project || !api?.saveTemplateSelection) {
      setSelectedTemplateIds(templateIds);
      return;
    }

    setSelectedTemplateIds(templateIds);
    setExtractionError(undefined);

    try {
      const selection = await api.saveTemplateSelection({
        projectId: project.id,
        templateIds
      });
      setSelectedTemplateIds(selection.templateIds);
    } catch (error) {
      setExtractionError(getErrorMessage(error, "保存模板选择失败"));
    }
  }

  async function saveTemplate(input: SaveTemplateDto): Promise<TemplateDto> {
    const api = window.novelExtractor;
    if (!api?.saveTemplate) {
      throw new Error("保存模板失败");
    }

    setTemplateSaveState("saving");
    setTemplateSaveError(undefined);

    try {
      const savedTemplate = await api.saveTemplate(input);
      await refreshTemplates(input.projectId);
      setTemplateSaveState("idle");
      return savedTemplate;
    } catch (error) {
      setTemplateSaveError(getErrorMessage(error, "保存模板失败"));
      setTemplateSaveState("error");
      throw error;
    }
  }

  async function deleteTemplate(templateId: string): Promise<void> {
    const api = window.novelExtractor;
    if (!api?.deleteTemplate || !project) {
      throw new Error("删除模板失败");
    }

    setTemplateSaveError(undefined);

    try {
      await api.deleteTemplate({ templateId });
      await refreshTemplates(project.id);
    } catch (error) {
      setTemplateSaveError(getErrorMessage(error, "删除模板失败"));
      setTemplateSaveState("error");
      throw error;
    }
  }

  async function uploadTxt(file: File): Promise<void> {
    const api = window.novelExtractor;
    if (!project || !api?.uploadTxt) {
      setUploadError("上传小说失败");
      setUploadState("error");
      return;
    }

    const filePath = (file as File & { path?: string }).path?.trim() || file.name;

    setUploadState("uploading");
    setUploadError(undefined);

    try {
      const result = await api.uploadTxt({
        projectId: project.id,
        filePath,
        displayName: file.name
      });
      const nextBook = mapUploadResultToBook(result);
      setBooks((currentBooks) => [
        nextBook,
        ...currentBooks.filter((book) => book.id !== nextBook.id)
      ]);
      setUploadState("idle");
    } catch (error) {
      setUploadError(getErrorMessage(error, "上传小说失败"));
      setUploadState("error");
    }
  }

  async function selectAssetBook(bookId: string): Promise<void> {
    const api = window.novelExtractor;
    setSelectedAssetBookId(bookId);
    setSelectedReportId(null);
    setReportPreview(null);
    setPreviewState("ready");
    setPreviewError(undefined);

    if (!api?.listReports) {
      setAssetReports([]);
      setReportError("读取报告失败");
      setReportState("error");
      return;
    }

    setReportState("loading");
    setReportError(undefined);

    try {
      const nextReports = await api.listReports({ bookId });
      setAssetReports(nextReports);
      setReportState("ready");
    } catch (error) {
      setAssetReports([]);
      setReportError(getErrorMessage(error, "读取报告失败"));
      setReportState("error");
    }
  }

  async function selectReport(reportId: string): Promise<void> {
    const api = window.novelExtractor;
    setSelectedReportId(reportId);
    setReportPreview(null);

    if (!api?.previewReport) {
      setPreviewError("读取预览失败");
      setPreviewState("error");
      return;
    }

    setPreviewState("loading");
    setPreviewError(undefined);

    try {
      const preview = await api.previewReport({ reportId });
      setReportPreview(preview);
      setPreviewState("ready");
    } catch (error) {
      setPreviewError(getErrorMessage(error, "读取预览失败"));
      setPreviewState("error");
    }
  }

  async function createJob(input: CreateJobDto): Promise<void> {
    const api = window.novelExtractor;
    if (!api?.createJob) {
      setCreateError("创建任务失败");
      setCreateState("error");
      return;
    }

    setCreateState("creating");
    setCreateError(undefined);

    try {
      const createdJob = mapJobDtoToExtractionJob(await api.createJob(input), ["任务已创建"]);
      if (createdJob) {
        setJobs((currentJobs) => [
          createdJob,
          ...currentJobs.filter((job) => job.id !== createdJob.id)
        ]);
      }
      setCreateState("idle");
    } catch (error) {
      setCreateError(getErrorMessage(error, "创建任务失败"));
      setCreateState("error");
    }
  }

  async function runJobAction(jobId: string, action: TaskAction): Promise<void> {
    const api = window.novelExtractor;
    if (!api) {
      setExtractionError("任务操作失败");
      return;
    }

    setExtractionError(undefined);

    let updatedJob: JobDto | void = undefined;

    try {
      switch (action) {
        case "start":
          updatedJob = await api.startJob({ jobId });
          break;
        case "pause":
          updatedJob = await api.pauseJob({ jobId });
          break;
        case "resume":
          updatedJob = await api.resumeJob({ jobId });
          break;
        case "delete":
          await api.deleteJob({ jobId, confirm: true });
          break;
        default:
          return;
      }

      if (updatedJob) {
        const mappedJob = mapJobDtoToExtractionJob(updatedJob, [
          action === "start" ? "任务已完成" : "任务状态已更新"
        ]);
        if (mappedJob) {
          setJobs((currentJobs) =>
            currentJobs.map((job) => (job.id === jobId ? mappedJob : job))
          );
        }
        return;
      }

      const nextStatus = getNextTaskStatusForAction(action);
      if (!nextStatus) {
        setJobs((currentJobs) => currentJobs.filter((job) => job.id !== jobId));
        return;
      }

      const logLineByAction: Record<TaskAction, string> = {
        start: "任务已开始",
        pause: "任务已暂停",
        resume: "任务已继续",
        delete: "任务已删除"
      };

      setJobs((currentJobs) =>
        currentJobs.map((job) =>
          job.id === jobId
            ? appendJobLog({ ...job, status: nextStatus }, logLineByAction[action])
            : job
        )
      );
    } catch (error) {
      setExtractionError(getErrorMessage(error, "任务操作失败"));
    }
  }

  async function deleteJob(jobId: string): Promise<void> {
    await runJobAction(jobId, "delete");
  }

  if (!project) {
    return (
      <main className="project-gate-shell" data-testid="desktop-shell">
        <ProjectGate
          errorMessage={projectError}
          projects={projects}
          state={projectState}
          onCreateProject={createProject}
          onSelectProject={setProject}
        />
      </main>
    );
  }

  return (
    <div className="workbench-shell" data-testid="desktop-shell">
      <WorkbenchNav
        activePage={activePage}
        projectName={project.displayName}
        onPageChange={setActivePage}
        userMenu={<UserMenu onOpenProviderConfig={() => setProviderModalOpen(true)} />}
      />
      <main className="workbench-main" aria-label="工作台内容">
        {activePage === "assets" ? (
          <AssetsPage
            books={books}
            preview={reportPreview}
            previewErrorMessage={previewError}
            previewState={previewState}
            reportErrorMessage={reportError}
            reportState={reportState}
            reports={assetReports}
            selectedBookId={selectedAssetBookId}
            selectedReportId={selectedReportId}
            state="ready"
            onSelectBook={selectAssetBook}
            onSelectReport={selectReport}
          />
        ) : null}
        {activePage === "extraction" ? (
          <ExtractionPage
            books={books}
            createError={createError}
            createState={createState}
            errorMessage={extractionError}
            jobs={jobs}
            models={extractionModels}
            onOpenProviderConfig={() => setProviderModalOpen(true)}
            onOpenTemplateManager={() => setTemplateModalOpen(true)}
            onCreateJob={createJob}
            onDeleteJob={deleteJob}
            onJobAction={runJobAction}
            onTemplateSelectionChange={(templateIds) => {
              void saveTemplateSelection(templateIds);
            }}
            onUploadTxt={uploadTxt}
            state={extractionError ? "error" : "ready"}
            selectedTemplateIds={selectedTemplateIds}
            templates={templates}
            uploadError={uploadError}
            uploadState={uploadState}
          />
        ) : null}
        {activePage === "graph" ? <GraphPlaceholderPage state="ready" /> : null}
      </main>
      <ProviderConfigModal
        open={isProviderModalOpen}
        providerError={providerError}
        providers={providers}
        providerState={providerState}
        saveError={saveError}
        saveState={saveState}
        onClose={() => setProviderModalOpen(false)}
        onSaveProvider={saveProvider}
      />
      <TemplateManagementModal
        open={isTemplateModalOpen}
        projectId={project.id}
        saveError={templateSaveError}
        saveState={templateSaveState}
        selectedTemplateIds={selectedTemplateIds}
        templates={templates}
        onClose={() => setTemplateModalOpen(false)}
        onDeleteTemplate={deleteTemplate}
        onSelectionChange={saveTemplateSelection}
        onSaveTemplate={saveTemplate}
      />
    </div>
  );
}

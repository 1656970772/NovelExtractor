import type {
  BookUploadResultDto,
  CreateJobDto,
  DesktopIpcEvent,
  DesktopIpcEventChannel,
  DesktopSettingsDto,
  DeleteJobDto,
  DesktopIpcChannel,
  DesktopIpcRequest,
  DesktopIpcResponse,
  JobDto,
  JobLogDto,
  ProjectDto,
  ProjectRuntimeDto,
  ProviderViewDto,
  ReportDto,
  SafeMarkdownPreviewDto,
  SaveDesktopSettingsDto,
  SaveProviderDto,
  SaveTemplateDto,
  TemplateDto,
  TemplateListDto,
  TemplateSelectionDto,
  UploadTxtDto
} from "../shared/ipcTypes";

export type InvokeDesktopIpc = <TChannel extends DesktopIpcChannel>(
  channel: TChannel,
  input?: DesktopIpcRequest<TChannel>
) => Promise<unknown>;

export type SubscribeDesktopIpc = <TChannel extends DesktopIpcEventChannel>(
  channel: TChannel,
  handler: (event: DesktopIpcEvent<TChannel>) => void
) => () => void;

export interface NovelExtractorDesktopApi {
  createProject(input: { displayName: string }): Promise<ProjectDto>;
  listProjects(): Promise<ProjectDto[]>;
  getSettings(): Promise<DesktopSettingsDto>;
  saveSettings(input: SaveDesktopSettingsDto): Promise<DesktopSettingsDto>;
  chooseProjectDirectory(): Promise<string | undefined>;
  saveProvider(input: SaveProviderDto): Promise<void>;
  listProviders(): Promise<ProviderViewDto[]>;
  uploadTxt(input: UploadTxtDto): Promise<BookUploadResultDto>;
  listReports(input: { bookId: string }): Promise<ReportDto[]>;
  previewReport(input: { reportId: string }): Promise<SafeMarkdownPreviewDto>;
  getProjectRuntime(input: { projectId: string }): Promise<ProjectRuntimeDto>;
  listTemplates(input: { projectId: string }): Promise<TemplateListDto>;
  saveTemplate(input: SaveTemplateDto): Promise<TemplateDto>;
  deleteTemplate(input: { templateId: string }): Promise<void>;
  getTemplateSelection(input: { projectId: string }): Promise<TemplateSelectionDto>;
  saveTemplateSelection(input: TemplateSelectionDto): Promise<TemplateSelectionDto>;
  createJob(input: CreateJobDto): Promise<JobDto>;
  startJob(input: { jobId: string }): Promise<JobDto | void>;
  pauseJob(input: { jobId: string }): Promise<JobDto | void>;
  resumeJob(input: { jobId: string }): Promise<JobDto | void>;
  restartJob(input: { jobId: string }): Promise<JobDto | void>;
  deleteJob(input: DeleteJobDto): Promise<void>;
  readJobLog(input: { jobId: string }): Promise<JobLogDto>;
  openJobLog(input: { jobId: string }): Promise<void>;
  openJobOutputDirectory(input: { jobId: string }): Promise<void>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  onJobUpdated(handler: (job: JobDto) => void): () => void;
}

function invokeTyped<TChannel extends DesktopIpcChannel>(
  invoke: InvokeDesktopIpc,
  channel: TChannel,
  input?: DesktopIpcRequest<TChannel>
): Promise<DesktopIpcResponse<TChannel>> {
  return invoke(channel, input) as Promise<DesktopIpcResponse<TChannel>>;
}

export function createNovelExtractorDesktopApi(
  invoke: InvokeDesktopIpc,
  subscribe?: SubscribeDesktopIpc
): NovelExtractorDesktopApi {
  const api: NovelExtractorDesktopApi = {
    createProject: (input) => invokeTyped(invoke, "project:create", input),
    listProjects: () => invokeTyped(invoke, "project:list", undefined),
    getSettings: () => invokeTyped(invoke, "settings:get", undefined),
    saveSettings: (input) => invokeTyped(invoke, "settings:save", input),
    chooseProjectDirectory: () => invokeTyped(invoke, "settings:chooseProjectDirectory", undefined),
    saveProvider: (input) => invokeTyped(invoke, "providers:save", input),
    listProviders: () => invokeTyped(invoke, "providers:list", undefined),
    uploadTxt: (input) => invokeTyped(invoke, "books:uploadTxt", input),
    listReports: (input) => invokeTyped(invoke, "books:listReports", input),
    previewReport: (input) => invokeTyped(invoke, "reports:preview", input),
    getProjectRuntime: (input) => invokeTyped(invoke, "projectRuntime:get", input),
    listTemplates: (input) => invokeTyped(invoke, "templates:list", input),
    saveTemplate: (input) => invokeTyped(invoke, "templates:save", input),
    deleteTemplate: (input) => invokeTyped(invoke, "templates:delete", input),
    getTemplateSelection: (input) => invokeTyped(invoke, "templateSelection:get", input),
    saveTemplateSelection: (input) => invokeTyped(invoke, "templateSelection:save", input),
    createJob: (input) => invokeTyped(invoke, "jobs:create", input),
    startJob: (input) => invokeTyped(invoke, "jobs:start", input),
    pauseJob: (input) => invokeTyped(invoke, "jobs:pause", input),
    resumeJob: (input) => invokeTyped(invoke, "jobs:resume", input),
    restartJob: (input) => invokeTyped(invoke, "jobs:restart", input),
    deleteJob: (input) => invokeTyped(invoke, "jobs:delete", input),
    readJobLog: (input) => invokeTyped(invoke, "jobs:readLog", input),
    openJobLog: (input) => invokeTyped(invoke, "jobs:openLog", input),
    openJobOutputDirectory: (input) => invokeTyped(invoke, "jobs:openOutputDirectory", input),
    minimizeWindow: () => invokeTyped(invoke, "window:minimize", undefined),
    toggleMaximizeWindow: () => invokeTyped(invoke, "window:toggleMaximize", undefined),
    closeWindow: () => invokeTyped(invoke, "window:close", undefined),
    onJobUpdated: (handler) => subscribe?.("jobs:updated", handler) ?? (() => undefined)
  };

  return Object.freeze(api);
}

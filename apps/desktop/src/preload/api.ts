import type {
  BookUploadResultDto,
  CreateJobDto,
  DeleteJobDto,
  DesktopIpcChannel,
  DesktopIpcRequest,
  DesktopIpcResponse,
  JobDto,
  ProjectDto,
  ProviderViewDto,
  ReportDto,
  SafeMarkdownPreviewDto,
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

export interface NovelExtractorDesktopApi {
  createProject(input: { displayName: string }): Promise<ProjectDto>;
  listProjects(): Promise<ProjectDto[]>;
  saveProvider(input: SaveProviderDto): Promise<void>;
  listProviders(): Promise<ProviderViewDto[]>;
  uploadTxt(input: UploadTxtDto): Promise<BookUploadResultDto>;
  listReports(input: { bookId: string }): Promise<ReportDto[]>;
  previewReport(input: { reportId: string }): Promise<SafeMarkdownPreviewDto>;
  listTemplates(input: { projectId: string }): Promise<TemplateListDto>;
  saveTemplate(input: SaveTemplateDto): Promise<TemplateDto>;
  deleteTemplate(input: { templateId: string }): Promise<void>;
  getTemplateSelection(input: { projectId: string }): Promise<TemplateSelectionDto>;
  saveTemplateSelection(input: TemplateSelectionDto): Promise<TemplateSelectionDto>;
  createJob(input: CreateJobDto): Promise<JobDto>;
  startJob(input: { jobId: string }): Promise<JobDto | void>;
  pauseJob(input: { jobId: string }): Promise<JobDto | void>;
  resumeJob(input: { jobId: string }): Promise<JobDto | void>;
  deleteJob(input: DeleteJobDto): Promise<void>;
}

function invokeTyped<TChannel extends DesktopIpcChannel>(
  invoke: InvokeDesktopIpc,
  channel: TChannel,
  input?: DesktopIpcRequest<TChannel>
): Promise<DesktopIpcResponse<TChannel>> {
  return invoke(channel, input) as Promise<DesktopIpcResponse<TChannel>>;
}

export function createNovelExtractorDesktopApi(
  invoke: InvokeDesktopIpc
): NovelExtractorDesktopApi {
  const api: NovelExtractorDesktopApi = {
    createProject: (input) => invokeTyped(invoke, "project:create", input),
    listProjects: () => invokeTyped(invoke, "project:list", undefined),
    saveProvider: (input) => invokeTyped(invoke, "providers:save", input),
    listProviders: () => invokeTyped(invoke, "providers:list", undefined),
    uploadTxt: (input) => invokeTyped(invoke, "books:uploadTxt", input),
    listReports: (input) => invokeTyped(invoke, "books:listReports", input),
    previewReport: (input) => invokeTyped(invoke, "reports:preview", input),
    listTemplates: (input) => invokeTyped(invoke, "templates:list", input),
    saveTemplate: (input) => invokeTyped(invoke, "templates:save", input),
    deleteTemplate: (input) => invokeTyped(invoke, "templates:delete", input),
    getTemplateSelection: (input) => invokeTyped(invoke, "templateSelection:get", input),
    saveTemplateSelection: (input) => invokeTyped(invoke, "templateSelection:save", input),
    createJob: (input) => invokeTyped(invoke, "jobs:create", input),
    startJob: (input) => invokeTyped(invoke, "jobs:start", input),
    pauseJob: (input) => invokeTyped(invoke, "jobs:pause", input),
    resumeJob: (input) => invokeTyped(invoke, "jobs:resume", input),
    deleteJob: (input) => invokeTyped(invoke, "jobs:delete", input)
  };

  return Object.freeze(api);
}

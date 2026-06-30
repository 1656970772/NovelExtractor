import type { ProviderKind as ConfigProviderKind } from "@novel-extractor/config";
import type { JobStatus as DomainJobStatus } from "@novel-extractor/domain";

export type ProviderKind = ConfigProviderKind;
export type JobStatus = DomainJobStatus;

export const DESKTOP_IPC_CHANNELS = [
  "project:create",
  "project:list",
  "settings:get",
  "settings:save",
  "providers:save",
  "providers:list",
  "books:uploadTxt",
  "books:listReports",
  "templates:list",
  "templates:save",
  "templates:delete",
  "templateSelection:get",
  "templateSelection:save",
  "jobs:create",
  "jobs:start",
  "jobs:pause",
  "jobs:resume",
  "jobs:delete",
  "reports:preview"
] as const;

export type DesktopIpcChannel = (typeof DESKTOP_IPC_CHANNELS)[number];

export interface ProjectDto {
  id: string;
  displayName: string;
  slug: string;
  createdAt: string;
}

export interface DesktopSettingsDto {
  defaultProjectStorageDirectory: string;
  effectiveProjectStorageDirectory: string;
  projectStorageDirectory?: string;
}

export interface SaveDesktopSettingsDto {
  projectStorageDirectory?: string;
}

export interface SaveProviderDto {
  providerId?: string;
  presetId: "deepseek" | "custom-openai-compatible";
  displayName: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  modelName: string;
  defaultModel: boolean;
  enabled: boolean;
}

export interface ProviderViewDto {
  id: string;
  presetId: "deepseek" | "custom-openai-compatible";
  displayName: string;
  kind: ProviderKind;
  baseUrl?: string;
  models: Array<{ id: string; displayName: string; enabled: boolean; isDefault: boolean }>;
  hasApiKey: boolean;
  enabled: boolean;
}

export interface UploadTxtDto {
  projectId: string;
  filePath: string;
  displayName?: string;
}

export interface BookUploadResultDto {
  bookId: string;
  displayName: string;
  sourceAssetId: string;
  sourceTextPath: string;
  fileName: string;
  byteSize: number;
  encoding: "utf-8" | "utf-8-bom" | "gbk" | "cp936";
  chapterCount: number;
}

export interface ReportDto {
  id: string;
  bookId: string;
  fileName: string;
  displayName: string;
  reportKind?: "raw-window" | "template-output";
  byteSize: number;
  createdAt: string;
  updatedAt: string;
}

export interface SafeMarkdownPreviewDto {
  reportId: string;
  html: string;
  headings: Array<{ id: string; depth: number; text: string }>;
  generatedAt: string;
}

export type TemplateScope = "global" | "project";

export interface TemplateDto {
  id: string;
  scope: TemplateScope;
  projectId?: string;
  name: string;
  fileName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListTemplatesDto {
  projectId: string;
}

export interface SaveTemplateDto {
  templateId?: string;
  projectId: string;
  scope: TemplateScope;
  name: string;
  fileName: string;
  body: string;
}

export interface DeleteTemplateDto {
  templateId: string;
}

export interface TemplateSelectionDto {
  projectId: string;
  templateIds: string[];
}

export interface TemplateListDto {
  templates: TemplateDto[];
}

export interface CreateJobDto {
  bookId: string;
  templateIds: string[];
  providerConfigId: string;
  modelId: string;
  singleRunChapterCount: number;
  extractionChapterCount: number;
  overlapChapterCount: number;
  skipAlreadyExtracted: boolean;
}

export interface JobDto {
  id: string;
  bookId: string;
  status: JobStatus;
  progressText: string;
  tokenText?: string;
  failureReason?: string;
  allowedActions: Array<"start" | "pause" | "resume" | "delete">;
  createdAt: string;
  updatedAt: string;
}

export interface DeleteJobDto {
  jobId: string;
  confirm: true;
}

export interface DesktopIpcRequestMap {
  "project:create": { displayName: string };
  "project:list": undefined;
  "settings:get": undefined;
  "settings:save": SaveDesktopSettingsDto;
  "providers:save": SaveProviderDto;
  "providers:list": undefined;
  "books:uploadTxt": UploadTxtDto;
  "books:listReports": { bookId: string };
  "templates:list": ListTemplatesDto;
  "templates:save": SaveTemplateDto;
  "templates:delete": DeleteTemplateDto;
  "templateSelection:get": { projectId: string };
  "templateSelection:save": TemplateSelectionDto;
  "jobs:create": CreateJobDto;
  "jobs:start": { jobId: string };
  "jobs:pause": { jobId: string };
  "jobs:resume": { jobId: string };
  "jobs:delete": DeleteJobDto;
  "reports:preview": { reportId: string };
}

export interface DesktopIpcResponseMap {
  "project:create": ProjectDto;
  "project:list": ProjectDto[];
  "settings:get": DesktopSettingsDto;
  "settings:save": DesktopSettingsDto;
  "providers:save": void;
  "providers:list": ProviderViewDto[];
  "books:uploadTxt": BookUploadResultDto;
  "books:listReports": ReportDto[];
  "templates:list": TemplateListDto;
  "templates:save": TemplateDto;
  "templates:delete": void;
  "templateSelection:get": TemplateSelectionDto;
  "templateSelection:save": TemplateSelectionDto;
  "jobs:create": JobDto;
  "jobs:start": JobDto | void;
  "jobs:pause": JobDto | void;
  "jobs:resume": JobDto | void;
  "jobs:delete": void;
  "reports:preview": SafeMarkdownPreviewDto;
}

export type DesktopIpcRequest<TChannel extends DesktopIpcChannel> =
  DesktopIpcRequestMap[TChannel];

export type DesktopIpcResponse<TChannel extends DesktopIpcChannel> =
  DesktopIpcResponseMap[TChannel];

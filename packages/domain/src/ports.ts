import type { Job, JobEvent } from "./job";
import type { ApiKeyRef, ProviderConfig } from "./provider";
import type { Book, Chapter, Project, ReportAsset } from "./project";
import type { TemplateSnapshot } from "./template";

export interface ProjectRepository {
  createProject(input: { displayName: string }): Promise<Project>;
  findByDisplayName(displayName: string): Promise<Project | null>;
  listReports(bookId: string): Promise<ReportAsset[]>;
}

export interface BookRepository {
  createBook(
    input: Pick<Book, "projectId" | "displayName" | "sourceAssetId" | "sourceTextPath" | "chapterCount">
  ): Promise<Book>;
  listBooks(projectId: string): Promise<Book[]>;
  listChapters(bookId: string): Promise<Chapter[]>;
}

export interface JobRepository {
  createJob(input: Omit<Job, "id" | "createdAt" | "updatedAt">): Promise<Job>;
  updateJob(job: Job): Promise<Job>;
  appendJobEvent(jobId: string, event: JobEvent): Promise<void>;
}

export interface ProviderConfigRepository {
  listProviderConfigs(): Promise<ProviderConfig[]>;
  saveProviderConfig(config: ProviderConfig): Promise<ProviderConfig>;
}

export interface TemplateSnapshotRepository {
  saveTemplateSnapshots(jobId: string, snapshots: TemplateSnapshot[]): Promise<TemplateSnapshot[]>;
  listTemplateSnapshots(jobId: string): Promise<TemplateSnapshot[]>;
}

export interface CredentialStore {
  saveApiKey(ref: ApiKeyRef, value: string): Promise<void>;
  resolveApiKey(ref: ApiKeyRef): Promise<string | null>;
}

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  createId(prefix?: string): string;
}

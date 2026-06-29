export interface TemplateSelection {
  templateId: string;
  outputFileName?: string;
}

export interface TemplateSnapshot {
  id: string;
  jobId: string;
  templateId: string;
  name: string;
  body: string;
  reportFileName: string;
  createdAt: string;
}

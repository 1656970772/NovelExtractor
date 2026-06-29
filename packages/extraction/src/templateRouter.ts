export type TemplateRoutingErrorCode = "INVALID_TEMPLATE_NAME";

export class TemplateRoutingError extends Error {
  readonly code: TemplateRoutingErrorCode;

  constructor(code: TemplateRoutingErrorCode, message: string) {
    super(message);
    this.name = "TemplateRoutingError";
    this.code = code;
  }
}

export interface TemplateSnapshotSource {
  id: string;
  name: string;
  body: string;
  outputFileName?: string | null;
}

export interface TemplateSnapshotClock {
  now(): string;
}

export interface CreateTemplateSnapshotsOptions {
  clock?: TemplateSnapshotClock;
}

export interface TemplateSnapshot {
  templateId: string;
  templateName: string;
  templateBody: string;
  reportFileName: string;
  createdAt: string;
}

const systemClock: TemplateSnapshotClock = {
  now: () => new Date().toISOString()
};

export function createTemplateSnapshots(
  templates: readonly TemplateSnapshotSource[],
  options: CreateTemplateSnapshotsOptions = {}
): TemplateSnapshot[] {
  const createdAt = (options.clock ?? systemClock).now();

  return templates.map((template) => ({
    templateId: template.id,
    templateName: template.name,
    templateBody: template.body,
    reportFileName: resolveReportFileName(template),
    createdAt
  }));
}

function resolveReportFileName(template: TemplateSnapshotSource): string {
  const explicitOutputFileName = template.outputFileName?.trim();

  if (explicitOutputFileName) {
    return explicitOutputFileName;
  }

  const reportNameBase = template.name.trim().replace(/\s*模板$/u, "").trim();
  if (!reportNameBase) {
    throw new TemplateRoutingError("INVALID_TEMPLATE_NAME", "Template name must not produce an empty report filename");
  }

  return `${reportNameBase}.md`;
}

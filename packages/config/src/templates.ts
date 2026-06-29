import { getDefaultConfig } from "./defaults";
import type { BuiltInTemplate, ReportFileNameInput } from "./schema";

export class UnknownTemplateError extends Error {
  constructor(templateName: string) {
    super(`Unknown built-in template: ${templateName}.`);
    this.name = "UnknownTemplateError";
  }
}

export function getBuiltInTemplates(): BuiltInTemplate[] {
  return getDefaultConfig().builtInTemplates;
}

export function resolveReportFileName(input: ReportFileNameInput): string {
  const explicitOutputFileName = input.outputFileName?.trim();

  if (explicitOutputFileName) {
    return explicitOutputFileName;
  }

  const templateName = input.name.trim();
  const template = getBuiltInTemplates().find((candidate) => candidate.name === templateName);

  if (template) {
    return template.defaultOutputFileName;
  }

  throw new UnknownTemplateError(templateName);
}

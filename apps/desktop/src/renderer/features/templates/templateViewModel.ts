import { getBuiltInTemplates } from "@novel-extractor/config";
import type { TemplateDto, TemplateScope } from "../../../shared/ipcTypes";

export type TemplateView = TemplateDto;

export interface TemplateGroups {
  global: TemplateView[];
  project: TemplateView[];
}

export function getDefaultTemplateViews(): TemplateView[] {
  const now = "1970-01-01T00:00:00.000Z";

  return getBuiltInTemplates().map((template) => ({
    id: template.id,
    scope: "global",
    name: template.name,
    fileName: template.defaultOutputFileName,
    body: template.description,
    createdAt: now,
    updatedAt: now
  }));
}

export function groupTemplatesByScope(templates: readonly TemplateView[]): TemplateGroups {
  return {
    global: templates.filter((template) => template.scope === "global"),
    project: templates.filter((template) => template.scope === "project")
  };
}

export function getTemplateIds(templates: readonly TemplateView[]): string[] {
  return templates.map((template) => template.id);
}

export function applyTemplateGroupSelection(input: {
  currentTemplateIds: readonly string[];
  groupTemplates: readonly TemplateView[];
  checked: boolean;
}): string[] {
  const groupTemplateIds = getTemplateIds(input.groupTemplates);

  if (input.checked) {
    return [
      ...input.currentTemplateIds,
      ...groupTemplateIds.filter((templateId) => !input.currentTemplateIds.includes(templateId))
    ];
  }

  return input.currentTemplateIds.filter((templateId) => !groupTemplateIds.includes(templateId));
}

export function countTemplatesByScope(
  templates: readonly TemplateView[],
  scope: TemplateScope
): number {
  return templates.filter((template) => template.scope === scope).length;
}

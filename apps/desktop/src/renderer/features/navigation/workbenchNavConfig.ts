import type { LucideIcon } from "lucide-react";
import { FileText, FolderOpen, Settings, Workflow } from "lucide-react";
import type { MenuItemId } from "@novel-extractor/config";

export type WorkbenchRailPageId = Extract<MenuItemId, "assets" | "extraction" | "graph">;
export type WorkbenchRailUtilityId = Extract<MenuItemId, "desktop-settings">;
export type WorkbenchRailItemId = WorkbenchRailPageId | WorkbenchRailUtilityId;

export interface WorkbenchRailRendererConfig {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly shortLabel: string;
}

const WORKBENCH_RAIL_RENDERER_CONFIG_BY_ID = {
  assets: { icon: FolderOpen, label: "资源", shortLabel: "资" },
  extraction: { icon: FileText, label: "提取", shortLabel: "提" },
  graph: { icon: Workflow, label: "关系图", shortLabel: "图" },
  "desktop-settings": { icon: Settings, label: "设置", shortLabel: "设" }
} satisfies Record<WorkbenchRailItemId, WorkbenchRailRendererConfig>;

export function getWorkbenchRailRendererConfig(
  id: MenuItemId
): WorkbenchRailRendererConfig | undefined {
  const configs = WORKBENCH_RAIL_RENDERER_CONFIG_BY_ID as Partial<
    Record<MenuItemId, WorkbenchRailRendererConfig>
  >;

  return configs[id];
}

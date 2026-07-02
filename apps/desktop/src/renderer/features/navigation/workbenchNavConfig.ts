import type { LucideIcon } from "lucide-react";
import { FileText, FolderOpen, Settings, Workflow } from "lucide-react";
import type { WorkbenchPage } from "./WorkbenchNav";

export interface WorkbenchNavItem {
  readonly page: WorkbenchPage;
  readonly label: string;
  readonly icon: LucideIcon;
}

export interface WorkbenchUtilityNavItem {
  readonly id: "desktop-settings";
  readonly label: string;
  readonly icon: LucideIcon;
}

export const WORKBENCH_NAV_ITEMS: readonly WorkbenchNavItem[] = [
  { page: "assets", label: "资源", icon: FolderOpen },
  { page: "extraction", label: "提取", icon: FileText },
  { page: "graph", label: "关系图", icon: Workflow }
];

export const WORKBENCH_SETTINGS_ITEM: WorkbenchUtilityNavItem = {
  id: "desktop-settings",
  label: "设置",
  icon: Settings
};

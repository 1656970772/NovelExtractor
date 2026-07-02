import type { LucideIcon } from "lucide-react";
import { Bot, FileText, FolderOpen, Settings, Workflow } from "lucide-react";
import type { WorkbenchPage } from "./WorkbenchNav";

export interface WorkbenchNavItem {
  readonly page: WorkbenchPage;
  readonly label: string;
  readonly icon: LucideIcon;
}

export interface WorkbenchUtilityNavItem {
  readonly id: "provider-settings" | "desktop-settings";
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

export const WORKBENCH_PROVIDER_SETTINGS_ITEM: WorkbenchUtilityNavItem = {
  id: "provider-settings",
  label: "大模型配置",
  icon: Bot
};

export const WORKBENCH_UTILITY_ITEMS: readonly WorkbenchUtilityNavItem[] = [
  WORKBENCH_PROVIDER_SETTINGS_ITEM,
  WORKBENCH_SETTINGS_ITEM
];

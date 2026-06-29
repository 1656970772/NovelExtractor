import { getDefaultConfig } from "./defaults";
import type { MenuConfig, MenuItemConfig, WorkbenchNavigationConfig } from "./schema";

export function getMenuConfig(): MenuConfig {
  return getDefaultConfig().menu;
}

export function getMainNavigationItems(): MenuItemConfig[] {
  return getMenuConfig().mainNavigation;
}

export function getUserMenuItems(): MenuItemConfig[] {
  return getMenuConfig().userMenu;
}

export function getWorkbenchNavigation(): WorkbenchNavigationConfig {
  return getMenuConfig().workbenchNavigation;
}

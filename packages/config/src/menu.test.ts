import { describe, expect, it } from "vitest";
import { getMenuConfig } from "./menu";
import type { MenuItemConfig } from "./schema";

interface WorkbenchNavigationTestShape {
  topFunctionLabel: string;
  topFunctionItems: MenuItemConfig[];
  railAssetItem: MenuItemConfig;
  railFunctionItems: MenuItemConfig[];
  languageAction: MenuItemConfig;
  userAction: MenuItemConfig;
}

describe("menu config", () => {
  it("expresses workbench navigation slots without putting assets in the top function menu", () => {
    const workbenchNavigation = (getMenuConfig() as { workbenchNavigation?: WorkbenchNavigationTestShape })
      .workbenchNavigation;

    expect(workbenchNavigation?.topFunctionLabel).toBe("功能");
    expect(workbenchNavigation?.topFunctionItems.map((item) => item.id)).toEqual([
      "extraction",
      "graph"
    ]);
    expect(workbenchNavigation?.topFunctionItems.map((item) => item.label)).toEqual([
      "小说提取",
      "关系图谱"
    ]);
    expect(workbenchNavigation?.topFunctionItems.map((item) => item.imageSrc)).toEqual([
      "function-extraction.svg",
      "function-graph.svg"
    ]);
    expect(workbenchNavigation?.topFunctionItems.map((item) => item.id)).not.toContain("assets");
    expect(workbenchNavigation?.railAssetItem).toMatchObject({ id: "assets", label: "资产" });
    expect(workbenchNavigation?.railFunctionItems.map((item) => item.id)).toEqual([
      "extraction",
      "graph"
    ]);
    expect(workbenchNavigation?.languageAction).toMatchObject({ id: "language", label: "语言" });
    expect(workbenchNavigation?.userAction).toMatchObject({ id: "user-menu", label: "用户菜单" });
    expect(getMenuConfig().userMenu.map((item) => item.id)).toEqual([
      "provider-settings",
      "desktop-settings"
    ]);
  });
});

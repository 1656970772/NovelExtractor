import { getWorkbenchNavigation, type MenuItemConfig, type MenuItemId } from "@novel-extractor/config";
import type { FocusEvent, ReactNode } from "react";
import { useId, useState } from "react";

export type WorkbenchPage = Extract<MenuItemId, "assets" | "extraction" | "graph">;

export interface WorkbenchNavProps {
  activePage: WorkbenchPage;
  projectName: string;
  onPageChange: (page: WorkbenchPage) => void;
  userMenu?: ReactNode;
}

interface WorkbenchNavigationItem extends MenuItemConfig {
  id: WorkbenchPage;
}

function isWorkbenchNavigationItem(item: MenuItemConfig): item is WorkbenchNavigationItem {
  return item.id === "assets" || item.id === "extraction" || item.id === "graph";
}

function getRailLabel(item: WorkbenchNavigationItem): string {
  return item.shortLabel ?? item.label.slice(0, 1);
}

export function WorkbenchNav({ activePage, projectName, onPageChange, userMenu }: WorkbenchNavProps) {
  const functionMenuId = useId();
  const [isFunctionMenuHovered, setFunctionMenuHovered] = useState(false);
  const [isFunctionMenuFocused, setFunctionMenuFocused] = useState(false);
  const [isFunctionMenuPinnedOpen, setFunctionMenuPinnedOpen] = useState(false);
  const workbenchNavigation = getWorkbenchNavigation();
  const topFunctionItems = workbenchNavigation.topFunctionItems.filter(isWorkbenchNavigationItem);
  const railAssetItem = isWorkbenchNavigationItem(workbenchNavigation.railAssetItem)
    ? workbenchNavigation.railAssetItem
    : null;
  const railFunctionItems =
    workbenchNavigation.railFunctionItems.filter(isWorkbenchNavigationItem);
  const isFunctionMenuOpen =
    isFunctionMenuHovered || isFunctionMenuFocused || isFunctionMenuPinnedOpen;

  function changePage(page: WorkbenchPage): void {
    onPageChange(page);
    setFunctionMenuHovered(false);
    setFunctionMenuFocused(false);
    setFunctionMenuPinnedOpen(false);
  }

  function closeFunctionMenuAfterBlur(event: FocusEvent<HTMLDivElement>): void {
    const nextTarget = event.relatedTarget;

    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      setFunctionMenuFocused(false);
      setFunctionMenuPinnedOpen(false);
    }
  }

  return (
    <header className="workbench-nav">
      <aside className="rail-nav" aria-label="快捷功能栏">
        <div className="rail-nav__brand" aria-hidden="true">
          NE
        </div>
        {railAssetItem ? (
          <div className="rail-nav__group" aria-label="资产入口">
            <button
              aria-label={railAssetItem.label}
              aria-pressed={activePage === railAssetItem.id}
              className="rail-nav__button"
              onClick={() => changePage(railAssetItem.id)}
              title={railAssetItem.label}
              type="button"
            >
              {getRailLabel(railAssetItem)}
            </button>
          </div>
        ) : null}
        <div className="rail-nav__group" aria-label="功能快捷入口">
          {railFunctionItems.map((item) => (
            <button
              aria-label={item.label}
              aria-pressed={activePage === item.id}
              className="rail-nav__button"
              key={item.id}
              onClick={() => changePage(item.id)}
              title={item.label}
              type="button"
            >
              {getRailLabel(item)}
            </button>
          ))}
        </div>
      </aside>
      <div className="top-nav">
        <div className="top-nav__project">
          <span>当前项目</span>
          <strong>{projectName}</strong>
        </div>
        <div className="top-nav__tabs">
          <div
            className="top-nav__menu-wrap"
            onBlur={closeFunctionMenuAfterBlur}
            onFocus={() => setFunctionMenuFocused(true)}
            onMouseEnter={() => setFunctionMenuHovered(true)}
            onMouseLeave={() => setFunctionMenuHovered(false)}
          >
            <button
              aria-controls={functionMenuId}
              aria-expanded={isFunctionMenuOpen}
              className="nav-tab"
              onClick={() => setFunctionMenuPinnedOpen((currentValue) => !currentValue)}
              type="button"
            >
              {workbenchNavigation.topFunctionLabel}
            </button>
            {isFunctionMenuOpen ? (
              <div className="top-nav__function-panel" id={functionMenuId}>
                <nav className="top-nav__feature-grid" aria-label="功能入口">
                  {topFunctionItems.map((item) => (
                    <button
                      aria-current={activePage === item.id ? "page" : undefined}
                      className="top-nav__feature-card"
                      key={item.id}
                      onClick={() => changePage(item.id)}
                      type="button"
                    >
                      {item.imageSrc ? (
                        <img
                          alt=""
                          className="top-nav__feature-image"
                          src={item.imageSrc}
                        />
                      ) : (
                        <span className="top-nav__feature-fallback" aria-hidden="true">
                          {getRailLabel(item)}
                        </span>
                      )}
                      <span className="top-nav__feature-name">{item.label}</span>
                    </button>
                  ))}
                </nav>
              </div>
            ) : null}
          </div>
        </div>
        <div className="top-nav__actions">
          <button className="button button--quiet" type="button">
            {workbenchNavigation.languageAction.label}
          </button>
          {userMenu ?? (
            <button className="button button--user" type="button">
              {workbenchNavigation.userAction.label}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

import { getWorkbenchNavigation, type MenuItemConfig, type MenuItemId } from "@novel-extractor/config";
import type { FocusEvent, ReactNode } from "react";
import { useId, useState } from "react";
import { flushSync } from "react-dom";
import {
  WORKBENCH_NAV_ITEMS,
  WORKBENCH_SETTINGS_ITEM,
  type WorkbenchNavItem,
  type WorkbenchUtilityNavItem
} from "./workbenchNavConfig";

export type WorkbenchPage = Extract<MenuItemId, "assets" | "extraction" | "graph">;

export interface WorkbenchNavProps {
  activePage: WorkbenchPage;
  projectName: string;
  onPageChange: (page: WorkbenchPage) => void;
  onOpenSettings?: () => void;
  userMenu?: ReactNode;
}

interface WorkbenchNavigationItem extends MenuItemConfig {
  id: WorkbenchPage;
}

type RailItemId = WorkbenchPage | WorkbenchUtilityNavItem["id"];

function isWorkbenchNavigationItem(item: MenuItemConfig): item is WorkbenchNavigationItem {
  return item.id === "assets" || item.id === "extraction" || item.id === "graph";
}

function getRailLabel(item: MenuItemConfig): string {
  return item.shortLabel ?? item.label.slice(0, 1);
}

function getRailTooltipId(id: RailItemId): string {
  return `rail-nav-tooltip-${id}`;
}

export function WorkbenchNav({
  activePage,
  projectName,
  onPageChange,
  onOpenSettings,
  userMenu
}: WorkbenchNavProps) {
  const functionMenuId = useId();
  const [isFunctionMenuHovered, setFunctionMenuHovered] = useState(false);
  const [isFunctionMenuFocused, setFunctionMenuFocused] = useState(false);
  const [isFunctionMenuPinnedOpen, setFunctionMenuPinnedOpen] = useState(false);
  const [hoveredRailItemId, setHoveredRailItemId] = useState<RailItemId | null>(null);
  const [focusedRailItemId, setFocusedRailItemId] = useState<RailItemId | null>(null);
  const workbenchNavigation = getWorkbenchNavigation();
  const topFunctionItems = workbenchNavigation.topFunctionItems.filter(isWorkbenchNavigationItem);
  const railAssetItems = WORKBENCH_NAV_ITEMS.filter((item) => item.page === "assets");
  const railFunctionItems = WORKBENCH_NAV_ITEMS.filter((item) => item.page !== "assets");
  const visibleRailTooltipId = focusedRailItemId ?? hoveredRailItemId;
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

  function handleUtilityItemClick(item: WorkbenchUtilityNavItem): void {
    if (item.id === "desktop-settings") {
      onOpenSettings?.();
    }
  }

  function focusRailItem(id: RailItemId): void {
    flushSync(() => setFocusedRailItemId(id));
  }

  function renderPageRailButton(item: WorkbenchNavItem): ReactNode {
    const Icon = item.icon;
    const tooltipId = getRailTooltipId(item.page);

    return (
      <div className="rail-nav__button-wrap" key={item.page}>
        <button
          aria-describedby={visibleRailTooltipId === item.page ? tooltipId : undefined}
          aria-label={item.label}
          aria-pressed={activePage === item.page}
          className="rail-nav__button rail-nav__button--icon"
          onBlur={() => setFocusedRailItemId(null)}
          onClick={() => changePage(item.page)}
          onFocus={() => focusRailItem(item.page)}
          onMouseEnter={() => setHoveredRailItemId(item.page)}
          onMouseLeave={() => setHoveredRailItemId(null)}
          type="button"
        >
          <Icon aria-hidden="true" className="rail-nav__icon" />
        </button>
        {visibleRailTooltipId === item.page ? (
          <span className="rail-nav__tooltip" id={tooltipId} role="tooltip">
            {item.label}
          </span>
        ) : null}
      </div>
    );
  }

  function renderUtilityRailButton(item: WorkbenchUtilityNavItem): ReactNode {
    const Icon = item.icon;
    const tooltipId = getRailTooltipId(item.id);

    return (
      <div className="rail-nav__button-wrap" key={item.id}>
        <button
          aria-describedby={visibleRailTooltipId === item.id ? tooltipId : undefined}
          aria-label={item.label}
          className="rail-nav__button rail-nav__button--icon"
          onBlur={() => setFocusedRailItemId(null)}
          onClick={() => handleUtilityItemClick(item)}
          onFocus={() => focusRailItem(item.id)}
          onMouseEnter={() => setHoveredRailItemId(item.id)}
          onMouseLeave={() => setHoveredRailItemId(null)}
          type="button"
        >
          <Icon aria-hidden="true" className="rail-nav__icon" />
        </button>
        {visibleRailTooltipId === item.id ? (
          <span className="rail-nav__tooltip" id={tooltipId} role="tooltip">
            {item.label}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <header className="workbench-nav">
      <aside className="rail-nav" aria-label="快捷功能栏">
        <div className="rail-nav__brand" aria-hidden="true">
          NE
        </div>
        {railAssetItems.length > 0 ? (
          <div className="rail-nav__group" aria-label="资源入口">
            {railAssetItems.map(renderPageRailButton)}
          </div>
        ) : null}
        <div className="rail-nav__group" aria-label="功能快捷入口">
          {railFunctionItems.map(renderPageRailButton)}
        </div>
        <div className="rail-nav__group rail-nav__utility-group" aria-label="底部工具入口">
          {renderUtilityRailButton(WORKBENCH_SETTINGS_ITEM)}
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

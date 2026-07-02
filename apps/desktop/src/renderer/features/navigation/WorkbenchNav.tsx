import type { ReactNode } from "react";
import { useState } from "react";
import { flushSync } from "react-dom";
import {
  WORKBENCH_NAV_ITEMS,
  WORKBENCH_UTILITY_ITEMS,
  type WorkbenchNavItem,
  type WorkbenchUtilityNavItem
} from "./workbenchNavConfig";

export type WorkbenchPage = "assets" | "extraction" | "graph";

export interface WorkbenchNavProps {
  activePage: WorkbenchPage;
  onPageChange: (page: WorkbenchPage) => void;
  onOpenProviderConfig?: () => void;
  onOpenSettings?: () => void;
}

type RailItemId = WorkbenchPage | WorkbenchUtilityNavItem["id"];

function getRailTooltipId(id: RailItemId): string {
  return `workbench-rail-tooltip-${id}`;
}

export function WorkbenchNav({
  activePage,
  onPageChange,
  onOpenProviderConfig,
  onOpenSettings
}: WorkbenchNavProps): JSX.Element {
  const [hoveredRailItemId, setHoveredRailItemId] = useState<RailItemId | null>(null);
  const [focusedRailItemId, setFocusedRailItemId] = useState<RailItemId | null>(null);
  const visibleRailItemId = hoveredRailItemId ?? focusedRailItemId;

  function showFocusedTooltip(id: RailItemId): void {
    flushSync(() => {
      setFocusedRailItemId(id);
    });
  }

  function hideFocusedTooltip(id: RailItemId): void {
    flushSync(() => {
      setFocusedRailItemId((currentId) => (currentId === id ? null : currentId));
    });
  }

  function renderTooltip(id: RailItemId, label: string): ReactNode {
    if (visibleRailItemId !== id) {
      return null;
    }

    return (
      <span
        aria-label={label}
        className="workbench-rail__tooltip"
        id={getRailTooltipId(id)}
        role="tooltip"
      >
        {label}
      </span>
    );
  }

  function renderPageButton(item: WorkbenchNavItem): ReactNode {
    const Icon = item.icon;
    const tooltipId = getRailTooltipId(item.page);

    return (
      <div className="workbench-rail__button-wrap" key={item.page}>
        <button
          aria-describedby={visibleRailItemId === item.page ? tooltipId : undefined}
          aria-label={item.label}
          aria-pressed={activePage === item.page}
          className="workbench-rail__button"
          onBlur={() => hideFocusedTooltip(item.page)}
          onClick={() => onPageChange(item.page)}
          onFocus={() => showFocusedTooltip(item.page)}
          onMouseEnter={() => setHoveredRailItemId(item.page)}
          onMouseLeave={() => setHoveredRailItemId(null)}
          type="button"
        >
          <span className="workbench-rail__icon" aria-hidden="true">
            <Icon className="workbench-rail__glyph" />
          </span>
        </button>
        {renderTooltip(item.page, item.label)}
      </div>
    );
  }

  function getUtilityClickHandler(item: WorkbenchUtilityNavItem): (() => void) | undefined {
    if (item.id === "provider-settings") {
      return onOpenProviderConfig;
    }

    return onOpenSettings;
  }

  function renderUtilityButton(item: WorkbenchUtilityNavItem): ReactNode {
    const Icon = item.icon;
    const tooltipId = getRailTooltipId(item.id);

    return (
      <div className="workbench-rail__button-wrap" key={item.id}>
        <button
          aria-describedby={visibleRailItemId === item.id ? tooltipId : undefined}
          aria-label={item.label}
          className="workbench-rail__button"
          onBlur={() => hideFocusedTooltip(item.id)}
          onClick={getUtilityClickHandler(item)}
          onFocus={() => showFocusedTooltip(item.id)}
          onMouseEnter={() => setHoveredRailItemId(item.id)}
          onMouseLeave={() => setHoveredRailItemId(null)}
          type="button"
        >
          <span className="workbench-rail__icon" aria-hidden="true">
            <Icon className="workbench-rail__glyph" />
          </span>
        </button>
        {renderTooltip(item.id, item.label)}
      </div>
    );
  }

  return (
    <nav className="workbench-rail" aria-label="工作台导航">
      <div className="workbench-rail__brand" aria-hidden="true">
        NE
      </div>
      <div className="workbench-rail__group" aria-label="页面入口">
        {WORKBENCH_NAV_ITEMS.map(renderPageButton)}
      </div>
      <div className="workbench-rail__group workbench-rail__utility-group" aria-label="工具入口">
        {WORKBENCH_UTILITY_ITEMS.map(renderUtilityButton)}
      </div>
    </nav>
  );
}

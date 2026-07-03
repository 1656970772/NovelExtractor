import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appCssPath = [
  resolve(process.cwd(), "src/renderer/styles/app.css"),
  resolve(process.cwd(), "apps/desktop/src/renderer/styles/app.css")
].find((candidate) => existsSync(candidate));

if (!appCssPath) {
  throw new Error("Cannot find desktop app.css");
}

const appCss = readFileSync(appCssPath, "utf8");

function getRuleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = appCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "m"));
  return match?.[1] ?? "";
}

describe("app css template modal layout", () => {
  it("keeps the extraction workbench in three columns at the default desktop width", () => {
    const extractionLayoutRule = getRuleBody(".extraction-layout");
    const compactBreakpointRule = getRuleBody("@media (max-width: 1080px)");

    expect(extractionLayoutRule).toContain(
      "grid-template-columns: minmax(300px, 0.9fr) minmax(320px, 1fr) minmax(420px, 1.45fr)"
    );
    expect(appCss).not.toContain("@media (max-width: 1180px)");
    expect(compactBreakpointRule).toContain(".extraction-layout");
    expect(compactBreakpointRule).toContain("grid-template-columns: 1fr");
  });

  it("uses distinct card surfaces for running, paused, failed, and completed jobs", () => {
    const runningRule = getRuleBody(".job-card--running");
    const pausedRule = getRuleBody(".job-card--paused");
    const failedRule = getRuleBody(".job-card--failed");
    const completedRule = getRuleBody(".job-card--completed");

    expect(runningRule).toContain("--job-card-status-surface: #fefcf9");
    expect(runningRule).toContain("--job-card-status-border: #f2c46f");
    expect(runningRule).toContain("--job-card-status-emphasis: #e09a04");
    expect(runningRule).not.toContain("color-mix");
    expect(pausedRule).toContain("--job-card-status-surface: #f8fbfd");
    expect(pausedRule).toContain("--job-card-status-emphasis: #416f91");
    expect(failedRule).toContain("--job-card-status-surface: #fef8f8");
    expect(failedRule).toContain("--job-card-status-border: #f2b8b5");
    expect(failedRule).toContain("--job-card-status-emphasis: #cf2f2f");
    expect(failedRule).not.toContain("color-mix");
    expect(completedRule).toContain("--job-card-status-surface: #f7faf8");
    expect(completedRule).toContain("--job-card-status-emphasis: #0f603d");
  });

  it("keeps active job selection from overriding status border colors", () => {
    const activeRule = getRuleBody(".job-card--active");

    expect(activeRule).not.toContain("border-color");
    expect(activeRule).toContain("box-shadow: 0 0 0 1px var(--app-color-accent)");
  });

  it("uses matching warning visuals for running job badges and progress bars", () => {
    const runningStatusRule = getRuleBody(".job-card__status--running");
    const pausedStatusRule = getRuleBody(".job-card__status--paused");
    const runningProgressRule = getRuleBody(".job-card__progress-bar--running");
    const pausedProgressRule = getRuleBody(".job-card__progress-bar--paused");
    const statusInCardRule = getRuleBody(".job-card .job-card__status");
    const progressBarInCardRule = getRuleBody(".job-card .job-card__progress-bar");

    expect(appCss).not.toContain(".job-row span");
    expect(statusInCardRule).toContain("background: var(--job-card-status-badge-surface)");
    expect(statusInCardRule).toContain("color: var(--job-card-status-emphasis)");
    expect(progressBarInCardRule).toContain("background: var(--job-card-status-emphasis)");
    expect(runningStatusRule).toContain("border-color: var(--job-card-status-emphasis)");
    expect(runningProgressRule).toContain("background: var(--job-card-status-emphasis)");
    expect(pausedStatusRule).toContain("border-color: var(--job-card-status-emphasis)");
    expect(pausedStatusRule).toContain("color: var(--job-card-status-emphasis)");
    expect(pausedProgressRule).toContain("background: var(--job-card-status-emphasis)");
  });

  it("keeps the template library scrollable with readable two-column rows", () => {
    const modalRule = getRuleBody(".template-modal");
    const scrollRule = getRuleBody(".template-modal__scroll");
    const cardsRule = getRuleBody(".template-modal__cards");
    const cardRule = getRuleBody(".template-modal__card");
    const activeRule = getRuleBody(".template-modal__card--active");
    const nameRule = getRuleBody(".template-modal__card-name");

    expect(modalRule).toContain("width: min(920px, 100%)");
    expect(scrollRule).toContain("display: flex");
    expect(scrollRule).toContain("flex-direction: column");
    expect(scrollRule).toContain("min-height: 0");
    expect(scrollRule).toContain("overflow-y: auto");
    expect(scrollRule).toContain("overflow-x: hidden");
    expect(cardsRule).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(cardsRule).toContain("gap: 8px 12px");
    expect(cardRule).toContain("min-height: 34px");
    expect(cardRule).toContain("padding: 6px 8px");
    expect(cardRule).toContain("border: 0");
    expect(cardRule).toContain("background: transparent");
    expect(activeRule).toContain("outline: 1px solid var(--app-color-accent)");
    expect(nameRule).toContain("overflow-x: auto");
    expect(nameRule).toContain("font-size: 13px");
    expect(nameRule).toContain("line-height: 1.35");
    expect(nameRule).toContain("scrollbar-width: thin");
  });

  it("keeps template upload actions aligned with consistent control sizing", () => {
    const uploadActionsRule = getRuleBody(".template-upload__actions");
    const uploadButtonRule = getRuleBody(".template-upload__submit-button");
    const manualButtonRule = getRuleBody(".template-upload__manual-button");
    const nameActionsRule = getRuleBody(".template-modal__name-actions");

    expect(uploadActionsRule).toContain("display: flex");
    expect(uploadActionsRule).toContain("align-items: center");
    expect(uploadActionsRule).toContain("justify-content: end");
    expect(uploadActionsRule).toContain("min-height: 40px");
    expect(uploadButtonRule).toContain("min-width: 96px");
    expect(uploadButtonRule).toContain("min-height: 40px");
    expect(uploadButtonRule).toContain("font-size: 14px");
    expect(manualButtonRule).toContain("width: 100%");
    expect(manualButtonRule).toContain("min-height: 40px");
    expect(manualButtonRule).toContain("font-size: 14px");
    expect(nameActionsRule).toContain("align-items: center");
    expect(nameActionsRule).toContain("justify-content: end");
    expect(nameActionsRule).toContain("min-height: 40px");
  });

  it("uses a red background for destructive template buttons", () => {
    const dangerButtonRule = getRuleBody(".button--danger");

    expect(dangerButtonRule).toContain("border-color: var(--app-color-danger)");
    expect(dangerButtonRule).toContain("background: var(--app-color-danger)");
  });

  it("keeps long upload errors inside their panel", () => {
    const formErrorRule = getRuleBody(".form-error");

    expect(formErrorRule).toContain("max-width: 100%");
    expect(formErrorRule).toContain("overflow-wrap: anywhere");
    expect(formErrorRule).toContain("white-space: pre-wrap");
  });

  it("keeps job action buttons pinned to the top when progress logs expand", () => {
    const headerRule = getRuleBody(".job-row__header");
    const actionsRule = getRuleBody(".job-row__actions");
    const detailsRule = getRuleBody(".job-row__details");
    const logActionsRule = getRuleBody(".job-log-actions");

    expect(headerRule).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(headerRule).toContain("align-items: start");
    expect(actionsRule).toContain("align-self: start");
    expect(actionsRule).toContain("justify-content: end");
    expect(detailsRule).toContain("min-width: 0");
    expect(detailsRule).toContain("max-width: 100%");
    expect(logActionsRule).toContain("flex-wrap: nowrap");
    expect(logActionsRule).toContain("justify-content: end");
  });

  it("keeps desktop settings modal aligned with the template modal shell", () => {
    const templateModalRule = getRuleBody(".template-modal");
    const settingsWorkspaceRule = getRuleBody(".settings-modal__workspace");
    const activeCategoryRule = getRuleBody(".settings-modal__category-button[aria-pressed=\"true\"]");
    const railNavRule = getRuleBody(".workbench-rail");
    const utilityGroupRule = getRuleBody(".workbench-rail__utility-group");
    const pathPickerRule = getRuleBody(".settings-modal__path-picker");

    expect(templateModalRule).toContain("width: min(920px, 100%)");
    expect(settingsWorkspaceRule).toContain("grid-template-columns: minmax(180px, 0.55fr) minmax(420px, 1.45fr)");
    expect(activeCategoryRule).toContain("background: var(--app-color-selected)");
    expect(activeCategoryRule).toContain("color: var(--app-color-accent)");
    expect(railNavRule).toContain("min-height: 0");
    expect(utilityGroupRule).toContain("margin-top: auto");
    expect(pathPickerRule).toContain("grid-template-columns: minmax(0, 1fr) auto");
  });
});

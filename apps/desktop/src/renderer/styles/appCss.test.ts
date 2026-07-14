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

const appCss = readFileSync(appCssPath, "utf8").replace(/\r\n/g, "\n");

function getRuleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = appCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "m"));
  return match?.[1] ?? "";
}

describe("app css template modal layout", () => {
  it("keeps desktop scrolling inside app panels instead of the document", () => {
    const rootDocumentRule = getRuleBody(":root");
    const bodyRule = getRuleBody("body");
    const reactRootRule = getRuleBody("#root");
    const shellRule = getRuleBody(".project-gate-shell,\n.workbench-shell");

    expect(rootDocumentRule).toContain("height: 100%");
    expect(bodyRule).toContain("height: 100dvh");
    expect(bodyRule).toContain("overflow: hidden");
    expect(reactRootRule).toContain("height: 100dvh");
    expect(reactRootRule).toContain("overflow: hidden");
    expect(shellRule).toContain("height: 100%");
    expect(shellRule).toContain("min-height: 0");
  });

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

  it("keeps the extraction task queue scroll inside the jobs panel on desktop", () => {
    const extractionMainRule = getRuleBody(".workbench-main--extraction");
    const extractionPageRule = getRuleBody(".extraction-page");
    const extractionLayoutRule = getRuleBody(".extraction-layout");
    const jobsPanelRule = getRuleBody(".jobs-panel");
    const jobListRule = getRuleBody(".jobs-panel > .job-list");

    expect(extractionMainRule).toContain("overflow: hidden");
    expect(extractionPageRule).toContain("height: 100%");
    expect(extractionPageRule).toContain("min-height: 0");
    expect(extractionPageRule).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(extractionLayoutRule).toContain("min-height: 0");
    expect(extractionLayoutRule).toContain("align-items: stretch");
    expect(extractionLayoutRule).toContain("overflow-y: auto");
    expect(extractionLayoutRule).toContain("overflow-x: hidden");
    expect(extractionLayoutRule).toContain("scrollbar-width: thin");
    expect(appCss).toContain(".workbench-main--extraction {\n    overflow: auto;");
    expect(appCss).toContain("overflow: visible");
    expect(jobsPanelRule).toContain("grid-template-rows: auto auto minmax(0, 1fr)");
    expect(jobsPanelRule).toContain("overflow: hidden");
    expect(jobListRule).toContain("min-height: 0");
    expect(jobListRule).toContain("overflow-y: auto");
    expect(jobListRule).toContain("overflow-x: hidden");
  });

  it("keeps a single extraction job card at its content height", () => {
    const jobListRule = getRuleBody(".jobs-panel > .job-list");

    expect(jobListRule).toContain("align-content: start");
  });

  it("uses transient thin scrollbar styling for local scroll regions", () => {
    const transientRule = getRuleBody(".transient-scrollbar");
    const transientActiveRule = getRuleBody(".transient-scrollbar--active");
    const webkitScrollbarRule = getRuleBody(".transient-scrollbar::-webkit-scrollbar");
    const webkitThumbRule = getRuleBody(".transient-scrollbar::-webkit-scrollbar-thumb");
    const webkitActiveThumbRule = getRuleBody(
      ".transient-scrollbar--active::-webkit-scrollbar-thumb"
    );

    expect(transientRule).toContain("--transient-scrollbar-thumb: transparent");
    expect(transientRule).toContain("scrollbar-color: transparent transparent");
    expect(transientActiveRule).toContain("--transient-scrollbar-thumb: rgb(189 196 202 / 0.82)");
    expect(transientActiveRule).toContain("scrollbar-color: var(--transient-scrollbar-thumb) transparent");
    expect(webkitScrollbarRule).toContain("width: 10px");
    expect(webkitThumbRule).toContain("border-radius: 999px");
    expect(webkitThumbRule).toContain("background-clip: padding-box");
    expect(webkitActiveThumbRule).toContain("background-color: var(--transient-scrollbar-thumb)");
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
    const sharedProgressRule = getRuleBody(".progress-meter");
    const sharedProgressBarRule = getRuleBody(".progress-meter__bar");
    const progressBarInCardRule = getRuleBody(".job-card .progress-meter__bar");
    const statusInCardRule = getRuleBody(".job-card .job-card__status");

    expect(appCss).not.toContain(".job-row span");
    expect(sharedProgressRule).toContain("height: 8px");
    expect(sharedProgressRule).toContain("border-radius: 999px");
    expect(sharedProgressRule).toContain("background: #d6dade");
    expect(sharedProgressBarRule).toContain("background: var(--app-color-progress)");
    expect(statusInCardRule).toContain("background: var(--job-card-status-badge-surface)");
    expect(statusInCardRule).toContain("color: var(--job-card-status-emphasis)");
    expect(progressBarInCardRule).toContain("background: var(--job-card-status-emphasis)");
    expect(runningStatusRule).toContain("border-color: var(--job-card-status-emphasis)");
    expect(pausedStatusRule).toContain("border-color: var(--job-card-status-emphasis)");
    expect(pausedStatusRule).toContain("color: var(--job-card-status-emphasis)");
  });

  it("keeps changing running job metrics from shifting the task card layout", () => {
    const progressHeadingRule = getRuleBody(".job-card__progress-heading");
    const detailsRule = getRuleBody(".job-card__details");
    const detailItemRule = getRuleBody(".job-card__details > span:not(.job-row__token)");
    const tokenRule = getRuleBody(".job-row__token");

    expect(progressHeadingRule).toContain("font-variant-numeric: tabular-nums");
    expect(detailsRule).toContain("display: grid");
    expect(detailsRule).toContain("grid-template-columns: repeat(auto-fit, minmax(132px, 1fr))");
    expect(detailsRule).toContain("font-variant-numeric: tabular-nums");
    expect(detailItemRule).toContain("white-space: nowrap");
    expect(detailItemRule).toContain("overflow-wrap: normal");
    expect(tokenRule).toContain("grid-column: 1 / -1");
  });

  it("lets failed job reasons use the full details width", () => {
    const failureRule = getRuleBody(".job-row__failure");

    expect(failureRule).toContain("grid-column: 1 / -1");
    expect(failureRule).toContain("width: 100%");
    expect(failureRule).toContain("overflow-wrap: anywhere");
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

  it("keeps pending template uploads in a fixed scrollable list", () => {
    const uploadFileListRule = getRuleBody(".template-upload__file-list");

    expect(uploadFileListRule).toContain("max-height: min(220px, 32dvh)");
    expect(uploadFileListRule).toContain("overflow-y: auto");
    expect(uploadFileListRule).toContain("overflow-x: hidden");
    expect(uploadFileListRule).toContain("scrollbar-gutter: stable");
    expect(uploadFileListRule).toContain("scrollbar-width: thin");
  });

  it("keeps the provider modal header fixed while the body scrolls", () => {
    const modalRule = getRuleBody(".provider-modal");
    const headerRule = getRuleBody(".provider-modal__header");
    const bodyRule = getRuleBody(".provider-modal__body");

    expect(modalRule).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(modalRule).toContain("overflow: hidden");
    expect(headerRule).toContain("position: sticky");
    expect(headerRule).toContain("top: 0");
    expect(headerRule).toContain("z-index: 1");
    expect(bodyRule).toContain("min-height: 0");
    expect(bodyRule).toContain("overflow-y: auto");
    expect(bodyRule).toContain("overflow-x: hidden");
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
    const logTextRule = getRuleBody(".job-log-text");

    expect(headerRule).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(headerRule).toContain("align-items: start");
    expect(actionsRule).toContain("align-self: start");
    expect(actionsRule).toContain("justify-content: end");
    expect(detailsRule).toContain("min-width: 0");
    expect(detailsRule).toContain("max-width: 100%");
    expect(logActionsRule).toContain("flex-wrap: nowrap");
    expect(logActionsRule).toContain("justify-content: end");
    expect(logTextRule).toContain("width: 100%");
    expect(logTextRule).not.toContain("58rem");
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

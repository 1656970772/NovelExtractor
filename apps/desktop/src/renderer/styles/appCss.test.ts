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
    const actionsRule = getRuleBody(".job-row__actions");

    expect(appCss).toMatch(/\.job-row\s*\{[^}]*align-items:\s*start/u);
    expect(actionsRule).toContain("align-self: start");
    expect(actionsRule).toContain("justify-content: end");
  });

  it("keeps desktop settings modal aligned with the template modal shell", () => {
    const templateModalRule = getRuleBody(".template-modal");
    const settingsWorkspaceRule = getRuleBody(".settings-modal__workspace");
    const activeCategoryRule = getRuleBody(".settings-modal__category-button[aria-pressed=\"true\"]");
    const railNavRule = getRuleBody(".rail-nav");
    const utilityGroupRule = getRuleBody(".rail-nav__utility-group");
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

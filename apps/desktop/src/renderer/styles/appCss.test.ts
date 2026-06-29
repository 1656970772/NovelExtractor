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

    expect(modalRule).toContain("width: min(780px, 100%)");
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
});

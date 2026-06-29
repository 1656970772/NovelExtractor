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
  it("keeps the template library scrollable with compact two-column rows", () => {
    const scrollRule = getRuleBody(".template-modal__scroll");
    const cardsRule = getRuleBody(".template-modal__cards");
    const cardRule = getRuleBody(".template-modal__card");
    const activeRule = getRuleBody(".template-modal__card--active");
    const nameRule = getRuleBody(".template-modal__card-name");

    expect(scrollRule).toContain("display: flex");
    expect(scrollRule).toContain("flex-direction: column");
    expect(scrollRule).toContain("min-height: 0");
    expect(scrollRule).toContain("overflow-y: auto");
    expect(scrollRule).toContain("overflow-x: hidden");
    expect(cardsRule).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(cardsRule).toContain("gap: 4px 8px");
    expect(cardRule).toContain("min-height: 24px");
    expect(cardRule).toContain("padding: 2px 4px");
    expect(cardRule).toContain("border: 0");
    expect(cardRule).toContain("background: transparent");
    expect(activeRule).toContain("outline: 1px solid var(--app-color-accent)");
    expect(nameRule).toContain("overflow-x: auto");
    expect(nameRule).toContain("font-size: 10px");
    expect(nameRule).toContain("scrollbar-width: thin");
  });
});

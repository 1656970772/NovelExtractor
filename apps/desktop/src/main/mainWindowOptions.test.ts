import { describe, expect, it } from "vitest";
import { createMainBrowserWindowOptions } from "./mainWindowOptions";

describe("main browser window options", () => {
  it("uses a default width that keeps the extraction workbench horizontal", () => {
    const options = createMainBrowserWindowOptions({
      appBackground: "#edf1f0"
    });

    expect(options.width).toBeGreaterThanOrEqual(1366);
    expect(options.height).toBeGreaterThanOrEqual(760);
    expect(options.minWidth).toBeGreaterThanOrEqual(1080);
  });

  it("honors explicit e2e window dimensions when they are valid", () => {
    const options = createMainBrowserWindowOptions(
      { appBackground: "#edf1f0" },
      {
        NOVEL_EXTRACTOR_WINDOW_WIDTH: "1180",
        NOVEL_EXTRACTOR_WINDOW_HEIGHT: "760"
      }
    );

    expect(options.width).toBe(1180);
    expect(options.height).toBe(760);
  });
});

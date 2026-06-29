import { describe, expect, it } from "vitest";
import { ChapterWindowPlanningError, planChapterWindows } from "./windowPlanner";

describe("planChapterWindows", () => {
  it("creates chapter windows from configured chapter count and extraction limit", () => {
    const windows = planChapterWindows({
      chapterIds: ["c1", "c2", "c3", "c4", "c5", "c6"],
      chaptersPerWindow: 2,
      maxChapters: 5
    });

    expect(windows.map((window) => window.chapterIds)).toEqual([["c1", "c2"], ["c3", "c4"], ["c5"]]);
    expect(windows.map((window) => window.index)).toEqual([0, 1, 2]);
  });

  it("returns no windows for an empty chapter list", () => {
    expect(planChapterWindows({ chapterIds: [], chaptersPerWindow: 3, maxChapters: 10 })).toEqual([]);
  });

  it("throws a typed error when chapters per window is not positive", () => {
    const error = captureError(() =>
      planChapterWindows({ chapterIds: ["c1"], chaptersPerWindow: 0, maxChapters: 1 })
    );

    expect(error).toBeInstanceOf(ChapterWindowPlanningError);
    expect(error).toMatchObject({ code: "INVALID_CHAPTERS_PER_WINDOW" });
  });

  it("throws a typed error when chapters per window is not a finite integer", () => {
    for (const chaptersPerWindow of [1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const error = captureError(() =>
        planChapterWindows({ chapterIds: ["c1"], chaptersPerWindow, maxChapters: 1 })
      );

      expect(error).toBeInstanceOf(ChapterWindowPlanningError);
      expect(error).toMatchObject({ code: "INVALID_CHAPTERS_PER_WINDOW" });
    }
  });

  it("throws a typed error when max chapters is not positive", () => {
    const error = captureError(() =>
      planChapterWindows({ chapterIds: ["c1"], chaptersPerWindow: 1, maxChapters: 0 })
    );

    expect(error).toBeInstanceOf(ChapterWindowPlanningError);
    expect(error).toMatchObject({ code: "INVALID_MAX_CHAPTERS" });
  });

  it("throws a typed error when max chapters is not a finite integer", () => {
    for (const maxChapters of [1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const error = captureError(() =>
        planChapterWindows({ chapterIds: ["c1"], chaptersPerWindow: 1, maxChapters })
      );

      expect(error).toBeInstanceOf(ChapterWindowPlanningError);
      expect(error).toMatchObject({ code: "INVALID_MAX_CHAPTERS" });
    }
  });

  it("uses all chapters when max chapters is omitted", () => {
    const windows = planChapterWindows({ chapterIds: ["c1", "c2", "c3"], chaptersPerWindow: 2 });

    expect(windows.map((window) => window.chapterIds)).toEqual([["c1", "c2"], ["c3"]]);
  });

  it("uses all chapters when max chapters is greater than the chapter count", () => {
    const windows = planChapterWindows({
      chapterIds: ["c1", "c2", "c3"],
      chaptersPerWindow: 2,
      maxChapters: 10
    });

    expect(windows.map((window) => window.chapterIds)).toEqual([["c1", "c2"], ["c3"]]);
  });

  it("returns chapter id arrays that do not share the input array", () => {
    const chapterIds = ["c1", "c2", "c3"];
    const windows = planChapterWindows({ chapterIds, chaptersPerWindow: 2 });
    const firstWindowChapterIds = windows[0]?.chapterIds;

    if (!firstWindowChapterIds) {
      throw new Error("Expected at least one chapter window");
    }

    chapterIds[0] = "changed-input";
    expect(firstWindowChapterIds).toEqual(["c1", "c2"]);

    firstWindowChapterIds[0] = "changed-window";
    expect(chapterIds).toEqual(["changed-input", "c2", "c3"]);
  });
});

function captureError(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error("Expected function to throw");
}

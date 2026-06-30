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

  it("keeps non-overlapping behavior while exposing context and commit fields", () => {
    const windows = planChapterWindows({
      chapterIds: ["c1", "c2", "c3", "c4", "c5"],
      chaptersPerWindow: 2
    });

    expect(windows).toEqual([
      {
        index: 0,
        windowId: "1-2",
        chapterIds: ["c1", "c2"],
        contextChapterIds: ["c1", "c2"],
        commitChapterIds: ["c1", "c2"],
        contextRange: "1-2",
        commitRange: "1-2"
      },
      {
        index: 1,
        windowId: "3-4",
        chapterIds: ["c3", "c4"],
        contextChapterIds: ["c3", "c4"],
        commitChapterIds: ["c3", "c4"],
        contextRange: "3-4",
        commitRange: "3-4"
      },
      {
        index: 2,
        windowId: "5-5",
        chapterIds: ["c5"],
        contextChapterIds: ["c5"],
        commitChapterIds: ["c5"],
        contextRange: "5-5",
        commitRange: "5-5"
      }
    ]);
    expect(windows.map((window) => window.windowId)).toEqual(["1-2", "3-4", "5-5"]);
    expect(windows.map((window) => window.contextChapterIds)).toEqual([["c1", "c2"], ["c3", "c4"], ["c5"]]);
    expect(windows.map((window) => window.commitChapterIds)).toEqual([["c1", "c2"], ["c3", "c4"], ["c5"]]);
    expect(windows.map((window) => window.contextRange)).toEqual(["1-2", "3-4", "5-5"]);
    expect(windows.map((window) => window.commitRange)).toEqual(["1-2", "3-4", "5-5"]);
  });

  it("matches CLI overlapping windows for the first twenty extraction runs", () => {
    const chapterIds = Array.from({ length: 81 }, (_, index) => `c${index + 1}`);

    const windows = planChapterWindows({
      chapterIds,
      chaptersPerWindow: 5,
      overlapChapterCount: 1,
      maxChapters: 81
    });

    expect(windows.map((window) => window.windowId)).toEqual([
      "1-5",
      "5-9",
      "9-13",
      "13-17",
      "17-21",
      "21-25",
      "25-29",
      "29-33",
      "33-37",
      "37-41",
      "41-45",
      "45-49",
      "49-53",
      "53-57",
      "57-61",
      "61-65",
      "65-69",
      "69-73",
      "73-77",
      "77-81"
    ]);
    expect(windows[1]?.contextChapterIds).toEqual(["c5", "c6", "c7", "c8", "c9"]);
    expect(windows[1]?.commitChapterIds).toEqual(["c6", "c7", "c8", "c9"]);
    expect(windows[1]?.contextRange).toBe("5-9");
    expect(windows[1]?.commitRange).toBe("6-9");
  });

  it("serializes window metadata for future run manifests", () => {
    const [window] = planChapterWindows({
      chapterIds: ["c1", "c2"],
      chaptersPerWindow: 2
    });

    expect(JSON.parse(JSON.stringify(window))).toEqual({
      index: 0,
      windowId: "1-2",
      chapterIds: ["c1", "c2"],
      contextChapterIds: ["c1", "c2"],
      commitChapterIds: ["c1", "c2"],
      contextRange: "1-2",
      commitRange: "1-2"
    });
  });

  it("exposes window metadata as enumerable plain object fields", () => {
    const [window] = planChapterWindows({
      chapterIds: ["c1", "c2"],
      chaptersPerWindow: 2
    });

    expect(Object.keys(window)).toEqual([
      "index",
      "windowId",
      "chapterIds",
      "contextChapterIds",
      "commitChapterIds",
      "contextRange",
      "commitRange"
    ]);
    expect({ ...window }).toEqual({
      index: 0,
      windowId: "1-2",
      chapterIds: ["c1", "c2"],
      contextChapterIds: ["c1", "c2"],
      commitChapterIds: ["c1", "c2"],
      contextRange: "1-2",
      commitRange: "1-2"
    });
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

  it("throws a typed error when overlap chapters are invalid", () => {
    for (const overlapChapterCount of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 2]) {
      const error = captureError(() =>
        planChapterWindows({ chapterIds: ["c1"], chaptersPerWindow: 2, overlapChapterCount })
      );

      expect(error).toBeInstanceOf(ChapterWindowPlanningError);
      expect(error).toMatchObject({ code: "INVALID_OVERLAP_CHAPTERS" });
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

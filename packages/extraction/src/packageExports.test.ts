import { describe, expect, it } from "vitest";
import { createTemplateSnapshots } from "@novel-extractor/extraction/templateRouter";
import { planChapterWindows } from "@novel-extractor/extraction/windowPlanner";

describe("@novel-extractor/extraction package exports", () => {
  it("exposes the window planner subpath", () => {
    expect(planChapterWindows({ chapterIds: ["c1"], chaptersPerWindow: 1 })).toEqual([
      { index: 0, chapterIds: ["c1"] }
    ]);
  });

  it("exposes the template router subpath", () => {
    const snapshots = createTemplateSnapshots(
      [{ id: "tpl-export", name: "导出模板", body: "抽取导出" }],
      { clock: { now: () => "2026-06-27T00:00:00.000Z" } }
    );

    expect(snapshots[0]?.reportFileName).toBe("导出.md");
  });
});

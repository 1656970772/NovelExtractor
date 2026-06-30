import { describe, expect, it } from "vitest";
import {
  generateExtractionRules as generateExtractionRulesFromRoot,
  generateRuntimeWindows as generateRuntimeWindowsFromRoot
} from "@novel-extractor/extraction";
import { generateExtractionRules } from "@novel-extractor/extraction/extractionRules";
import { generateRuntimeWindows } from "@novel-extractor/extraction/runtimeWindows";
import { createTemplateSnapshots } from "@novel-extractor/extraction/templateRouter";
import { planChapterWindows } from "@novel-extractor/extraction/windowPlanner";

describe("@novel-extractor/extraction package exports", () => {
  it("exposes the window planner subpath", () => {
    expect(planChapterWindows({ chapterIds: ["c1"], chaptersPerWindow: 1 })).toEqual([
      {
        index: 0,
        windowId: "1-1",
        chapterIds: ["c1"],
        contextChapterIds: ["c1"],
        commitChapterIds: ["c1"],
        contextRange: "1-1",
        commitRange: "1-1"
      }
    ]);
  });

  it("exposes the template router subpath", () => {
    const snapshots = createTemplateSnapshots(
      [{ id: "tpl-export", name: "导出模板", body: "抽取导出" }],
      { clock: { now: () => "2026-06-27T00:00:00.000Z" } }
    );

    expect(snapshots[0]?.reportFileName).toBe("导出.md");
  });

  it("exposes the runtime windows subpath", () => {
    expect(typeof generateRuntimeWindows).toBe("function");
  });

  it("exposes the extraction rules subpath", () => {
    expect(typeof generateExtractionRules).toBe("function");
  });

  it("exposes new extraction services from the root entry", () => {
    expect(typeof generateRuntimeWindowsFromRoot).toBe("function");
    expect(typeof generateExtractionRulesFromRoot).toBe("function");
  });
});

export type ChapterWindowPlanningErrorCode = "INVALID_CHAPTERS_PER_WINDOW" | "INVALID_MAX_CHAPTERS";

export class ChapterWindowPlanningError extends Error {
  readonly code: ChapterWindowPlanningErrorCode;

  constructor(code: ChapterWindowPlanningErrorCode, message: string) {
    super(message);
    this.name = "ChapterWindowPlanningError";
    this.code = code;
  }
}

export interface PlanChapterWindowsInput {
  chapterIds: readonly string[];
  chaptersPerWindow: number;
  maxChapters?: number;
}

export interface ChapterWindow {
  index: number;
  chapterIds: string[];
}

export function planChapterWindows(input: PlanChapterWindowsInput): ChapterWindow[] {
  assertPositiveInteger(input.chaptersPerWindow, "INVALID_CHAPTERS_PER_WINDOW", "Chapters per window must be positive");

  if (input.maxChapters !== undefined) {
    assertPositiveInteger(input.maxChapters, "INVALID_MAX_CHAPTERS", "Max chapters must be positive");
  }

  const plannedChapterIds =
    input.maxChapters === undefined ? [...input.chapterIds] : input.chapterIds.slice(0, input.maxChapters);
  const windows: ChapterWindow[] = [];

  for (let start = 0; start < plannedChapterIds.length; start += input.chaptersPerWindow) {
    windows.push({
      index: windows.length,
      chapterIds: plannedChapterIds.slice(start, start + input.chaptersPerWindow)
    });
  }

  return windows;
}

function assertPositiveInteger(value: number, code: ChapterWindowPlanningErrorCode, message: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ChapterWindowPlanningError(code, message);
  }
}

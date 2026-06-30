export type ChapterWindowPlanningErrorCode =
  | "INVALID_CHAPTERS_PER_WINDOW"
  | "INVALID_MAX_CHAPTERS"
  | "INVALID_OVERLAP_CHAPTERS";

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
  overlapChapterCount?: number;
}

export interface ChapterWindow {
  index: number;
  windowId: string;
  chapterIds: string[];
  contextChapterIds: string[];
  commitChapterIds: string[];
  contextRange: string;
  commitRange: string;
}

export function planChapterWindows(input: PlanChapterWindowsInput): ChapterWindow[] {
  assertPositiveInteger(input.chaptersPerWindow, "INVALID_CHAPTERS_PER_WINDOW", "Chapters per window must be positive");

  if (input.maxChapters !== undefined) {
    assertPositiveInteger(input.maxChapters, "INVALID_MAX_CHAPTERS", "Max chapters must be positive");
  }

  const overlapChapterCount = input.overlapChapterCount ?? 0;
  assertOverlapChapterCount(overlapChapterCount, input.chaptersPerWindow);

  const plannedChapterIds =
    input.maxChapters === undefined ? [...input.chapterIds] : input.chapterIds.slice(0, input.maxChapters);
  const windows: ChapterWindow[] = [];
  const stride = input.chaptersPerWindow - overlapChapterCount;

  for (let start = 0; start < plannedChapterIds.length; start += stride) {
    if (windows.length > 0 && start + overlapChapterCount >= plannedChapterIds.length) {
      break;
    }

    const contextChapterIds = plannedChapterIds.slice(start, start + input.chaptersPerWindow);
    const contextStart = start + 1;
    const contextEnd = start + contextChapterIds.length;
    const leadingOverlapCount = windows.length === 0 ? 0 : overlapChapterCount;
    const commitStartOffset = Math.min(leadingOverlapCount, contextChapterIds.length);
    const commitChapterIds = contextChapterIds.slice(commitStartOffset);
    const commitStart = contextStart + commitStartOffset;
    const commitEnd = commitStart + commitChapterIds.length - 1;
    const contextRange = formatRange(contextStart, contextEnd);
    const commitRange = formatRange(commitStart, commitEnd);
    windows.push({
      index: windows.length,
      windowId: contextRange,
      chapterIds: [...contextChapterIds],
      contextChapterIds,
      commitChapterIds,
      contextRange,
      commitRange
    });
  }

  return windows;
}

function assertPositiveInteger(value: number, code: ChapterWindowPlanningErrorCode, message: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ChapterWindowPlanningError(code, message);
  }
}

function assertOverlapChapterCount(value: number, chaptersPerWindow: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= chaptersPerWindow) {
    throw new ChapterWindowPlanningError(
      "INVALID_OVERLAP_CHAPTERS",
      "Overlap chapters must be a non-negative integer less than chapters per window"
    );
  }
}

function formatRange(start: number, end: number): string {
  return `${start}-${end}`;
}

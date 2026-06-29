export interface ParsedChapter {
  index: number;
  title: string;
  content: string;
}

export class ChapterParseError extends Error {
  readonly code = "CHAPTER_PARSE_FAILED";

  constructor(message = "No chapter headings were found") {
    super(message);
    this.name = "ChapterParseError";
  }
}

const CHINESE_NUMBER = "[零〇一二两三四五六七八九十百千万0-9]+";
const CHINESE_CHAPTER_HEADING = new RegExp(
  `^(?:卷\\s*${CHINESE_NUMBER}\\s*)?第\\s*${CHINESE_NUMBER}\\s*章(?:[\\s　:：、.-].*)?$`,
  "u"
);
const ENGLISH_CHAPTER_HEADING = /^chapter\s+\d+(?:[\s:：.-].*)?$/iu;
const MAX_HEADING_LENGTH = 120;

export function parseChapters(text: string): ParsedChapter[] {
  const chapters: ParsedChapter[] = [];
  let currentTitle: string | null = null;
  let currentBodyLines: string[] = [];

  for (const line of text.split("\n")) {
    const title = parseChapterTitle(line);
    if (title) {
      appendCurrentChapter(chapters, currentTitle, currentBodyLines);
      currentTitle = title;
      currentBodyLines = [];
      continue;
    }

    if (currentTitle !== null) {
      currentBodyLines.push(line);
    }
  }

  appendCurrentChapter(chapters, currentTitle, currentBodyLines);

  if (chapters.length === 0) {
    throw new ChapterParseError();
  }

  return chapters;
}

export function isChapterHeading(line: string): boolean {
  const title = line.trim();
  if (!title || title.length > MAX_HEADING_LENGTH) {
    return false;
  }

  return CHINESE_CHAPTER_HEADING.test(title) || ENGLISH_CHAPTER_HEADING.test(title);
}

function parseChapterTitle(line: string): string | null {
  const title = line.trim();
  return isChapterHeading(title) ? title : null;
}

function appendCurrentChapter(
  chapters: ParsedChapter[],
  currentTitle: string | null,
  currentBodyLines: string[]
): void {
  if (currentTitle === null) {
    return;
  }

  chapters.push({
    index: chapters.length,
    title: currentTitle,
    content: currentBodyLines.join("\n").trim()
  });
}

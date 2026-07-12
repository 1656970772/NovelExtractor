export interface ParsedChapter {
  index: number;
  title: string;
  content: string;
}

export interface ChapterParserOptions {
  maxHeadingLength: number;
  chineseChapterUnits: readonly string[];
  chineseSectionUnits: readonly string[];
  specialChapterHeadings: readonly string[];
  englishChapterUnits: readonly string[];
  englishSectionUnits: readonly string[];
  englishSpecialChapterHeadings: readonly string[];
  sectionTitleSeparator: string;
}

export class ChapterParseError extends Error {
  readonly code = "CHAPTER_PARSE_FAILED";

  constructor(message = "No chapter headings were found") {
    super(message);
    this.name = "ChapterParseError";
  }
}

export const DEFAULT_CHAPTER_PARSER_OPTIONS: Readonly<ChapterParserOptions> = Object.freeze({
  maxHeadingLength: 120,
  chineseChapterUnits: Object.freeze(["章", "节", "回"]),
  chineseSectionUnits: Object.freeze(["卷", "部", "篇", "集"]),
  specialChapterHeadings: Object.freeze([
    "楔子",
    "序章",
    "序言",
    "前言",
    "引子",
    "尾声",
    "后记",
    "终章",
    "番外",
    "附录"
  ]),
  englishChapterUnits: Object.freeze(["chapter", "section", "episode"]),
  englishSectionUnits: Object.freeze(["volume", "part", "book"]),
  englishSpecialChapterHeadings: Object.freeze([
    "prologue",
    "epilogue",
    "preface",
    "afterword",
    "appendix",
    "interlude"
  ]),
  sectionTitleSeparator: " · "
});

type HeadingKind = "chapter" | "section" | "special";

interface ClassifiedHeading {
  kind: HeadingKind;
  title: string;
  hasSectionContext: boolean;
}

interface ChapterHeadingMatcher {
  maxHeadingLength: number;
  chapterPatterns: readonly RegExp[];
  sectionQualifiedChapterPatterns: readonly RegExp[];
  sectionPatterns: readonly RegExp[];
  specialPatterns: readonly RegExp[];
  sectionTitleSeparator: string;
}

const CHINESE_NUMBER = "[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟0-9０-９]+";
const ENGLISH_NUMBER =
  "(?:[0-9０-９]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)";
const HEADING_SEPARATOR = "[\\s　:：、.．·•—–_-]";
const OUTER_WRAPPERS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  Object.freeze(["**", "**"] as const),
  Object.freeze(["__", "__"] as const),
  Object.freeze(["~~", "~~"] as const),
  Object.freeze(["【", "】"] as const),
  Object.freeze(["[", "]"] as const),
  Object.freeze(["（", "）"] as const),
  Object.freeze(["(", ")"] as const),
  Object.freeze(["《", "》"] as const),
  Object.freeze(["〈", "〉"] as const),
  Object.freeze(["「", "」"] as const),
  Object.freeze(["『", "』"] as const)
]);
const PAIRED_LINE_DECORATION = /^([-—–_=~*·•]{2,})\s*(.+?)\s*\1$/u;
const PROSE_SENTENCE_ENDING = /[。．.][”’"')）】》〉」』]*$/u;

const DEFAULT_MATCHER = createHeadingMatcher(DEFAULT_CHAPTER_PARSER_OPTIONS);

export function parseChapters(
  text: string,
  options: Partial<ChapterParserOptions> = {}
): ParsedChapter[] {
  const matcher = resolveHeadingMatcher(options);
  const lines = text.split("\n");
  const headings = lines.map((line) => classifyHeading(line, matcher));
  const hasPrimaryChapterHeadings = headings.some(
    (heading) => heading?.kind === "chapter" || heading?.kind === "special"
  );
  const chapters: ParsedChapter[] = [];
  let currentTitle: string | null = null;
  let currentBodyLines: string[] = [];
  let sectionTitle: string | null = null;
  let sectionPreludeLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const heading = headings[index];
    if (!heading) {
      if (currentTitle !== null) {
        currentBodyLines.push(lines[index]);
      } else if (sectionTitle !== null) {
        sectionPreludeLines.push(lines[index]);
      }
      continue;
    }

    if (heading.kind === "section" && hasPrimaryChapterHeadings) {
      appendCurrentChapter(chapters, currentTitle, currentBodyLines);
      currentTitle = null;
      currentBodyLines = [];
      sectionTitle = heading.title;
      sectionPreludeLines = [];
      continue;
    }

    appendCurrentChapter(chapters, currentTitle, currentBodyLines);
    currentTitle = sectionTitle && !heading.hasSectionContext
      ? `${sectionTitle}${matcher.sectionTitleSeparator}${heading.title}`
      : heading.title;
    currentBodyLines = sectionPreludeLines;
    sectionPreludeLines = [];
  }

  appendCurrentChapter(chapters, currentTitle, currentBodyLines);

  if (chapters.length === 0) {
    throw new ChapterParseError();
  }

  return chapters;
}

export function isChapterHeading(
  line: string,
  options: Partial<ChapterParserOptions> = {}
): boolean {
  return classifyHeading(line, resolveHeadingMatcher(options)) !== null;
}

function resolveHeadingMatcher(options: Partial<ChapterParserOptions>): ChapterHeadingMatcher {
  if (Object.keys(options).length === 0) {
    return DEFAULT_MATCHER;
  }

  return createHeadingMatcher({
    ...DEFAULT_CHAPTER_PARSER_OPTIONS,
    ...options
  });
}

function createHeadingMatcher(options: ChapterParserOptions): ChapterHeadingMatcher {
  const chineseChapterUnits = createAlternation(options.chineseChapterUnits);
  const chineseSectionUnits = createAlternation(options.chineseSectionUnits);
  const chineseSpecialHeadings = createAlternation(options.specialChapterHeadings);
  const englishChapterUnits = createAlternation(options.englishChapterUnits);
  const englishSectionUnits = createAlternation(options.englishSectionUnits);
  const englishSpecialHeadings = createAlternation(options.englishSpecialChapterHeadings);
  const chineseSectionPrefix =
    `(?:第\\s*${CHINESE_NUMBER}\\s*(?:${chineseSectionUnits})|` +
    `(?:${chineseSectionUnits})\\s*${CHINESE_NUMBER})`;
  const englishSectionPrefix = `(?:${englishSectionUnits})\\s*${ENGLISH_NUMBER}`;
  const chineseTitleSuffix = `(?:$|${HEADING_SEPARATOR}.*|[《【（(].*)`;
  const requiredTitleBoundary = `(?:$|${HEADING_SEPARATOR}.*)`;
  const chineseChapterCore =
    `第\\s*${CHINESE_NUMBER}\\s*(?:${chineseChapterUnits})${chineseTitleSuffix}`;
  const englishChapterCore =
    `(?:${englishChapterUnits})\\s*${ENGLISH_NUMBER}${requiredTitleBoundary}`;
  const sectionQualifiedChapterPatterns = [
    new RegExp(`^${chineseSectionPrefix}(?:\\s*[-—·:：]\\s*|\\s*)${chineseChapterCore}`, "u"),
    new RegExp(`^${englishSectionPrefix}(?:\\s*[-—·:：]\\s*|\\s+)${englishChapterCore}`, "iu")
  ];

  return {
    maxHeadingLength: options.maxHeadingLength,
    chapterPatterns: [
      ...sectionQualifiedChapterPatterns,
      new RegExp(`^${chineseChapterCore}`, "u"),
      new RegExp(`^${englishChapterCore}`, "iu")
    ],
    sectionQualifiedChapterPatterns,
    sectionPatterns: [
      new RegExp(`^${chineseSectionPrefix}${requiredTitleBoundary}`, "u"),
      new RegExp(`^(?:${englishSectionUnits})\\s*${ENGLISH_NUMBER}${requiredTitleBoundary}`, "iu")
    ],
    specialPatterns: [
      new RegExp(
        `^(?:${chineseSpecialHeadings})(?:\\s*第?\\s*${CHINESE_NUMBER})?${requiredTitleBoundary}`,
        "u"
      ),
      new RegExp(`^(?:${englishSpecialHeadings})(?:\\s*${ENGLISH_NUMBER})?${requiredTitleBoundary}`, "iu")
    ],
    sectionTitleSeparator: options.sectionTitleSeparator
  };
}

function createAlternation(values: readonly string[]): string {
  if (values.length === 0) {
    return "(?!)";
  }
  return values.map(escapeRegExp).join("|");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyHeading(line: string, matcher: ChapterHeadingMatcher): ClassifiedHeading | null {
  const title = normalizeHeadingCandidate(line);
  if (!title || title.length > matcher.maxHeadingLength || PROSE_SENTENCE_ENDING.test(title)) {
    return null;
  }

  if (matcher.chapterPatterns.some((pattern) => pattern.test(title))) {
    return {
      kind: "chapter",
      title,
      hasSectionContext: matcher.sectionQualifiedChapterPatterns.some((pattern) => pattern.test(title))
    };
  }
  if (matcher.specialPatterns.some((pattern) => pattern.test(title))) {
    return { kind: "special", title, hasSectionContext: false };
  }
  if (matcher.sectionPatterns.some((pattern) => pattern.test(title))) {
    return { kind: "section", title, hasSectionContext: false };
  }
  return null;
}

function normalizeHeadingCandidate(line: string): string {
  let title = line.trim().replace(/^#{1,6}\s*/u, "").trim();

  let previousTitle: string;
  do {
    previousTitle = title;
    const decoratedLine = title.match(PAIRED_LINE_DECORATION);
    if (decoratedLine) {
      title = decoratedLine[2].trim();
      continue;
    }

    for (const [opening, closing] of OUTER_WRAPPERS) {
      if (title.startsWith(opening) && title.endsWith(closing)) {
        title = title.slice(opening.length, -closing.length).trim();
        break;
      }
    }
  } while (title !== previousTitle);

  return title;
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

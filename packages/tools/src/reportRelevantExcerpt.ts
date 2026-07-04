import fs from "node:fs/promises";
import { buildReportSectionIndex } from "./reportSectionIndex";

export interface ReportLineMatch {
  lineNumber: number;
  line: string;
}

export interface GrepReportFileResult {
  matches: ReportLineMatch[];
}

export type GrepReportFile = (input: {
  reportPath: string;
  keywords: readonly string[];
}) => Promise<GrepReportFileResult>;

export type ReadReportRange = (input: {
  reportPath: string;
  startLine: number;
  endLine: number;
}) => Promise<string>;

export interface ReportRelevantExcerptResult {
  outputFileName: string;
  found: boolean;
  recommendedWriteMode: "append_to_end" | "append_to_section";
  sectionId?: string;
  excerptMarkdown?: string;
  truncated?: boolean;
  message?: string;
}

export async function findRelevantReportExcerpt(_input: {
  outputFileName: string;
  reportPath: string;
  keywords: readonly string[];
  maxChars?: number;
  grepReportFile?: GrepReportFile;
  readReportRange?: ReadReportRange;
}): Promise<ReportRelevantExcerptResult> {
  const input = _input;
  const maxChars = clampMaxChars(input.maxChars);
  const keywords = input.keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword !== "");
  if (input.grepReportFile === undefined && input.readReportRange === undefined) {
    return findRelevantReportExcerptFromFile({
      outputFileName: input.outputFileName,
      reportPath: input.reportPath,
      keywords,
      maxChars
    });
  }

  const grepReportFile = input.grepReportFile ?? defaultGrepReportFile;
  const readReportRange = input.readReportRange ?? defaultReadReportRange;
  const grepResult = await grepReportFile({
    reportPath: input.reportPath,
    keywords
  });
  const [firstMatch] = grepResult.matches
    .filter((match) => match.lineNumber > 0)
    .sort((left, right) => left.lineNumber - right.lineNumber);

  if (firstMatch === undefined) {
    return {
      outputFileName: input.outputFileName,
      found: false,
      recommendedWriteMode: "append_to_end",
      message: "未检索到关键词命中；建议将新增内容追加到报告末尾。"
    };
  }

  const excerpt = await readRelevantMarkdownAroundMatch({
    reportPath: input.reportPath,
    keywords,
    matchLineNumber: firstMatch.lineNumber,
    maxChars,
    readReportRange
  });
  const capped = capExcerpt(excerpt, maxChars);

  return {
    outputFileName: input.outputFileName,
    found: true,
    recommendedWriteMode: "append_to_section",
    excerptMarkdown: capped.text,
    truncated: capped.truncated,
    ...(capped.truncated
      ? { message: `相关段落已按 maxChars=${maxChars} 截断；如需更多上下文，请使用更具体关键词再次检索。` }
      : {})
  };
}

const DEFAULT_MAX_CHARS = 4000;
const MIN_MAX_CHARS = 500;
const MAX_MAX_CHARS = 20000;
const INITIAL_BEFORE_LINES = 40;
const INITIAL_AFTER_LINES = 80;
const SECTION_SEARCH_CHUNK_LINES = 80;

function clampMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_CHARS;
  }

  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(value)));
}

async function findRelevantReportExcerptFromFile(input: {
  outputFileName: string;
  reportPath: string;
  keywords: readonly string[];
  maxChars: number;
}): Promise<ReportRelevantExcerptResult> {
  const content = await readReportContent(input.reportPath);
  const lines = splitLines(content);
  const firstMatch = findFirstKeywordMatch(lines, input.keywords);

  if (firstMatch === undefined) {
    return {
      outputFileName: input.outputFileName,
      found: false,
      recommendedWriteMode: "append_to_end",
      message: "未检索到关键词命中；建议将新增内容追加到报告末尾。"
    };
  }

  const excerpt = extractRelevantMarkdownFromLines(lines, firstMatch.lineNumber);
  const capped = capExcerpt(excerpt, input.maxChars);
  const sectionId = findSectionIdForLine(content, firstMatch.lineNumber);

  return {
    outputFileName: input.outputFileName,
    found: true,
    recommendedWriteMode: "append_to_section",
    ...(sectionId === undefined ? {} : { sectionId }),
    excerptMarkdown: capped.text,
    truncated: capped.truncated,
    ...(capped.truncated
      ? { message: `相关段落已按 maxChars=${input.maxChars} 截断；如需更多上下文，请使用更具体关键词再次检索。` }
      : {})
  };
}

async function readReportContent(reportPath: string): Promise<string> {
  try {
    return await fs.readFile(reportPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function defaultGrepReportFile(input: {
  reportPath: string;
  keywords: readonly string[];
}): Promise<GrepReportFileResult> {
  let content: string;
  try {
    content = await fs.readFile(input.reportPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { matches: [] };
    }
    throw error;
  }

  const normalizedKeywords = input.keywords.map(normalizeForSearch);
  const matches = content.split(/\r?\n/u).flatMap((line, index) => {
    const normalizedLine = normalizeForSearch(line);
    return normalizedKeywords.some((keyword) => keyword !== "" && normalizedLine.includes(keyword))
      ? [{ lineNumber: index + 1, line }]
      : [];
  });
  return { matches };
}

async function defaultReadReportRange(input: {
  reportPath: string;
  startLine: number;
  endLine: number;
}): Promise<string> {
  const content = await fs.readFile(input.reportPath, "utf8");
  return content
    .split(/\r?\n/u)
    .slice(Math.max(0, input.startLine - 1), Math.max(input.startLine, input.endLine))
    .join("\n");
}

function extractRelevantMarkdown(rangeText: string, keywords: readonly string[]): string {
  const lines = splitLines(rangeText);
  const matchIndex = lines.findIndex((line) => lineContainsAnyKeyword(line, keywords));
  if (matchIndex < 0) {
    return rangeText.trim();
  }

  const headingIndex = findSectionHeadingIndex(lines, matchIndex);
  if (headingIndex < 0) {
    return rangeText.trim();
  }

  const headingLevel = getHeadingLevel(lines[headingIndex]) ?? 1;
  const nextHeadingIndex = lines.findIndex((line, index) => index > headingIndex && isClosingHeading(line, headingLevel));
  const endIndex = nextHeadingIndex < 0 ? lines.length : nextHeadingIndex;
  return lines.slice(headingIndex, endIndex).join("\n").trim();
}

async function readRelevantMarkdownAroundMatch(input: {
  reportPath: string;
  keywords: readonly string[];
  matchLineNumber: number;
  maxChars: number;
  readReportRange: ReadReportRange;
}): Promise<string> {
  const initialStartLine = Math.max(1, input.matchLineNumber - INITIAL_BEFORE_LINES);
  const initialEndLine = input.matchLineNumber + INITIAL_AFTER_LINES;
  const initialText = await input.readReportRange({
    reportPath: input.reportPath,
    startLine: initialStartLine,
    endLine: initialEndLine
  });
  const initialLines = splitLines(initialText);
  const initialMatchIndex = toRangeMatchIndex(initialLines, initialStartLine, input.matchLineNumber, input.keywords);
  if (initialMatchIndex >= 0 && findSectionHeadingIndex(initialLines, initialMatchIndex) >= 0) {
    return extractRelevantMarkdown(initialText, input.keywords);
  }

  let startLine = initialStartLine;
  let endLine = initialEndLine;
  let lines = initialLines;
  let matchIndex = initialMatchIndex;
  let headingIndex = matchIndex >= 0 ? findSectionHeadingIndex(lines, matchIndex) : -1;

  while (headingIndex < 0 && startLine > 1) {
    const previousStartLine = Math.max(1, startLine - SECTION_SEARCH_CHUNK_LINES);
    const previousText = await input.readReportRange({
      reportPath: input.reportPath,
      startLine: previousStartLine,
      endLine: startLine - 1
    });
    const previousLines = splitLines(previousText);
    if (previousLines.length === 0) {
      break;
    }
    lines = [...previousLines, ...lines];
    startLine = previousStartLine;
    matchIndex = toRangeMatchIndex(lines, startLine, input.matchLineNumber, input.keywords);
    headingIndex = matchIndex >= 0 ? findSectionHeadingIndex(lines, matchIndex) : -1;
  }

  if (headingIndex < 0) {
    return initialText.trim();
  }

  let headingLevel = getHeadingLevel(lines[headingIndex]) ?? 1;
  let nextHeadingIndex = findClosingHeadingIndex(lines, headingIndex, headingLevel);
  while (nextHeadingIndex < 0 && joinedLength(lines.slice(headingIndex)) <= input.maxChars + 1000) {
    const nextStartLine = endLine + 1;
    const nextEndLine = endLine + SECTION_SEARCH_CHUNK_LINES;
    const nextText = await input.readReportRange({
      reportPath: input.reportPath,
      startLine: nextStartLine,
      endLine: nextEndLine
    });
    const nextLines = splitLines(nextText);
    if (nextLines.length === 0) {
      break;
    }
    lines = [...lines, ...nextLines];
    endLine = nextEndLine;
    headingLevel = getHeadingLevel(lines[headingIndex]) ?? 1;
    nextHeadingIndex = findClosingHeadingIndex(lines, headingIndex, headingLevel);
  }

  const endIndex = nextHeadingIndex < 0 ? lines.length : nextHeadingIndex;
  return lines.slice(headingIndex, endIndex).join("\n").trim();
}

function extractRelevantMarkdownFromLines(lines: readonly string[], matchLineNumber: number): string {
  const matchIndex = matchLineNumber - 1;
  const headingIndex = findSectionHeadingIndex(lines, matchIndex);
  if (headingIndex < 0) {
    return extractBoundedRange(lines, matchLineNumber);
  }

  const headingLevel = getHeadingLevel(lines[headingIndex]) ?? 1;
  const nextHeadingIndex = findClosingHeadingIndex(lines, headingIndex, headingLevel);
  const endIndex = nextHeadingIndex < 0 ? lines.length : nextHeadingIndex;
  const excerpt = lines.slice(headingIndex, endIndex).join("\n").trim();
  return excerpt === "" ? extractBoundedRange(lines, matchLineNumber) : excerpt;
}

function findSectionIdForLine(content: string, lineNumber: number): string | undefined {
  const lineStartOffset = findLineStartOffset(content, lineNumber);
  if (lineStartOffset === undefined) {
    return undefined;
  }

  const containingSections = buildReportSectionIndex(content).sections.filter(
    (section) => section.range.start <= lineStartOffset && lineStartOffset < section.range.end
  );
  containingSections.sort((left, right) => right.level - left.level || right.range.start - left.range.start);
  return containingSections[0]?.id;
}

function findLineStartOffset(content: string, lineNumber: number): number | undefined {
  if (lineNumber < 1) {
    return undefined;
  }
  if (lineNumber === 1) {
    return 0;
  }

  let currentLineNumber = 1;
  for (const match of content.matchAll(/\r\n|\n|\r/gu)) {
    currentLineNumber += 1;
    if (currentLineNumber === lineNumber) {
      return match.index + match[0].length;
    }
  }

  return undefined;
}

function extractBoundedRange(lines: readonly string[], matchLineNumber: number): string {
  const startIndex = Math.max(0, matchLineNumber - INITIAL_BEFORE_LINES - 1);
  const endIndex = Math.min(lines.length, matchLineNumber + INITIAL_AFTER_LINES);
  return lines.slice(startIndex, endIndex).join("\n").trim();
}

function findFirstKeywordMatch(lines: readonly string[], keywords: readonly string[]): ReportLineMatch | undefined {
  return lines.flatMap((line, index) => lineContainsAnyKeyword(line, keywords) ? [{ lineNumber: index + 1, line }] : [])[0];
}

function toRangeMatchIndex(
  lines: readonly string[],
  startLine: number,
  matchLineNumber: number,
  keywords: readonly string[]
): number {
  const expectedIndex = matchLineNumber - startLine;
  if (expectedIndex >= 0 && expectedIndex < lines.length && lineContainsAnyKeyword(lines[expectedIndex], keywords)) {
    return expectedIndex;
  }
  return lines.findIndex((line) => lineContainsAnyKeyword(line, keywords));
}

function findSectionHeadingIndex(lines: readonly string[], matchIndex: number): number {
  for (let index = matchIndex; index >= 0; index -= 1) {
    if (getHeadingLevel(lines[index]) !== undefined) {
      return index;
    }
  }
  return -1;
}

function findClosingHeadingIndex(lines: readonly string[], headingIndex: number, headingLevel: number): number {
  return lines.findIndex((line, index) => index > headingIndex && isClosingHeading(line, headingLevel));
}

function isClosingHeading(line: string, currentLevel: number): boolean {
  const level = getHeadingLevel(line);
  return level !== undefined && level <= currentLevel;
}

function getHeadingLevel(line: string): number | undefined {
  const match = /^(#{1,6})\s+\S/u.exec(line);
  return match === null ? undefined : match[1].length;
}

function lineContainsAnyKeyword(line: string, keywords: readonly string[]): boolean {
  const normalizedLine = normalizeForSearch(line);
  return keywords.some((keyword) => {
    const normalizedKeyword = normalizeForSearch(keyword);
    return normalizedKeyword !== "" && normalizedLine.includes(normalizedKeyword);
  });
}

function normalizeForSearch(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
}

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(/\r?\n/u);
}

function joinedLength(lines: readonly string[]): number {
  return lines.reduce((length, line) => length + line.length + 1, 0);
}

function capExcerpt(text: string, maxChars: number): { text: string; truncated: boolean } {
  const trimmedText = text.trim();
  if (trimmedText.length <= maxChars) {
    return { text: trimmedText, truncated: false };
  }

  const suffix = "\n\n[内容已截断；请用更具体关键词再次检索相关段落。]";
  return {
    text: `${trimmedText.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`,
    truncated: true
  };
}

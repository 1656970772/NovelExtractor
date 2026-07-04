export type ReportWriteMode = "replace_section" | "append_to_section" | "append_to_end";

export interface ReportTextRange {
  start: number;
  end: number;
}

export interface ReportSection {
  id: string;
  level: number;
  title: string;
  range: ReportTextRange;
  bodyRange: ReportTextRange;
  snippet: string;
}

export interface ReportSectionIndex {
  sections: ReportSection[];
}

export type UpsertReportSectionResult =
  | {
      ok: true;
      content: string;
    }
  | {
      ok: false;
      code: "SECTION_NOT_FOUND";
      message: string;
    };

export interface UpsertReportSectionInput {
  content: string;
  sectionId?: string;
  writeMode: ReportWriteMode;
  nextContent: string;
}

interface ParsedHeading {
  level: number;
  title: string;
  start: number;
  end: number;
  id: string;
  segment: string;
}

const SECTION_NOT_FOUND_MESSAGE =
  "SECTION_NOT_FOUND: sectionId 未命中当前报告。Task 7 关键词未命中新内容改用 append_to_end；需要创建新标题要等后续 create_section 能力，本任务不隐式创建 section。";
const MAX_SNIPPET_CHARS = 160;

export function buildReportSectionIndex(content: string): ReportSectionIndex {
  const headings = parseMarkdownHeadings(content);
  const sections = headings.map((heading, index): ReportSection => {
    const nextBoundary = headings
      .slice(index + 1)
      .find((candidate) => candidate.level <= heading.level);
    const end = nextBoundary?.start ?? content.length;
    const body = content.slice(heading.end, end).trim();

    return {
      id: heading.id,
      level: heading.level,
      title: heading.title,
      range: { start: heading.start, end },
      bodyRange: { start: heading.end, end },
      snippet: body.slice(0, MAX_SNIPPET_CHARS)
    };
  });

  return { sections };
}

export function upsertReportSection(input: UpsertReportSectionInput): UpsertReportSectionResult {
  const lineEnding = detectDominantLineEnding(input.content);
  if (input.writeMode === "append_to_end") {
    return {
      ok: true,
      content: appendBlockToEnd(input.content, input.nextContent, lineEnding)
    };
  }

  const sectionId = input.sectionId?.trim();
  if (!sectionId) {
    return sectionNotFound(sectionId);
  }

  const section = buildReportSectionIndex(input.content).sections.find((candidate) => candidate.id === sectionId);
  if (section === undefined) {
    return sectionNotFound(sectionId);
  }

  if (input.writeMode === "replace_section") {
    const suffix = input.content.slice(section.bodyRange.end);
    return {
      ok: true,
      content: input.content.slice(0, section.bodyRange.start) + normalizeReplacementBody(input.nextContent, suffix, lineEnding) + suffix
    };
  }

  const suffix = input.content.slice(section.bodyRange.end);
  return {
    ok: true,
    content: input.content.slice(0, section.bodyRange.end) + normalizeAppendBlock(input.content, section.bodyRange.end, input.nextContent, suffix, lineEnding) + suffix
  };
}

function parseMarkdownHeadings(content: string): ParsedHeading[] {
  const headings: ParsedHeading[] = [];
  const stack: ParsedHeading[] = [];
  const siblingCounts = new Map<string, number>();
  let position = 0;
  let insideFence = false;

  for (const lineWithEnding of splitLinesWithEndings(content)) {
    const line = lineWithEnding.replace(/\r?\n$/u, "");
    const trimmed = line.trim();
    if (/^(```|~~~)/u.test(trimmed)) {
      insideFence = !insideFence;
    }

    if (!insideFence) {
      const match = /^(#{1,6})(?:[ \t]+|$)(.*)$/u.exec(line);
      if (match !== null) {
        const level = match[1].length;
        const title = stripAtxClosingSequence(match[2]).trim();
        if (title === "") {
          position += lineWithEnding.length;
          continue;
        }
        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
          stack.pop();
        }

        const parentPath = stack.map((heading) => heading.segment).join("/");
        const key = `${parentPath}\0${level}\0${title}`;
        const count = (siblingCounts.get(key) ?? 0) + 1;
        siblingCounts.set(key, count);
        const segment = count === 1 ? title : `${title}#${count}`;
        const id = parentPath === "" ? segment : `${parentPath}/${segment}`;
        const heading: ParsedHeading = {
          id,
          level,
          title,
          start: position,
          end: position + lineWithEnding.length,
          segment
        };
        headings.push(heading);
        stack.push(heading);
      }
    }

    position += lineWithEnding.length;
  }

  return headings;
}

function splitLinesWithEndings(content: string): string[] {
  if (content === "") {
    return [];
  }
  return content.match(/[^\n]*(?:\n|$)/gu)?.filter((line) => line !== "") ?? [];
}

function stripAtxClosingSequence(value: string): string {
  return value.replace(/[ \t]+#{1,}[ \t]*$/u, "");
}

function appendBlockToEnd(content: string, nextContent: string, lineEnding: string): string {
  const normalized = normalizeTextBlock(nextContent, lineEnding);
  if (content.trimEnd() === "") {
    return normalized;
  }
  return `${content.trimEnd()}${lineEnding}${lineEnding}${normalized}`;
}

function normalizeReplacementBody(nextContent: string, suffix: string, lineEnding: string): string {
  return normalizeTextBlock(nextContent, lineEnding) + (startsWithMarkdownHeading(suffix) ? lineEnding : "");
}

function normalizeAppendBlock(content: string, insertionIndex: number, nextContent: string, suffix: string, lineEnding: string): string {
  const prefix = content.slice(0, insertionIndex);
  const separator = prefix.endsWith(`${lineEnding}${lineEnding}`) || prefix.trimEnd() === "" ? "" : prefix.endsWith(lineEnding) ? lineEnding : `${lineEnding}${lineEnding}`;
  return `${separator}${normalizeTextBlock(nextContent, lineEnding)}${startsWithMarkdownHeading(suffix) ? lineEnding : ""}`;
}

function normalizeTextBlock(value: string, lineEnding: string): string {
  return `${normalizeLineEndings(value.trimEnd(), lineEnding)}${lineEnding}`;
}

function normalizeLineEndings(value: string, lineEnding: string): string {
  return value.replace(/\r\n|\r|\n/gu, lineEnding);
}

function detectDominantLineEnding(value: string): string {
  const crlfCount = value.match(/\r\n/gu)?.length ?? 0;
  const bareLfCount = (value.match(/\n/gu)?.length ?? 0) - crlfCount;
  return crlfCount > bareLfCount ? "\r\n" : "\n";
}

function sectionNotFound(sectionId: string | undefined): UpsertReportSectionResult {
  return {
    ok: false,
    code: "SECTION_NOT_FOUND",
    message: `${SECTION_NOT_FOUND_MESSAGE}${sectionId ? ` sectionId=${sectionId}` : ""}`
  };
}

function startsWithMarkdownHeading(value: string): boolean {
  return /^#{1,6}\s/u.test(value);
}

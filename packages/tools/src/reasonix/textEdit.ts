import { decodeResidualStringEscapes, decodeResidualStringEscapesWithMap } from "../residualStringEscapes";

export interface EditApplyResult {
  updated: string;
  applied: number;
  matches: number;
  fuzzy: boolean;
}

interface EditRange {
  start: number;
  end: number;
}

interface LineSegment {
  raw: string;
  start: number;
  end: number;
}

interface FuzzyMode {
  stripOldReadPrefixes?: boolean;
  trimTrailing?: boolean;
  expandTabs?: boolean;
  trimLeading?: boolean;
}

const utf8Encoder = new TextEncoder();

export function applyOldStringEdit(content: string, oldString: string, newString: string, replaceAll: boolean): EditApplyResult {
  const [old, newStr] = matchLineEndings(content, oldString, newString);
  if (replaceAll) {
    const count = countOccurrences(content, old);
    if (count > 0) {
      return {
        updated: content.split(old).join(newStr),
        applied: count,
        matches: count,
        fuzzy: false
      };
    }

    const ranges = fuzzyEditRanges(content, old);
    if (ranges.length === 0) {
      const residualEscapeRanges = residualEscapeEditRanges(content, old);
      if (residualEscapeRanges.length > 0) {
        return {
          updated: replaceEditRanges(content, residualEscapeRanges, matchReplacementLineEndings(content, decodeResidualStringEscapes(newStr))),
          applied: residualEscapeRanges.length,
          matches: residualEscapeRanges.length,
          fuzzy: true
        };
      }
      return { updated: content, applied: 0, matches: 0, fuzzy: false };
    }
    return {
      updated: replaceEditRanges(content, ranges, matchReplacementLineEndings(content, newStr)),
      applied: ranges.length,
      matches: ranges.length,
      fuzzy: true
    };
  }

  const count = countOccurrences(content, old);
  if (count === 0) {
    const ranges = fuzzyEditRanges(content, old);
    if (ranges.length !== 1) {
      if (ranges.length === 0) {
        const residualEscapeRanges = residualEscapeEditRanges(content, old);
        if (residualEscapeRanges.length === 1) {
          return {
            updated: replaceEditRanges(content, residualEscapeRanges, matchReplacementLineEndings(content, decodeResidualStringEscapes(newStr))),
            applied: 1,
            matches: 1,
            fuzzy: true
          };
        }
        if (residualEscapeRanges.length > 1) {
          return { updated: content, applied: 0, matches: residualEscapeRanges.length, fuzzy: false };
        }
      }
      return { updated: content, applied: 0, matches: ranges.length, fuzzy: false };
    }
    return {
      updated: replaceEditRanges(content, ranges, matchReplacementLineEndings(content, newStr)),
      applied: 1,
      matches: 1,
      fuzzy: true
    };
  }
  if (count === 1) {
    return {
      updated: replaceOnce(content, old, newStr),
      applied: 1,
      matches: 1,
      fuzzy: false
    };
  }
  return { updated: content, applied: 0, matches: count, fuzzy: false };
}

function residualEscapeEditRanges(content: string, old: string): EditRange[] {
  if (old === "" || content === "") {
    return [];
  }

  const decodedContent = decodeResidualStringEscapesWithMap(content);
  const decodedOld = decodeResidualStringEscapes(old);
  if (!decodedContent.changed && decodedOld === old) {
    return [];
  }

  const ranges: EditRange[] = [];
  let index = 0;
  for (;;) {
    const found = decodedContent.text.indexOf(decodedOld, index);
    if (found === -1) {
      return ranges;
    }

    const rawStart = decodedContent.rawStarts[found];
    const rawEnd = decodedContent.rawEnds[found + decodedOld.length - 1];
    if (rawStart !== undefined && rawEnd !== undefined) {
      ranges.push({ start: rawStart, end: rawEnd });
    }
    index = found + decodedOld.length;
  }
}

export function oldStringNotFoundError(path: string, oldString: string, content: string): Error {
  const nearest = nearestContentLine(oldString, content);
  if (nearest !== undefined) {
    return new Error(`old_string not found in ${path} (nearest line ${nearest.line}: ${quoteString(nearest.text)})`);
  }
  return new Error(`old_string not found in ${path}`);
}

export function oldStringNotUniqueError(path: string, matches: number, replaceAllHint: boolean): Error {
  if (replaceAllHint) {
    return new Error(`old_string is not unique in ${path} (${matches} matches); add more surrounding context or set replace_all`);
  }
  return new Error(`old_string is not unique in ${path} (${matches} matches); add more surrounding context`);
}

function matchLineEndings(content: string, oldString: string, newString: string): [string, string] {
  if (content.includes(oldString) || !content.includes("\r\n")) {
    return [oldString, newString];
  }

  const crlfOld = toCRLF(oldString);
  if (content.includes(crlfOld)) {
    return [crlfOld, toCRLF(newString)];
  }
  return [oldString, newString];
}

function toCRLF(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/\n/gu, "\r\n");
}

function matchReplacementLineEndings(content: string, replacement: string): string {
  if (content.includes("\r\n")) {
    return toCRLF(replacement);
  }
  return replacement;
}

function fuzzyEditRanges(content: string, old: string): EditRange[] {
  if (old === "" || content === "") {
    return [];
  }

  const contentLines = splitLineSegments(content);
  const oldLines = splitLineSegments(old);
  if (oldLines.length === 0 || oldLines.length > contentLines.length) {
    return [];
  }

  const oldHasReadPrefixes = allLinesHaveReadFilePrefix(oldLines);
  const modes: FuzzyMode[] = [{ trimTrailing: true }, { trimTrailing: true, expandTabs: true }];
  if (oldHasReadPrefixes) {
    modes.push({ stripOldReadPrefixes: true, trimTrailing: true }, { stripOldReadPrefixes: true, trimTrailing: true, expandTabs: true });
  }

  for (const mode of modes) {
    const normOld = oldLines.map((line) => normalizeFuzzyLine(line.raw, lineHasNewline(line.raw), mode, mode.stripOldReadPrefixes === true));
    const ranges: EditRange[] = [];
    for (let index = 0; index <= contentLines.length - oldLines.length; ) {
      if (fuzzyWindowMatches(contentLines.slice(index, index + oldLines.length), oldLines, normOld, mode)) {
        ranges.push({
          start: contentLines[index].start,
          end: fuzzyWindowEnd(contentLines[index + oldLines.length - 1], oldLines[oldLines.length - 1])
        });
        index += oldLines.length;
        continue;
      }
      index += 1;
    }
    if (ranges.length > 0) {
      return ranges;
    }
  }
  return [];
}

function fuzzyWindowMatches(contentWindow: LineSegment[], oldLines: LineSegment[], normOld: string[], mode: FuzzyMode): boolean {
  return contentWindow.every((contentLine, index) => {
    const oldHasNewline = lineHasNewline(oldLines[index].raw);
    if (oldHasNewline && !lineHasNewline(contentLine.raw)) {
      return false;
    }
    return normalizeFuzzyLine(contentLine.raw, oldHasNewline, mode, false) === normOld[index];
  });
}

function splitLineSegments(value: string): LineSegment[] {
  if (value === "") {
    return [];
  }

  const lines: LineSegment[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\n") {
      continue;
    }
    const end = index + 1;
    lines.push({ raw: value.slice(start, end), start, end });
    start = end;
  }
  if (start < value.length) {
    lines.push({ raw: value.slice(start), start, end: value.length });
  }
  return lines;
}

function lineHasNewline(line: string): boolean {
  return line.endsWith("\n");
}

function fuzzyWindowEnd(contentLast: LineSegment, oldLast: LineSegment): number {
  if (lineHasNewline(oldLast.raw) || !lineHasNewline(contentLast.raw)) {
    return contentLast.end;
  }

  let end = contentLast.end - 1;
  if (end > contentLast.start && contentLast.raw[contentLast.raw.length - 2] === "\r") {
    end -= 1;
  }
  return end;
}

function normalizeFuzzyLine(line: string, includeNewline: boolean, mode: FuzzyMode, stripReadPrefix: boolean): string {
  let body = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (stripReadPrefix) {
    body = stripReadFileLinePrefix(body)[0];
  }
  if (mode.trimTrailing === true) {
    body = body.replace(/[ \t\r]+$/u, "");
  }
  if (mode.expandTabs === true) {
    body = body.replace(/\t/gu, "    ");
  }
  if (mode.trimLeading === true) {
    body = body.replace(/^[ \t]+/u, "");
  }
  if (includeNewline) {
    return `${body}\n`;
  }
  return body;
}

function allLinesHaveReadFilePrefix(lines: LineSegment[]): boolean {
  if (lines.length === 0) {
    return false;
  }
  return lines.every((line) => stripReadFileLinePrefix(line.raw.endsWith("\n") ? line.raw.slice(0, -1) : line.raw)[1]);
}

function stripReadFileLinePrefix(line: string): [string, boolean] {
  let index = 0;
  while (index < line.length && (line[index] === " " || line[index] === "\t")) {
    index += 1;
  }

  let digitEnd = index;
  while (digitEnd < line.length && line[digitEnd] >= "0" && line[digitEnd] <= "9") {
    digitEnd += 1;
  }

  if (digitEnd === index || !line.startsWith("\u2192", digitEnd)) {
    return [line, false];
  }
  return [line.slice(digitEnd + 1), true];
}

function replaceEditRanges(content: string, ranges: EditRange[], replacement: string): string {
  let updated = content;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index];
    updated = updated.slice(0, range.start) + replacement + updated.slice(range.end);
  }
  return updated;
}

function nearestContentLine(oldString: string, content: string): { line: number; text: string } | undefined {
  const oldLines = splitLineSegments(oldString);
  if (oldLines.length === 0) {
    return undefined;
  }

  const target = normalizeFuzzyLine(oldLines[0].raw, false, { trimTrailing: true, expandTabs: true }, true).trim();
  if (target === "") {
    return undefined;
  }

  let bestLine = 0;
  let bestScore = 0;
  let bestText = "";
  splitLineSegments(content).forEach((line, index) => {
    const text = line.raw.endsWith("\n") ? line.raw.slice(0, -1) : line.raw;
    const score = commonPrefixLen(text.replace(/\t/gu, "    ").trim(), target);
    if (score > bestScore) {
      bestLine = index + 1;
      bestScore = score;
      bestText = text;
    }
  });

  if (bestScore < 3) {
    return undefined;
  }
  return { line: bestLine, text: bestText };
}

function commonPrefixLen(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return index;
    }
  }
  return length;
}

function countOccurrences(content: string, needle: string): number {
  if (needle === "") {
    return content.length + 1;
  }

  let count = 0;
  let index = 0;
  for (;;) {
    const found = content.indexOf(needle, index);
    if (found === -1) {
      return count;
    }
    count += 1;
    index = found + needle.length;
  }
}

function replaceOnce(content: string, needle: string, replacement: string): string {
  const index = content.indexOf(needle);
  if (index === -1) {
    return content;
  }
  return content.slice(0, index) + replacement + content.slice(index + needle.length);
}

function quoteString(value: string): string {
  return JSON.stringify(value) ?? "\"\"";
}

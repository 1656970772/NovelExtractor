export interface ReportFieldQuery {
  cardName: string;
  fields: string[];
}

export interface ReportFieldUpdate {
  cardName: string;
  fieldName: string;
  content: string;
}

export interface ReportFieldReadResult {
  outputFileName: string;
  truncated: boolean;
  maxChars: number;
  cards: ReportFieldReadCard[];
  message?: string;
}

export interface ReportFieldReadCard {
  cardName: string;
  found: boolean;
  fields: ReportFieldReadField[];
  message?: string;
}

export interface ReportFieldReadField {
  fieldName: string;
  found: boolean;
  content?: string;
  truncated?: boolean;
  message?: string;
}

export type ReportFieldReplaceResult =
  | { ok: true; content: string; updated: Array<{ cardName: string; fieldName: string }> }
  | {
      ok: false;
      code: "CARD_NOT_FOUND" | "FIELD_NOT_FOUND" | "FIELD_AMBIGUOUS" | "INVALID_FIELD_CONTENT";
      message: string;
    };

interface TextRange {
  start: number;
  end: number;
}

interface ParsedCard {
  name: string;
  range: TextRange;
  bodyRange: TextRange;
}

interface ParsedField {
  name: string;
  range: TextRange;
}

const DEFAULT_MAX_CHARS = 8000;
const MIN_MAX_CHARS = 500;
const MAX_MAX_CHARS = 20000;
const TRUNCATED_SUFFIX = "\n[字段内容已截断，请缩小 queries 分批读取剩余字段。]";

export function readReportFieldBlocks(input: {
  outputFileName: string;
  content: string;
  queries: readonly ReportFieldQuery[];
  maxChars?: number;
}): ReportFieldReadResult {
  const maxChars = clampMaxChars(input.maxChars);
  const cards = parseCards(input.content);
  let remainingChars = maxChars;
  let truncated = false;

  const readCards = input.queries.map((query): ReportFieldReadCard => {
    const card = findSingleCard(cards, query.cardName);
    if (card === undefined) {
      return {
        cardName: query.cardName,
        found: false,
        message: `CARD_NOT_FOUND: 未找到卡片 ${query.cardName}`,
        fields: query.fields.map((fieldName) => ({
          fieldName,
          found: false,
          message: "卡片未找到，字段未读取。"
        }))
      };
    }

    const fields = parseFieldsInCard(input.content, card);
    return {
      cardName: query.cardName,
      found: true,
      fields: query.fields.map((fieldName): ReportFieldReadField => {
        const matchedFields = fields.filter((field) => normalizeName(field.name) === normalizeName(fieldName));
        if (matchedFields.length === 0) {
          return { fieldName, found: false, message: `FIELD_NOT_FOUND: ${query.cardName}/${fieldName}` };
        }
        if (matchedFields.length > 1) {
          return { fieldName, found: false, message: `FIELD_AMBIGUOUS: ${query.cardName}/${fieldName}` };
        }

        const rawContent = input.content.slice(matchedFields[0].range.start, matchedFields[0].range.end).trimEnd();
        const capped = capFieldContent(rawContent, remainingChars);
        remainingChars = Math.max(0, remainingChars - capped.content.length);
        truncated = truncated || capped.truncated;

        return {
          fieldName,
          found: true,
          content: capped.content,
          truncated: capped.truncated,
          ...(capped.truncated ? { message: "字段内容已截断，请单独读取该字段或提高 maxChars。" } : {})
        };
      })
    };
  });

  return {
    outputFileName: input.outputFileName,
    maxChars,
    truncated,
    cards: readCards,
    ...(truncated ? { message: "读取结果超过 maxChars，已截断；请用更少字段分批读取。" } : {})
  };
}

export function replaceReportFieldBlocks(input: {
  content: string;
  updates: readonly ReportFieldUpdate[];
}): ReportFieldReplaceResult {
  const cards = parseCards(input.content);
  const lineEnding = detectDominantLineEnding(input.content);
  const replacements: Array<{ range: TextRange; content: string; cardName: string; fieldName: string }> = [];

  for (const update of input.updates) {
    const parsedReplacement = parseFieldLine(update.content.split(/\r\n|\r|\n/u)[0] ?? "");
    if (parsedReplacement === undefined || normalizeName(parsedReplacement.name) !== normalizeName(update.fieldName)) {
      return {
        ok: false,
        code: "INVALID_FIELD_CONTENT",
        message: `INVALID_FIELD_CONTENT: content 必须以 - ${update.fieldName}： 开头。`
      };
    }

    const card = findSingleCard(cards, update.cardName);
    if (card === undefined) {
      return { ok: false, code: "CARD_NOT_FOUND", message: `CARD_NOT_FOUND: 未找到卡片 ${update.cardName}` };
    }

    const fields = parseFieldsInCard(input.content, card).filter(
      (field) => normalizeName(field.name) === normalizeName(update.fieldName)
    );
    if (fields.length === 0) {
      return {
        ok: false,
        code: "FIELD_NOT_FOUND",
        message: `FIELD_NOT_FOUND: 未找到字段 ${update.cardName}/${update.fieldName}`
      };
    }
    if (fields.length > 1) {
      return {
        ok: false,
        code: "FIELD_AMBIGUOUS",
        message: `FIELD_AMBIGUOUS: 字段重复 ${update.cardName}/${update.fieldName}`
      };
    }

    replacements.push({
      range: fields[0].range,
      content: normalizeReplacementBlock(update.content, lineEnding),
      cardName: update.cardName,
      fieldName: update.fieldName
    });
  }

  const sorted = [...replacements].sort((left, right) => right.range.start - left.range.start);
  let content = input.content;
  for (const replacement of sorted) {
    content = content.slice(0, replacement.range.start) + replacement.content + content.slice(replacement.range.end);
  }

  return {
    ok: true,
    content,
    updated: replacements.map((replacement) => ({ cardName: replacement.cardName, fieldName: replacement.fieldName }))
  };
}

function parseCards(content: string): ParsedCard[] {
  const lines = splitLinesWithEndings(content);
  const headings: Array<{ level: number; name: string; start: number; end: number }> = [];
  let offset = 0;
  let insideFence = false;

  for (const lineWithEnding of lines) {
    const line = stripLineEnding(lineWithEnding);
    const trimmed = line.trim();
    if (/^(```|~~~)/u.test(trimmed)) {
      insideFence = !insideFence;
    }
    if (!insideFence) {
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
      if (match !== null) {
        headings.push({
          level: match[1].length,
          name: match[2].trim(),
          start: offset,
          end: offset + lineWithEnding.length
        });
      }
    }
    offset += lineWithEnding.length;
  }

  return headings.flatMap((heading, index) => {
    if (heading.level !== 3) {
      return [];
    }

    const next = headings.slice(index + 1).find((candidate) => candidate.level <= 3);
    return {
      name: heading.name,
      range: { start: heading.start, end: next?.start ?? content.length },
      bodyRange: { start: heading.end, end: next?.start ?? content.length }
    };
  });
}

function parseFieldsInCard(content: string, card: ParsedCard): ParsedField[] {
  const body = content.slice(card.bodyRange.start, card.bodyRange.end);
  const lines = splitLinesWithEndings(body);
  const starts: Array<{ name: string; start: number }> = [];
  let offset = card.bodyRange.start;
  let insideFence = false;

  for (const lineWithEnding of lines) {
    const line = stripLineEnding(lineWithEnding);
    const trimmed = line.trim();
    if (/^(```|~~~)/u.test(trimmed)) {
      insideFence = !insideFence;
    }
    if (!insideFence) {
      const field = parseFieldLine(line);
      if (field !== undefined) {
        starts.push({ name: field.name, start: offset });
      }
    }
    offset += lineWithEnding.length;
  }

  return starts.map((field, index) => ({
    name: field.name,
    range: { start: field.start, end: starts[index + 1]?.start ?? card.bodyRange.end }
  }));
}

function parseFieldLine(line: string): { name: string } | undefined {
  const match = /^-\s*([^:：\r\n]+?)\s*[:：]/u.exec(line);
  return match === null ? undefined : { name: match[1].trim() };
}

function findSingleCard(cards: readonly ParsedCard[], cardName: string): ParsedCard | undefined {
  const normalized = normalizeName(cardName);
  return cards.find((card) => normalizeName(card.name) === normalized);
}

function normalizeName(value: string): string {
  return value.normalize("NFC").trim();
}

function clampMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_CHARS;
  }
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(value)));
}

function capFieldContent(content: string, remainingChars: number): { content: string; truncated: boolean } {
  if (remainingChars <= 0) {
    return { content: "", truncated: true };
  }
  if (content.length <= remainingChars) {
    return { content, truncated: false };
  }
  if (remainingChars <= TRUNCATED_SUFFIX.length) {
    return { content: TRUNCATED_SUFFIX.slice(0, remainingChars), truncated: true };
  }

  const budget = remainingChars - TRUNCATED_SUFFIX.length;
  return { content: `${content.slice(0, budget)}${TRUNCATED_SUFFIX}`, truncated: true };
}

function normalizeReplacementBlock(value: string, lineEnding: string): string {
  return `${value.trimEnd().replace(/\r\n|\r|\n/gu, lineEnding)}${lineEnding}`;
}

function detectDominantLineEnding(value: string): string {
  const crlf = value.match(/\r\n/gu)?.length ?? 0;
  const bareLf = (value.match(/\n/gu)?.length ?? 0) - crlf;
  return crlf > bareLf ? "\r\n" : "\n";
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*(?:\n|$)/gu)?.filter((line) => line !== "") ?? [];
}

function stripLineEnding(value: string): string {
  return value.replace(/\r?\n$/u, "");
}

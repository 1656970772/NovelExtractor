export interface SafeMarkdownHeading {
  id: string;
  depth: number;
  text: string;
}

export interface SafeMarkdownRenderResult {
  html: string;
  headings: SafeMarkdownHeading[];
}

const HEADING_PATTERN = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u;
const FENCE_PATTERN = /^ {0,3}```/u;
const HORIZONTAL_RULE_PATTERN = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const UNORDERED_LIST_PATTERN = /^ {0,3}[-*+]\s+(.+)$/u;
const ORDERED_LIST_PATTERN = /^ {0,3}\d+[.)]\s+(.+)$/u;
const BLOCKQUOTE_PATTERN = /^ {0,3}>\s?(.*)$/u;

export function renderSafeMarkdown(markdown: string): SafeMarkdownRenderResult {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const html: string[] = [];
  const headings: SafeMarkdownHeading[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    if (FENCE_PATTERN.test(line)) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_PATTERN.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const headingMatch = line.match(HEADING_PATTERN);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const text = toPlainText(headingMatch[2]);
      const id = `heading-${headings.length + 1}`;
      headings.push({ id, depth, text });
      html.push(`<h${depth} id="${id}">${renderInline(text)}</h${depth}>`);
      index += 1;
      continue;
    }

    if (HORIZONTAL_RULE_PATTERN.test(line)) {
      html.push("<hr>");
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const table = collectTable(lines, index);
      html.push(renderTable(table.rows));
      index = table.nextIndex;
      continue;
    }

    const blockquoteMatch = line.match(BLOCKQUOTE_PATTERN);
    if (blockquoteMatch) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const nextMatch = (lines[index] ?? "").match(BLOCKQUOTE_PATTERN);
        if (!nextMatch) {
          break;
        }
        quoteLines.push(nextMatch[1]);
        index += 1;
      }
      html.push(`<blockquote><p>${renderInline(quoteLines.join(" "))}</p></blockquote>`);
      continue;
    }

    const unorderedMatch = line.match(UNORDERED_LIST_PATTERN);
    if (unorderedMatch) {
      const listItems: string[] = [];
      while (index < lines.length) {
        const nextMatch = (lines[index] ?? "").match(UNORDERED_LIST_PATTERN);
        if (!nextMatch) {
          break;
        }
        listItems.push(`<li>${renderInline(nextMatch[1])}</li>`);
        index += 1;
      }
      html.push(`<ul>${listItems.join("")}</ul>`);
      continue;
    }

    const orderedMatch = line.match(ORDERED_LIST_PATTERN);
    if (orderedMatch) {
      const listItems: string[] = [];
      while (index < lines.length) {
        const nextMatch = (lines[index] ?? "").match(ORDERED_LIST_PATTERN);
        if (!nextMatch) {
          break;
        }
        listItems.push(`<li>${renderInline(nextMatch[1])}</li>`);
        index += 1;
      }
      html.push(`<ol>${listItems.join("")}</ol>`);
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && shouldContinueParagraph(lines, index)) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    html.push(`<p>${renderInline(paragraphLines.join(" "))}</p>`);
  }

  return { html: html.join("\n"), headings };
}

function shouldContinueParagraph(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (line.trim() === "") {
    return false;
  }
  if (
    FENCE_PATTERN.test(line) ||
    HEADING_PATTERN.test(line) ||
    HORIZONTAL_RULE_PATTERN.test(line) ||
    BLOCKQUOTE_PATTERN.test(line) ||
    UNORDERED_LIST_PATTERN.test(line) ||
    ORDERED_LIST_PATTERN.test(line) ||
    isTableStart(lines, index)
  ) {
    return false;
  }
  return true;
}

function isTableStart(lines: string[], index: number): boolean {
  const headerLine = lines[index] ?? "";
  const dividerLine = lines[index + 1] ?? "";
  return headerLine.includes("|") && isTableDivider(dividerLine);
}

function isTableDivider(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }

  return parseTableRow(line).every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function collectTable(lines: string[], index: number): { rows: string[][]; nextIndex: number } {
  const rows = [parseTableRow(lines[index] ?? "")];
  index += 2;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.includes("|") || line.trim() === "") {
      break;
    }
    rows.push(parseTableRow(line));
    index += 1;
  }

  return { rows, nextIndex: index };
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderTable(rows: string[][]): string {
  const [header = [], ...bodyRows] = rows;
  const headerHtml = header.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
  const bodyHtml = bodyRows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
    .join("");

  return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

function renderInline(value: string): string {
  const withoutResources = stripResourceMarkdown(value);
  const parts = withoutResources.split(/(`[^`]*`)/u);

  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part);
    })
    .join("");
}

function toPlainText(value: string): string {
  return stripResourceMarkdown(value)
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/[*_~]+/gu, "")
    .trim();
}

function stripResourceMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

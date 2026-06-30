export interface TemplatePromptProfileDefaults {
  compressionVersion: string;
  exampleSectionPatterns: readonly string[];
  referenceSectionPatterns: readonly string[];
  placeholderPatterns: readonly string[];
  alwaysKeepHeadingPatterns: readonly string[];
  minProfileChars: number;
}

export interface TemplatePromptProfileTemplate {
  id: string;
  name: string;
  fileName: string;
  body: string;
}

export interface TemplatePromptProfile {
  templateId: string;
  templateName: string;
  outputFileName: string;
  templateHash: string;
  compressionVersion: string;
  originalChars: number;
  profileChars: number;
  compressionRatio: number;
  fallback: boolean;
  fallbackReason?: string;
  body: string;
}

export interface BuildTemplatePromptProfileInput {
  defaults: TemplatePromptProfileDefaults;
  template: TemplatePromptProfileTemplate;
  templateHash: string;
}

interface CompiledProfilePatterns {
  dropSectionPatterns: RegExp[];
  placeholderPatterns: RegExp[];
  alwaysKeepHeadingPatterns: RegExp[];
}

const HEADING_PATTERN = /^#{1,6}\s+/u;
const MAX_FALLBACK_BODY_CHARS = 1200;

function compilePattern(pattern: string): RegExp {
  return new RegExp(pattern, "iu");
}

function compileProfilePatterns(defaults: TemplatePromptProfileDefaults): CompiledProfilePatterns {
  return {
    dropSectionPatterns: [
      ...defaults.exampleSectionPatterns.map(compilePattern),
      ...defaults.referenceSectionPatterns.map(compilePattern)
    ],
    placeholderPatterns: defaults.placeholderPatterns.map(compilePattern),
    alwaysKeepHeadingPatterns: defaults.alwaysKeepHeadingPatterns.map(compilePattern)
  };
}

function matchesAny(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function normalizeProfileBody(lines: readonly string[]): string {
  return lines
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function stripTemplateBody(body: string, patterns: CompiledProfilePatterns): string {
  const keptLines: string[] = [];
  let droppingSection = false;

  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    const trimmedLine = line.trim();
    const isHeading = HEADING_PATTERN.test(trimmedLine);

    if (isHeading && matchesAny(patterns.dropSectionPatterns, trimmedLine)) {
      droppingSection = true;
      continue;
    }

    if (droppingSection && isHeading) {
      droppingSection = false;
    }

    if (droppingSection) {
      continue;
    }

    if (matchesAny(patterns.placeholderPatterns, trimmedLine)) {
      continue;
    }

    keptLines.push(line);
  }

  const profileBody = normalizeProfileBody(keptLines);

  if (profileBody) {
    return profileBody;
  }

  return normalizeProfileBody(
    body
      .split(/\r?\n/u)
      .filter((line) => matchesAny(patterns.alwaysKeepHeadingPatterns, line.trim()))
  );
}

function buildFallbackBody(input: BuildTemplatePromptProfileInput, strippedBody: string): string {
  const fallbackSource = strippedBody || input.template.body.trim().slice(0, MAX_FALLBACK_BODY_CHARS);

  return [
    "模板压缩信息不足，请保守执行。",
    "必须只根据当前窗口文本和已读取的既有报告写入；当前窗口没有证据时保持为空或标记无更新。",
    fallbackSource
  ]
    .filter((line) => line.trim())
    .join("\n\n");
}

export function buildTemplatePromptProfile(input: BuildTemplatePromptProfileInput): TemplatePromptProfile {
  const patterns = compileProfilePatterns(input.defaults);
  const strippedBody = stripTemplateBody(input.template.body, patterns);
  const fallback = strippedBody.length < input.defaults.minProfileChars;
  const body = fallback ? buildFallbackBody(input, strippedBody) : strippedBody;
  const originalChars = input.template.body.length;
  const profileChars = body.length;

  return {
    templateId: input.template.id,
    templateName: input.template.name,
    outputFileName: input.template.fileName,
    templateHash: input.templateHash,
    compressionVersion: input.defaults.compressionVersion,
    originalChars,
    profileChars,
    compressionRatio: originalChars > 0 ? profileChars / originalChars : 1,
    fallback,
    ...(fallback ? { fallbackReason: "压缩后内容不足，使用保守回退卡片。" } : {}),
    body
  };
}

export function renderTemplatePromptProfileCard(profile: TemplatePromptProfile): string {
  return [
    `### ${profile.templateName}`,
    `- templateId: ${profile.templateId}`,
    `- templateName: ${profile.templateName}`,
    `- outputFileName: ${profile.outputFileName}`,
    `- templateHash: ${profile.templateHash}`,
    `- compressionVersion: ${profile.compressionVersion}`,
    `- profileFallback: ${profile.fallback ? "true" : "false"}`,
    `- originalChars: ${profile.originalChars}`,
    `- profileChars: ${profile.profileChars}`,
    "",
    profile.body
  ].join("\n");
}

import iconv from "iconv-lite";
import { isChapterHeading } from "./chapterParser";

export type NovelTextEncoding = "utf-8" | "utf-8-bom" | "gbk" | "cp936";

export interface DecodedNovelText {
  text: string;
  encoding: NovelTextEncoding;
}

export interface DecodeNovelTextOptions {
  legacyEncoding?: Extract<NovelTextEncoding, "gbk" | "cp936">;
}

export class TextDecodingError extends Error {
  readonly code = "TEXT_DECODING_FAILED";

  constructor(message = "Unable to decode novel text") {
    super(message);
    this.name = "TextDecodingError";
  }
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const LEGACY_SHORT_TEXT_MIN_CHARACTERS = 4;
const LEGACY_LONG_TEXT_MIN_CHARACTERS = 20;
const LEGACY_MIN_CJK_RATIO = 0.35;
const LEGACY_SHORT_TEXT_MIN_CJK_RATIO = 0.6;
const LEGACY_SHORT_HEADING_MIN_CHARACTERS = 3;
const LEGACY_SHORT_TEXT_MIN_COMMON_CJK_RATIO = 0.2;
const LEGACY_SHORT_TEXT_MIN_COMMON_CJK_CHARACTERS = 2;
const LEGACY_MAX_RARE_CJK_RATIO = 0.4;
const LEGACY_MIN_STRUCTURE_RATIO = 0.03;
const LEGACY_MIN_COMMON_CJK_RATIO = 0.08;

export function decodeNovelText(
  input: Uint8Array,
  options: DecodeNovelTextOptions = {}
): DecodedNovelText {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);

  if (hasUtf8Bom(buffer)) {
    const text = normalizeLineEndings(decodeUtf8Strict(buffer.subarray(UTF8_BOM.length)));
    assertReadableText(text);
    return { text, encoding: "utf-8-bom" };
  }

  try {
    const text = normalizeLineEndings(decodeUtf8Strict(buffer));
    assertReadableText(text);
    return { text, encoding: "utf-8" };
  } catch (error) {
    if (!(error instanceof TextDecodingError)) {
      throw error;
    }
  }

  const legacyEncoding = options.legacyEncoding ?? "gbk";
  const text = normalizeLineEndings(iconv.decode(buffer, legacyEncoding));
  assertReadableText(text);
  assertReadableLegacyNovelText(text);

  return { text, encoding: legacyEncoding };
}

function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= UTF8_BOM.length && buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
}

function decodeUtf8Strict(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new TextDecodingError("Input is not valid UTF-8");
  }
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function assertReadableText(text: string): void {
  if (!isReadableText(text)) {
    throw new TextDecodingError("Decoded text does not look like readable novel text");
  }
}

function assertReadableLegacyNovelText(text: string): void {
  if (!hasLegacyNovelTextSignal(text)) {
    throw new TextDecodingError("Decoded legacy text does not look like readable novel text");
  }
}

function isReadableText(text: string): boolean {
  if (text.trim().length === 0 || text.includes("\uFFFD")) {
    return false;
  }

  const characters = Array.from(text);
  const printableCharacters = characters.filter(isPrintableTextCharacter).length;
  return printableCharacters / characters.length >= 0.95;
}

function isPrintableTextCharacter(character: string): boolean {
  if (character === "\n" || character === "\t") {
    return true;
  }

  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f);
}

function hasLegacyNovelTextSignal(text: string): boolean {
  const hasChapterHeading = text.split("\n").some((line) => isChapterHeading(line));
  const characters = Array.from(text.trim());
  const cjkCharacters = characters.filter(isCjkCharacter);
  if (cjkCharacters.length / characters.length < LEGACY_MIN_CJK_RATIO) {
    return false;
  }

  const commonCjkCharacters = cjkCharacters.filter(isCommonChineseTextCharacter).length;
  const commonCjkRatio = commonCjkCharacters / cjkCharacters.length;
  const rareCjkCharacters = cjkCharacters.filter(isRareCjkNoiseCharacter).length;
  const rareCjkRatio = rareCjkCharacters / cjkCharacters.length;

  if (characters.length < LEGACY_LONG_TEXT_MIN_CHARACTERS) {
    return hasShortReadableLegacyTextSignal(
      characters,
      cjkCharacters,
      commonCjkCharacters,
      commonCjkRatio,
      rareCjkRatio,
      hasChapterHeading
    );
  }

  const structuralCharacters = characters.filter(isTextStructureCharacter).length;
  if (structuralCharacters / characters.length < LEGACY_MIN_STRUCTURE_RATIO) {
    return false;
  }

  return commonCjkRatio >= LEGACY_MIN_COMMON_CJK_RATIO && rareCjkRatio <= LEGACY_MAX_RARE_CJK_RATIO;
}

function hasShortReadableLegacyTextSignal(
  characters: string[],
  cjkCharacters: string[],
  commonCjkCharacters: number,
  commonCjkRatio: number,
  rareCjkRatio: number,
  hasChapterHeading: boolean
): boolean {
  const minimumCharacters = hasChapterHeading
    ? LEGACY_SHORT_HEADING_MIN_CHARACTERS
    : LEGACY_SHORT_TEXT_MIN_CHARACTERS;

  return (
    characters.length >= minimumCharacters &&
    cjkCharacters.length / characters.length >= LEGACY_SHORT_TEXT_MIN_CJK_RATIO &&
    commonCjkCharacters >= LEGACY_SHORT_TEXT_MIN_COMMON_CJK_CHARACTERS &&
    rareCjkRatio <= LEGACY_MAX_RARE_CJK_RATIO &&
    commonCjkRatio >= LEGACY_SHORT_TEXT_MIN_COMMON_CJK_RATIO
  );
}

function isCjkCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint >= 0x4e00 && codePoint <= 0x9fff;
}

function isTextStructureCharacter(character: string): boolean {
  return /\s|[，。！？；：、“”‘’（）《》【】…—,.!?;:"'()[\]<>-]/u.test(character);
}

function isCommonChineseTextCharacter(character: string): boolean {
  return COMMON_CHINESE_TEXT_CHARACTERS.has(character);
}

function isRareCjkNoiseCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint >= 0x9f00 && codePoint <= 0x9fff;
}

const COMMON_CHINESE_TEXT_CHARACTERS = new Set(
  Array.from(
    "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三第章"
  )
);

import { describe, expect, it } from "vitest";
import iconv from "iconv-lite";
import { ChapterParseError, parseChapters } from "./chapterParser";
import { decodeNovelText, TextDecodingError } from "./textEncoding";

const gbkFirstChapterBytes = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]);

describe("decodeNovelText", () => {
  it("decodes UTF-8 without BOM as utf-8", () => {
    const result = decodeNovelText(Buffer.from("第一章 起始", "utf8"));

    expect(result).toEqual({ text: "第一章 起始", encoding: "utf-8" });
  });

  it("decodes UTF-8 BOM as utf-8-bom and strips the BOM", () => {
    const result = decodeNovelText(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("第一章 起始", "utf8")])
    );

    expect(result).toEqual({ text: "第一章 起始", encoding: "utf-8-bom" });
    expect(result.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("decodes GBK bytes containing a Chinese chapter heading", () => {
    const result = decodeNovelText(gbkFirstChapterBytes);

    expect(result.encoding).toBe("gbk");
    expect(result.text).toContain("第一章");
  });

  it("decodes the CP936 alias for the same Chinese chapter bytes", () => {
    const result = decodeNovelText(gbkFirstChapterBytes, { legacyEncoding: "cp936" });

    expect(result.encoding).toBe("cp936");
    expect(result.text).toContain("第一章");
  });

  it("decodes short readable GBK text so parsing can reject missing chapter headings", () => {
    const sourceText = "只有正文，没有章节标题";
    const result = decodeNovelText(iconv.encode(sourceText, "gbk"));

    expect(result).toEqual({ text: sourceText, encoding: "gbk" });
    expect(() => parseChapters(result.text)).toThrow(ChapterParseError);
  });

  it("throws TextDecodingError for legacy GBK rare-character noise even with a chapter heading", () => {
    const sourceText = `第一章\n${"龠".repeat(80)}`;

    expect(() => decodeNovelText(iconv.encode(sourceText, "gbk"))).toThrow(TextDecodingError);
  });

  it("throws TextDecodingError for legacy GBK common CJK text with only a chapter heading as structure", () => {
    const sourceText = `第一章\n${"的".repeat(80)}`;

    expect(() => decodeNovelText(iconv.encode(sourceText, "gbk"))).toThrow(TextDecodingError);
  });

  it.each(["的龠龠龠", "的龠龠龠龠", "的龠龠，龠"])(
    "throws TextDecodingError for short legacy GBK mojibake %s",
    (sourceText) => {
      expect(() => decodeNovelText(iconv.encode(sourceText, "gbk"))).toThrow(TextDecodingError);
    }
  );

  it("throws TextDecodingError for invalid binary instead of returning mojibake", () => {
    const binaryLikeBuffer = Buffer.from([0xff, 0x00, 0x80, 0x00, 0x1f, 0x00]);

    expect(() => decodeNovelText(binaryLikeBuffer)).toThrow(TextDecodingError);
  });

  it.each([1, 42, 777])("throws TextDecodingError for fixed GBK-compatible high-bit noise seed %s", (seed) => {
    expect(() => decodeNovelText(createGbkCompatibleNoise(seed))).toThrow(TextDecodingError);
  });

  it("still decodes plain English UTF-8 text so parsing can reject missing chapter headings later", () => {
    const result = decodeNovelText(Buffer.from("plain utf-8 text without chapter headings", "utf8"));

    expect(result).toEqual({ text: "plain utf-8 text without chapter headings", encoding: "utf-8" });
  });

  it("normalizes CRLF and CR line endings to LF", () => {
    const result = decodeNovelText(Buffer.from("第一章\r\n正文\r第二章", "utf8"));

    expect(result.text).toBe("第一章\n正文\n第二章");
  });
});

function createGbkCompatibleNoise(seed: number): Buffer {
  const pool = "载铞鹌蜣於致璐躜龠黪纛鬣鲡鹾麴黩鲧鹚鼯龃龉鳜鳌颞飨骧髑髅鹇鹈鹕鹱麽黧黥黯";
  let state = seed >>> 0;
  let text = "";

  for (let index = 0; index < 96; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    text += pool[state % pool.length];
  }

  return iconv.encode(text, "gbk");
}

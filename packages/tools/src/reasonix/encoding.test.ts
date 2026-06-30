import { describe, expect, it } from "vitest";

describe("Reasonix file encoding parity", () => {
  it("detects and decodes UTF-8, UTF-8 BOM, UTF-16 BOMs, BOM-less UTF-16, GB18030, and lossy UTF-8", async () => {
    const { decodeFileBytes, detectFileEncoding, FileEncodingKind } = await import("./encoding");

    expect(detectFileEncoding(Buffer.from("hello world\n")).kind).toBe(FileEncodingKind.UTF8);
    expect(decodeFileBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello")]), FileEncodingKind.UTF8BOM)).toBe(
      "hello"
    );

    const utf16le = encodeUtf16("hello\nworld", "le", true);
    const utf16be = encodeUtf16("hello\nworld", "be", true);
    expect(detectFileEncoding(utf16le).kind).toBe(FileEncodingKind.UTF16LE);
    expect(detectFileEncoding(utf16be).kind).toBe(FileEncodingKind.UTF16BE);
    expect(decodeFileBytes(utf16le, FileEncodingKind.UTF16LE)).toBe("hello\nworld");
    expect(decodeFileBytes(utf16be, FileEncodingKind.UTF16BE)).toBe("hello\nworld");

    const noBomLe = encodeUtf16('// Created by 69431 on 2024/12/31\n#include "x.h"\n', "le", false);
    const noBomBe = encodeUtf16("package main\nfunc main() {}\n", "be", false);
    expect(detectFileEncoding(noBomLe).kind).toBe(FileEncodingKind.UTF16LENoBOM);
    expect(detectFileEncoding(noBomBe).kind).toBe(FileEncodingKind.UTF16BENoBOM);
    expect(decodeFileBytes(noBomLe, FileEncodingKind.UTF16LENoBOM)).toContain("Created by 69431");

    expect(detectFileEncoding(Buffer.from([196, 227, 186, 195, 202, 192, 189, 231])).kind).toBe(FileEncodingKind.GB18030);
    expect(decodeFileBytes(Buffer.from([196, 227, 186, 195, 202, 192, 189, 231]), FileEncodingKind.GB18030)).toBe(
      "你好世界"
    );

    expect(detectFileEncoding(Buffer.from([0xff, 0xff, 0xff])).kind).toBe(FileEncodingKind.LossyUTF8);
    const lossy = Buffer.from([0xff, 0xfe, 0x61]);
    const decoded = decodeFileBytes(lossy, FileEncodingKind.LossyUTF8);
    expect(Buffer.isBuffer(decoded)).toBe(true);
    expect(Buffer.from(decoded as Uint8Array)).toEqual(lossy);
  });

  it("does not classify binary NULs on both parities as BOM-less UTF-16", async () => {
    const { detectUTF16NoBOM } = await import("./encoding");

    expect(detectUTF16NoBOM(Buffer.from([0x00, 0x00, 0x01, 0x00, 0x00, 0x02, 0xff, 0x00, 0x00, 0x03]))).toBeUndefined();
  });

  it("streams UTF-8 and lossy UTF-8 without a TextDecoder transform like Reasonix", async () => {
    const { FileEncodingKind, streamingDecoderName } = await import("./encoding");

    expect(streamingDecoderName(FileEncodingKind.UTF8)).toBeUndefined();
    expect(streamingDecoderName(FileEncodingKind.LossyUTF8)).toBeUndefined();
    expect(streamingDecoderName(FileEncodingKind.GB18030)).toBe("gb18030");
  });

  it("decodes isolated UTF-16 surrogate code units as replacement characters like Go", async () => {
    const { decodeFileBytes, FileEncodingKind } = await import("./encoding");

    expect(decodeFileBytes(Buffer.from([0xff, 0xfe, 0x00, 0xd8]), FileEncodingKind.UTF16LE)).toBe("�");
    expect(decodeFileBytes(Buffer.from([0xff, 0xfe, 0x00, 0xdc]), FileEncodingKind.UTF16LE)).toBe("�");
    expect(decodeFileBytes(Buffer.from([0xfe, 0xff, 0xd8, 0x00]), FileEncodingKind.UTF16BE)).toBe("�");
    expect(decodeFileBytes(Buffer.from([0xfe, 0xff, 0xdc, 0x00]), FileEncodingKind.UTF16BE)).toBe("�");
  });
});

function encodeUtf16(text: string, endian: "le" | "be", withBom: boolean): Buffer {
  const body = Buffer.from(text, "utf16le");
  const out = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 2) {
    out[index] = endian === "le" ? body[index] : body[index + 1];
    out[index + 1] = endian === "le" ? body[index + 1] : body[index];
  }
  if (!withBom) {
    return out;
  }
  return Buffer.concat([Buffer.from(endian === "le" ? [0xff, 0xfe] : [0xfe, 0xff]), out]);
}

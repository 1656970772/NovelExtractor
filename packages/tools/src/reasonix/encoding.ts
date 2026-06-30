export enum FileEncodingKind {
  UTF8 = "UTF8",
  UTF8BOM = "UTF8BOM",
  UTF16LE = "UTF16LE",
  UTF16BE = "UTF16BE",
  GB18030 = "GB18030",
  LossyUTF8 = "LossyUTF8",
  UTF16LENoBOM = "UTF16LENoBOM",
  UTF16BENoBOM = "UTF16BENoBOM"
}

export interface FileEncodingDetection {
  kind: FileEncodingKind;
  bytes: Uint8Array;
}

const utf8BOM = [0xef, 0xbb, 0xbf] as const;

export function detectFileEncoding(bytes: Uint8Array): FileEncodingDetection {
  const quick = detectQuickEncoding(bytes);
  if (quick !== FileEncodingKind.UTF8) {
    return { kind: quick, bytes };
  }

  const noBom = detectUTF16NoBOM(bytes);
  if (noBom !== undefined) {
    return { kind: noBom, bytes };
  }

  if (canDecode(bytes, "utf-8")) {
    return { kind: FileEncodingKind.UTF8, bytes };
  }

  if (canDecode(bytes, "gb18030")) {
    return { kind: FileEncodingKind.GB18030, bytes };
  }

  return { kind: FileEncodingKind.LossyUTF8, bytes };
}

export function detectQuickEncoding(bytes: Uint8Array): FileEncodingKind {
  if (bytes.length >= 3 && bytes[0] === utf8BOM[0] && bytes[1] === utf8BOM[1] && bytes[2] === utf8BOM[2]) {
    return FileEncodingKind.UTF8BOM;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return FileEncodingKind.UTF16LE;
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return FileEncodingKind.UTF16BE;
  }
  return FileEncodingKind.UTF8;
}

export function detectUTF16NoBOM(bytes: Uint8Array): FileEncodingKind.UTF16LENoBOM | FileEncodingKind.UTF16BENoBOM | undefined {
  let n = bytes.length;
  if (n < 16) {
    return undefined;
  }
  n -= n % 2;

  let evenNUL = 0;
  let oddNUL = 0;
  for (let index = 0; index < n; index += 1) {
    if (bytes[index] !== 0) {
      continue;
    }
    if (index % 2 === 0) {
      evenNUL += 1;
    } else {
      oddNUL += 1;
    }
  }

  const half = n / 2;
  if (oddNUL * 10 >= half * 3 && evenNUL * 20 <= half) {
    return FileEncodingKind.UTF16LENoBOM;
  }
  if (evenNUL * 10 >= half * 3 && oddNUL * 20 <= half) {
    return FileEncodingKind.UTF16BENoBOM;
  }
  return undefined;
}

export function decodeFileBytes(bytes: Uint8Array, kind: FileEncodingKind.UTF8 | FileEncodingKind.LossyUTF8): Buffer;
export function decodeFileBytes(
  bytes: Uint8Array,
  kind:
    | FileEncodingKind.UTF8BOM
    | FileEncodingKind.UTF16LE
    | FileEncodingKind.UTF16BE
    | FileEncodingKind.GB18030
    | FileEncodingKind.UTF16LENoBOM
    | FileEncodingKind.UTF16BENoBOM
): string;
export function decodeFileBytes(bytes: Uint8Array, kind: FileEncodingKind): string | Buffer {
  switch (kind) {
    case FileEncodingKind.UTF8BOM:
      return decodeText(bytes.slice(3), "utf-8");
    case FileEncodingKind.UTF16LE:
      return decodeUTF16(bytes.slice(2), "le");
    case FileEncodingKind.UTF16BE:
      return decodeUTF16(bytes.slice(2), "be");
    case FileEncodingKind.UTF16LENoBOM:
      return decodeUTF16(bytes, "le");
    case FileEncodingKind.UTF16BENoBOM:
      return decodeUTF16(bytes, "be");
    case FileEncodingKind.GB18030:
      return decodeText(bytes, "gb18030");
    case FileEncodingKind.UTF8:
    case FileEncodingKind.LossyUTF8:
      return Buffer.from(bytes);
  }
}

export function streamingDecoderName(kind: FileEncodingKind): "gb18030" | undefined {
  switch (kind) {
    case FileEncodingKind.GB18030:
      return "gb18030";
    case FileEncodingKind.LossyUTF8:
      return undefined;
    default:
      return undefined;
  }
}

function canDecode(bytes: Uint8Array, encoding: "utf-8" | "gb18030"): boolean {
  try {
    decodeText(bytes, encoding, true);
    return true;
  } catch {
    return false;
  }
}

function decodeText(bytes: Uint8Array, encoding: "utf-8" | "gb18030", fatal = false): string {
  return new TextDecoder(encoding, { fatal }).decode(bytes);
}

function decodeUTF16(bytes: Uint8Array, endian: "le" | "be"): string {
  const body = Buffer.from(bytes);
  let out = "";
  for (let index = 0; index + 1 < body.length; index += 2) {
    const codeUnit = endian === "le" ? body[index] | (body[index + 1] << 8) : (body[index] << 8) | body[index + 1];
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 3 < body.length) {
        const next = endian === "le" ? body[index + 2] | (body[index + 3] << 8) : (body[index + 2] << 8) | body[index + 3];
        if (next >= 0xdc00 && next <= 0xdfff) {
          out += String.fromCodePoint(0x10000 + ((codeUnit - 0xd800) << 10) + (next - 0xdc00));
          index += 2;
          continue;
        }
      }
      out += "\ufffd";
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      out += "\ufffd";
      continue;
    }
    out += String.fromCharCode(codeUnit);
  }
  return out;
}

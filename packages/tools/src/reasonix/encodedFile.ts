import { readFile, writeFile } from "node:fs/promises";
import { decodeFileBytes, detectFileEncoding, encodeFileText, FileEncodingKind } from "./encoding";
import type { ReasonixDiffKind } from "./diff";

export interface EncodedFileContent {
  content: string;
  encoding: FileEncodingKind;
}

export interface EditableEncodedFileContent extends EncodedFileContent {
  contentUsesRawBytes: boolean;
}

export async function readExistingFileEncoded(targetPath: string): Promise<EncodedFileContent> {
  let bytes: Buffer;
  try {
    bytes = await readFile(targetPath);
  } catch (error) {
    throw new Error(`read ${targetPath}: ${goStyleFsError(error)}`);
  }

  const { kind } = detectFileEncoding(bytes);
  return {
    content: decodeFileText(bytes, kind),
    encoding: kind
  };
}

export async function readExistingFileForEdit(targetPath: string): Promise<EditableEncodedFileContent> {
  let bytes: Buffer;
  try {
    bytes = await readFile(targetPath);
  } catch (error) {
    throw new Error(`read ${targetPath}: ${goStyleFsError(error)}`);
  }

  const { kind } = detectFileEncoding(bytes);
  if (kind === FileEncodingKind.LossyUTF8) {
    return {
      content: rawByteString(bytes),
      encoding: kind,
      contentUsesRawBytes: true
    };
  }

  return {
    content: decodeFileText(bytes, kind),
    encoding: kind,
    contentUsesRawBytes: false
  };
}

export async function readOptionalFileEncoded(targetPath: string): Promise<{ content?: string; encoding: FileEncodingKind }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(targetPath);
  } catch {
    return { encoding: FileEncodingKind.UTF8 };
  }

  const { kind } = detectFileEncoding(bytes);
  if (kind === FileEncodingKind.LossyUTF8) {
    return { encoding: kind };
  }

  return {
    content: decodeFileText(bytes, kind),
    encoding: kind
  };
}

export async function readFileForPreview(targetPath: string): Promise<{ oldText: string; kind: ReasonixDiffKind }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(targetPath);
  } catch (error) {
    if (isNotExistError(error)) {
      return { oldText: "", kind: "create" };
    }
    throw new Error(`read ${targetPath}: ${goStyleFsError(error)}`);
  }

  const { kind } = detectFileEncoding(bytes);
  return {
    oldText: decodeFileText(bytes, kind),
    kind: "modify"
  };
}

export async function writeFileEncoded(targetPath: string, content: string, encoding: FileEncodingKind): Promise<void> {
  try {
    await writeFile(targetPath, encodeFileText(content, encoding), { mode: 0o644 });
  } catch (error) {
    throw new Error(`write ${targetPath}: ${goStyleFsError(error)}`);
  }
}

export async function writeEditedFileEncoded(targetPath: string, content: string, source: EditableEncodedFileContent): Promise<void> {
  try {
    await writeFile(targetPath, encodeEditedFileText(content, source), { mode: 0o644 });
  } catch (error) {
    throw new Error(`write ${targetPath}: ${goStyleFsError(error)}`);
  }
}

export function utf8TextToRawByteString(text: string): string {
  return rawByteString(Buffer.from(text, "utf8"));
}

export function decodeFileText(bytes: Uint8Array, kind: FileEncodingKind): string {
  switch (kind) {
    case FileEncodingKind.UTF8:
      return decodeFileBytes(bytes, kind).toString("utf8");
    case FileEncodingKind.UTF8BOM:
    case FileEncodingKind.UTF16LE:
    case FileEncodingKind.UTF16BE:
    case FileEncodingKind.GB18030:
    case FileEncodingKind.UTF16LENoBOM:
    case FileEncodingKind.UTF16BENoBOM:
      return decodeFileBytes(bytes, kind);
    case FileEncodingKind.LossyUTF8:
      return Buffer.from(bytes).toString("utf8");
  }
}

function encodeEditedFileText(content: string, source: EditableEncodedFileContent): Buffer {
  if (source.contentUsesRawBytes) {
    return Buffer.from(content, "latin1");
  }
  return encodeFileText(content, source.encoding);
}

function rawByteString(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

export function isNotExistError(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function goStyleFsError(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const err = error as NodeJS.ErrnoException;
    if (typeof err.syscall === "string" && typeof err.path === "string" && typeof err.code === "string") {
      return `${err.syscall} ${err.path}: ${goStyleErrnoMessage(err.code, err.message)}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function goStyleErrnoMessage(code: string, fallback: string): string {
  switch (code) {
    case "ENOENT":
      return "no such file or directory";
    case "EACCES":
      return "permission denied";
    case "EPERM":
      return "operation not permitted";
    case "EISDIR":
      return "is a directory";
    case "ENOTDIR":
      return "not a directory";
    default:
      return fallback;
  }
}

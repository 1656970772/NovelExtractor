import fs from "node:fs";
import { open, stat } from "node:fs/promises";
import { confineRead, resolveReadablePath, type ResolvedPath } from "../pathResolver";
import type { ReasonixTool } from "../registry";
import type { Workspace } from "../workspace";
import {
  decodeFileBytes,
  detectFileEncoding,
  detectQuickEncoding,
  detectUTF16NoBOM,
  FileEncodingKind,
  streamingDecoderName
} from "../encoding";
import {
  GoRawJSONUnmarshaller,
  goJSONTokenKind,
  goJSONTypeError,
  invalidArgs,
  isGoIntLiteral,
  parsedJSONValueForError,
  type ParsedRawJSONValue,
  type RawJSONValueKind,
  replaceIsolatedSurrogates
} from "../goJson";

const readFileBinaryPeek = 8 * 1024;
const readFileDetectSample = 256 * 1024;
const readFileDefaultLimit = 2000;
const scannerMaxTokenSize = 1024 * 1024;
const readFileArgsGoStructType =
  'struct { Path string "json:\\"path\\""; Offset int "json:\\"offset,omitempty\\""; Limit int "json:\\"limit,omitempty\\"" }';
const goInt64Min = -(1n << 63n);
const goInt64Max = (1n << 63n) - 1n;

interface NormalizedReadFileArgs {
  path: string;
  offset: bigint;
  limit: bigint;
}

export function createReadFileTool(workspace: Workspace): ReasonixTool {
  const [definition] = workspace.tools(["read_file"]);

  return {
    ...definition,
    async execute(args: unknown): Promise<string> {
      const params = normalizeArgs(args);
      const resolved = resolveReadablePath(workspace.dir, params.path, workspace.readPaths);
      const targetPath = resolved.path;
      const displayPath = resolved.displayPath;

      if (confineRead(workspace.realForbidReadRoots, targetPath)) {
        const error = pathError("open", targetPath, "file does not exist");
        if (resolved.external) {
          throw new Error(`read ${displayPath}: ${toSlash(resolved.errorText(error))}`);
        }
        throw error;
      }

      const offset = params.offset < 0n ? 0n : params.offset;
      const limit = params.limit <= 0n ? BigInt(readFileDefaultLimit) : params.limit;

      try {
        const info = await stat(targetPath);
        if (info.isDirectory()) {
          throw new Error(`${displayPath} is a directory, not a file — use the ls tool to list it, or read a specific file inside it`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes(" is a directory, not a file ")) {
          throw error;
        }
      }

      return readResolvedFile(targetPath, displayPath, resolved, offset, limit);
    }
  };
}

async function readResolvedFile(targetPath: string, displayPath: string, resolved: ResolvedPath, offset: bigint, limit: bigint): Promise<string> {
  let file: fs.promises.FileHandle;
  try {
    file = await open(targetPath, "r");
  } catch (error) {
    throwReadError(error, displayPath, resolved);
  }

  try {
    const peekResult = await readAtMost(file, readFileBinaryPeek, 0);
    const peek = peekResult.bytes;
    const peekEOF = peekResult.eof;

    const quick = detectQuickEncoding(peek);
    switch (quick) {
      case FileEncodingKind.UTF16LE:
      case FileEncodingKind.UTF16BE: {
        const all = Buffer.concat([peek, await readRest(file, peek.length)]);
        return scanText(decodeFileBytes(all, quick), offset, limit);
      }
      case FileEncodingKind.UTF8BOM: {
        const body = peek.length >= 3 ? peek.subarray(3) : peek;
        return await scanRawByteChunks(chunksFromHeadAndFile(body, file, peek.length), offset, limit);
      }
      default:
        break;
    }

    const noBom = detectUTF16NoBOM(peek);
    if (noBom !== undefined) {
      const all = Buffer.concat([peek, await readRest(file, peek.length)]);
      return scanText(decodeFileBytes(all, noBom), offset, limit);
    }

    if (peek.includes(0)) {
      if (resolved.external) {
        throw new Error(`binary file ${displayPath} (NUL byte detected); not shown by read_file`);
      }
      throw new Error(`binary file ${displayPath} (NUL byte detected); use \`bash hexdump\` or another tool`);
    }

    let head = peek;
    let eof = peekEOF;
    if (!eof) {
      const more = await readAtMost(file, readFileDetectSample - peek.length, peek.length);
      head = Buffer.concat([peek, more.bytes]);
      eof = more.eof;
    }

    let sample = head;
    if (!eof) {
      const index = head.lastIndexOf(0x0a);
      if (index >= 0) {
        sample = head.subarray(0, index + 1);
      }
    }
    const { kind } = detectFileEncoding(sample);
    const decoderName = streamingDecoderName(kind);
    if (decoderName === undefined) {
      if (kind === FileEncodingKind.UTF8 || kind === FileEncodingKind.LossyUTF8) {
        return await scanRawByteChunks(chunksFromHeadAndFile(head, file, head.length), offset, limit);
      }
      return scanText(decodeFileBytesAsText(head, kind), offset, limit);
    }
    return await scanDecodedChunks(chunksFromHeadAndFile(head, file, head.length), decoderName, offset, limit);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("binary file ") || error.message.startsWith("scan: "))) {
      throw error;
    }
    throwReadError(error, displayPath, resolved);
  } finally {
    await file.close();
  }
}

function normalizeArgs(args: unknown): NormalizedReadFileArgs {
  if (typeof args === "string") {
    return normalizeRawJSONArgs(args);
  }
  if (args instanceof Uint8Array) {
    return normalizeRawJSONArgs(new TextDecoder().decode(args));
  }

  return normalizeStructuredArgs(args);
}

function normalizeRawJSONArgs(rawText: string): NormalizedReadFileArgs {
  const result = new RawReadFileArgsUnmarshaller(rawText).unmarshal();
  if (result.kind !== "object" && result.kind !== "null") {
    throw invalidArgs(`json: cannot unmarshal ${result.kind === "bool" ? "bool" : result.kind} into Go value of type ${readFileArgsGoStructType}`);
  }
  if (result.typeError !== undefined) {
    throw invalidArgs(result.typeError);
  }
  if (result.path === "") {
    throw new Error("path is required");
  }

  return {
    path: result.path,
    offset: result.offset,
    limit: result.limit
  };
}

function normalizeStructuredArgs(raw: unknown): NormalizedReadFileArgs {
  if (raw === null) {
    raw = {};
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidArgs(`json: cannot unmarshal ${goJSONTokenKind(raw)} into Go value of type ${readFileArgsGoStructType}`);
  }

  const value = raw as Record<string, unknown>;
  let pathValue = "";
  let offsetValue = 0n;
  let limitValue = 0n;
  let firstTypeError: string | undefined;

  for (const key of Object.keys(value)) {
    const field = readFileArgField(key);
    if (field === "path") {
      const fieldValue = value[key];
      if (fieldValue === undefined || fieldValue === null) {
        pathValue = "";
      } else if (typeof fieldValue === "string") {
        pathValue = replaceIsolatedSurrogates(fieldValue);
      } else {
        firstTypeError ??= goJSONTypeError(fieldValue, "path", "string");
      }
      continue;
    }
    if (field === "offset") {
      const decoded = structuredNumberArg(value[key], "offset");
      if (typeof decoded === "string") {
        firstTypeError ??= decoded;
      } else {
        offsetValue = decoded;
      }
      continue;
    }
    if (field === "limit") {
      const decoded = structuredNumberArg(value[key], "limit");
      if (typeof decoded === "string") {
        firstTypeError ??= decoded;
      } else {
        limitValue = decoded;
      }
    }
  }

  if (firstTypeError !== undefined) {
    throw invalidArgs(firstTypeError);
  }
  if (pathValue === "") {
    throw new Error("path is required");
  }

  return {
    path: pathValue,
    offset: offsetValue,
    limit: limitValue
  };
}

function structuredNumberArg(value: unknown, field: "offset" | "limit"): bigint | string {
  if (value === undefined || value === null) {
    return 0n;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return goJSONTypeError(value, field, "int");
  }
  const intValue = BigInt(value);
  if (intValue < goInt64Min || intValue > goInt64Max) {
    return goJSONTypeError(value, field, "int");
  }
  return intValue;
}

function readFileArgField(key: string): "path" | "offset" | "limit" | undefined {
  const folded = key.toLowerCase();
  if (folded === "path" || folded === "offset" || folded === "limit") {
    return folded;
  }
  return undefined;
}

class RawReadFileArgsUnmarshaller {
  private path = "";
  private offset = 0n;
  private limit = 0n;
  private firstTypeError: string | undefined;

  constructor(private readonly json: string) {}

  unmarshal(): { kind: RawJSONValueKind; path: string; offset: bigint; limit: bigint; typeError?: string } {
    const kind = new GoRawJSONUnmarshaller(this.json, (key, value) => this.unmarshalKnownField(key, value)).unmarshal();
    return {
      kind,
      path: this.path,
      offset: this.offset,
      limit: this.limit,
      typeError: this.firstTypeError
    };
  }

  private unmarshalKnownField(key: string, value: ParsedRawJSONValue): void {
    const field = readFileArgField(key);
    if (field === "path") {
      if (value.kind === "null") {
        return;
      } else if (value.kind === "string") {
        this.path = value.stringValue ?? "";
      } else {
        this.firstTypeError ??= goJSONTypeError(parsedJSONValueForError(value), "path", "string", value.raw);
      }
      return;
    }
    if (field === "offset" || field === "limit") {
      const decoded = this.unmarshalRawIntField(value, field);
      if (typeof decoded === "string") {
        this.firstTypeError ??= decoded;
      } else if (field === "offset") {
        this.offset = decoded;
      } else {
        this.limit = decoded;
      }
    }
  }

  private unmarshalRawIntField(value: ParsedRawJSONValue, field: "offset" | "limit"): bigint | string {
    if (value.kind === "null") {
      return field === "offset" ? this.offset : this.limit;
    }
    if (value.kind !== "number") {
      return goJSONTypeError(parsedJSONValueForError(value), field, "int", value.raw);
    }
    if (!isGoIntLiteral(value.raw)) {
      return goJSONTypeError(0, field, "int", value.raw);
    }
    return BigInt(value.raw);
  }
}

function decodeFileBytesAsText(bytes: Uint8Array, kind: FileEncodingKind): string {
  switch (kind) {
    case FileEncodingKind.UTF8BOM:
    case FileEncodingKind.UTF16LE:
    case FileEncodingKind.UTF16BE:
    case FileEncodingKind.GB18030:
    case FileEncodingKind.UTF16LENoBOM:
    case FileEncodingKind.UTF16BENoBOM:
      return decodeFileBytes(bytes, kind);
    case FileEncodingKind.UTF8:
    case FileEncodingKind.LossyUTF8:
      return decodeFileBytes(bytes, kind).toString("utf8");
  }
}

async function readAtMost(file: fs.promises.FileHandle, length: number, position: number): Promise<{ bytes: Buffer; eof: boolean }> {
  if (length <= 0) {
    return { bytes: Buffer.alloc(0), eof: false };
  }
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return { bytes: buffer.subarray(0, bytesRead), eof: bytesRead < length };
}

async function readRest(file: fs.promises.FileHandle, position: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let current = position;
  for (;;) {
    const { bytes, eof } = await readAtMost(file, 64 * 1024, current);
    if (bytes.length > 0) {
      chunks.push(bytes);
      current += bytes.length;
    }
    if (eof) {
      return Buffer.concat(chunks);
    }
  }
}

async function* chunksFromHeadAndFile(head: Buffer, file: fs.promises.FileHandle, start: number): AsyncIterable<Buffer> {
  if (head.length > 0) {
    yield head;
  }
  let current = start;
  for (;;) {
    const { bytes, eof } = await readAtMost(file, 64 * 1024, current);
    if (bytes.length > 0) {
      yield bytes;
      current += bytes.length;
    }
    if (eof) {
      return;
    }
  }
}

async function scanDecodedChunks(chunks: AsyncIterable<Buffer>, encoding: "utf-8" | "gb18030", offset: bigint, limit: bigint): Promise<string> {
  const decoder = new TextDecoder(encoding);
  return scanStringChunks(decodeChunks(chunks, decoder), offset, limit);
}

async function scanRawByteChunks(chunks: AsyncIterable<Buffer>, offset: bigint, limit: bigint): Promise<string> {
  const scanner = new RawByteLineWindowScanner(offset, limit);
  for await (const chunk of chunks) {
    scanner.push(chunk);
    if (scanner.done) {
      break;
    }
  }
  return scanner.finish();
}

async function* decodeChunks(chunks: AsyncIterable<Buffer>, decoder: TextDecoder): AsyncIterable<string> {
  for await (const chunk of chunks) {
    yield decoder.decode(chunk, { stream: true });
  }
  const tail = decoder.decode();
  if (tail !== "") {
    yield tail;
  }
}

function scanText(text: string, offset: bigint, limit: bigint): string {
  return scanSyncStringChunks([text], offset, limit);
}

function scanStringChunks(chunks: Iterable<string> | AsyncIterable<string>, offset: bigint, limit: bigint): string | Promise<string> {
  if (Symbol.asyncIterator in chunks) {
    return scanAsyncStringChunks(chunks, offset, limit);
  }
  return scanSyncStringChunks(chunks, offset, limit);
}

async function scanAsyncStringChunks(chunks: AsyncIterable<string>, offset: bigint, limit: bigint): Promise<string> {
  const scanner = new LineWindowScanner(offset, limit);
  for await (const chunk of chunks) {
    scanner.push(chunk);
    if (scanner.done) {
      break;
    }
  }
  return scanner.finish();
}

function scanSyncStringChunks(chunks: Iterable<string>, offset: bigint, limit: bigint): string {
  const scanner = new LineWindowScanner(offset, limit);
  for (const chunk of chunks) {
    scanner.push(chunk);
    if (scanner.done) {
      break;
    }
  }
  return scanner.finish();
}

class LineWindowScanner {
  private buffered = "";
  private readonly collected: string[] = [];
  private lineNo = 0n;
  private hasMore = false;
  done = false;

  constructor(
    private readonly offset: bigint,
    private readonly limit: bigint
  ) {}

  push(chunk: string): void {
    this.buffered += chunk;
    for (;;) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) {
        this.checkTokenSize();
        return;
      }
      if (Buffer.byteLength(this.buffered.slice(0, newline)) >= scannerMaxTokenSize) {
        throw new Error("scan: bufio.Scanner: token too long");
      }
      const line = stripCR(this.buffered.slice(0, newline));
      this.buffered = this.buffered.slice(newline + 1);
      this.accept(line);
      if (this.done) {
        return;
      }
    }
  }

  finish(): string {
    if (!this.done && this.buffered.length > 0) {
      this.checkTokenSize();
      this.accept(this.buffered);
      this.buffered = "";
    }

    if (this.lineNo === 0n) {
      return "(empty file)";
    }
    if (this.collected.length === 0) {
      return `(offset ${this.offset} is past EOF — file has ${this.lineNo} lines)`;
    }

    const maxShown = this.offset + BigInt(this.collected.length);
    const width = String(maxShown).length;
    let out = "";
    for (let index = 0; index < this.collected.length; index += 1) {
      out += `${String(this.offset + BigInt(index) + 1n).padStart(width, " ")}→${this.collected[index]}\n`;
    }
    if (this.hasMore) {
      out += `\n[more lines below; pass offset=${this.offset + BigInt(this.collected.length)} to continue]\n`;
    }
    return out;
  }

  private accept(line: string): void {
    this.lineNo += 1n;
    if (this.lineNo <= this.offset) {
      return;
    }
    if (BigInt(this.collected.length) < this.limit) {
      this.collected.push(line);
      return;
    }
    this.hasMore = true;
    this.done = true;
  }

  private checkTokenSize(): void {
    if (Buffer.byteLength(this.buffered) >= scannerMaxTokenSize) {
      throw new Error("scan: bufio.Scanner: token too long");
    }
  }
}

class RawByteLineWindowScanner {
  private buffered = Buffer.alloc(0);
  private readonly collected: Buffer[] = [];
  private lineNo = 0n;
  private hasMore = false;
  done = false;

  constructor(
    private readonly offset: bigint,
    private readonly limit: bigint
  ) {}

  push(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    for (;;) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline < 0) {
        this.checkTokenSize();
        return;
      }
      if (newline >= scannerMaxTokenSize) {
        throw new Error("scan: bufio.Scanner: token too long");
      }
      const line = stripCRByte(this.buffered.subarray(0, newline));
      this.buffered = this.buffered.subarray(newline + 1);
      this.accept(line);
      if (this.done) {
        return;
      }
    }
  }

  finish(): string {
    if (!this.done && this.buffered.length > 0) {
      this.checkTokenSize();
      this.accept(this.buffered);
      this.buffered = Buffer.alloc(0);
    }

    if (this.lineNo === 0n) {
      return "(empty file)";
    }
    if (this.collected.length === 0) {
      return `(offset ${this.offset} is past EOF — file has ${this.lineNo} lines)`;
    }

    const maxShown = this.offset + BigInt(this.collected.length);
    const width = String(maxShown).length;
    let out = "";
    for (let index = 0; index < this.collected.length; index += 1) {
      out += `${String(this.offset + BigInt(index) + 1n).padStart(width, " ")}→${decodeRawUTF8ByteString(this.collected[index])}\n`;
    }
    if (this.hasMore) {
      out += `\n[more lines below; pass offset=${this.offset + BigInt(this.collected.length)} to continue]\n`;
    }
    return out;
  }

  private accept(line: Buffer): void {
    this.lineNo += 1n;
    if (this.lineNo <= this.offset) {
      return;
    }
    if (BigInt(this.collected.length) < this.limit) {
      this.collected.push(line);
      return;
    }
    this.hasMore = true;
    this.done = true;
  }

  private checkTokenSize(): void {
    if (this.buffered.length >= scannerMaxTokenSize) {
      throw new Error("scan: bufio.Scanner: token too long");
    }
  }
}

function decodeRawUTF8ByteString(bytes: Buffer): string {
  let out = "";
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index];
    if (first < 0x80) {
      out += String.fromCharCode(first);
      index += 1;
      continue;
    }

    const decoded = decodeUTF8Sequence(bytes, index);
    if (decoded === undefined) {
      out += String.fromCharCode(first);
      index += 1;
      continue;
    }
    out += String.fromCodePoint(decoded.codePoint);
    index += decoded.length;
  }
  return out;
}

function decodeUTF8Sequence(bytes: Buffer, index: number): { codePoint: number; length: number } | undefined {
  const first = bytes[index];
  if (first >= 0xc2 && first <= 0xdf) {
    const b1 = bytes[index + 1];
    if (isUTF8Continuation(b1)) {
      return { codePoint: ((first & 0x1f) << 6) | (b1 & 0x3f), length: 2 };
    }
  }
  if (first >= 0xe0 && first <= 0xef) {
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    if (isUTF8Continuation(b1) && isUTF8Continuation(b2) && (first !== 0xe0 || b1 >= 0xa0) && (first !== 0xed || b1 <= 0x9f)) {
      return { codePoint: ((first & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f), length: 3 };
    }
  }
  if (first >= 0xf0 && first <= 0xf4) {
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    const b3 = bytes[index + 3];
    if (isUTF8Continuation(b1) && isUTF8Continuation(b2) && isUTF8Continuation(b3) && (first !== 0xf0 || b1 >= 0x90) && (first !== 0xf4 || b1 <= 0x8f)) {
      return { codePoint: ((first & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f), length: 4 };
    }
  }
  return undefined;
}

function isUTF8Continuation(byte: number | undefined): byte is number {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function stripCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function stripCRByte(line: Buffer): Buffer {
  return line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line;
}

function throwReadError(error: unknown, displayPath: string, resolved: ResolvedPath): never {
  const message = goStyleFsError(error);
  if (resolved.external) {
    throw new Error(`read ${displayPath}: ${toSlash(resolved.errorText(new Error(message)))}`);
  }
  throw new Error(`read ${displayPath}: ${message}`);
}

function pathError(op: string, targetPath: string, message: string): Error {
  return new Error(`${op} ${targetPath}: ${message}`);
}

function goStyleFsError(error: unknown): string {
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
    default:
      return fallback;
  }
}

function toSlash(inputPath: string): string {
  return inputPath.replace(/\\/gu, "/");
}

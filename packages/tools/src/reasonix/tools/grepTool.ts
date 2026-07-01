import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { RE2JS } from "re2js";
import { decodeFileBytes, detectFileEncoding, detectQuickEncoding, FileEncodingKind } from "../encoding";
import { goStyleFsError } from "../encodedFile";
import {
  GoRawJSONUnmarshaller,
  goJSONTokenKind,
  goJSONTypeError,
  invalidArgs,
  isGoIntLiteral,
  parsedJSONValueForError,
  replaceIsolatedSurrogates,
  type ParsedRawJSONValue,
  type RawJSONValueKind
} from "../goJson";
import { confineRead, resolveReadablePath, type ResolvedPath } from "../pathResolver";
import type { ReasonixTool } from "../registry";
import { walkSearchFiles } from "../searchWalk";
import type { Workspace } from "../workspace";

const grepMaxMatches = 200;
const grepDefaultTimeoutSeconds = 30n;
const grepMaxTimeoutSeconds = 300n;
const goInt64Min = -(1n << 63n);
const goInt64Max = (1n << 63n) - 1n;
const binaryPeekBytes = 8 * 1024;
const scannerMaxTokenBytes = 1024 * 1024;
const grepArgsGoStructType =
  'struct { Pattern string "json:\\"pattern\\""; Path string "json:\\"path\\""; TimeoutSeconds int "json:\\"timeout_seconds\\"" }';

interface NormalizedGrepArgs {
  pattern: string;
  path: string;
  timeoutSeconds: bigint;
}

interface GrepRunState {
  matches: string[];
  truncated: boolean;
  timedOut: boolean;
}

export function createGrepTool(workspace: Workspace): ReasonixTool {
  const [definition] = workspace.tools(["grep"]);

  return {
    ...definition,
    async execute(args: unknown): Promise<string> {
      const params = normalizeArgs(args);
      const inputPath = params.path === "" ? "." : params.path;
      const resolved = resolveReadablePath(workspace.dir, inputPath, workspace.readPaths);
      const targetPath = resolved.path;
      const timeoutSeconds = grepTimeout(params.timeoutSeconds);

      let info;
      try {
        info = await stat(targetPath);
      } catch (error) {
        throw new Error(`grep ${resolved.displayPath}: ${toSlash(resolved.errorText(new Error(goStyleFsError(error))))}`);
      }

      if (confineRead(workspace.realForbidReadRoots, targetPath)) {
        if (info.isDirectory()) {
          return formatGrep({ matches: [], truncated: false, timedOut: false }, timeoutSeconds);
        }
        const error = new Error(`stat ${targetPath}: file does not exist`);
        if (resolved.external) {
          throw new Error(`grep ${resolved.displayPath}: ${toSlash(resolved.errorText(error))}`);
        }
        throw error;
      }

      if (workspace.search.rgPath !== undefined && workspace.search.rgPath !== "" && workspace.realForbidReadRoots.length === 0) {
        const rgOut = await runRipgrep(workspace.search.rgPath, params.pattern, targetPath, timeoutSeconds, resolved);
        if (rgOut !== undefined) {
          return rgOut;
        }
      }

      return runNative(params.pattern, targetPath, info.isDirectory(), timeoutSeconds, resolved, workspace.realForbidReadRoots);
    }
  };
}

function normalizeArgs(args: unknown): NormalizedGrepArgs {
  if (typeof args === "string") {
    return normalizeRawJSONArgs(args);
  }
  if (args instanceof Uint8Array) {
    return normalizeRawJSONArgs(new TextDecoder().decode(args));
  }

  return normalizeStructuredArgs(args);
}

function normalizeRawJSONArgs(rawText: string): NormalizedGrepArgs {
  const result = new RawGrepArgsUnmarshaller(rawText).unmarshal();
  if (result.kind !== "object" && result.kind !== "null") {
    throw invalidArgs(`json: cannot unmarshal ${result.kind === "bool" ? "bool" : result.kind} into Go value of type ${grepArgsGoStructType}`);
  }
  if (result.typeError !== undefined) {
    throw invalidArgs(result.typeError);
  }
  if (result.pattern === "") {
    throw new Error("pattern is required");
  }
  return {
    pattern: result.pattern,
    path: result.path,
    timeoutSeconds: result.timeoutSeconds
  };
}

function normalizeStructuredArgs(raw: unknown): NormalizedGrepArgs {
  if (raw === null) {
    raw = {};
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidArgs(`json: cannot unmarshal ${goJSONTokenKind(raw)} into Go value of type ${grepArgsGoStructType}`);
  }

  const value = raw as Record<string, unknown>;
  let patternValue = "";
  let pathValue = "";
  let timeoutValue = 0n;
  let firstTypeError: string | undefined;

  for (const key of Object.keys(value)) {
    const field = grepArgField(key);
    if (field === undefined) {
      continue;
    }
    const fieldValue = value[key];
    if (field === "timeout_seconds") {
      const decoded = structuredIntArg(fieldValue, "timeout_seconds");
      if (typeof decoded === "string") {
        firstTypeError ??= decoded;
      } else {
        timeoutValue = decoded;
      }
      continue;
    }

    if (fieldValue === undefined || fieldValue === null) {
      if (field === "pattern") {
        patternValue = "";
      } else {
        pathValue = "";
      }
      continue;
    }
    if (typeof fieldValue === "string") {
      const text = replaceIsolatedSurrogates(fieldValue);
      if (field === "pattern") {
        patternValue = text;
      } else {
        pathValue = text;
      }
      continue;
    }
    firstTypeError ??= goJSONTypeError(fieldValue, field, "string");
  }

  if (firstTypeError !== undefined) {
    throw invalidArgs(firstTypeError);
  }
  if (patternValue === "") {
    throw new Error("pattern is required");
  }

  return {
    pattern: patternValue,
    path: pathValue,
    timeoutSeconds: timeoutValue
  };
}

class RawGrepArgsUnmarshaller {
  private pattern = "";
  private path = "";
  private timeoutSeconds = 0n;
  private firstTypeError: string | undefined;

  constructor(private readonly json: string) {}

  unmarshal(): { kind: RawJSONValueKind; pattern: string; path: string; timeoutSeconds: bigint; typeError?: string } {
    const kind = new GoRawJSONUnmarshaller(this.json, (key, value) => this.unmarshalKnownField(key, value)).unmarshal();
    return {
      kind,
      pattern: this.pattern,
      path: this.path,
      timeoutSeconds: this.timeoutSeconds,
      typeError: this.firstTypeError
    };
  }

  private unmarshalKnownField(key: string, value: ParsedRawJSONValue): void {
    const field = grepArgField(key);
    if (field === undefined) {
      return;
    }
    if (field === "timeout_seconds") {
      const decoded = rawIntArg(value, "timeout_seconds", this.timeoutSeconds);
      if (typeof decoded === "string") {
        this.firstTypeError ??= decoded;
      } else {
        this.timeoutSeconds = decoded;
      }
      return;
    }

    if (value.kind === "null") {
      return;
    }
    if (value.kind === "string") {
      if (field === "pattern") {
        this.pattern = value.stringValue ?? "";
      } else {
        this.path = value.stringValue ?? "";
      }
      return;
    }
    this.firstTypeError ??= goJSONTypeError(parsedJSONValueForError(value), field, "string", value.raw);
  }
}

function grepArgField(key: string): "pattern" | "path" | "timeout_seconds" | undefined {
  const folded = key.toLowerCase();
  switch (folded) {
    case "pattern":
    case "path":
    case "timeout_seconds":
      return folded;
    default:
      return undefined;
  }
}

function structuredIntArg(value: unknown, field: "timeout_seconds"): bigint | string {
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

function rawIntArg(value: ParsedRawJSONValue, field: "timeout_seconds", current: bigint): bigint | string {
  if (value.kind === "null") {
    return current;
  }
  if (value.kind !== "number") {
    return goJSONTypeError(parsedJSONValueForError(value), field, "int", value.raw);
  }
  if (!isGoIntLiteral(value.raw)) {
    return goJSONTypeError(0, field, "int", value.raw);
  }
  return BigInt(value.raw);
}

function grepTimeout(seconds: bigint): bigint {
  if (seconds <= 0n) {
    return grepDefaultTimeoutSeconds;
  }
  if (seconds > grepMaxTimeoutSeconds) {
    return grepMaxTimeoutSeconds;
  }
  return seconds;
}

async function runNative(
  pattern: string,
  targetPath: string,
  isDirectory: boolean,
  timeoutSeconds: bigint,
  resolved: ResolvedPath,
  forbidRoots: readonly string[]
): Promise<string> {
  const regexp = compileGrepRegexp(pattern);

  const deadline = Date.now() + Number(timeoutSeconds) * 1000;
  const state: GrepRunState = { matches: [], truncated: false, timedOut: false };
  const shouldStop = (): boolean => {
    if (state.truncated || state.timedOut) {
      return true;
    }
    if (Date.now() >= deadline) {
      state.timedOut = true;
      return true;
    }
    return false;
  };

  const searchFile = async (filePath: string): Promise<void> => {
    if (shouldStop() || confineRead(forbidRoots, filePath)) {
      return;
    }

    let peek: Buffer;
    try {
      peek = await readFilePeek(filePath);
    } catch {
      return;
    }

    const { kind } = detectFileEncoding(peek);
    if (isBinaryPeek(peek)) {
      return;
    }

    const scanLine = (lineNumber: number, line: string, matchLine = line): "continue" | "stop" => {
      if (shouldStop()) {
        return "stop";
      }
      if (line.includes("\0")) {
        return "stop";
      }
      if (!regexp.test(matchLine)) {
        return "continue";
      }
      state.matches.push(`${resolved.displayFor(filePath)}:${lineNumber}:${line}`);
      if (state.matches.length >= grepMaxMatches) {
        state.truncated = true;
        return "stop";
      }
      return "continue";
    };

    if (kind === FileEncodingKind.UTF16LE || kind === FileEncodingKind.UTF16BE) {
      let bytes: Buffer;
      try {
        bytes = await readFile(filePath);
      } catch {
        return;
      }
      const text = decodeSearchText(bytes);
      if (text !== undefined) {
        scanLines(text, scanLine);
      }
      return;
    }

    await scanStreamingSearchText(filePath, peek, kind, scanLine);
  };

  if (isDirectory) {
    for await (const filePath of walkSearchFiles(targetPath, forbidRoots, { shouldStop })) {
      await searchFile(filePath);
      if (shouldStop()) {
        break;
      }
    }
  } else {
    await searchFile(targetPath);
  }

  shouldStop();
  return formatGrep(state, timeoutSeconds);
}

async function readFilePeek(filePath: string): Promise<Buffer> {
  const file = await open(filePath, "r");
  try {
    const peek = Buffer.alloc(binaryPeekBytes);
    const { bytesRead } = await file.read(peek, 0, binaryPeekBytes, 0);
    return peek.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function isBinaryPeek(peek: Buffer): boolean {
  const quick = detectQuickEncoding(peek);
  if (quick !== FileEncodingKind.UTF16LE && quick !== FileEncodingKind.UTF16BE && quick !== FileEncodingKind.UTF8BOM && peek.includes(0)) {
    return true;
  }
  return false;
}

async function scanStreamingSearchText(
  filePath: string,
  peek: Buffer,
  kind: FileEncodingKind,
  onLine: (lineNumber: number, line: string, matchLine?: string) => "continue" | "stop"
): Promise<void> {
  if (kind === FileEncodingKind.LossyUTF8) {
    await scanLossyUTF8SearchText(filePath, peek, onLine);
    return;
  }

  let lineNumber = 0;
  let remainder = "";
  let stopped = false;
  const decoder =
    kind === FileEncodingKind.GB18030
      ? new TextDecoder("gb18030")
      : kind === FileEncodingKind.UTF8 || kind === FileEncodingKind.UTF8BOM
        ? new TextDecoder("utf-8", { ignoreBOM: kind === FileEncodingKind.UTF8BOM })
        : undefined;

  const feedText = (text: string): void => {
    if (stopped || text === "") {
      return;
    }
    remainder += text;
    for (;;) {
      const newline = remainder.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(remainder, "utf8") >= scannerMaxTokenBytes) {
          stopped = true;
          remainder = "";
        }
        return;
      }

      const rawLine = remainder.slice(0, newline);
      if (Buffer.byteLength(rawLine, "utf8") >= scannerMaxTokenBytes) {
        stopped = true;
        remainder = "";
        return;
      }

      lineNumber += 1;
      remainder = remainder.slice(newline + 1);
      if (onLine(lineNumber, stripCR(rawLine)) === "stop") {
        stopped = true;
        remainder = "";
        return;
      }
    }
  };

  const feedBytes = (bytes: Buffer, stream: boolean): void => {
    if (stopped || bytes.length === 0) {
      return;
    }
    switch (kind) {
      case FileEncodingKind.GB18030:
      case FileEncodingKind.UTF8:
      case FileEncodingKind.UTF8BOM:
        feedText(decoder?.decode(bytes, { stream }) ?? "");
        return;
      default:
        feedText(bytes.toString("utf8"));
    }
  };

  feedBytes(peek, true);
  if (stopped) {
    return;
  }

  const stream = createReadStream(filePath, { start: peek.length });
  try {
    for await (const chunk of stream) {
      feedBytes(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), true);
      if (stopped) {
        stream.destroy();
        return;
      }
    }
    if (kind === FileEncodingKind.GB18030 || kind === FileEncodingKind.UTF8 || kind === FileEncodingKind.UTF8BOM) {
      feedText(decoder?.decode() ?? "");
    }
    if (!stopped && remainder !== "") {
      if (Buffer.byteLength(remainder, "utf8") < scannerMaxTokenBytes) {
        lineNumber += 1;
        onLine(lineNumber, stripCR(remainder));
      }
      remainder = "";
    }
  } catch {
    return;
  }
}

async function scanLossyUTF8SearchText(
  filePath: string,
  peek: Buffer,
  onLine: (lineNumber: number, line: string, matchLine?: string) => "continue" | "stop"
): Promise<void> {
  let lineNumber = 0;
  let remainder = Buffer.alloc(0);
  let stopped = false;

  const feedBytes = (bytes: Buffer): void => {
    if (stopped || bytes.length === 0) {
      return;
    }

    const data = remainder.length === 0 ? bytes : Buffer.concat([remainder, bytes]);
    let start = 0;
    for (;;) {
      const newline = data.indexOf(0x0a, start);
      if (newline < 0) {
        remainder = data.subarray(start);
        if (remainder.length >= scannerMaxTokenBytes) {
          stopped = true;
          remainder = Buffer.alloc(0);
        }
        return;
      }

      const rawLine = data.subarray(start, newline);
      if (rawLine.length >= scannerMaxTokenBytes) {
        stopped = true;
        remainder = Buffer.alloc(0);
        return;
      }

      lineNumber += 1;
      const line = stripCRByte(rawLine);
      if (line.includes(0)) {
        stopped = true;
        remainder = Buffer.alloc(0);
        return;
      }
      if (onLine(lineNumber, decodeRawUTF8ByteString(line), decodeGoRegexpUTF8String(line)) === "stop") {
        stopped = true;
        remainder = Buffer.alloc(0);
        return;
      }
      start = newline + 1;
    }
  };

  feedBytes(peek);
  if (stopped) {
    return;
  }

  const stream = createReadStream(filePath, { start: peek.length });
  try {
    for await (const chunk of stream) {
      feedBytes(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (stopped) {
        stream.destroy();
        return;
      }
    }
    if (!stopped && remainder.length !== 0) {
      if (remainder.length < scannerMaxTokenBytes) {
        lineNumber += 1;
        const line = stripCRByte(remainder);
        if (!line.includes(0)) {
          onLine(lineNumber, decodeRawUTF8ByteString(line), decodeGoRegexpUTF8String(line));
        }
      }
      remainder = Buffer.alloc(0);
    }
  } catch {
    return;
  }
}

function decodeSearchText(bytes: Buffer): string | undefined {
  const peek = bytes.subarray(0, binaryPeekBytes);
  if (isBinaryPeek(peek)) {
    return undefined;
  }
  const { kind } = detectFileEncoding(peek);
  switch (kind) {
    case FileEncodingKind.UTF8:
      return decodeFileBytes(bytes, kind).toString("utf8");
    case FileEncodingKind.LossyUTF8:
      return bytes.toString("latin1");
    case FileEncodingKind.UTF8BOM:
      return bytes.toString("utf8");
    case FileEncodingKind.UTF16LE:
    case FileEncodingKind.UTF16BE:
    case FileEncodingKind.GB18030:
      return decodeFileBytes(bytes, kind);
    case FileEncodingKind.UTF16LENoBOM:
    case FileEncodingKind.UTF16BENoBOM:
      return undefined;
  }
}

function scanLines(text: string, onLine: (lineNumber: number, line: string) => "continue" | "stop"): void {
  let start = 0;
  let lineNumber = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") {
      continue;
    }
    const rawLine = text.slice(start, index);
    if (Buffer.byteLength(rawLine, "utf8") >= scannerMaxTokenBytes) {
      return;
    }
    lineNumber += 1;
    if (onLine(lineNumber, stripCR(rawLine)) === "stop") {
      return;
    }
    start = index + 1;
  }
  if (start < text.length) {
    const rawLine = text.slice(start);
    if (Buffer.byteLength(rawLine, "utf8") >= scannerMaxTokenBytes) {
      return;
    }
    lineNumber += 1;
    onLine(lineNumber, stripCR(rawLine));
  }
}

function compileGrepRegexp(pattern: string): RE2JS {
  try {
    return RE2JS.compile(pattern);
  } catch (error) {
    throw new Error(`invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runRipgrep(
  rgPath: string,
  pattern: string,
  targetPath: string,
  timeoutSeconds: bigint,
  resolved: ResolvedPath
): Promise<string | undefined> {
  try {
    const info = await stat(rgPath);
    if (!info.isFile()) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return await new Promise((resolve, reject) => {
    const timeoutMs = Number(timeoutSeconds) * 1000;
    const child = spawn(
      rgPath,
      ["--no-heading", "--line-number", "--with-filename", "--color", "never", "--regexp", pattern, "--", targetPath],
      { windowsHide: true }
    );
    const stderrChunks: Buffer[] = [];
    const lines: string[] = [];
    let stdoutRemainder = Buffer.alloc(0);
    let scannerStopped = false;
    let timedOut = false;
    let truncated = false;
    let settled = false;
    const killChild = (): void => {
      child.kill("SIGKILL");
    };
    const finishOnce = (finish: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);

    const appendLine = (line: string): void => {
      if (truncated || line === "") {
        return;
      }
      lines.push(displayRipgrepLine(line, resolved));
      if (lines.length >= grepMaxMatches) {
        truncated = true;
        killChild();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated || scannerStopped) {
        return;
      }
      const data = stdoutRemainder.length === 0 ? chunk : Buffer.concat([stdoutRemainder, chunk]);
      let start = 0;
      for (;;) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) {
          stdoutRemainder = data.subarray(start);
          if (stdoutRemainder.length >= scannerMaxTokenBytes) {
            stdoutRemainder = Buffer.alloc(0);
            scannerStopped = true;
          }
          return;
        }

        const line = data.subarray(start, newline);
        if (line.length >= scannerMaxTokenBytes) {
          stdoutRemainder = Buffer.alloc(0);
          scannerStopped = true;
          return;
        }

        appendLine(stripCR(line.toString("utf8")));
        if (truncated) {
          stdoutRemainder = Buffer.alloc(0);
          return;
        }
        start = newline + 1;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      finishOnce(() => reject(new Error(`ripgrep: ${error.message}`)));
    });
    child.on("close", () => {
      finishOnce(() => {
        if (!truncated && !scannerStopped && stdoutRemainder.length !== 0) {
          if (stdoutRemainder.length < scannerMaxTokenBytes) {
            appendLine(stripCR(stdoutRemainder.toString("utf8")));
          }
        }
        const state: GrepRunState = {
          matches: lines,
          truncated,
          timedOut
        };
        if (state.matches.length === 0 && !timedOut) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          if (stderr !== "") {
            reject(new Error(`ripgrep: ${toSlash(resolved.errorText(new Error(stderr)))}`));
            return;
          }
        }
        resolve(formatGrep(state, timeoutSeconds));
      });
    });
  });
}

function displayRipgrepLine(line: string, resolved: ResolvedPath): string {
  if (!resolved.external || !line.startsWith(resolved.root)) {
    return line;
  }

  for (let index = resolved.root.length; index < line.length; index += 1) {
    if (line[index] !== ":" || !isDigit(line[index + 1])) {
      continue;
    }
    let cursor = index + 1;
    while (isDigit(line[cursor])) {
      cursor += 1;
    }
    if (line[cursor] === ":") {
      return `${resolved.displayFor(line.slice(0, index))}${line.slice(index)}`;
    }
  }
  return line;
}

function formatGrep(state: GrepRunState, timeoutSeconds: bigint): string {
  const duration = formatDuration(timeoutSeconds);
  if (state.matches.length === 0) {
    if (state.timedOut) {
      return `(no matches; timed out after ${duration} — narrow the path/pattern or raise timeout_seconds)`;
    }
    return "(no matches)";
  }

  let out = state.matches.join("\n");
  if (state.truncated) {
    out += `\n... (truncated at ${grepMaxMatches} matches)`;
  } else if (state.timedOut) {
    out += `\n... (timed out after ${duration}; results incomplete — narrow the path/pattern or raise timeout_seconds)`;
  }
  return out;
}

function formatDuration(seconds: bigint): string {
  const hours = seconds / 3600n;
  const minutes = (seconds % 3600n) / 60n;
  const remainingSeconds = seconds % 60n;
  if (hours > 0n) {
    return `${hours}h${minutes}m${remainingSeconds}s`;
  }
  if (minutes > 0n) {
    return `${minutes}m${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

function stripCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function stripCRByte(line: Buffer): Buffer {
  return line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line;
}

function decodeRawUTF8ByteString(bytes: Buffer): string {
  return decodeUTF8ByteString(bytes, (byte) => String.fromCharCode(byte));
}

function decodeGoRegexpUTF8String(bytes: Buffer): string {
  return decodeUTF8ByteString(bytes, () => "\ufffd");
}

function decodeUTF8ByteString(bytes: Buffer, invalidByte: (byte: number) => string): string {
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
      out += invalidByte(first);
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

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function toSlash(input: string): string {
  return input.replace(/\\/gu, "/");
}

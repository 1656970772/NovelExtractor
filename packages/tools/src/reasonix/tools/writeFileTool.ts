import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildChange, type ReasonixDiffChange, type ReasonixDiffKind } from "../diff";
import { decodeFileBytes, detectFileEncoding, encodeFileText, FileEncodingKind } from "../encoding";
import {
  GoRawJSONUnmarshaller,
  goJSONTokenKind,
  goJSONTypeError,
  invalidArgs,
  parsedJSONValueForError,
  type ParsedRawJSONValue,
  type RawJSONValueKind,
  replaceIsolatedSurrogates
} from "../goJson";
import { assertWritablePath, resolveInWorkspace } from "../pathResolver";
import type { ReasonixPreviewableTool } from "../registry";
import type { Workspace } from "../workspace";

const writeFileArgsGoStructType = 'struct { Path string "json:\\"path\\""; Content string "json:\\"content\\"" }';

interface NormalizedWriteFileArgs {
  path: string;
  content: string;
}

export function createWriteFileTool(workspace: Workspace): ReasonixPreviewableTool {
  const [definition] = workspace.tools(["write_file"]);

  return {
    ...definition,
    async preview(args: unknown): Promise<ReasonixDiffChange> {
      const params = normalizeArgs(args);
      const targetPath = resolveInWorkspace(workspace.dir, params.path);
      const existing = await readFileForPreview(targetPath);

      return buildChange(targetPath, existing.oldText, params.content, existing.kind);
    },
    async execute(args: unknown): Promise<string> {
      const params = normalizeArgs(args);
      const targetPath = resolveInWorkspace(workspace.dir, params.path);
      assertWritablePath(workspace.realWriteRoots, targetPath);

      const existing = await readFileEncoded(targetPath);
      if (existing.content !== undefined && existing.content === params.content) {
        return `${targetPath} already contains the exact content; no changes made`;
      }

      const dir = path.dirname(targetPath);
      if (dir !== "" && dir !== ".") {
        try {
          await mkdir(dir, { recursive: true, mode: 0o755 });
        } catch (error) {
          throw new Error(`mkdir ${dir}: ${goStyleFsError(error)}`);
        }
      }

      try {
        await writeFile(targetPath, encodeFileText(params.content, existing.encoding), { mode: 0o644 });
      } catch (error) {
        throw new Error(`write ${targetPath}: ${goStyleFsError(error)}`);
      }

      return `wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${targetPath}`;
    }
  };
}

async function readFileForPreview(targetPath: string): Promise<{ oldText: string; kind: ReasonixDiffKind }> {
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

function normalizeArgs(args: unknown): NormalizedWriteFileArgs {
  if (typeof args === "string") {
    return normalizeRawJSONArgs(args);
  }
  if (args instanceof Uint8Array) {
    return normalizeRawJSONArgs(new TextDecoder().decode(args));
  }

  return normalizeStructuredArgs(args);
}

function normalizeRawJSONArgs(rawText: string): NormalizedWriteFileArgs {
  const result = new RawWriteFileArgsUnmarshaller(rawText).unmarshal();
  if (result.kind !== "object" && result.kind !== "null") {
    throw invalidArgs(`json: cannot unmarshal ${result.kind === "bool" ? "bool" : result.kind} into Go value of type ${writeFileArgsGoStructType}`);
  }
  if (result.typeError !== undefined) {
    throw invalidArgs(result.typeError);
  }
  if (result.path === "") {
    throw new Error("path is required");
  }

  return {
    path: result.path,
    content: result.content
  };
}

function normalizeStructuredArgs(raw: unknown): NormalizedWriteFileArgs {
  if (raw === null) {
    raw = {};
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidArgs(`json: cannot unmarshal ${goJSONTokenKind(raw)} into Go value of type ${writeFileArgsGoStructType}`);
  }

  const value = raw as Record<string, unknown>;
  let pathValue = "";
  let contentValue = "";
  let firstTypeError: string | undefined;

  for (const key of Object.keys(value)) {
    const field = writeFileArgField(key);
    if (field === undefined) {
      continue;
    }

    const fieldValue = value[key];
    if (fieldValue === undefined || fieldValue === null) {
      if (field === "path") {
        pathValue = "";
      } else {
        contentValue = "";
      }
      continue;
    }
    if (typeof fieldValue === "string") {
      if (field === "path") {
        pathValue = replaceIsolatedSurrogates(fieldValue);
      } else {
        contentValue = replaceIsolatedSurrogates(fieldValue);
      }
      continue;
    }
    firstTypeError ??= goJSONTypeError(fieldValue, field, "string");
  }

  if (firstTypeError !== undefined) {
    throw invalidArgs(firstTypeError);
  }
  if (pathValue === "") {
    throw new Error("path is required");
  }

  return {
    path: pathValue,
    content: contentValue
  };
}

class RawWriteFileArgsUnmarshaller {
  private path = "";
  private content = "";
  private firstTypeError: string | undefined;

  constructor(private readonly json: string) {}

  unmarshal(): { kind: RawJSONValueKind; path: string; content: string; typeError?: string } {
    const kind = new GoRawJSONUnmarshaller(this.json, (key, value) => this.unmarshalKnownField(key, value)).unmarshal();
    return {
      kind,
      path: this.path,
      content: this.content,
      typeError: this.firstTypeError
    };
  }

  private unmarshalKnownField(key: string, value: ParsedRawJSONValue): void {
    const field = writeFileArgField(key);
    if (field === undefined) {
      return;
    }
    if (value.kind === "null") {
      if (field === "path") {
        this.path = "";
      } else {
        this.content = "";
      }
      return;
    }
    if (value.kind === "string") {
      if (field === "path") {
        this.path = value.stringValue ?? "";
      } else {
        this.content = value.stringValue ?? "";
      }
      return;
    }
    this.firstTypeError ??= goJSONTypeError(parsedJSONValueForError(value), field, "string", value.raw);
  }
}

function writeFileArgField(key: string): "path" | "content" | undefined {
  const folded = key.toLowerCase();
  if (folded === "path" || folded === "content") {
    return folded;
  }
  return undefined;
}

async function readFileEncoded(targetPath: string): Promise<{ content?: string; encoding: FileEncodingKind }> {
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
    content: decodeExistingText(bytes, kind),
    encoding: kind
  };
}

function decodeExistingText(bytes: Uint8Array, kind: Exclude<FileEncodingKind, FileEncodingKind.LossyUTF8>): string {
  return decodeFileText(bytes, kind);
}

function decodeFileText(bytes: Uint8Array, kind: FileEncodingKind): string {
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

function isNotExistError(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
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
    case "ENOTDIR":
      return "not a directory";
    default:
      return fallback;
  }
}

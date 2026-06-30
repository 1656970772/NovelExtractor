import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildChange, type ReasonixDiffChange } from "../diff";
import { goStyleFsError, readFileForPreview, readOptionalFileEncoded, writeFileEncoded } from "../encodedFile";
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

      const existing = await readOptionalFileEncoded(targetPath);
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

      await writeFileEncoded(targetPath, params.content, existing.encoding);

      return `wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${targetPath}`;
    }
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

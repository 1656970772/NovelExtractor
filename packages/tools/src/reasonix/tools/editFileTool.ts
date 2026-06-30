import { buildChange, type ReasonixDiffChange } from "../diff";
import {
  goStyleFsError,
  readExistingFileForEdit,
  utf8TextToRawByteString,
  writeEditedFileEncoded,
  type EditableEncodedFileContent
} from "../encodedFile";
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
import { applyOldStringEdit, oldStringNotFoundError, oldStringNotUniqueError } from "../textEdit";
import type { Workspace } from "../workspace";

const editFileArgsGoStructType =
  'struct { Path string "json:\\"path\\""; OldString string "json:\\"old_string\\""; NewString string "json:\\"new_string\\"" }';

interface NormalizedEditFileArgs {
  path: string;
  oldString: string;
  newString: string;
}

export function createEditFileTool(workspace: Workspace): ReasonixPreviewableTool {
  const [definition] = workspace.tools(["edit_file"]);

  return {
    ...definition,
    async preview(args: unknown): Promise<ReasonixDiffChange> {
      const params = normalizeArgs(args);
      const targetPath = resolveInWorkspace(workspace.dir, params.path);
      const existing = await readExistingFileForEdit(targetPath);
      const applied = applyEditOrThrow(targetPath, existing.content, paramsForEditableContent(existing, params));

      return buildChange(targetPath, existing.content, applied.updated, "modify");
    },
    async execute(args: unknown): Promise<string> {
      const params = normalizeArgs(args);
      const targetPath = resolveInWorkspace(workspace.dir, params.path);
      assertWritablePath(workspace.realWriteRoots, targetPath);

      const existing = await readExistingFileForEdit(targetPath);
      const applied = applyEditOrThrow(targetPath, existing.content, paramsForEditableContent(existing, params));
      try {
        await writeEditedFileEncoded(targetPath, applied.updated, existing);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(`write ${targetPath}: `)) {
          throw error;
        }
        throw new Error(`write ${targetPath}: ${goStyleFsError(error)}`);
      }

      if (applied.fuzzy) {
        return `edited ${targetPath} (fuzzy match)`;
      }
      return `edited ${targetPath}`;
    }
  };
}

function paramsForEditableContent(existing: EditableEncodedFileContent, params: NormalizedEditFileArgs): NormalizedEditFileArgs {
  if (!existing.contentUsesRawBytes) {
    return params;
  }

  return {
    path: params.path,
    oldString: utf8TextToRawByteString(params.oldString),
    newString: utf8TextToRawByteString(params.newString)
  };
}

function applyEditOrThrow(targetPath: string, content: string, params: NormalizedEditFileArgs): ReturnType<typeof applyOldStringEdit> {
  const applied = applyOldStringEdit(content, params.oldString, params.newString, false);
  if (applied.applied === 1) {
    return applied;
  }
  if (applied.matches === 0) {
    throw oldStringNotFoundError(targetPath, params.oldString, content);
  }
  throw oldStringNotUniqueError(targetPath, applied.matches, false);
}

function normalizeArgs(args: unknown): NormalizedEditFileArgs {
  if (typeof args === "string") {
    return normalizeRawJSONArgs(args);
  }
  if (args instanceof Uint8Array) {
    return normalizeRawJSONArgs(new TextDecoder().decode(args));
  }

  return normalizeStructuredArgs(args);
}

function normalizeRawJSONArgs(rawText: string): NormalizedEditFileArgs {
  const result = new RawEditFileArgsUnmarshaller(rawText).unmarshal();
  if (result.kind !== "object" && result.kind !== "null") {
    throw invalidArgs(`json: cannot unmarshal ${result.kind === "bool" ? "bool" : result.kind} into Go value of type ${editFileArgsGoStructType}`);
  }
  if (result.typeError !== undefined) {
    throw invalidArgs(result.typeError);
  }
  if (result.path === "") {
    throw new Error("path is required");
  }
  if (result.oldString === "") {
    throw new Error("old_string is required");
  }

  return {
    path: result.path,
    oldString: result.oldString,
    newString: result.newString
  };
}

function normalizeStructuredArgs(raw: unknown): NormalizedEditFileArgs {
  if (raw === null) {
    raw = {};
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidArgs(`json: cannot unmarshal ${goJSONTokenKind(raw)} into Go value of type ${editFileArgsGoStructType}`);
  }

  const value = raw as Record<string, unknown>;
  let pathValue = "";
  let oldStringValue = "";
  let newStringValue = "";
  let firstTypeError: string | undefined;

  for (const key of Object.keys(value)) {
    const field = editFileArgField(key);
    if (field === undefined) {
      continue;
    }

    const fieldValue = value[key];
    if (fieldValue === undefined || fieldValue === null) {
      if (field === "path") {
        pathValue = "";
      } else if (field === "old_string") {
        oldStringValue = "";
      } else {
        newStringValue = "";
      }
      continue;
    }
    if (typeof fieldValue === "string") {
      const text = replaceIsolatedSurrogates(fieldValue);
      if (field === "path") {
        pathValue = text;
      } else if (field === "old_string") {
        oldStringValue = text;
      } else {
        newStringValue = text;
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
  if (oldStringValue === "") {
    throw new Error("old_string is required");
  }

  return {
    path: pathValue,
    oldString: oldStringValue,
    newString: newStringValue
  };
}

class RawEditFileArgsUnmarshaller {
  private path = "";
  private oldString = "";
  private newString = "";
  private firstTypeError: string | undefined;

  constructor(private readonly json: string) {}

  unmarshal(): { kind: RawJSONValueKind; path: string; oldString: string; newString: string; typeError?: string } {
    const kind = new GoRawJSONUnmarshaller(this.json, (key, value) => this.unmarshalKnownField(key, value)).unmarshal();
    return {
      kind,
      path: this.path,
      oldString: this.oldString,
      newString: this.newString,
      typeError: this.firstTypeError
    };
  }

  private unmarshalKnownField(key: string, value: ParsedRawJSONValue): void {
    const field = editFileArgField(key);
    if (field === undefined) {
      return;
    }
    if (value.kind === "null") {
      if (field === "path") {
        this.path = "";
      } else if (field === "old_string") {
        this.oldString = "";
      } else {
        this.newString = "";
      }
      return;
    }
    if (value.kind === "string") {
      if (field === "path") {
        this.path = value.stringValue ?? "";
      } else if (field === "old_string") {
        this.oldString = value.stringValue ?? "";
      } else {
        this.newString = value.stringValue ?? "";
      }
      return;
    }
    this.firstTypeError ??= goJSONTypeError(parsedJSONValueForError(value), field, "string", value.raw);
  }
}

function editFileArgField(key: string): "path" | "old_string" | "new_string" | undefined {
  const folded = key.toLowerCase();
  switch (folded) {
    case "path":
    case "old_string":
    case "new_string":
      return folded;
    default:
      return undefined;
  }
}

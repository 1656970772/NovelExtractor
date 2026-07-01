import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { goStyleFsError } from "../encodedFile";
import {
  GoRawJSONUnmarshaller,
  goJSONTokenKind,
  goJSONTypeError,
  invalidArgs,
  parsedJSONValueForError,
  replaceIsolatedSurrogates,
  type ParsedRawJSONValue,
  type RawJSONValueKind
} from "../goJson";
import { confineRead, resolveReadablePath, type ResolvedPath } from "../pathResolver";
import type { ReasonixTool } from "../registry";
import { compareUtf8Lexical } from "../searchWalk";
import type { Workspace } from "../workspace";

const lsArgsGoStructType = 'struct { Path string "json:\\"path\\""; Recursive bool "json:\\"recursive\\"" }';
const recursiveSkipDirs = new Set([".git", "node_modules", ".DS_Store", "__pycache__", ".idea", ".vscode"]);
const maxRecursiveDepthSeparators = 50;

interface NormalizedLsArgs {
  path: string;
  recursive: boolean;
}

export function createLsTool(workspace: Workspace): ReasonixTool {
  const [definition] = workspace.tools(["ls"]);

  return {
    ...definition,
    async execute(args: unknown): Promise<string> {
      const params = normalizeArgs(args);
      if (params.path === "") {
        params.path = ".";
      }
      const resolved = resolveReadablePath(workspace.dir, params.path, workspace.readPaths);

      if (confineRead(workspace.realForbidReadRoots, resolved.path)) {
        return "(empty directory)";
      }

      if (params.recursive) {
        return listRecursive(resolved.path, resolved, workspace.realForbidReadRoots);
      }

      return listDirectory(resolved.path, resolved);
    }
  };
}

function normalizeArgs(args: unknown): NormalizedLsArgs {
  if (typeof args === "string") {
    return normalizeRawJSONArgs(args);
  }
  if (args instanceof Uint8Array) {
    return normalizeRawJSONArgs(new TextDecoder().decode(args));
  }
  return normalizeStructuredArgs(args);
}

function normalizeRawJSONArgs(rawText: string): NormalizedLsArgs {
  const result = new RawLsArgsUnmarshaller(rawText).unmarshal();
  if (result.kind !== "object" && result.kind !== "null") {
    throw invalidArgs(`json: cannot unmarshal ${result.kind === "bool" ? "bool" : result.kind} into Go value of type ${lsArgsGoStructType}`);
  }
  if (result.typeError !== undefined) {
    throw invalidArgs(result.typeError);
  }
  return {
    path: result.path,
    recursive: result.recursive
  };
}

function normalizeStructuredArgs(raw: unknown): NormalizedLsArgs {
  if (raw === null) {
    raw = {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidArgs(`json: cannot unmarshal ${goJSONTokenKind(raw)} into Go value of type ${lsArgsGoStructType}`);
  }

  const value = raw as Record<string, unknown>;
  let pathValue = ".";
  let recursiveValue = false;
  let firstTypeError: string | undefined;
  for (const key of Object.keys(value)) {
    const field = lsArgField(key);
    if (field === undefined) {
      continue;
    }
    const fieldValue = value[key];
    if (fieldValue === undefined || fieldValue === null) {
      continue;
    }
    if (field === "path") {
      if (typeof fieldValue === "string") {
        pathValue = replaceIsolatedSurrogates(fieldValue);
      } else {
        firstTypeError ??= goJSONTypeError(fieldValue, "path", "string");
      }
      continue;
    }
    if (typeof fieldValue === "boolean") {
      recursiveValue = fieldValue;
    } else {
      firstTypeError ??= goJSONTypeError(fieldValue, "recursive", "bool");
    }
  }

  if (firstTypeError !== undefined) {
    throw invalidArgs(firstTypeError);
  }
  return {
    path: pathValue,
    recursive: recursiveValue
  };
}

class RawLsArgsUnmarshaller {
  private path = ".";
  private recursive = false;
  private firstTypeError: string | undefined;

  constructor(private readonly json: string) {}

  unmarshal(): { kind: RawJSONValueKind; path: string; recursive: boolean; typeError?: string } {
    const kind = new GoRawJSONUnmarshaller(this.json, (key, value) => this.unmarshalKnownField(key, value)).unmarshal();
    return {
      kind,
      path: this.path,
      recursive: this.recursive,
      typeError: this.firstTypeError
    };
  }

  private unmarshalKnownField(key: string, value: ParsedRawJSONValue): void {
    const field = lsArgField(key);
    if (field === undefined || value.kind === "null") {
      return;
    }
    if (field === "path") {
      if (value.kind === "string") {
        this.path = value.stringValue ?? "";
      } else {
        this.firstTypeError ??= goJSONTypeError(parsedJSONValueForError(value), "path", "string", value.raw);
      }
      return;
    }
    if (value.kind === "bool") {
      this.recursive = value.raw === "true";
    } else {
      this.firstTypeError ??= goJSONTypeError(parsedJSONValueForError(value), "recursive", "bool", value.raw);
    }
  }
}

function lsArgField(key: string): "path" | "recursive" | undefined {
  const folded = key.toLowerCase();
  switch (folded) {
    case "path":
    case "recursive":
      return folded;
    default:
      return undefined;
  }
}

async function listDirectory(targetPath: string, resolved: ResolvedPath): Promise<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    throw new Error(`ls ${resolved.displayPath}: ${formatLsError(error, resolved, "open")}`);
  }

  entries.sort((left, right) => compareUtf8Lexical(left.name, right.name));
  let output = "";
  for (const entry of entries) {
    if (entry.isDirectory()) {
      output += `${entry.name}/\n`;
      continue;
    }
    output += `${entry.name}\t${await entrySize(path.join(targetPath, entry.name))}\n`;
  }

  return output === "" ? "(empty directory)" : output;
}

async function listRecursive(root: string, resolved: ResolvedPath, forbidRoots: readonly string[]): Promise<string> {
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    throw new Error(`ls -R ${resolved.displayPath}: ${formatLsError(error, resolved, "lstat")}`);
  }
  if (!rootInfo.isDirectory()) {
    return "(empty directory tree)";
  }

  let output = "";
  const appendEntry = async (targetPath: string, entry: Dirent): Promise<"descend" | "skip"> => {
    const relativePath = path.relative(root, targetPath);
    if (countPathSeparators(relativePath) > maxRecursiveDepthSeparators) {
      return "skip";
    }

    let rel = toSlash(relativePath);
    if (entry.isDirectory()) {
      rel += "/";
      output += `${rel}\n`;
      return "descend";
    }

    output += `${rel}\t${await entrySize(targetPath)}\n`;
    return "skip";
  };

  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    entries.sort((left, right) => compareUtf8Lexical(left.name, right.name));
    for (const entry of entries) {
      const targetPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursiveSkipDirs.has(entry.name) || confineRead(forbidRoots, targetPath)) {
          continue;
        }
        if ((await appendEntry(targetPath, entry)) === "descend") {
          await walk(targetPath);
        }
        continue;
      }
      await appendEntry(targetPath, entry);
    }
  };

  try {
    await walk(root);
  } catch (error) {
    throw new Error(`ls -R ${resolved.displayPath}: ${formatLsError(error, resolved, "open")}`);
  }

  return output === "" ? "(empty directory tree)" : output;
}

async function entrySize(targetPath: string): Promise<number> {
  try {
    return (await lstat(targetPath)).size;
  } catch {
    return -1;
  }
}

function countPathSeparators(relativePath: string): number {
  if (relativePath === "") {
    return 0;
  }
  return relativePath.split(path.sep).length - 1;
}

function formatLsError(error: unknown, resolved: ResolvedPath, syscall: "open" | "lstat"): string {
  const message = replaceFsSyscall(goStyleFsError(error), syscall);
  return resolved.external ? toSlash(resolved.errorText(new Error(message))) : message;
}

function replaceFsSyscall(message: string, syscall: "open" | "lstat"): string {
  return message.replace(/^(?:scandir|stat|lstat|open) /u, `${syscall} `);
}

function toSlash(input: string): string {
  return input.replace(/\\/gu, "/");
}

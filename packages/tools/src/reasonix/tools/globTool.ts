import { lstat, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
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
import type { ReasonixTool, ReasonixToolExecutionContext } from "../registry";
import { compareUtf8Lexical } from "../searchWalk";
import type { Workspace } from "../workspace";

const globMaxResults = 1000;
const globArgsGoStructType = 'struct { Pattern string "json:\\"pattern\\"" }';
const globVendorDirs = new Set([".git", ".svn", ".hg", ".jj", "node_modules", "vendor", ".venv", "__pycache__", ".mypy_cache", ".pytest_cache"]);
const macOSProtectedHomeDirNames = ["Music", "Pictures", "Movies", "Library"];

interface NormalizedGlobArgs {
  pattern: string;
}

export function createGlobTool(workspace: Workspace): ReasonixTool {
  const [definition] = workspace.tools(["glob"]);

  return {
    ...definition,
    async execute(args: unknown, context?: ReasonixToolExecutionContext): Promise<string> {
      const params = normalizeArgs(args);
      const rawPattern = params.pattern;
      const resolved = resolveReadablePath(workspace.dir, params.pattern, workspace.readPaths);
      const pattern = fromSlash(resolved.path);
      const displayPattern = resolved.displayPath;

      if (pattern.includes("**")) {
        return globRecursive(pattern, displayPattern, resolved, workspace.realForbidReadRoots, context?.signal);
      }

      let matches: string[];
      try {
        matches = await globPlain(pattern);
      } catch (error) {
        throw globError(displayPattern, resolved, error);
      }

      matches = filterForbidMatches(matches, workspace.realForbidReadRoots);
      if (matches.length === 0 && !/[\\/]/u.test(rawPattern)) {
        const fallback = path.join(workspace.dir, "**", rawPattern);
        return globRecursive(fallback, fallback, undefined, workspace.realForbidReadRoots, context?.signal);
      }
      if (matches.length === 0) {
        return "(no matches)";
      }

      matches.sort(compareUtf8Lexical);
      matches = displayGlobMatches(matches, resolved);
      if (matches.length > globMaxResults) {
        return `${matches.slice(0, globMaxResults).join("\n")}\n... (truncated at ${globMaxResults} results)`;
      }
      return matches.join("\n");
    }
  };
}

function normalizeArgs(args: unknown): NormalizedGlobArgs {
  if (typeof args === "string") {
    return normalizeRawJSONArgs(args);
  }
  if (args instanceof Uint8Array) {
    return normalizeRawJSONArgs(new TextDecoder().decode(args));
  }
  return normalizeStructuredArgs(args);
}

function normalizeRawJSONArgs(rawText: string): NormalizedGlobArgs {
  const result = new RawGlobArgsUnmarshaller(rawText).unmarshal();
  if (result.kind !== "object" && result.kind !== "null") {
    throw invalidArgs(`json: cannot unmarshal ${result.kind === "bool" ? "bool" : result.kind} into Go value of type ${globArgsGoStructType}`);
  }
  if (result.typeError !== undefined) {
    throw invalidArgs(result.typeError);
  }
  if (result.pattern === "") {
    throw new Error("pattern is required");
  }
  return { pattern: result.pattern };
}

function normalizeStructuredArgs(raw: unknown): NormalizedGlobArgs {
  if (raw === null) {
    raw = {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidArgs(`json: cannot unmarshal ${goJSONTokenKind(raw)} into Go value of type ${globArgsGoStructType}`);
  }

  const value = raw as Record<string, unknown>;
  let pattern = "";
  let firstTypeError: string | undefined;
  for (const key of Object.keys(value)) {
    if (globArgField(key) !== "pattern") {
      continue;
    }
    const fieldValue = value[key];
    if (fieldValue === undefined || fieldValue === null) {
      pattern = "";
      continue;
    }
    if (typeof fieldValue === "string") {
      pattern = replaceIsolatedSurrogates(fieldValue);
      continue;
    }
    firstTypeError ??= goJSONTypeError(fieldValue, "pattern", "string");
  }

  if (firstTypeError !== undefined) {
    throw invalidArgs(firstTypeError);
  }
  if (pattern === "") {
    throw new Error("pattern is required");
  }
  return { pattern };
}

class RawGlobArgsUnmarshaller {
  private pattern = "";
  private firstTypeError: string | undefined;

  constructor(private readonly json: string) {}

  unmarshal(): { kind: RawJSONValueKind; pattern: string; typeError?: string } {
    const kind = new GoRawJSONUnmarshaller(this.json, (key, value) => this.unmarshalKnownField(key, value)).unmarshal();
    return {
      kind,
      pattern: this.pattern,
      typeError: this.firstTypeError
    };
  }

  private unmarshalKnownField(key: string, value: ParsedRawJSONValue): void {
    if (globArgField(key) !== "pattern") {
      return;
    }
    if (value.kind === "null") {
      return;
    }
    if (value.kind === "string") {
      this.pattern = value.stringValue ?? "";
      return;
    }
    this.firstTypeError ??= goJSONTypeError(parsedJSONValueForError(value), "pattern", "string", value.raw);
  }
}

function globArgField(key: string): "pattern" | undefined {
  return key.toLowerCase() === "pattern" ? "pattern" : undefined;
}

async function globRecursive(
  pattern: string,
  displayPattern: string,
  resolved: ResolvedPath | undefined,
  forbidRoots: readonly string[],
  signal: AbortSignal | undefined
): Promise<string> {
  const parts = pattern.split("**");
  let root = parts[0] ?? "";
  if (root === "") {
    root = ".";
  }
  root = path.normalize(root);

  let info;
  try {
    info = await stat(root);
  } catch (error) {
    throw globError(displayPattern, resolved, error);
  }
  if (!info.isDirectory()) {
    return "(no matches)";
  }

  throwIfCanceled(signal);

  const suffix = trimLeadingSeparator(parts.length > 1 ? parts.slice(1).join("**") : "");
  const matches: string[] = [];
  let truncated = false;
  const shouldStop = (): boolean => truncated;

  try {
    for await (const filePath of walkGlobFiles(root, forbidRoots, shouldStop, signal)) {
      throwIfCanceled(signal);
      if (confineRead(forbidRoots, filePath)) {
        continue;
      }
      if (suffix === "" || matchGlobSuffix(path.relative(root, filePath), suffix)) {
        matches.push(filePath);
        if (matches.length >= globMaxResults) {
          truncated = true;
          break;
        }
      }
    }
  } catch (error) {
    if (isContextCanceled(error)) {
      throw globError(displayPattern, resolved, error);
    }
    throw error;
  }

  if (matches.length === 0) {
    return "(no matches)";
  }
  matches.sort(compareUtf8Lexical);
  const displayed = displayGlobMatches(matches, resolved);
  let result = displayed.join("\n");
  if (truncated) {
    result += `\n... (truncated at ${globMaxResults} results)`;
  }
  return result;
}

async function* walkGlobFiles(
  root: string,
  forbidRoots: readonly string[],
  shouldStop: () => boolean,
  signal: AbortSignal | undefined
): AsyncIterable<string> {
  yield* walkGlobDirectory(root, root, forbidRoots, shouldStop, signal);
}

async function* walkGlobDirectory(
  root: string,
  dir: string,
  forbidRoots: readonly string[],
  shouldStop: () => boolean,
  signal: AbortSignal | undefined
): AsyncIterable<string> {
  throwIfCanceled(signal);
  if (shouldStop()) {
    return;
  }

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => compareUtf8Lexical(left.name, right.name));
  for (const entry of entries) {
    throwIfCanceled(signal);
    if (shouldStop()) {
      return;
    }
    const targetPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipGlobWalkDir(root, targetPath, entry.name, forbidRoots)) {
        continue;
      }
      yield* walkGlobDirectory(root, targetPath, forbidRoots, shouldStop, signal);
      continue;
    }
    yield targetPath;
  }
}

function throwIfCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("context canceled");
  }
}

function isContextCanceled(error: unknown): boolean {
  return error instanceof Error && error.message === "context canceled";
}

function skipGlobWalkDir(root: string, dir: string, name: string, forbidRoots: readonly string[]): boolean {
  if (path.resolve(dir) === path.resolve(root)) {
    return false;
  }
  return globVendorDirs.has(name) || isMacOSProtectedDir(dir) || confineRead(forbidRoots, dir);
}

function isMacOSProtectedDir(dir: string): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  const home = os.homedir();
  if (home === "") {
    return false;
  }
  const resolvedDir = path.resolve(dir);
  return macOSProtectedHomeDirNames.some((name) => resolvedDir === path.resolve(home, name));
}

async function globPlain(pattern: string): Promise<string[]> {
  validateGlobPattern(pattern);

  const { root, segments } = splitPattern(pattern);
  let matches = [root];

  for (const segment of segments) {
    const nextMatches: string[] = [];
    const segmentHasMagic = hasGlobMagic(segment);
    for (const current of matches) {
      if (!segmentHasMagic) {
        const candidate = joinGlobPath(current, segment);
        if (await pathExists(candidate)) {
          nextMatches.push(candidate);
        }
        continue;
      }

      let entries: string[];
      try {
        entries = (await readdir(current === "" ? "." : current, { withFileTypes: true })).map((entry) => entry.name);
      } catch {
        continue;
      }
      entries.sort(compareUtf8Lexical);
      for (const entry of entries) {
        if (matchGlobPath(entry, segment)) {
          nextMatches.push(joinGlobPath(current, entry));
        }
      }
    }
    matches = nextMatches;
    if (matches.length === 0) {
      return [];
    }
  }

  return matches;
}

function splitPattern(pattern: string): { root: string; segments: string[] } {
  const parsed = path.parse(pattern);
  const root = parsed.root;
  const rest = root === "" ? pattern : pattern.slice(root.length);
  return {
    root,
    segments: rest.split(/[\\/]+/u).filter((segment) => segment !== "")
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function joinGlobPath(base: string, segment: string): string {
  if (base === "") {
    return segment;
  }
  return path.join(base, segment);
}

function validateGlobPattern(pattern: string): void {
  const { segments } = splitPattern(pattern);
  for (const segment of segments) {
    compileGlobPattern(segment);
  }
}

function filterForbidMatches(matches: string[], forbidRoots: readonly string[]): string[] {
  if (forbidRoots.length === 0 || matches.length === 0) {
    return matches;
  }
  return matches.filter((match) => !confineRead(forbidRoots, match));
}

function displayGlobMatches(matches: readonly string[], resolved: ResolvedPath | undefined): string[] {
  if (resolved === undefined || !resolved.external) {
    return [...matches];
  }
  return matches.map((match) => resolved.displayFor(match));
}

function matchGlobSuffix(filePath: string, pattern: string): boolean {
  if (matchGlobPathIgnoringSyntaxError(filePath, pattern)) {
    return true;
  }

  const parts = filePath.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    if (matchGlobPathIgnoringSyntaxError(parts.slice(index).join(path.sep), pattern)) {
      return true;
    }
  }

  if (!pattern.includes(path.sep) && matchGlobPathIgnoringSyntaxError(path.basename(filePath), pattern)) {
    return true;
  }
  return false;
}

function matchGlobPathIgnoringSyntaxError(targetPath: string, pattern: string): boolean {
  try {
    return matchGlobPath(targetPath, pattern);
  } catch (error) {
    if (error instanceof Error && error.message === "syntax error in pattern") {
      return false;
    }
    throw error;
  }
}

function matchGlobPath(targetPath: string, pattern: string): boolean {
  const regexp = compileGlobPattern(pattern);
  return regexp.test(targetPath);
}

function compileGlobPattern(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; ) {
    const char = pattern[index];
    switch (char) {
      case "*":
        source += "[^/\\\\]*";
        index += 1;
        break;
      case "?":
        source += "[^/\\\\]";
        index += 1;
        break;
      case "[": {
        const parsed = parseGlobClass(pattern, index);
        source += parsed.source;
        index = parsed.nextIndex;
        break;
      }
      case "/":
      case "\\":
        source += "[/\\\\]";
        index += 1;
        break;
      default:
        source += escapeRegexp(char);
        index += char.length;
        break;
    }
  }
  source += "$";
  try {
    return new RegExp(source, "u");
  } catch {
    throw new Error("syntax error in pattern");
  }
}

function parseGlobClass(pattern: string, start: number): { source: string; nextIndex: number } {
  let index = start + 1;
  if (index >= pattern.length) {
    throw new Error("syntax error in pattern");
  }

  let negated = false;
  if (pattern[index] === "^") {
    negated = true;
    index += 1;
  }
  if (index >= pattern.length || pattern[index] === "]") {
    throw new Error("syntax error in pattern");
  }

  let body = "";
  for (; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "]") {
      if (body === "") {
        throw new Error("syntax error in pattern");
      }
      return {
        source: `[${negated ? "^" : ""}${body}]`,
        nextIndex: index + 1
      };
    }
    if (char === "/" || char === "\\") {
      throw new Error("syntax error in pattern");
    }
    body += escapeCharClass(char);
  }
  throw new Error("syntax error in pattern");
}

function hasGlobMagic(segment: string): boolean {
  return /[*?[]/u.test(segment);
}

function globError(displayPattern: string, resolved: ResolvedPath | undefined, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "syntax error in pattern") {
    return new Error(`glob ${JSON.stringify(displayPattern)}: ${message}`);
  }
  if (message === "context canceled") {
    return new Error(`glob ${JSON.stringify(displayPattern)}: ${message}`);
  }
  const fsError = new Error(goStyleFsError(error));
  const errorText = resolved?.errorText(fsError) ?? fsError.message;
  return new Error(`glob ${JSON.stringify(displayPattern)}: ${toSlash(errorText)}`);
}

function trimLeadingSeparator(input: string): string {
  return input.startsWith(path.sep) ? input.slice(path.sep.length) : input;
}

function fromSlash(inputPath: string): string {
  return inputPath.replace(/\//gu, path.sep);
}

function toSlash(inputPath: string): string {
  return inputPath.replace(/\\/gu, "/");
}

function escapeRegexp(char: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(char) ? `\\${char}` : char;
}

function escapeCharClass(char: string): string {
  return /[\\\]^]/u.test(char) ? `\\${char}` : char;
}

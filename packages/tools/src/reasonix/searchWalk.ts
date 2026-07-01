import fs from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { confineRead } from "./pathResolver";

const vendorDirs = new Set([".git", ".svn", ".hg", ".jj", "node_modules", "vendor", ".venv", "__pycache__", ".mypy_cache", ".pytest_cache"]);

export interface WalkSearchFilesOptions {
  shouldStop?: () => boolean;
}

export async function* walkSearchFiles(
  root: string,
  forbidRoots: readonly string[] = [],
  options: WalkSearchFilesOptions = {}
): AsyncIterable<string> {
  const ignorer = new WalkIgnorer(root, forbidRoots);
  yield* walkDirectory(root, ignorer, ignorer.initialPatterns(), options);
}

async function* walkDirectory(
  dir: string,
  ignorer: WalkIgnorer,
  activePatterns: readonly string[],
  options: WalkSearchFilesOptions
): AsyncIterable<string> {
  if (options.shouldStop?.() === true) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  if (options.shouldStop?.() === true) {
    return;
  }

  entries.sort((left, right) => compareUtf8Lexical(left.name, right.name));

  for (const entry of entries) {
    if (options.shouldStop?.() === true) {
      return;
    }

    const targetPath = path.join(dir, entry.name);
    const isDir = entry.isDirectory();
    if (ignorer.skip(targetPath, entry.name, isDir, activePatterns)) {
      continue;
    }
    if (isDir) {
      const childPatterns = ignorer.patternsForChildDirectory(targetPath, activePatterns);
      yield* walkDirectory(targetPath, ignorer, childPatterns, options);
    } else if (entry.isFile()) {
      yield targetPath;
    }
  }
}

class WalkIgnorer {
  private readonly root: string;
  private readonly repoRoot: string;
  private readonly disabled: boolean;
  private readonly basePatterns: string[];
  private readonly compiled = new Map<string, ReturnType<typeof ignore>>();

  constructor(root: string, private readonly forbidRoots: readonly string[]) {
    this.root = absClean(root);
    this.repoRoot = findRepoRoot(this.root);
    this.basePatterns = this.repoRoot === "" ? [] : this.buildInitialPatterns();
    this.disabled = this.repoRoot !== "" && (isHiddenName(path.basename(this.root)) || this.ignored(this.root, true, this.basePatterns));
  }

  initialPatterns(): readonly string[] {
    return this.basePatterns;
  }

  patternsForChildDirectory(dir: string, parentPatterns: readonly string[]): readonly string[] {
    if (this.disabled || this.repoRoot === "") {
      return parentPatterns;
    }
    const lines = reanchorLines(readIgnoreLines(path.join(dir, ".gitignore")), relSlash(this.repoRoot, dir));
    return lines.length === 0 ? parentPatterns : [...parentPatterns, ...lines];
  }

  skip(targetPath: string, name: string, isDir: boolean, activePatterns: readonly string[]): boolean {
    const abs = absClean(targetPath);
    if (abs === this.root || this.disabled) {
      return false;
    }
    if (isHiddenName(name)) {
      return true;
    }
    if (isDir && (vendorDirs.has(name) || confineRead(this.forbidRoots, abs))) {
      return true;
    }
    return this.ignored(abs, isDir, activePatterns);
  }

  private buildInitialPatterns(): string[] {
    const rootLines = [
      ...reanchorLines(readIgnoreLines(globalExcludesFile()), ""),
      ...reanchorLines(readIgnoreLines(path.join(this.repoRoot, ".git", "info", "exclude")), ""),
      ...reanchorLines(readIgnoreLines(path.join(this.repoRoot, ".gitignore")), "")
    ];
    let patterns = rootLines;
    for (const dir of ancestorsBetween(this.repoRoot, this.root)) {
      const lines = reanchorLines(readIgnoreLines(path.join(dir, ".gitignore")), relSlash(this.repoRoot, dir));
      if (lines.length > 0) {
        patterns = [...patterns, ...lines];
      }
    }
    return patterns;
  }

  private ignored(abs: string, isDir: boolean, activePatterns: readonly string[]): boolean {
    if (this.repoRoot === "" || activePatterns.length === 0) {
      return false;
    }
    const rel = relSlash(this.repoRoot, abs);
    if (rel === "" || rel === "." || rel.startsWith("..")) {
      return false;
    }

    const matcher = this.matcher(activePatterns);
    return matcher.ignores(isDir ? `${rel}/` : rel);
  }

  private matcher(patterns: readonly string[]): ReturnType<typeof ignore> {
    const key = patterns.join("\n");
    const cached = this.compiled.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const compiled = ignore().add([...patterns]);
    this.compiled.set(key, compiled);
    return compiled;
  }
}

function reanchorLines(lines: readonly string[], relDir: string): string[] {
  return lines.flatMap((raw) => {
    const line = raw.replace(/[ \t\r]+$/u, "");
    if (line === "" || line.startsWith("#")) {
      return [];
    }
    return [reanchorPattern(line, relDir)];
  });
}

function reanchorPattern(rawLine: string, relDir: string): string {
  let line = rawLine;
  let neg = "";
  if (line.startsWith("!")) {
    neg = "!";
    line = line.slice(1);
  }
  if (line.startsWith("\\")) {
    line = line.slice(1);
  }
  if (relDir === "" || relDir === ".") {
    return `${neg}${line}`;
  }

  const trimmed = line.endsWith("/") ? line.slice(0, -1) : line;
  const anchored = line.startsWith("/") || trimmed.includes("/");
  line = line.replace(/^\/+/u, "");
  return anchored ? `${neg}/${relDir}/${line}` : `${neg}/${relDir}/**/${line}`;
}

function isHiddenName(name: string): boolean {
  return name.length > 1 && name.startsWith(".") && name !== "..";
}

function findRepoRoot(start: string): string {
  let current = absClean(start);
  try {
    if (!fs.statSync(current).isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return "";
    }
    current = parent;
  }
}

function ancestorsBetween(repoRoot: string, root: string): string[] {
  const dirs: string[] = [];
  for (let dir = root; dir !== repoRoot && path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    dirs.push(dir);
  }
  return dirs.reverse();
}

function readIgnoreLines(filePath: string): string[] {
  if (filePath === "") {
    return [];
  }
  try {
    return fs.readFileSync(filePath, "utf8").split("\n");
  } catch {
    return [];
  }
}

function globalExcludesFile(): string {
  const configured = gitConfigExcludesFile();
  if (configured !== "" && statFile(configured)) {
    return configured;
  }

  let base = process.env.XDG_CONFIG_HOME ?? "";
  if (base === "") {
    try {
      base = path.join(osHomeDir(), ".config");
    } catch {
      base = "";
    }
  }
  const candidate = base === "" ? "" : path.join(base, "git", "ignore");
  return candidate !== "" && statFile(candidate) ? candidate : "";
}

function gitConfigExcludesFile(): string {
  for (const configPath of gitConfigPaths()) {
    const excludesFile = scanGitConfigExcludes(configPath);
    if (excludesFile !== "") {
      return expandHome(excludesFile);
    }
  }
  return "";
}

function gitConfigPaths(): string[] {
  if (process.env.GIT_CONFIG_GLOBAL !== undefined && process.env.GIT_CONFIG_GLOBAL !== "") {
    return [process.env.GIT_CONFIG_GLOBAL];
  }

  const home = safeHomeDir();
  const paths: string[] = [];
  const configHome = process.env.XDG_CONFIG_HOME ?? (home === "" ? "" : path.join(home, ".config"));
  if (configHome !== "") {
    paths.push(path.join(configHome, "git", "config"));
  }
  if (home !== "") {
    paths.push(path.join(home, ".gitconfig"));
  }
  return paths;
}

function scanGitConfigExcludes(configPath: string): string {
  let lines: string[];
  try {
    lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/u);
  } catch {
    return "";
  }

  let inCore = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith("[")) {
      const section = line.replace(/^\[|\]$/gu, "").toLowerCase();
      inCore = section.split(/\s+/u)[0] === "core";
      continue;
    }
    if (!inCore) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 0) {
      continue;
    }
    const key = line.slice(0, equals).trim();
    if (key.toLowerCase() !== "excludesfile") {
      continue;
    }
    return line.slice(equals + 1).trim().replace(/^"|"$/gu, "");
  }
  return "";
}

function expandHome(inputPath: string): string {
  if (inputPath === "~" || inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    const home = safeHomeDir();
    if (home !== "") {
      return path.join(home, inputPath.slice(1).replace(/^[/\\]+/u, ""));
    }
  }
  return inputPath;
}

function statFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function safeHomeDir(): string {
  try {
    return osHomeDir();
  } catch {
    return "";
  }
}

function osHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

function absClean(inputPath: string): string {
  return path.resolve(inputPath);
}

function relSlash(base: string, target: string): string {
  return path.relative(base, target).replace(/\\/gu, "/");
}

function compareUtf8Lexical(left: string, right: string): number {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const minLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < minLength; index += 1) {
    const delta = leftBytes[index] - rightBytes[index];
    if (delta !== 0) {
      return delta;
    }
  }
  return leftBytes.length - rightBytes.length;
}

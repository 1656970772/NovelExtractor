import fs from "node:fs";
import path from "node:path";

export class ResolvedPath {
  constructor(
    readonly path: string,
    readonly displayPath: string,
    readonly root: string,
    readonly displayRoot: string,
    readonly external = false
  ) {}

  displayFor(targetPath: string): string {
    if (!this.external) {
      return targetPath;
    }

    const relativePath = path.relative(this.root, targetPath);
    if (!isLocalRelativePath(relativePath)) {
      return targetPath;
    }
    if (relativePath === "") {
      return this.displayRoot;
    }

    return `${this.displayRoot}/${toSlash(relativePath)}`;
  }

  errorText(error: Error): string {
    if (!this.external) {
      return error.message;
    }

    return error.message.split(this.root).join(this.displayRoot);
  }
}

export class PathResolver {
  private readonly roots = new Map<string, string>();

  registerReadRoot(token: string, root: string): void {
    const normalizedToken = normalizeReadToken(token);
    const normalizedRoot = path.normalize(root.trim());
    if (normalizedToken === "" || normalizedRoot === "") {
      return;
    }

    this.roots.set(normalizedToken, normalizedRoot);
  }

  resolve(inputPath: string): ResolvedPath | undefined {
    const key = normalizeReadToken(inputPath);
    if (key === "") {
      return undefined;
    }

    const exactRoot = this.roots.get(key);
    if (exactRoot !== undefined) {
      return new ResolvedPath(exactRoot, key, exactRoot, key, true);
    }

    for (const [token, root] of this.roots) {
      if (!key.startsWith(`${token}/`)) {
        continue;
      }

      const subpath = cleanReadSubpath(key.slice(token.length + 1));
      if (subpath === undefined) {
        return undefined;
      }

      return new ResolvedPath(path.join(root, pathFromSlash(subpath)), `${token}/${subpath}`, root, token, true);
    }

    return undefined;
  }
}

export function resolveInWorkspace(workDir: string, inputPath: string): string {
  if (workDir === "") {
    return inputPath;
  }
  if (inputPath === "" || inputPath === ".") {
    return workDir;
  }
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  return path.join(workDir, inputPath);
}

export function resolveReadablePath(workDir: string, inputPath: string, resolver?: PathResolver): ResolvedPath {
  const resolved = resolver?.resolve(inputPath);
  if (resolved !== undefined) {
    return resolved;
  }

  const resolvedPath = resolveInWorkspace(workDir, inputPath);
  return new ResolvedPath(resolvedPath, resolvedPath, resolvedPath, resolvedPath);
}

export function realRoots(roots: readonly string[]): string[] {
  return roots.flatMap((root) => {
    try {
      return [realPath(root)];
    } catch {
      return [];
    }
  });
}

export function assertWritablePath(roots: readonly string[], targetPath: string): void {
  if (roots.length === 0) {
    return;
  }

  let absolutePath: string;
  try {
    absolutePath = realPath(targetPath);
  } catch (error) {
    throw new Error(`resolve ${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const root of roots) {
    if (within(root, absolutePath)) {
      return;
    }
  }

  throw new Error(
    `path "${targetPath}" is outside the writable roots (writes are confined to ${roots.join(
      ", "
    )}); write inside the workspace or a configured allow_write root, or widen [sandbox] workspace_root / allow_write in reasonix.toml`
  );
}

export function confineRead(forbidRoots: readonly string[], targetPath: string): boolean {
  if (forbidRoots.length === 0) {
    return false;
  }

  let absolutePath: string;
  try {
    absolutePath = realPath(targetPath);
  } catch {
    return false;
  }

  return forbidRoots.some((root) => within(root, absolutePath));
}

export function within(root: string, targetPath: string): boolean {
  const relativePath = path.relative(root, targetPath);
  return isLocalRelativePath(relativePath);
}

export function normalizeReadToken(token: string): string {
  return toSlash(token.trim().replace(/^@/u, "")).replace(/\/+$/u, "");
}

function cleanReadSubpath(subpath: string): string | undefined {
  const slashed = toSlash(subpath.trim());
  const trimmed = slashed.startsWith("/") ? slashed.slice(1) : slashed;
  if (trimmed === "" || trimmed === ".") {
    return ".";
  }

  const cleaned = path.win32.normalize(trimmed.split("/").join("\\"));
  if (cleaned === ".") {
    return ".";
  }
  if (!isLocalWindowsPath(cleaned)) {
    return undefined;
  }

  return toSlash(cleaned);
}

function isLocalWindowsPath(inputPath: string): boolean {
  return (
    !/^[a-zA-Z]:/u.test(inputPath) &&
    !path.win32.isAbsolute(inputPath) &&
    inputPath !== ".." &&
    !inputPath.startsWith("..\\")
  );
}

function realPath(inputPath: string): string {
  const absolutePath = path.resolve(inputPath);
  const cleanPath = path.normalize(absolutePath);
  let tail = "";
  let current = cleanPath;

  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return cleanPath;
      }
      tail = path.join(path.basename(current), tail);
      current = parent;
    }
  }
}

function isLocalRelativePath(relativePath: string): boolean {
  return relativePath === "" || (!path.isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`));
}

function toSlash(inputPath: string): string {
  return inputPath.replace(/\\/gu, "/");
}

function pathFromSlash(inputPath: string): string {
  return inputPath.split("/").join(path.sep);
}

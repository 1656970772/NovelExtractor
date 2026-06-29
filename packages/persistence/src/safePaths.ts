import fs from "node:fs";
import path from "node:path";

export class SafePathError extends Error {
  readonly code = "UNSAFE_PATH";

  constructor(message: string) {
    super(message);
    this.name = "SafePathError";
  }
}

export function createSafeProjectPath(root: string, ...segments: string[]): string {
  if (segments.length === 0) {
    throw new SafePathError("Path must include at least one segment");
  }

  const rootRealPath = fs.realpathSync.native(root);
  const safeSegments = segments.map(validateSegment);
  const candidatePath = path.resolve(rootRealPath, ...safeSegments);

  assertInsideRoot(rootRealPath, candidatePath, "Path is outside project root");
  assertExistingParentInsideRoot(rootRealPath, candidatePath);

  return candidatePath;
}

export function toSafeRelativePath(root: string, target: string): string {
  const rootRealPath = fs.realpathSync.native(root);
  const targetRealPath = fs.realpathSync.native(target);
  assertInsideRoot(rootRealPath, targetRealPath, "Path is outside project root");

  const relativePath = path.relative(rootRealPath, targetRealPath);
  if (relativePath === "") {
    throw new SafePathError("Path must not resolve to project root");
  }

  return relativePath.replace(/\\/g, "/");
}

function validateSegment(segment: string): string {
  const normalized = segment.normalize("NFC");

  if (normalized === "" || normalized === "." || normalized === "..") {
    throw new SafePathError("Path segment must not be empty or dot-only");
  }

  if (/[\0/\\]/u.test(normalized)) {
    throw new SafePathError("Path segment must not contain separators");
  }

  if (/^[A-Za-z]:/u.test(normalized) || path.win32.isAbsolute(normalized) || path.posix.isAbsolute(normalized)) {
    throw new SafePathError("Absolute paths are not allowed");
  }

  return normalized;
}

function assertExistingParentInsideRoot(rootRealPath: string, candidatePath: string): void {
  let existingParent = path.dirname(candidatePath);

  while (!fs.existsSync(existingParent)) {
    assertInsideRoot(rootRealPath, existingParent, "Missing parent escapes project root");
    const nextParent = path.dirname(existingParent);

    if (isSamePath(existingParent, nextParent)) {
      throw new SafePathError("No existing parent found inside project root");
    }

    existingParent = nextParent;
  }

  const parentRealPath = fs.realpathSync.native(existingParent);
  assertInsideRoot(rootRealPath, parentRealPath, "Existing parent escapes project root");
}

function assertInsideRoot(rootRealPath: string, targetPath: string, message: string): void {
  const relativePath = path.relative(rootRealPath, targetPath);

  if (relativePath === "") {
    return;
  }

  const escapesRoot = path.isAbsolute(relativePath) || relativePath.split(path.sep).some((part) => part === "..");
  if (escapesRoot) {
    throw new SafePathError(message);
  }
}

function isSamePath(left: string, right: string): boolean {
  return path.relative(left, right) === "";
}

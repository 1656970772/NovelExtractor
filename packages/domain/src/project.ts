export interface Project {
  id: string;
  displayName: string;
  slug: string;
  rootPath: string;
  createdAt: string;
}

export interface Book {
  id: string;
  projectId: string;
  displayName: string;
  sourceAssetId: string;
  sourceTextPath: string;
  chapterCount: number;
  createdAt: string;
}

export interface Chapter {
  id: string;
  bookId: string;
  index: number;
  title: string;
  textPath: string;
}

export interface ReportAsset {
  id: string;
  bookId: string;
  fileName: string;
  displayName: string;
  reportKind?: "raw-window" | "template-output";
  relativePath: string;
  byteSize: number;
  createdAt: string;
  updatedAt: string;
}

export function createProjectSlug(displayName: string): string {
  const canonicalName = displayName.trim().normalize("NFC");

  if (!canonicalName) {
    throw new Error("Project name must not be blank");
  }

  const readablePart = canonicalName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  const hashPart = hashToBase36(canonicalName);

  if (!readablePart) {
    return `project-${hashPart}`;
  }

  return `project-${readablePart}-${hashPart}`;
}

export function createDefaultBookSourceTextPath(bookId: string): string {
  return `assets/books/${bookId}/source/original.txt`;
}

function hashToBase36(value: string): string {
  let hash = 0x811c9dc5;

  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36).padStart(7, "0");
}

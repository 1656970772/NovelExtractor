import fs from "node:fs/promises";
import path from "node:path";

export type CoverageOutcomeStatus = "written" | "no_update" | "skipped_covered";

export type CoverageIndexCorruptionStrategy = "fail" | "conservative-rerun";

export interface ReportCoverageTarget {
  bookId: string;
  templateId: string;
  outputFileName: string;
  templateHash: string;
  windowHash: string;
  rulesSemanticHash: string;
  submittedChapterRange: string;
}

export interface ReportCoverageRecord extends ReportCoverageTarget {
  status: CoverageOutcomeStatus;
  updatedAt: string;
}

export interface ReportCoverageIndexStore {
  isCovered(target: ReportCoverageTarget): boolean;
  recordCovered(record: ReportCoverageRecord): void;
  records(): ReportCoverageRecord[];
  save(): Promise<void>;
}

interface CoverageIndexFile {
  version: 1;
  records: ReportCoverageRecord[];
}

export interface LoadReportCoverageIndexInput {
  projectRoot: string;
  relativePath: string;
  corruptionStrategy: CoverageIndexCorruptionStrategy;
}

function toCoverageKey(target: ReportCoverageTarget): string {
  return [
    target.bookId,
    target.templateId,
    target.outputFileName,
    target.templateHash,
    target.windowHash,
    target.rulesSemanticHash,
    target.submittedChapterRange
  ].join("\u001f");
}

function assertCoverageFile(value: unknown): asserts value is CoverageIndexFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("coverage index is damaged: root must be an object");
  }

  const candidate = value as Partial<CoverageIndexFile>;
  if (candidate.version !== 1 || !Array.isArray(candidate.records)) {
    throw new Error("coverage index is damaged: invalid version or records");
  }
}

function createStore(indexPath: string, records: ReportCoverageRecord[]): ReportCoverageIndexStore {
  const recordsByKey = new Map(records.map((record) => [toCoverageKey(record), record]));

  return {
    isCovered(target) {
      return recordsByKey.has(toCoverageKey(target));
    },
    recordCovered(record) {
      recordsByKey.set(toCoverageKey(record), { ...record });
    },
    records() {
      return [...recordsByKey.values()].sort((left, right) =>
        toCoverageKey(left).localeCompare(toCoverageKey(right))
      );
    },
    async save() {
      const nextIndex: CoverageIndexFile = {
        version: 1,
        records: this.records()
      };
      const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;

      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      await fs.writeFile(tempPath, `${JSON.stringify(nextIndex, null, 2)}\n`, "utf8");
      await fs.rename(tempPath, indexPath);
    }
  };
}

export async function loadReportCoverageIndex(
  input: LoadReportCoverageIndexInput
): Promise<ReportCoverageIndexStore> {
  const indexPath = path.join(input.projectRoot, input.relativePath);

  try {
    const rawIndex = await fs.readFile(indexPath, "utf8");
    const parsedIndex: unknown = JSON.parse(rawIndex);
    assertCoverageFile(parsedIndex);
    return createStore(indexPath, parsedIndex.records);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createStore(indexPath, []);
    }

    if (input.corruptionStrategy === "conservative-rerun") {
      return createStore(indexPath, []);
    }

    throw new Error("coverage index is damaged", { cause: error });
  }
}

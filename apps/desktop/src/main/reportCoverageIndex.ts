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

const saveLocksByPath = new Map<string, Promise<void>>();

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

async function readCoverageRecords(indexPath: string): Promise<ReportCoverageRecord[]> {
  try {
    const rawIndex = await fs.readFile(indexPath, "utf8");
    const parsedIndex: unknown = JSON.parse(rawIndex);
    assertCoverageFile(parsedIndex);
    return parsedIndex.records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function runWithSaveLock(indexPath: string, action: () => Promise<void>): Promise<void> {
  const previousSave = saveLocksByPath.get(indexPath) ?? Promise.resolve();
  const currentSave = previousSave.catch(() => undefined).then(action);
  saveLocksByPath.set(indexPath, currentSave);
  try {
    await currentSave;
  } finally {
    if (saveLocksByPath.get(indexPath) === currentSave) {
      saveLocksByPath.delete(indexPath);
    }
  }
}

async function readCoverageRecordsForSave(
  indexPath: string,
  corruptionStrategy: CoverageIndexCorruptionStrategy
): Promise<ReportCoverageRecord[]> {
  try {
    return await readCoverageRecords(indexPath);
  } catch (error) {
    if (corruptionStrategy === "conservative-rerun") {
      return [];
    }
    throw error;
  }
}

function createStore(
  indexPath: string,
  records: ReportCoverageRecord[],
  corruptionStrategy: CoverageIndexCorruptionStrategy
): ReportCoverageIndexStore {
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
      await runWithSaveLock(indexPath, async () => {
        const mergedRecordsByKey = new Map(
          (await readCoverageRecordsForSave(indexPath, corruptionStrategy)).map((record) => [
            toCoverageKey(record),
            record
          ])
        );
        for (const record of recordsByKey.values()) {
          mergedRecordsByKey.set(toCoverageKey(record), record);
        }
        recordsByKey.clear();
        for (const [key, record] of mergedRecordsByKey) {
          recordsByKey.set(key, record);
        }

        const nextIndex: CoverageIndexFile = {
          version: 1,
          records: this.records()
        };
        const tempPath = `${indexPath}.${process.pid}.${Date.now()}.${Math.random()
          .toString(36)
          .slice(2)}.tmp`;

        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        await fs.writeFile(tempPath, `${JSON.stringify(nextIndex, null, 2)}\n`, "utf8");
        await fs.rename(tempPath, indexPath);
      });
    }
  };
}

export async function loadReportCoverageIndex(
  input: LoadReportCoverageIndexInput
): Promise<ReportCoverageIndexStore> {
  const indexPath = path.join(input.projectRoot, input.relativePath);

  try {
    return createStore(indexPath, await readCoverageRecords(indexPath), input.corruptionStrategy);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createStore(indexPath, [], input.corruptionStrategy);
    }

    if (input.corruptionStrategy === "conservative-rerun") {
      return createStore(indexPath, [], input.corruptionStrategy);
    }

    throw new Error("coverage index is damaged", { cause: error });
  }
}

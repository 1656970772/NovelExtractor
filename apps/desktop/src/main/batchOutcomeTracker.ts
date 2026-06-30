export type BatchOutcomeStatus = "written" | "no_update" | "skipped_covered" | "failed";

export interface BatchOutcomeTarget {
  templateId: string;
  templateName: string;
  outputFileName: string;
}

export interface BatchOutcome {
  outputFileName: string;
  status: BatchOutcomeStatus;
  reason?: string;
}

export interface BatchOutcomeTracker {
  isComplete(): boolean;
  missingOutputFileNames(): string[];
  outcomes(): BatchOutcome[];
  recordBatchNoUpdate(reason: string): void;
  recordNoUpdate(outputFileName: string, reason: string): void;
  recordWritten(outputFileName: string): void;
}

interface TrackedTarget extends BatchOutcomeTarget {
  normalizedOutputFileName: string;
}

function normalizeOutputFileName(outputFileName: string): string {
  return outputFileName.replace(/\\/g, "/").replace(/^(?:\.\/)+/u, "");
}

export function createBatchOutcomeTracker(targets: readonly BatchOutcomeTarget[]): BatchOutcomeTracker {
  const trackedTargets = targets.map((target) => ({
    ...target,
    normalizedOutputFileName: normalizeOutputFileName(target.outputFileName)
  }));
  const byOutputFileName = new Map<string, TrackedTarget>();
  const outcomesByOutputFileName = new Map<string, BatchOutcome>();

  for (const target of trackedTargets) {
    if (byOutputFileName.has(target.normalizedOutputFileName)) {
      throw new Error(`Duplicate outputFileName in template batch: ${target.outputFileName}`);
    }
    byOutputFileName.set(target.normalizedOutputFileName, target);
  }

  function requireSelectedOutput(outputFileName: string): TrackedTarget {
    const normalizedOutputFileName = normalizeOutputFileName(outputFileName);
    const target = byOutputFileName.get(normalizedOutputFileName);
    if (!target) {
      throw new Error(`Batch outcome target is not selected: ${outputFileName}`);
    }
    return target;
  }

  function recordOutcome(outputFileName: string, outcome: Omit<BatchOutcome, "outputFileName">): void {
    const target = requireSelectedOutput(outputFileName);
    outcomesByOutputFileName.set(target.normalizedOutputFileName, {
      outputFileName: target.outputFileName,
      ...outcome
    });
  }

  return {
    isComplete() {
      return outcomesByOutputFileName.size === byOutputFileName.size;
    },
    missingOutputFileNames() {
      return trackedTargets
        .filter((target) => !outcomesByOutputFileName.has(target.normalizedOutputFileName))
        .map((target) => target.outputFileName);
    },
    outcomes() {
      return trackedTargets.flatMap((target) => {
        const outcome = outcomesByOutputFileName.get(target.normalizedOutputFileName);
        return outcome ? [outcome] : [];
      });
    },
    recordBatchNoUpdate(reason: string) {
      for (const target of trackedTargets) {
        if (!outcomesByOutputFileName.has(target.normalizedOutputFileName)) {
          recordOutcome(target.outputFileName, { status: "no_update", reason });
        }
      }
    },
    recordNoUpdate(outputFileName: string, reason: string) {
      recordOutcome(outputFileName, { status: "no_update", reason });
    },
    recordWritten(outputFileName: string) {
      recordOutcome(outputFileName, { status: "written" });
    }
  };
}

import type { TokenUsage } from "@novel-extractor/jobs";

export class TemplateBatchPipelineAbortError extends Error {
  constructor(message: string, readonly code: "cancelled" | "deleted" | "fatal_config") {
    super(message);
  }
}

export interface TemplateBatchPipelineBatch {
  batchId: string;
  batchIndex: number;
}

export interface TemplateBatchPipelineWindow {
  windowId: string;
}

export interface TemplateBatchPipelineProcessResult {
  completedTemplateTargetCount: number;
  skippedTemplateTargetCount: number;
  executedTemplateTargetCount: number;
  executedWindowElapsedMs?: number;
  usage: TokenUsage;
}

export interface RunTemplateBatchPipelinesInput<
  TBatch extends TemplateBatchPipelineBatch,
  TWindow extends TemplateBatchPipelineWindow
> {
  batches: readonly TBatch[];
  windows: readonly TWindow[];
  retryIntervalMs: number;
  sleep(ms: number): Promise<"elapsed" | "woken">;
  onFatalStop?(error: unknown): void;
  waitForRunPermission?(): Promise<void>;
  shouldAbort?(): TemplateBatchPipelineAbortError | null;
  processWindow(input: { batch: TBatch; window: TWindow; windowIndex: number }): Promise<TemplateBatchPipelineProcessResult>;
  onProgress(progress: {
    batch: TBatch;
    window: TWindow;
    windowIndex: number;
    completedTemplateTargetCount: number;
    skippedTemplateTargetCount: number;
    executedTemplateTargetCount: number;
    executedWindowElapsedMs?: number;
    usage: TokenUsage;
  }): Promise<void> | void;
  onBatchFailure(input: {
    batch: TBatch;
    window: TWindow;
    windowIndex: number;
    error: unknown;
    nextRetryDelayMs: number;
  }): Promise<void> | void;
}

export async function runTemplateBatchPipelines<
  TBatch extends TemplateBatchPipelineBatch,
  TWindow extends TemplateBatchPipelineWindow
>(input: RunTemplateBatchPipelinesInput<TBatch, TWindow>): Promise<void> {
  let abortedError: TemplateBatchPipelineAbortError | null = null;
  let fatalError: unknown;
  let hasFatalError = false;

  function readAbort(): TemplateBatchPipelineAbortError | null {
    return abortedError ?? input.shouldAbort?.() ?? null;
  }

  function rememberAbort(error: TemplateBatchPipelineAbortError): void {
    abortedError ??= error;
  }

  function rememberFatal(error: unknown): void {
    if (!hasFatalError) {
      fatalError = error;
      hasFatalError = true;
      try {
        input.onFatalStop?.(error);
      } catch {
        // Preserve the original fatal error; waking waiters is best-effort.
      }
    }
  }

  function throwIfStopped(): void {
    if (hasFatalError) {
      throw fatalError;
    }
    const error = readAbort();
    if (error) {
      throw error;
    }
  }

  async function waitForRunPermission(): Promise<void> {
    await input.waitForRunPermission?.();
    throwIfStopped();
  }

  async function runBatch(batch: TBatch): Promise<void> {
    try {
      for (let windowIndex = 0; windowIndex < input.windows.length; windowIndex += 1) {
        throwIfStopped();
        await waitForRunPermission();

        const window = input.windows[windowIndex];
        while (true) {
          throwIfStopped();
          let result: TemplateBatchPipelineProcessResult;
          try {
            result = await input.processWindow({ batch, window, windowIndex });
          } catch (error) {
            if (error instanceof TemplateBatchPipelineAbortError) {
              rememberAbort(error);
              return;
            }

            await input.onBatchFailure({
              batch,
              window,
              windowIndex,
              error,
              nextRetryDelayMs: input.retryIntervalMs
            });
            throwIfStopped();

            const sleepResult = await input.sleep(input.retryIntervalMs);
            throwIfStopped();
            if (sleepResult === "woken") {
              await waitForRunPermission();
            }
            continue;
          }

          await input.onProgress({
            batch,
            window,
            windowIndex,
            completedTemplateTargetCount: result.completedTemplateTargetCount,
            skippedTemplateTargetCount: result.skippedTemplateTargetCount,
            executedTemplateTargetCount: result.executedTemplateTargetCount,
            executedWindowElapsedMs: result.executedWindowElapsedMs,
            usage: result.usage
          });
          throwIfStopped();
          break;
        }
      }
    } catch (error) {
      if (error instanceof TemplateBatchPipelineAbortError) {
        rememberAbort(error);
        return;
      }
      rememberFatal(error);
      throw error;
    }
  }

  const workerResults = await Promise.allSettled(input.batches.map((batch) => runBatch(batch)));
  if (hasFatalError) {
    throw fatalError;
  }
  if (abortedError) {
    throw abortedError;
  }

  const failedWorker = workerResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failedWorker) {
    throw failedWorker.reason;
  }
}

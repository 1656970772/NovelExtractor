export type TemplateBatchSplitReason = "complete" | "maxTemplatesPerCall";

export interface TemplateBatchPlannerTemplate {
  id: string;
  name: string;
  fileName: string;
}

export interface TemplateBatch<TTemplate extends TemplateBatchPlannerTemplate> {
  templates: TTemplate[];
  splitReason: TemplateBatchSplitReason;
}

export interface PlanTemplateBatchesInput<TTemplate extends TemplateBatchPlannerTemplate> {
  maxTemplatesPerCall: number;
  templates: readonly TTemplate[];
}

function toBatchSize(maxTemplatesPerCall: number): number {
  return Math.max(1, Math.floor(maxTemplatesPerCall));
}

export function planTemplateBatches<TTemplate extends TemplateBatchPlannerTemplate>(
  input: PlanTemplateBatchesInput<TTemplate>
): Array<TemplateBatch<TTemplate>> {
  const batchSize = toBatchSize(input.maxTemplatesPerCall);
  const batchCount = Math.ceil(input.templates.length / batchSize);
  const batches: Array<TemplateBatch<TTemplate>> = [];

  if (batchCount === 0) {
    return batches;
  }

  const baseBatchSize = Math.floor(input.templates.length / batchCount);
  const largerBatchCount = input.templates.length % batchCount;
  let startIndex = 0;

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    const currentBatchSize = baseBatchSize + (batchIndex < largerBatchCount ? 1 : 0);
    const endIndex = startIndex + currentBatchSize;
    batches.push({
      templates: input.templates.slice(startIndex, endIndex),
      splitReason: batchIndex === batchCount - 1 ? "complete" : "maxTemplatesPerCall"
    });
    startIndex = endIndex;
  }

  return batches;
}

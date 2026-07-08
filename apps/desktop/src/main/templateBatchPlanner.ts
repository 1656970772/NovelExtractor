export type TemplateBatchSplitReason = "complete" | "maxTemplatesPerCall";

export interface TemplateBatchPlannerTemplate {
  id: string;
  name: string;
  fileName: string;
}

export interface TemplateBatch<TTemplate extends TemplateBatchPlannerTemplate> {
  batchId: string;
  batchIndex: number;
  templates: TTemplate[];
  splitReason: TemplateBatchSplitReason;
}

export interface PlanTemplateBatchesInput<TTemplate extends TemplateBatchPlannerTemplate> {
  maxTemplatesPerCall: number;
  templates: readonly TTemplate[];
}

function toBatchSize(maxTemplatesPerCall: number): number {
  if (!Number.isFinite(maxTemplatesPerCall) || maxTemplatesPerCall <= 0) {
    return 1;
  }

  return Math.max(1, Math.floor(maxTemplatesPerCall));
}

function toBatchId(batchIndex: number): string {
  return `batch-${String(batchIndex + 1).padStart(4, "0")}`;
}

export function planTemplateBatches<TTemplate extends TemplateBatchPlannerTemplate>(
  input: PlanTemplateBatchesInput<TTemplate>
): Array<TemplateBatch<TTemplate>> {
  const batchSize = toBatchSize(input.maxTemplatesPerCall);
  const batches: Array<TemplateBatch<TTemplate>> = [];

  for (let startIndex = 0; startIndex < input.templates.length; startIndex += batchSize) {
    const batchIndex = batches.length;
    const endIndex = startIndex + batchSize;
    batches.push({
      batchId: toBatchId(batchIndex),
      batchIndex,
      templates: input.templates.slice(startIndex, endIndex),
      splitReason: endIndex >= input.templates.length ? "complete" : "maxTemplatesPerCall"
    });
  }

  return batches;
}

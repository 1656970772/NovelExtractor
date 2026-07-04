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
  const batches: Array<TemplateBatch<TTemplate>> = [];
  let currentTemplates: TTemplate[] = [];

  function flush(splitReason: TemplateBatchSplitReason): void {
    if (currentTemplates.length === 0) {
      return;
    }
    batches.push({
      templates: currentTemplates,
      splitReason
    });
    currentTemplates = [];
  }

  for (const template of input.templates) {
    currentTemplates.push(template);

    if (currentTemplates.length >= batchSize) {
      flush("maxTemplatesPerCall");
    }
  }

  if (currentTemplates.length > 0) {
    flush("complete");
  } else if (batches.length > 0 && batches.at(-1)?.splitReason === "maxTemplatesPerCall") {
    batches[batches.length - 1] = {
      ...batches[batches.length - 1],
      splitReason: "complete"
    };
  }

  return batches;
}

export type TemplateBatchSplitReason = "budget" | "complete" | "maxTemplatesPerCall";

export interface TemplateBatchPlannerTemplate {
  id: string;
  name: string;
  fileName: string;
  body?: string;
  promptChars?: number;
}

export interface TemplateBatch<TTemplate extends TemplateBatchPlannerTemplate> {
  templates: TTemplate[];
  splitReason: TemplateBatchSplitReason;
}

export interface PlanTemplateBatchesInput<TTemplate extends TemplateBatchPlannerTemplate> {
  maxTemplatesPerCall: number;
  promptBudgetChars?: number;
  templates: readonly TTemplate[];
}

function toBatchSize(maxTemplatesPerCall: number): number {
  return Math.max(1, Math.floor(maxTemplatesPerCall));
}

function estimatePromptChars(template: TemplateBatchPlannerTemplate): number {
  return template.promptChars ?? template.body?.length ?? 0;
}

export function planTemplateBatches<TTemplate extends TemplateBatchPlannerTemplate>(
  input: PlanTemplateBatchesInput<TTemplate>
): Array<TemplateBatch<TTemplate>> {
  const batchSize = toBatchSize(input.maxTemplatesPerCall);
  const promptBudgetChars = input.promptBudgetChars;
  const batches: Array<TemplateBatch<TTemplate>> = [];
  let currentTemplates: TTemplate[] = [];
  let currentPromptChars = 0;

  function flush(splitReason: TemplateBatchSplitReason): void {
    if (currentTemplates.length === 0) {
      return;
    }
    batches.push({
      templates: currentTemplates,
      splitReason
    });
    currentTemplates = [];
    currentPromptChars = 0;
  }

  for (const template of input.templates) {
    const nextPromptChars = estimatePromptChars(template);
    const wouldExceedBudget =
      promptBudgetChars !== undefined &&
      currentTemplates.length > 0 &&
      currentPromptChars + nextPromptChars > promptBudgetChars;
    if (wouldExceedBudget) {
      flush("budget");
    }

    currentTemplates.push(template);
    currentPromptChars += nextPromptChars;

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

import type { MiniMaxTokenPlanWaitDefaults } from "@novel-extractor/config";
import type { ApiKeyRef } from "@novel-extractor/domain";
import type { FetchLike } from "@novel-extractor/llm";

export interface MiniMaxTokenPlanWaitContext {
  apiKeyRef?: ApiKeyRef;
  baseUrl: string;
  modelId: string;
  presetId?: string;
  providerConfigId: string;
}

export interface MiniMaxTokenPlanWaitGate {
  getRemainingDelayMs(context: MiniMaxTokenPlanWaitContext): number | undefined;
  recordFailure(
    context: MiniMaxTokenPlanWaitContext,
    error: unknown
  ): Promise<number | undefined>;
}

export interface MiniMaxTokenPlanWaitGateOptions {
  defaults: MiniMaxTokenPlanWaitDefaults;
  fetch?: FetchLike;
  now?: () => number;
  resolveApiKey(ref: ApiKeyRef): Promise<string | null | undefined> | string | null | undefined;
}

interface TokenPlanRemainRecord {
  model_name?: unknown;
  end_time?: unknown;
  remains_time?: unknown;
  current_interval_total_count?: unknown;
  current_interval_usage_count?: unknown;
  current_interval_remaining_percent?: unknown;
  current_interval_status?: unknown;
}

function stringifyForMatching(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function matchesExhaustedFailure(
  error: unknown,
  fragments: readonly string[]
): boolean {
  const errorRecord =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const text = `${error instanceof Error ? error.message : stringifyForMatching(error)}\n${stringifyForMatching(
    errorRecord?.details
  )}`.toLocaleLowerCase();
  return fragments.some((fragment) => text.includes(fragment.toLocaleLowerCase()));
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isExhausted(record: TokenPlanRemainRecord): boolean {
  const status = asFiniteNumber(record.current_interval_status);
  if (status === 2) {
    return true;
  }

  const total = asFiniteNumber(record.current_interval_total_count);
  const usage = asFiniteNumber(record.current_interval_usage_count);
  if (total !== undefined && total > 0 && usage !== undefined && usage >= total) {
    return true;
  }

  return asFiniteNumber(record.current_interval_remaining_percent) === 0;
}

function quotaDelayMs(record: TokenPlanRemainRecord, now: number): number | undefined {
  const remainsTime = asFiniteNumber(record.remains_time);
  if (remainsTime !== undefined && remainsTime >= 0) {
    return remainsTime;
  }

  const endTime = asFiniteNumber(record.end_time);
  if (endTime !== undefined && endTime > now) {
    return endTime - now;
  }

  return undefined;
}

function asRemainRecords(value: unknown): TokenPlanRemainRecord[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const records = (value as { model_remains?: unknown }).model_remains;
  return Array.isArray(records)
    ? records.filter(
        (record): record is TokenPlanRemainRecord =>
          record !== null && typeof record === "object" && !Array.isArray(record)
      )
    : [];
}

function createQuotaEndpoint(baseUrl: string, endpointPath: string): string | undefined {
  try {
    return new URL(endpointPath, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function waitKey(context: MiniMaxTokenPlanWaitContext): string | undefined {
  return context.apiKeyRef
    ? `${context.providerConfigId}:${context.apiKeyRef.id}`
    : undefined;
}

export function createMiniMaxTokenPlanWaitGate(
  options: MiniMaxTokenPlanWaitGateOptions
): MiniMaxTokenPlanWaitGate {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const blockedUntilByKey = new Map<string, number>();
  const pendingProbeByKey = new Map<string, Promise<number | undefined>>();
  const textQuotaPatterns = options.defaults.textQuotaModelNamePatterns.map(
    (pattern) => new RegExp(pattern, "iu")
  );

  function supportsContext(context: MiniMaxTokenPlanWaitContext): boolean {
    return (
      options.defaults.enabled &&
      context.presetId !== undefined &&
      options.defaults.providerPresetIds.includes(context.presetId)
    );
  }

  function getRemainingDelayMs(context: MiniMaxTokenPlanWaitContext): number | undefined {
    if (!supportsContext(context)) {
      return undefined;
    }
    const key = waitKey(context);
    if (!key) {
      return undefined;
    }
    const blockedUntil = blockedUntilByKey.get(key);
    if (blockedUntil === undefined) {
      return undefined;
    }
    const remaining = Math.ceil(blockedUntil - now());
    if (remaining <= 0) {
      blockedUntilByKey.delete(key);
      return undefined;
    }
    return remaining;
  }

  async function probe(context: MiniMaxTokenPlanWaitContext, key: string): Promise<number | undefined> {
    const endpoint = createQuotaEndpoint(context.baseUrl, options.defaults.quotaEndpointPath);
    if (!endpoint || !context.apiKeyRef) {
      return undefined;
    }
    const apiKey = await options.resolveApiKey(context.apiKeyRef);
    if (!apiKey) {
      return undefined;
    }

    try {
      const response = await fetchImpl(endpoint, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        method: "GET"
      });
      if (!response.ok) {
        return undefined;
      }
      const records = asRemainRecords(await response.json());
      const textRecords = records.filter(
        (record) =>
          typeof record.model_name === "string" &&
          textQuotaPatterns.some((pattern) => pattern.test(record.model_name as string))
      );
      const candidates = textRecords.length > 0 ? textRecords : records.filter(isExhausted);
      const exhaustedCandidates = candidates.filter(isExhausted);
      const selectable = exhaustedCandidates.length > 0 ? exhaustedCandidates : candidates;
      const currentTime = now();
      const delay = selectable
        .map((record) => quotaDelayMs(record, currentTime))
        .filter((value): value is number => value !== undefined)
        .sort((left, right) => left - right)[0];
      if (delay === undefined) {
        return undefined;
      }
      const retryDelay = Math.max(0, delay) + options.defaults.retrySafetyBufferMs;
      blockedUntilByKey.set(key, currentTime + retryDelay);
      return retryDelay;
    } catch {
      return undefined;
    }
  }

  return {
    getRemainingDelayMs,
    async recordFailure(context, error) {
      if (
        !supportsContext(context) ||
        !matchesExhaustedFailure(error, options.defaults.exhaustedMessageFragments)
      ) {
        return undefined;
      }
      const existingDelay = getRemainingDelayMs(context);
      if (existingDelay !== undefined) {
        return existingDelay;
      }
      const key = waitKey(context);
      if (!key) {
        return undefined;
      }
      const pendingProbe = pendingProbeByKey.get(key);
      if (pendingProbe) {
        return pendingProbe;
      }
      const nextProbe = probe(context, key).finally(() => {
        pendingProbeByKey.delete(key);
      });
      pendingProbeByKey.set(key, nextProbe);
      return nextProbe;
    }
  };
}

export interface LlmFailureClassification {
  reason: string;
  switchable: boolean;
}

export function classifyLlmFailure(error: unknown): LlmFailureClassification {
  const message = toSafeErrorMessage(error);
  const httpStatus = parseHttpStatus(message);
  const errorText = extractHttpErrorText(message) ?? message;
  const normalized = errorText.toLowerCase();
  const switchable =
    httpStatus === 429 ||
    /rate limit|too many requests|quota|insufficient[_\s-]?quota|额度不足|余额不足|限流|请求过多/u.test(
      normalized
    );

  return {
    reason: message,
    switchable
  };
}

function toSafeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseHttpStatus(message: string): number | undefined {
  const match = /OpenAI-compatible request failed with HTTP\s+(\d{3})/u.exec(message);
  if (!match) {
    return undefined;
  }

  return Number.parseInt(match[1], 10);
}

function extractHttpErrorText(message: string): string | undefined {
  const marker = ": ";
  const markerIndex = message.indexOf(marker);
  if (!message.startsWith("OpenAI-compatible request failed with HTTP") || markerIndex < 0) {
    return undefined;
  }

  const rawBody = message.slice(markerIndex + marker.length);
  try {
    return collectErrorText(JSON.parse(rawBody)).join("\n");
  } catch {
    return rawBody;
  }
}

function collectErrorText(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const fragments: string[] = [];
  const error = record.error;

  if (error && typeof error === "object" && !Array.isArray(error)) {
    const errorRecord = error as Record<string, unknown>;
    fragments.push(...stringFields(errorRecord, ["message", "code", "type"]));
  }

  fragments.push(...stringFields(record, ["message", "code", "type"]));
  return fragments;
}

function stringFields(record: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields
    .map((field) => record[field])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

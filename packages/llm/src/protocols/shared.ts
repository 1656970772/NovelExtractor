export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function parseProtocolToolArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return parseEmptyObjectPrefixedJsonObject(value) ?? value;
  }
}

function parseEmptyObjectPrefixedJsonObject(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{}")) {
    return undefined;
  }

  const suffix = trimmed.slice(2).trimStart();
  if (!suffix.startsWith("{")) {
    return undefined;
  }

  try {
    return JSON.parse(suffix);
  } catch {
    return undefined;
  }
}

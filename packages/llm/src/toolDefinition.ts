export type JsonSchemaValue =
  | string
  | number
  | boolean
  | null
  | JsonSchemaValue[]
  | { [key: string]: JsonSchemaValue };

export type JsonObject = { [key: string]: JsonSchemaValue };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
}

export interface ProviderToolSource {
  name: string;
  description: string;
  parameters?: unknown;
  outputSchema?: unknown;
}

const EMPTY_OBJECT_SCHEMA: JsonObject = {
  type: "object",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return asRecord(value) !== undefined;
}

export function normalizeInputSchema(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    return { ...EMPTY_OBJECT_SCHEMA };
  }

  return stableJsonValue(value) as JsonObject;
}

export function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }

  const record = asRecord(value);
  if (!record) {
    return value;
  }

  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = stableJsonValue(record[key]);
      return result;
    }, {});
}

export function encodeToolArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(stableJsonValue(value)) ?? "";
}

export function toToolDefinition(tool: ProviderToolSource): ToolDefinition {
  const outputSchema = stableJsonValue(tool.outputSchema);

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: normalizeInputSchema(tool.parameters),
    ...(isJsonObject(outputSchema) ? { outputSchema } : {}),
  };
}

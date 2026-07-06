export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
}

export interface ToolDefinitionInput {
  name: string;
  description?: string;
  parameters?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

const EMPTY_OBJECT_SCHEMA: JsonObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return asRecord(value) !== undefined;
}

function inputSchemaOrFallback(value: unknown): JsonObject {
  const record = asRecord(value);
  if (record?.type !== "object") {
    return { ...EMPTY_OBJECT_SCHEMA };
  }

  return stableJsonValue(record) as JsonObject;
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

export function toToolDefinition(input: ToolDefinitionInput): ToolDefinition {
  const outputSchema = stableJsonValue(input.outputSchema);

  return {
    name: input.name,
    description: input.description ?? "",
    inputSchema: inputSchemaOrFallback(input.inputSchema ?? input.parameters),
    ...(isJsonObject(outputSchema) ? { outputSchema } : {}),
  };
}

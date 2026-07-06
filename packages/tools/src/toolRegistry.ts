import type { BuiltinToolName } from "./toolPolicy";
import { classifyToolEffects } from "./toolPolicy";
import { Workspace } from "./reasonix/workspace";

export interface JsonSchema {
  type: "object" | "array" | "string" | "number" | "boolean" | "integer";
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ToolSchema {
  name: BuiltinToolName;
  description: string;
  parameters: unknown;
}

export interface ToolDefinitionSource {
  name: BuiltinToolName;
  description: string;
  inputSchema: unknown;
}

export interface ToolValidationError {
  path: string;
  message: string;
}

const stringSchema = (description: string): JsonSchema => ({ type: "string", description });

const MARK_NO_UPDATE_TOOL: ToolSchema = {
  name: "mark_no_update",
  description: "Record that a selected report has no new information for the current window without writing a report file.",
  parameters: {
    type: "object",
    properties: {
      path: stringSchema("Selected report file name under the reports root."),
      reason: stringSchema("Short reason why the current window has no new information for this report.")
    },
    required: ["path", "reason"],
    additionalProperties: false
  }
};

const BUILTIN_TOOLS = new Map<string, ToolSchema>([
  ...new Workspace().tools().map((tool) => [
    tool.name,
    {
      name: tool.name as BuiltinToolName,
      description: tool.description(),
      parameters: tool.schema()
    } satisfies ToolSchema
  ] as const),
  ["mark_no_update", MARK_NO_UPDATE_TOOL]
]);

export function getEnabledTools(enabledNames: string[]): ToolSchema[] {
  for (const name of enabledNames) {
    classifyToolEffects(name);
  }

  return enabledNames.map((name) => {
    const tool = BUILTIN_TOOLS.get(name);
    if (tool === undefined) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool;
  });
}

export function getEnabledToolDefinitions(enabledNames: string[]): ToolDefinitionSource[] {
  return getEnabledTools(enabledNames).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters
  }));
}

export function validateToolArguments(schema: unknown, value: unknown): ToolValidationError[] {
  return validateJsonSchemaValue(schema, value, "$");
}

function validateJsonSchemaValue(schema: unknown, value: unknown, path: string): ToolValidationError[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }

  const record = schema as Record<string, unknown>;
  const type = record.type;

  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return [{ path, message: "必须是对象" }];
    }

    const valueRecord = value as Record<string, unknown>;
    const required = stringArray(record.required);
    const properties = objectRecord(record.properties);
    const missing = required
      .filter((key) => !(key in valueRecord))
      .map((key) => ({ path: `${path}.${key}`, message: "缺少必填字段" }));
    const extra =
      record.additionalProperties === false
        ? Object.keys(valueRecord)
            .filter((key) => !(key in properties))
            .map((key) => ({ path: `${path}.${key}`, message: "不允许额外字段" }))
        : [];
    const nested = Object.entries(properties).flatMap(([key, childSchema]) =>
      key in valueRecord ? validateJsonSchemaValue(childSchema, valueRecord[key], `${path}.${key}`) : []
    );

    return [...missing, ...extra, ...nested];
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      return [{ path, message: "必须是数组" }];
    }

    const minItems = typeof record.minItems === "number" ? record.minItems : undefined;
    const lengthErrors =
      minItems !== undefined && value.length < minItems
        ? [{ path, message: `数组长度不能少于 ${minItems}` }]
        : [];
    const itemErrors = value.flatMap((item, index) => validateJsonSchemaValue(record.items, item, `${path}[${index}]`));

    return [...lengthErrors, ...itemErrors];
  }

  if (type === "string") {
    return typeof value === "string" ? [] : [{ path, message: "必须是字符串" }];
  }

  if (type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return [{ path, message: "必须是整数" }];
    }

    return validateNumberBounds(record, value, path);
  }

  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return [{ path, message: "必须是数字" }];
    }

    return validateNumberBounds(record, value, path);
  }

  if (type === "boolean") {
    return typeof value === "boolean" ? [] : [{ path, message: "必须是布尔值" }];
  }

  return [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function validateNumberBounds(
  schema: Record<string, unknown>,
  value: number,
  path: string
): ToolValidationError[] {
  const minimum = typeof schema.minimum === "number" ? schema.minimum : undefined;
  const maximum = typeof schema.maximum === "number" ? schema.maximum : undefined;

  return [
    ...(minimum !== undefined && value < minimum ? [{ path, message: `不能小于 ${minimum}` }] : []),
    ...(maximum !== undefined && value > maximum ? [{ path, message: `不能大于 ${maximum}` }] : [])
  ];
}

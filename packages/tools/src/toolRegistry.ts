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

import type { BuiltinToolName } from "./toolPolicy";
import { classifyToolEffects } from "./toolPolicy";

export interface JsonSchema {
  type: "object" | "array" | "string" | "number" | "boolean" | "integer";
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSchema {
  name: BuiltinToolName;
  description: string;
  parameters: JsonSchema;
}

const stringSchema = (description: string): JsonSchema => ({ type: "string", description });

const editSchema: JsonSchema = {
  type: "object",
  properties: {
    oldText: stringSchema("Exact text to replace."),
    newText: stringSchema("Replacement text.")
  },
  required: ["oldText", "newText"],
  additionalProperties: false
};

const BUILTIN_TOOLS: ToolSchema[] = [
  {
    name: "ls",
    description: "List files or directories under the project root.",
    parameters: {
      type: "object",
      properties: {
        path: stringSchema("Project-relative directory path.")
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file under the project root.",
    parameters: {
      type: "object",
      properties: {
        path: stringSchema("Project-relative file path.")
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "grep",
    description: "Search UTF-8 text files under the project root.",
    parameters: {
      type: "object",
      properties: {
        path: stringSchema("Project-relative file or directory path."),
        pattern: stringSchema("Literal text pattern to search for.")
      },
      required: ["path", "pattern"],
      additionalProperties: false
    }
  },
  {
    name: "write_file",
    description: "Create a new Markdown report file under the reports root.",
    parameters: {
      type: "object",
      properties: {
        path: stringSchema("Report file name under the reports root."),
        content: stringSchema("Complete Markdown report content.")
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  },
  {
    name: "edit_file",
    description: "Replace the first exact text occurrence in a Markdown report.",
    parameters: {
      type: "object",
      properties: {
        path: stringSchema("Report file name under the reports root."),
        oldText: stringSchema("Exact text to replace."),
        newText: stringSchema("Replacement text.")
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false
    }
  },
  {
    name: "multi_edit",
    description: "Apply ordered exact text replacements to a Markdown report.",
    parameters: {
      type: "object",
      properties: {
        path: stringSchema("Report file name under the reports root."),
        edits: {
          type: "array",
          description: "Ordered replacements.",
          items: editSchema
        }
      },
      required: ["path", "edits"],
      additionalProperties: false
    }
  }
];

export function getEnabledTools(enabledNames: string[]): ToolSchema[] {
  const enabled = new Set(enabledNames);
  for (const name of enabled) {
    classifyToolEffects(name);
  }

  return BUILTIN_TOOLS.filter((tool) => enabled.has(tool.name));
}

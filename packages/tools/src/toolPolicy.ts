export type ToolEffect = "read" | "write";

const TOOL_EFFECTS = {
  ls: "read",
  read_file: "read",
  grep: "read",
  write_file: "write",
  edit_file: "write",
  multi_edit: "write"
} as const;

export type BuiltinToolName = keyof typeof TOOL_EFFECTS;

export function classifyToolEffects(name: string): ToolEffect {
  const effect = TOOL_EFFECTS[name as BuiltinToolName];
  if (effect === undefined) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return effect;
}

export function isReadTool(name: string): boolean {
  return classifyToolEffects(name) === "read";
}

export function isWriteTool(name: string): boolean {
  return classifyToolEffects(name) === "write";
}

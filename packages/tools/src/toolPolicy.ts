export type ToolEffect = "read" | "write" | "state";

const TOOL_EFFECTS = {
  read_file: "read",
  read_report_excerpt: "read",
  grep: "read",
  glob: "read",
  ls: "read",
  bash_output: "read",
  wait: "read",
  write_file: "write",
  edit_file: "write",
  multi_edit: "write",
  upsert_report_section: "write",
  bash: "write",
  kill_shell: "write",
  mark_no_update: "state"
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

import path from "node:path";
import { describe, expect, it } from "vitest";

const reasonixOrder = [
  "bash",
  "bash_output",
  "edit_file",
  "glob",
  "grep",
  "kill_shell",
  "ls",
  "multi_edit",
  "read_file",
  "wait",
  "write_file"
];

interface ReasonixToolDefinitionForTest {
  name: string;
  description(): string;
  schema(): unknown;
  readOnly(): boolean;
}

describe("Reasonix workspace parity", () => {
  it("exposes the configured desktop Reasonix tools in Reasonix Go name-sorted order", async () => {
    const { Workspace } = await import("./workspace");
    const workspace = new Workspace({ dir: path.resolve("C:\\tmp", "project") });

    expect(workspace.tools().map((tool: { name: string }) => tool.name)).toEqual(reasonixOrder);
  });

  it("filters enabled tools by Reasonix Go name-sorted order and ignores unknown names", async () => {
    const { Workspace } = await import("./workspace");
    const workspace = new Workspace({ dir: path.resolve("C:\\tmp", "project") });

    expect(workspace.tools(["wait", "bash", "read_file", "todo_write", "grep", "kill_shell"]).map((tool: { name: string }) => tool.name)).toEqual([
      "bash",
      "grep",
      "kill_shell",
      "read_file",
      "wait"
    ]);
  });

  it("uses enabledTools from workspace config when no explicit enabled list is supplied", async () => {
    const { Workspace } = await import("./workspace");
    const workspace = new Workspace({
      dir: path.resolve("C:\\tmp", "project"),
      enabledTools: ["ls", "read_file"]
    });

    expect(workspace.tools().map((tool: { name: string }) => tool.name)).toEqual(["ls", "read_file"]);
  });

  it("defaults bash foreground timeout to Reasonix zero and preserves explicit configuration", async () => {
    const { Workspace } = await import("./workspace");

    expect(new Workspace().bashTimeoutSeconds).toBe(0);
    expect(new Workspace({ bashTimeoutSeconds: 0.25 }).bashTimeoutSeconds).toBe(0.25);
  });

  it("defaults writable roots to the workspace dir and preserves injected config", async () => {
    const { Workspace } = await import("./workspace");
    const dir = path.resolve("C:\\tmp", "project");
    const explicitWriteRoot = path.resolve("C:\\tmp", "writes");
    const forbidReadRoot = path.resolve("C:\\tmp", "secret");
    const workspace = new Workspace({
      dir,
      writeRoots: [explicitWriteRoot],
      forbidReadRoots: [forbidReadRoot],
      search: { rgPath: "C:\\tools\\rg.exe" },
      shell: { kind: "powershell", supportsChaining: false, path: "powershell.exe" }
    });
    const defaultWorkspace = new Workspace({ dir });

    expect(defaultWorkspace.writeRoots).toEqual([dir]);
    expect(workspace.writeRoots).toEqual([explicitWriteRoot]);
    expect(workspace.forbidReadRoots).toEqual([forbidReadRoot]);
    expect(workspace.search).toEqual({ rgPath: "C:\\tools\\rg.exe" });
    expect(workspace.shell).toEqual({ kind: "powershell", supportsChaining: false, path: "powershell.exe" });
  });

  it("keeps provider-visible schemas stable across roots and read aliases", async () => {
    const { Registry, Workspace, PathResolver } = await import("./index");
    const first = new Workspace({ dir: path.resolve("C:\\tmp", "first") });
    const second = new Workspace({ dir: path.resolve("C:\\tmp", "second") });
    const resolver = new PathResolver();
    resolver.registerReadRoot("__reasonix_external_folder/schema/root", path.resolve("C:\\external", "schema"));
    const withResolver = new Workspace({ dir: path.resolve("C:\\tmp", "first"), readPaths: resolver });

    expect(schemaJSON(first)).toBe(schemaJSON(second));
    expect(schemaJSON(first)).toBe(schemaJSON(withResolver));

    function schemaJSON(workspace: { tools: () => ReasonixToolDefinitionForTest[] }) {
      const registry = new Registry();
      for (const tool of workspace.tools()) {
        registry.add(tool);
      }
      return JSON.stringify(registry.schemas());
    }
  });

  it("defines Reasonix model-visible schemas and read-only flags for the configured tools", async () => {
    const { Workspace } = await import("./workspace");
    const tools = Object.fromEntries(new Workspace({}).tools().map((tool: ReasonixToolDefinitionForTest) => [tool.name, tool])) as Record<
      string,
      ReasonixToolDefinitionForTest
    >;

    expect(tools.read_file.readOnly()).toBe(true);
    expect(tools.write_file.readOnly()).toBe(false);
    expect(tools.grep.readOnly()).toBe(true);
    expect(tools.bash.readOnly()).toBe(false);
    expect(tools.bash_output.readOnly()).toBe(true);
    expect(tools.wait.readOnly()).toBe(true);
    expect(tools.kill_shell.readOnly()).toBe(false);
    expect(tools.read_file.schema()).toMatchObject({
      type: "object",
      required: ["path"],
      properties: {
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1 }
      }
    });
    expect(tools.edit_file.schema()).toMatchObject({
      required: ["path", "old_string", "new_string"],
      properties: {
        old_string: { type: "string" },
        new_string: { type: "string" }
      }
    });
    const multiEditSchema = tools.multi_edit.schema() as { properties: { edits: { items: unknown } } };
    expect(multiEditSchema.properties.edits.items).toMatchObject({
      required: ["old_string", "new_string"],
      properties: {
        replace_all: { type: "boolean" }
      }
    });
    expect(tools.glob.schema()).toEqual({
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (supports ** for recursive matching)" }
      },
      required: ["pattern"]
    });
    expect(tools.bash_output.schema()).toMatchObject({
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string" },
        filter: { type: "string" }
      }
    });
    expect(tools.wait.schema()).toMatchObject({
      type: "object",
      properties: {
        job_ids: { type: "array", items: { type: "string" } },
        timeout_seconds: { type: "integer", minimum: 1 }
      }
    });
    expect(tools.kill_shell.schema()).toMatchObject({
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string" }
      }
    });
  });

  it("does not expose unimplemented execution on Task 1 workspace tool definitions", async () => {
    const { Workspace } = await import("./workspace");
    const workspace = new Workspace({});
    const [readFile] = workspace.tools(["read_file"]);

    expect("execute" in readFile).toBe(false);
  });

  it("uses resolved PowerShell guidance for bash when default shell resolution falls back on Windows PowerShell", async () => {
    const { Workspace } = await import("./workspace");
    const workspace = new Workspace({
      shellResolver: () => ({ kind: "powershell", path: "powershell.exe" })
    });
    const [bash] = workspace.tools(["bash"]);

    expect(bash.description()).toContain("commands run under Windows PowerShell, so write PowerShell, not bash");
    expect(bash.description()).toContain("'&&' and '||' are NOT parsed");
  });

  it("distinguishes PowerShell 7 chaining guidance from Windows PowerShell guidance", async () => {
    const { Workspace } = await import("./workspace");
    const workspace = new Workspace({
      shellResolver: () => ({ kind: "powershell", path: "pwsh.exe" })
    });
    const [bash] = workspace.tools(["bash"]);

    expect(bash.description()).toContain("commands run under PowerShell 7 (pwsh), so write PowerShell, not bash");
    expect(bash.description()).toContain("'&&' and '||' are parsed for conditional chaining");
  });
});

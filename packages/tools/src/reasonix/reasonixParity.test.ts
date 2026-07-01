import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  BashJobManager,
  Registry,
  Workspace,
  createBashOutputTool,
  createKillShellTool,
  createWaitTool,
  reasonixToolOrder
} from "./index";

const reasonixToolNames = [
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
] as const;

const requiredByTool = {
  bash: ["command"],
  bash_output: ["job_id"],
  edit_file: ["path", "old_string", "new_string"],
  glob: ["pattern"],
  grep: ["pattern"],
  kill_shell: ["job_id"],
  ls: undefined,
  multi_edit: ["path", "edits"],
  read_file: ["path"],
  wait: undefined,
  write_file: ["path", "content"]
} as const;

const readOnlyByTool = {
  bash: false,
  bash_output: true,
  edit_file: false,
  glob: true,
  grep: true,
  kill_shell: false,
  ls: true,
  multi_edit: false,
  read_file: true,
  wait: true,
  write_file: false
} as const;

const protocolDescriptionSnippets = {
  bash: ["Execute a command", "return combined stdout/stderr"],
  bash_output: ["Read new output", "running/done/failed/killed"],
  edit_file: ["Replace an exact string", "old_string must occur exactly once"],
  glob: ["Find files matching a glob pattern", "**"],
  grep: ["Search for a regular expression", "capped at 200 matches"],
  kill_shell: ["Terminate a running background job", "no-op"],
  ls: ["List the entries of a directory", "recursive=true"],
  multi_edit: ["Apply a list of edits", "atomically"],
  read_file: ["Read a text file", "pagination hints"],
  wait: ["Block until background jobs finish", "Omit job_ids"],
  write_file: ["Write content to a file", "overwriting existing content"]
} as const;

const behaviorCoverageInventory = [
  {
    file: "./tools/readFileTool.test.ts",
    snippets: ["Reasonix read_file tool parity", "line-numbered text windows", "Go struct JSON fields case-insensitively"]
  },
  {
    file: "./tools/writeFileTool.test.ts",
    snippets: ["Reasonix write_file tool parity", "overwrites files", "preserves GB18030"]
  },
  {
    file: "./tools/editFileTool.test.ts",
    snippets: ["Reasonix edit_file tool parity", "edits exactly once", "fuzzy edit modes"]
  },
  {
    file: "./tools/multiEditTool.test.ts",
    snippets: ["Reasonix multi_edit tool parity", "applies chained edits in memory", "edits applied"]
  },
  {
    file: "./tools/grepTool.test.ts",
    snippets: ["Reasonix grep tool parity", "Go RE2 pattern semantics", "200-match truncation"]
  },
  {
    file: "./tools/globTool.test.ts",
    snippets: ["Reasonix glob tool parity", "recursive ** patterns", "1000 results"]
  },
  {
    file: "./tools/lsTool.test.ts",
    snippets: ["Reasonix ls tool parity", "Go ReadDir sorting", "depth-first"]
  },
  {
    file: "./tools/bashTool.test.ts",
    snippets: ["Reasonix bash tool parity", "starts background bash jobs", "bash_output"]
  },
  {
    file: "./bashJobs.test.ts",
    snippets: ["Reasonix BashJobManager lifecycle parity", "background job teardown", "session artifacts"]
  }
] as const;

describe("Reasonix full tool parity lock", () => {
  it("locks the complete Reasonix tool order including the bash job family", () => {
    expect(reasonixToolOrder).toEqual(reasonixToolNames);
    expect(new Workspace({}).tools().map((tool) => tool.name)).toEqual(reasonixToolNames);
  });

  it("locks model-visible schemas, read-only flags, and descriptions for every ported tool", () => {
    const tools = Object.fromEntries(new Workspace({}).tools().map((tool) => [tool.name, tool]));

    for (const name of reasonixToolNames) {
      const tool = tools[name];
      expect(tool, `missing tool ${name}`).toBeDefined();
      expect(tool.readOnly()).toBe(readOnlyByTool[name]);

      const schema = tool.schema() as { type?: unknown; properties?: Record<string, unknown>; required?: unknown };
      expect(schema.type).toBe("object");
      expect(schema.required).toEqual(requiredByTool[name]);

      const description = tool.description();
      for (const snippet of protocolDescriptionSnippets[name]) {
        expect(description).toContain(snippet);
      }
    }

    const bashSchema = tools.bash.schema() as { properties: Record<string, { description?: string }> };
    expect(bashSchema.properties.run_in_background.description).toContain("bash_output");
    expect(bashSchema.properties.run_in_background.description).toContain("kill_shell");

    const waitSchema = tools.wait.schema() as { properties: Record<string, { items?: unknown; minimum?: unknown }> };
    expect(waitSchema.properties.job_ids.items).toEqual({ type: "string" });
    expect(waitSchema.properties.timeout_seconds.minimum).toBe(1);
  });

  it("locks provider schema export semantics to Reasonix registry behavior", () => {
    const registry = new Registry();
    for (const tool of new Workspace({}).tools()) {
      registry.add(tool);
    }

    expect(registry.names()).toEqual(reasonixToolNames);
    expect(registry.schemas().map((schema) => schema.name)).toEqual(reasonixToolNames);
    expect(JSON.parse(registry.schemasJSON()).map((schema: { name: string }) => schema.name)).toEqual(reasonixToolNames);
  });

  it("keeps bash_output, wait, kill_shell, and the background job manager wired together", async () => {
    const manager = new BashJobManager();
    const workspace = new Workspace({});
    const context = { jobManager: manager, sessionId: "parity-session" };

    try {
      const job = manager.startForSession("parity-session", "bash", "parity", ({ write }) => {
        write("alpha\nbeta\n");
        return "";
      });

      await expect(createWaitTool(workspace).execute({ job_ids: [job.id], timeout_seconds: 1 }, context)).resolves.toContain(
        `[${job.id} (parity)] done\nalpha\nbeta\n`
      );
      await expect(createBashOutputTool(workspace).execute({ job_id: job.id, filter: "beta" }, context)).resolves.toBe(
        `[${job.id}] done\nbeta`
      );
      await expect(createBashOutputTool(workspace).execute({ job_id: job.id }, context)).resolves.toBe(
        `[${job.id}] done\n(no new output)`
      );
      await expect(createKillShellTool(workspace).execute({ job_id: job.id }, context)).resolves.toBe(
        `Background job "${job.id}" was not running (already finished or unknown).`
      );
    } finally {
      await manager.close();
    }
  });

  it("documents that the detailed core behavior parity checks already exist per tool family", async () => {
    for (const item of behaviorCoverageInventory) {
      const source = await readFile(new URL(item.file, import.meta.url), "utf8");
      for (const snippet of item.snippets) {
        expect(source).toContain(snippet);
      }
    }
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BashJobManager,
  Registry,
  Workspace,
  createBashTool,
  createBashOutputTool,
  createEditFileTool,
  createGlobTool,
  createGrepTool,
  createKillShellTool,
  createLsTool,
  createMultiEditTool,
  createReadFileTool,
  createWaitTool,
  createWriteFileTool,
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
  "read_report_excerpt",
  "upsert_report_section",
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
  read_report_excerpt: ["outputFileName", "queries"],
  upsert_report_section: ["outputFileName", "updates"],
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
  read_report_excerpt: true,
  upsert_report_section: false,
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
  read_report_excerpt: ["卡片字段块", "cardName", "fields"],
  upsert_report_section: ["字段块", "cardName", "fieldName"],
  wait: ["Block until background jobs finish", "Omit job_ids"],
  write_file: ["Write content to a file", "overwriting existing content"]
} as const;

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

  it("executes a minimal behavior contract for every core Reasonix tool family", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "reasonix-parity-contract-"));
    const workspace = new Workspace({ dir, shell: { kind: "powershell", path: "powershell" } });
    const target = path.join(dir, "notes.txt");
    const multiTarget = path.join(dir, "multi.txt");

    try {
      await writeFile(target, "alpha\nneedle\n", "utf8");
      await writeFile(multiTarget, "one two two\n", "utf8");

      await expect(createReadFileTool(workspace).execute({ path: "notes.txt", limit: 2 })).resolves.toBe(
        "1→alpha\n2→needle\n"
      );

      await expect(createWriteFileTool(workspace).execute({ path: "write.txt", content: "old value\n" })).resolves.toBe(
        `wrote 10 bytes to ${path.join(dir, "write.txt")}`
      );

      await expect(
        createEditFileTool(workspace).execute({ path: "write.txt", old_string: "old value", new_string: "edited value" })
      ).resolves.toBe(`edited ${path.join(dir, "write.txt")}`);
      await expect(readFile(path.join(dir, "write.txt"), "utf8")).resolves.toBe("edited value\n");

      await expect(
        createMultiEditTool(workspace).execute({
          path: "multi.txt",
          edits: [
            { old_string: "one", new_string: "ONE" },
            { old_string: "two", new_string: "TWO", replace_all: true }
          ]
        })
      ).resolves.toBe(`multi_edit ${multiTarget}: 2 edits applied (3 total replacements)`);
      await expect(readFile(multiTarget, "utf8")).resolves.toBe("ONE TWO TWO\n");

      await expect(createGrepTool(workspace).execute({ pattern: "needle", path: "notes.txt" })).resolves.toBe(
        `${target}:2:needle`
      );

      await expect(createGlobTool(workspace).execute({ pattern: "*.txt" })).resolves.toContain(target);
      await expect(createLsTool(workspace).execute({ path: "." })).resolves.toContain("notes.txt\t13\n");

      await expect(createBashTool(workspace).execute({ command: "Write-Output parity-bash" })).resolves.toContain("parity-bash");
      await expect(runBashFamilyContract(workspace)).resolves.toEqual(
        expect.objectContaining({
          jobId: expect.stringMatching(/^bash-\d+$/u),
          output: expect.stringContaining("parity-bg"),
          killed: expect.stringContaining("Killed background job"),
          wait: expect.stringContaining("killed")
        })
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, 20000);
});

async function runBashFamilyContract(workspace: Workspace): Promise<{ jobId: string; output: string; killed: string; wait: string }> {
  const manager = new BashJobManager();
  const context = { jobManager: manager, sessionId: "parity-contract-session" };

  try {
    const started = await createBashTool(workspace).execute(
      {
        command: "Write-Output parity-bg; Start-Sleep -Seconds 30",
        run_in_background: true
      },
      context
    );
    const jobId = extractBackgroundJobId(started);
    const output = await readBackgroundOutputUntil(workspace, context, jobId, "parity-bg");
    const killed = await createKillShellTool(workspace).execute({ job_id: jobId }, context);
    const wait = await createWaitTool(workspace).execute({ job_ids: [jobId], timeout_seconds: 1 }, context);

    return { jobId, output, killed, wait };
  } finally {
    await manager.close();
  }
}

async function readBackgroundOutputUntil(
  workspace: Workspace,
  context: { jobManager: BashJobManager; sessionId: string },
  jobId: string,
  expected: string
): Promise<string> {
  let lastOutput = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    lastOutput = await createBashOutputTool(workspace).execute({ job_id: jobId }, context);
    if (lastOutput.includes(expected)) {
      return lastOutput;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return lastOutput;
}

function extractBackgroundJobId(content: string): string {
  const match = /Started background job "([^"]+)"/u.exec(content);
  if (match === null) {
    throw new Error(`missing background job id in bash result: ${content}`);
  }
  return match[1];
}

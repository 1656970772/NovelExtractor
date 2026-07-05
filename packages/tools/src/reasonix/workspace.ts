import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PathResolver, realRoots } from "./pathResolver";
import type { ReasonixToolDefinition } from "./registry";

export const reasonixToolOrder = [
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

export type ReasonixToolName = (typeof reasonixToolOrder)[number];

export interface ReasonixSearchConfig {
  rgPath?: string;
}

export type ReasonixShellPreference = "auto" | "bash" | "powershell" | "pwsh";

export interface ReasonixShellConfig {
  kind?: "bash" | "powershell" | "pwsh";
  prefer?: ReasonixShellPreference;
  path?: string;
  supportsChaining?: boolean;
}

export interface ReasonixResolvedShell {
  kind: "bash" | "powershell";
  path: string;
  supportsChaining?: boolean;
}

export type ReasonixShellResolver = (prefer: ReasonixShellPreference, shellPath: string) => ReasonixResolvedShell;

export interface ReasonixWorkspaceConfig {
  dir?: string;
  writeRoots?: readonly string[];
  forbidReadRoots?: readonly string[];
  readPaths?: PathResolver;
  search?: ReasonixSearchConfig;
  shell?: ReasonixShellConfig;
  shellResolver?: ReasonixShellResolver;
  bashTimeoutSeconds?: number;
  enabledTools?: readonly string[];
}

export class Workspace {
  readonly dir: string;
  readonly writeRoots: string[];
  readonly realWriteRoots: string[];
  readonly forbidReadRoots: string[];
  readonly realForbidReadRoots: string[];
  readonly readPaths?: PathResolver;
  readonly search: ReasonixSearchConfig;
  readonly shell: ReasonixShellConfig;
  readonly shellResolver?: ReasonixShellResolver;
  readonly bashTimeoutSeconds: number;
  readonly enabledTools?: readonly string[];

  constructor(config: ReasonixWorkspaceConfig = {}) {
    this.dir = config.dir ?? "";
    this.writeRoots = config.writeRoots !== undefined ? [...config.writeRoots] : this.dir === "" ? [] : [this.dir];
    this.realWriteRoots = realRoots(this.writeRoots);
    this.forbidReadRoots = [...(config.forbidReadRoots ?? [])];
    this.realForbidReadRoots = realRoots(this.forbidReadRoots);
    this.readPaths = config.readPaths;
    this.search = { ...(config.search ?? {}) };
    this.shell = { ...(config.shell ?? {}) };
    this.shellResolver = config.shellResolver;
    this.bashTimeoutSeconds = config.bashTimeoutSeconds ?? 0;
    this.enabledTools = config.enabledTools;
  }

  tools(enabled = this.enabledTools): ReasonixToolDefinition[] {
    if (enabled === undefined || enabled.length === 0) {
      return reasonixToolOrder.map((name) => this.makeTool(name));
    }

    const wanted = new Set(enabled);
    return reasonixToolOrder.flatMap((name) => (wanted.has(name) ? [this.makeTool(name)] : []));
  }

  private makeTool(name: ReasonixToolName): ReasonixToolDefinition {
    return {
      name,
      description: () => toolDescriptions[name](this),
      schema: () => toolSchemas[name],
      readOnly: () => toolReadOnly[name]
    };
  }
}

const toolReadOnly: Record<ReasonixToolName, boolean> = {
  read_file: true,
  read_report_excerpt: true,
  upsert_report_section: false,
  write_file: false,
  edit_file: false,
  multi_edit: false,
  grep: true,
  glob: true,
  ls: true,
  bash: false,
  bash_output: true,
  wait: true,
  kill_shell: false
};

const toolDescriptions: Record<ReasonixToolName, (workspace: Workspace) => string> = {
  read_file: (workspace) =>
    "Read a text file with optional line offset/limit. Output prefixes each line with its 1-based number (e.g. `   42→...`) so subsequent edit_file calls can target exact lines. Use `offset` and `limit` to page through large files; the tool reports total length and pagination hints in a trailer." +
    reportInventoryGuidance(workspace, "read_existing"),
  read_report_excerpt: () =>
    "读取本批允许报告中的卡片字段块。输入 outputFileName 和 queries，每个 query 是 cardName + fields；卡片标题为 ### 卡片名，字段行为 - 字段名：内容，字段下缩进子项会一起返回。不要整读旧报告。",
  upsert_report_section: () =>
    "按 cardName + fieldName 替换已有 Markdown 报告字段块。输入 outputFileName 和 updates；content 必须以对应 - 字段名： 开头。不接受 old_string、sectionId 或 writeMode，不隐式创建新卡片或新字段。",
  write_file: () => "Write content to a file at the given path (overwriting existing content). Creates parent directories as needed.",
  edit_file: () =>
    "Replace an exact string in a file with another. old_string must occur exactly once; add surrounding context to disambiguate. Use for targeted edits instead of rewriting the whole file.",
  multi_edit: () =>
    "Apply a list of edits to a single file atomically: each edit runs against the result of the previous one, all in memory; the file is rewritten only if every edit succeeds. Cheaper and safer than chaining edit_file calls — a failure in step 3 leaves the file untouched instead of half-edited.",
  grep: (workspace) =>
    workspace.search.rgPath !== undefined && workspace.search.rgPath !== ""
      ? "Search for a regular expression in a file, or recursively under a directory — ripgrep-backed, so it honors .gitignore. Returns matching lines as path:line:text, capped at 200 matches."
      : "Search for a regular expression in a file, or recursively under a directory (skips hidden files and files matched by .gitignore). Returns matching lines as path:line:text, capped at 200 matches.",
  glob: (workspace) =>
    'Find files matching a glob pattern (e.g. "*.go", "internal/*/*.go", "**/*.test.ts"). Supports shell metacharacters * ? [] and the recursive ** pattern.' +
    reportInventoryGuidance(workspace, "discovery"),
  ls: (workspace) =>
    "List the entries of a directory. Directories are shown with a trailing slash; files show their byte size. Set recursive=true to list all nested files depth-first (skips .git/node_modules)." +
    reportInventoryGuidance(workspace, "discovery"),
  bash: (workspace) => bashDescription(resolveWorkspaceShell(workspace)) + reportInventoryGuidance(workspace, "read_existing"),
  bash_output: () =>
    "Read new output from a background job started with bash(run_in_background=true) or task(run_in_background=true). Returns the output produced since the last bash_output call for that job, plus its status (running/done/failed/killed). Does not block.",
  wait: () =>
    "Block until background jobs finish, then return each job's status and final output/answer. Use to collect the result of a task(run_in_background) or bash(run_in_background) before continuing. Omit job_ids to wait for every running job.",
  kill_shell: () =>
    "Terminate a running background job (bash or task) started with run_in_background. A no-op if the job has already finished or the id is unknown."
};

const toolSchemas: Record<ReasonixToolName, unknown> = {
  read_file: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      offset: { type: "integer", description: "0-based line offset to start reading from (default 0)", minimum: 0 },
      limit: { type: "integer", description: "Maximum lines to return (default 2000)", minimum: 1 }
    },
    required: ["path"]
  },
  read_report_excerpt: {
    type: "object",
    properties: {
      outputFileName: { type: "string", description: "本批选中模板的平面报告文件名，例如 NPC性格与代表事件.md" },
      queries: {
        type: "array",
        minItems: 1,
        description: "要读取的卡片字段坐标数组。",
        items: {
          type: "object",
          properties: {
            cardName: { type: "string", description: "三级标题卡片名，例如 韩立" },
            fields: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
              description: "字段名数组，例如 [角色定位, 核心性格, 代表行为]"
            }
          },
          required: ["cardName", "fields"],
          additionalProperties: false
        }
      },
      maxChars: {
        type: "integer",
        description: "返回字段块总字符预算，默认 8000，允许范围 500-20000。",
        minimum: 500,
        maximum: 20000
      }
    },
    required: ["outputFileName", "queries"],
    additionalProperties: false
  },
  upsert_report_section: {
    type: "object",
    properties: {
      outputFileName: { type: "string", description: "本批选中模板的平面报告文件名，例如 NPC性格与代表事件.md" },
      updates: {
        type: "array",
        minItems: 1,
        description: "要替换的字段块数组。",
        items: {
          type: "object",
          properties: {
            cardName: { type: "string", description: "三级标题卡片名，例如 韩立" },
            fieldName: { type: "string", description: "字段名，例如 核心性格" },
            content: { type: "string", description: "完整字段块，必须以 - 字段名： 开头，并包含需要保留或更新的子项。" }
          },
          required: ["cardName", "fieldName", "content"],
          additionalProperties: false
        }
      }
    },
    required: ["outputFileName", "updates"],
    additionalProperties: false
  },
  write_file: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "Full content to write" }
    },
    required: ["path", "content"]
  },
  edit_file: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old_string: { type: "string", description: "Exact text to replace (must be unique in the file)" },
      new_string: { type: "string", description: "Replacement text (may be empty to delete)" }
    },
    required: ["path", "old_string", "new_string"]
  },
  multi_edit: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      edits: {
        type: "array",
        minItems: 1,
        description: "Ordered edits. Each step sees the file as left by the previous step.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Exact text to find. Without replace_all, must match exactly once." },
            new_string: { type: "string", description: "Replacement text (empty deletes)." },
            replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." }
          },
          required: ["old_string", "new_string"]
        }
      }
    },
    required: ["path", "edits"]
  },
  grep: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (RE2 syntax)" },
      path: { type: "string", description: 'File or directory to search (default ".")' },
      timeout_seconds: {
        type: "integer",
        description:
          "Abort and return partial matches after this many seconds (default 30, max 300). Raise it for a large tree; lower it for a quick probe.",
        minimum: 1
      }
    },
    required: ["pattern"]
  },
  glob: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern (supports ** for recursive matching)" }
    },
    required: ["pattern"]
  },
  ls: {
    type: "object",
    properties: {
      path: { type: "string", description: 'Directory path (default ".")' },
      recursive: { type: "boolean", description: "When true, recursively list all nested files (default false)" }
    }
  },
  bash: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      run_in_background: {
        type: "boolean",
        description:
          "Run detached: returns a job id immediately and keeps running across turns (no foreground timeout). Read new output with bash_output, wait with wait, stop it with kill_shell. Use for long-running commands like servers, watchers, or builds you don't need to block on."
      },
      preserve_background_processes: {
        type: "boolean",
        description:
          "After the shell command exits normally, keep any process-group members it intentionally left behind. Use only for deliberate daemonization, browser/GUI/session launchers such as playwright-cli open, or nohup/disown/setsid; cancellation and timeouts still kill the process group."
      }
    },
    required: ["command"]
  },
  bash_output: {
    type: "object",
    properties: {
      job_id: { type: "string", description: 'The background job id (e.g. "bash-1") returned when it was started.' },
      filter: { type: "string", description: "Optional regular expression; only matching lines of the new output are returned." }
    },
    required: ["job_id"]
  },
  wait: {
    type: "object",
    properties: {
      job_ids: {
        type: "array",
        items: { type: "string" },
        description: "Background job ids to wait for. Omit to wait for every currently-running job."
      },
      timeout_seconds: {
        type: "integer",
        description: "Optional maximum seconds to block before returning current progress. Omit to wait until the jobs finish.",
        minimum: 1
      }
    }
  },
  kill_shell: {
    type: "object",
    properties: {
      job_id: { type: "string", description: 'The background job id to terminate (e.g. "bash-1").' }
    },
    required: ["job_id"]
  }
};

const bashToolSteer =
  " Use for builds, tests, git, package managers, etc. To search/read/list/edit/move files, prefer the dedicated tools (grep, read_file, ls, glob, edit_file, move_file) over shell grep/cat/ls/find/sed/mv/Move-Item — they behave identically on every OS. For symbol search or architecture questions, prefer LSP/read tools and targeted grep before shell commands.";

function reportInventoryGuidance(workspace: Workspace, mode: "discovery" | "read_existing"): string {
  if (workspace.dir !== "") {
    return "";
  }

  const base = " 报告是否存在已由宿主清单提供；不要用 glob/ls/bash 查找报告。";
  return mode === "read_existing" ? `${base}需要读已有报告时后续任务会走卡片字段块读取。` : base;
}

function bashDescription(shell: ReasonixResolvedShell): string {
  if (shell.kind === "powershell") {
    const supportsChaining = shell.supportsChaining ?? shellSupportsChaining(shell);
    const shellName = supportsChaining ? "PowerShell 7 (pwsh)" : "Windows PowerShell";
    const chaining =
      supportsChaining
        ? "'&&' and '||' are parsed for conditional chaining; ';' runs both regardless."
        : "';' runs both regardless; 'if ($?) { ... }' is conditional. '&&' and '||' are NOT parsed.";

    return (
      `Execute a command in the shell and return combined stdout/stderr. NOTE: bash is not available on this host — commands run under ${shellName}, so write PowerShell, not bash:\n` +
      `  - chaining: ${chaining}\n` +
      "  - redirect/vars: $null not /dev/null; $env:VAR not $VAR; '2>$null' drops stderr.\n" +
      "  - file ops: Get-ChildItem (ls), Get-Content (cat), Remove-Item -Recurse -Force (rm -rf), Copy-Item (cp), Select-String (grep).\n" +
      "  - no head/tail/which/touch: use Select-Object -First/-Last N, (Get-Command x).Source, New-Item.\n" +
      "  - multi-line text to a native exe (e.g. git commit -m): use a single-quoted here-string @'...'@ (closing '@ at column 0)." +
      bashToolSteer
    );
  }

  return "Execute a command in the shell and return combined stdout/stderr." + bashToolSteer;
}

export function resolveWorkspaceShell(workspace: Workspace): ReasonixResolvedShell {
  const shell = workspace.shell;
  if (shell.kind !== undefined) {
    return {
      kind: shell.kind === "pwsh" ? "powershell" : shell.kind,
      path: shell.path ?? defaultShellPath(shell.kind),
      supportsChaining: shell.supportsChaining
    };
  }

  const prefer = shell.prefer ?? "auto";
  const shellPath = shell.path ?? "";
  const resolved = workspace.shellResolver?.(prefer, shellPath) ?? resolveReasonixShell(prefer, shellPath);
  if (shell.supportsChaining === undefined || resolved.kind !== "powershell") {
    return resolved;
  }
  return { ...resolved, supportsChaining: shell.supportsChaining };
}

export function resolveReasonixShell(prefer: ReasonixShellPreference = "auto", shellPath = ""): ReasonixResolvedShell {
  const normalizedPrefer = prefer.trim().toLowerCase() as ReasonixShellPreference;

  const findBash = (): ReasonixResolvedShell | undefined => {
    const pathFromPath = lookPath("bash");
    if (pathFromPath !== undefined && !isWindowsWSLBash(pathFromPath) && probeBash(pathFromPath)) {
      return { kind: "bash", path: pathFromPath };
    }

    for (const candidate of windowsBashCandidates()) {
      if (fileExists(candidate) && probeBash(candidate)) {
        return { kind: "bash", path: candidate };
      }
    }
    return undefined;
  };

  const findPowerShell = (order: readonly ("pwsh" | "powershell")[]): ReasonixResolvedShell | undefined => {
    for (const name of order) {
      for (const candidate of windowsPowerShellCandidates()) {
        const base = path.basename(candidate).toLowerCase();
        if (base !== name && base.replace(/\.exe$/u, "") !== name) {
          continue;
        }
        if (fileExists(candidate)) {
          return { kind: "powershell", path: candidate };
        }
      }

      const pathFromPath = lookPath(name);
      if (pathFromPath !== undefined) {
        return { kind: "powershell", path: pathFromPath };
      }
    }
    return undefined;
  };

  const auto = (): ReasonixResolvedShell => {
    const bash = findBash();
    if (bash !== undefined) {
      return bash;
    }

    if (process.platform === "win32") {
      const powershell = findPowerShell(["pwsh", "powershell"]);
      if (powershell !== undefined) {
        return powershell;
      }
    }

    return { kind: "bash", path: "bash" };
  };

  switch (normalizedPrefer) {
    case "auto":
      return auto();
    case "bash":
      if (shellPath !== "" && fileExists(shellPath) && probeBash(shellPath)) {
        return { kind: "bash", path: shellPath };
      }
      return findBash() ?? auto();
    case "powershell":
    case "pwsh": {
      if (shellPath !== "" && fileExists(shellPath)) {
        return { kind: "powershell", path: shellPath };
      }
      const order: ("pwsh" | "powershell")[] = normalizedPrefer === "powershell" ? ["powershell", "pwsh"] : ["pwsh", "powershell"];
      return findPowerShell(order) ?? auto();
    }
    default:
      return auto();
  }
}

function shellSupportsChaining(shell: ReasonixResolvedShell): boolean {
  if (shell.kind !== "powershell") {
    return true;
  }
  const base = path.basename(shell.path).toLowerCase();
  return base === "pwsh" || base === "pwsh.exe";
}

function defaultShellPath(kind: ReasonixShellConfig["kind"]): string {
  switch (kind) {
    case "pwsh":
      return "pwsh";
    case "powershell":
      return "powershell";
    default:
      return "bash";
  }
}

function lookPath(command: string): string | undefined {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || result.stdout.trim() === "") {
    return undefined;
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "");
}

function fileExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function probeBash(candidate: string): boolean {
  if (process.platform !== "win32") {
    return true;
  }

  const result = spawnSync(candidate, ["-c", "true"], { timeout: 3000, windowsHide: true });
  return result.status === 0;
}

function isWindowsWSLBash(candidate: string): boolean {
  if (process.platform !== "win32" || candidate === "") {
    return false;
  }

  const windowsRoot = process.env.SystemRoot ?? process.env.windir;
  if (windowsRoot === undefined || windowsRoot === "") {
    return false;
  }

  const normalizedCandidate = path.normalize(candidate).toLowerCase();
  const normalizedRoot = `${path.normalize(windowsRoot).toLowerCase()}${path.sep}`;
  return normalizedCandidate.startsWith(normalizedRoot);
}

function windowsBashCandidates(): string[] {
  const roots = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
    .map((name) => process.env[name])
    .filter((value): value is string => value !== undefined && value !== "");
  if (process.env.LOCALAPPDATA !== undefined && process.env.LOCALAPPDATA !== "") {
    roots.push(path.join(process.env.LOCALAPPDATA, "Programs"));
  }

  return roots.flatMap((root) => [path.join(root, "Git", "bin", "bash.exe"), path.join(root, "Git", "usr", "bin", "bash.exe")]);
}

function windowsPowerShellCandidates(): string[] {
  const roots = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
    .map((name) => process.env[name])
    .filter((value): value is string => value !== undefined && value !== "");
  const candidates = roots.map((root) => path.join(root, "PowerShell", "7", "pwsh.exe"));
  const windowsRoot = process.env.SystemRoot ?? process.env.windir;
  if (windowsRoot !== undefined && windowsRoot !== "") {
    candidates.push(path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  }
  return candidates;
}

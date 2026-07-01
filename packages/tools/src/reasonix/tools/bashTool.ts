import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RE2JS } from "re2js";
import { sessionFromContext, type BashJobResult } from "../bashJobs";
import {
  GoRawJSONUnmarshaller,
  goJSONTokenKind,
  goJSONTypeError,
  invalidArgs,
  isGoIntLiteral,
  parsedJSONValueForError,
  replaceIsolatedSurrogates,
  type ParsedRawJSONValue,
  type RawJSONValueKind
} from "../goJson";
import type { ReasonixTool, ReasonixToolExecutionContext } from "../registry";
import {
  bashCommandEnv,
  formatGoDuration,
  hasExplicitBackgroundKeepalive,
  hasUnquotedSeq,
  shellArgv,
  shellSupportsChaining
} from "../shell";
import { resolveWorkspaceShell, type Workspace, type ReasonixResolvedShell } from "../workspace";

const bashArgsGoStructType =
  'struct { Command string "json:\\"command\\""; RunInBackground bool "json:\\"run_in_background\\""; PreserveBackgroundProcesses bool "json:\\"preserve_background_processes\\"" }';

interface NormalizedBashArgs {
  command: string;
  runInBackground: boolean;
  preserveBackgroundProcesses: boolean;
}

interface NormalizedBashOutputArgs {
  jobId: string;
  filter: string;
}

interface NormalizedKillShellArgs {
  jobId: string;
}

interface NormalizedWaitArgs {
  jobIds: string[];
  timeoutSeconds: number;
}

interface RunShellResult {
  output: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
  timedOut: boolean;
  canceled: boolean;
  waitDelayExpired: boolean;
}

const bashWaitDelayMs = 5_000;
const errWaitDelayMessage = "exec: WaitDelay expired before I/O complete";

export function createBashTool(workspace: Workspace): ReasonixTool {
  const [definition] = workspace.tools(["bash"]);

  return {
    ...definition,
    async execute(args: unknown, context?: ReasonixToolExecutionContext): Promise<string> {
      const params = normalizeArgs(args);
      const shell = resolveWorkspaceShell(workspace);
      const supportsChaining = shell.supportsChaining ?? shellSupportsChaining(shell);
      if (!supportsChaining && (hasUnquotedSeq(params.command, "&&") || hasUnquotedSeq(params.command, "||"))) {
        throw new Error(
          "this shell is Windows PowerShell, which does not parse '&&' or '||'. " +
            "Sequence with ';' (both run regardless of the first's result), use 'if ($?) { ... }' for " +
            "conditional chaining, or issue the commands as separate calls"
        );
      }

      if (params.runInBackground) {
        const manager = context?.jobManager;
        if (manager === undefined) {
          throw new Error("background execution is not available in this context");
        }
        const job = manager.startForSession(sessionFromContext(context), "bash", commandPreview(params.command), async (jobContext) => {
          const result = await runShellCommand({
            shell,
            command: params.command,
            workDir: workspace.dir,
            preserveBackgroundProcesses: params.preserveBackgroundProcesses,
            timeoutMs: 0,
            signal: jobContext.signal,
            onOutput: jobContext.write,
            captureOutput: false,
            env: context?.env
          });
          const error = backgroundShellResultError(result);
          if (error !== undefined) {
            throw error;
          }
          return "";
        });
        return `Started background job "${job.id}". It keeps running across turns; read new output with bash_output(job_id="${job.id}"), wait for it with wait, or stop it with kill_shell(job_id="${job.id}").`;
      }

      const timeoutMs = foregroundTimeoutMs(workspace.bashTimeoutSeconds);
      const result = await runShellCommand({
        shell,
        command: params.command,
        workDir: workspace.dir,
        preserveBackgroundProcesses: params.preserveBackgroundProcesses,
        timeoutMs,
        signal: context?.signal,
        env: context?.env
      });

      const error = shellResultError(result, timeoutMs);
      if (error !== undefined) {
        throw bashRunError(error.message, result.output);
      }
      return result.output;
    }
  };
}

export function createBashOutputTool(workspace: Workspace): ReasonixTool {
  const [definition] = workspace.tools(["bash_output"]);
  return {
    ...definition,
    async execute(args: unknown, context?: ReasonixToolExecutionContext): Promise<string> {
      const params = normalizeBashOutputArgs(args);
      const manager = context?.jobManager;
      if (manager === undefined) {
        throw new Error("background jobs are not available in this context");
      }
      const sessionId = sessionFromContext(context);
      const result = manager.outputForSession(sessionId, params.jobId);
      if (!result.found) {
        throw new Error(`no background job "${params.jobId}"`);
      }
      let text = result.text;
      if (params.filter !== "" && text !== "") {
        text = applyFilter(text, compileFilter(params.filter));
      }
      const header = `[${params.jobId}] ${result.status}`;
      return text.trim() === "" ? `${header}\n(no new output)` : `${header}\n${text}`;
    }
  };
}

export function createKillShellTool(workspace: Workspace): ReasonixTool {
  const [definition] = workspace.tools(["kill_shell"]);
  return {
    ...definition,
    async execute(args: unknown, context?: ReasonixToolExecutionContext): Promise<string> {
      const params = normalizeKillShellArgs(args);
      const manager = context?.jobManager;
      if (manager === undefined) {
        throw new Error("background jobs are not available in this context");
      }
      if (manager.killForSession(sessionFromContext(context), params.jobId)) {
        return `Killed background job "${params.jobId}".`;
      }
      return `Background job "${params.jobId}" was not running (already finished or unknown).`;
    }
  };
}

export function createWaitTool(workspace: Workspace): ReasonixTool {
  const [definition] = workspace.tools(["wait"]);
  return {
    ...definition,
    async execute(args: unknown, context?: ReasonixToolExecutionContext): Promise<string> {
      const params = normalizeWaitArgs(args);
      const manager = context?.jobManager;
      if (manager === undefined) {
        throw new Error("background jobs are not available in this context");
      }
      const results = await manager.waitForSession(context?.signal, sessionFromContext(context), params.jobIds, params.timeoutSeconds);
      if (results.length === 0) {
        return "No background jobs to wait for.";
      }
      return results.map(formatWaitResult).join("\n\n");
    }
  };
}

function normalizeArgs(args: unknown): NormalizedBashArgs {
  if (typeof args === "string") {
    return normalizeRawJSONArgs(args);
  }
  if (args instanceof Uint8Array) {
    return normalizeRawJSONArgs(new TextDecoder().decode(args));
  }
  return normalizeStructuredArgs(args);
}

function normalizeRawJSONArgs(rawText: string): NormalizedBashArgs {
  const result = new RawBashArgsUnmarshaller(rawText).unmarshal();
  if (result.kind !== "object" && result.kind !== "null") {
    throw invalidArgs(`json: cannot unmarshal ${result.kind === "bool" ? "bool" : result.kind} into Go value of type ${bashArgsGoStructType}`);
  }
  if (result.typeError !== undefined) {
    throw invalidArgs(result.typeError);
  }
  if (result.command === "") {
    throw new Error("command is required");
  }
  return {
    command: result.command,
    runInBackground: result.runInBackground,
    preserveBackgroundProcesses: result.preserveBackgroundProcesses
  };
}

function normalizeStructuredArgs(raw: unknown): NormalizedBashArgs {
  if (raw === null) {
    raw = {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidArgs(`json: cannot unmarshal ${goJSONTokenKind(raw)} into Go value of type ${bashArgsGoStructType}`);
  }

  const value = raw as Record<string, unknown>;
  let command = "";
  let runInBackground = false;
  let preserveBackgroundProcesses = false;
  let firstTypeError: string | undefined;

  for (const key of Object.keys(value)) {
    const field = bashArgField(key);
    if (field === undefined) {
      continue;
    }
    const fieldValue = value[key];
    if (fieldValue === undefined || fieldValue === null) {
      if (field === "command") {
        command = "";
      }
      continue;
    }
    if (field === "command") {
      if (typeof fieldValue === "string") {
        command = replaceIsolatedSurrogates(fieldValue);
      } else {
        firstTypeError ??= goJSONTypeError(fieldValue, "command", "string");
      }
      continue;
    }
    if (typeof fieldValue === "boolean") {
      if (field === "run_in_background") {
        runInBackground = fieldValue;
      } else {
        preserveBackgroundProcesses = fieldValue;
      }
    } else {
      firstTypeError ??= goJSONTypeError(fieldValue, field, "bool");
    }
  }

  if (firstTypeError !== undefined) {
    throw invalidArgs(firstTypeError);
  }
  if (command === "") {
    throw new Error("command is required");
  }
  return { command, runInBackground, preserveBackgroundProcesses };
}

class RawBashArgsUnmarshaller {
  private command = "";
  private runInBackground = false;
  private preserveBackgroundProcesses = false;
  private firstTypeError: string | undefined;

  constructor(private readonly json: string) {}

  unmarshal(): {
    kind: RawJSONValueKind;
    command: string;
    runInBackground: boolean;
    preserveBackgroundProcesses: boolean;
    typeError?: string;
  } {
    const kind = new GoRawJSONUnmarshaller(this.json, (key, value) => this.unmarshalKnownField(key, value)).unmarshal();
    return {
      kind,
      command: this.command,
      runInBackground: this.runInBackground,
      preserveBackgroundProcesses: this.preserveBackgroundProcesses,
      typeError: this.firstTypeError
    };
  }

  private unmarshalKnownField(key: string, value: ParsedRawJSONValue): void {
    const field = bashArgField(key);
    if (field === undefined || value.kind === "null") {
      return;
    }

    if (field === "command") {
      if (value.kind === "string") {
        this.command = value.stringValue ?? "";
      } else {
        this.firstTypeError ??= goJSONTypeError(parsedJSONValueForError(value), "command", "string", value.raw);
      }
      return;
    }

    if (value.kind === "bool") {
      if (field === "run_in_background") {
        this.runInBackground = value.raw === "true";
      } else {
        this.preserveBackgroundProcesses = value.raw === "true";
      }
    } else {
      this.firstTypeError ??= goJSONTypeError(parsedJSONValueForError(value), field, "bool", value.raw);
    }
  }
}

function bashArgField(key: string): "command" | "run_in_background" | "preserve_background_processes" | undefined {
  const folded = key.toLowerCase();
  switch (folded) {
    case "command":
    case "run_in_background":
    case "preserve_background_processes":
      return folded;
    default:
      return undefined;
  }
}

function normalizeBashOutputArgs(args: unknown): NormalizedBashOutputArgs {
  const value = normalizeObjectArgs(args, bashOutputArgsGoStructType);
  const jobId = stringField(value, "job_id");
  const filter = stringField(value, "filter");
  if (jobId.typeError !== undefined) {
    throw invalidArgs(jobId.typeError);
  }
  if (filter.typeError !== undefined) {
    throw invalidArgs(filter.typeError);
  }
  if (jobId.value === "") {
    throw new Error("job_id is required");
  }
  return { jobId: jobId.value, filter: filter.value };
}

function normalizeKillShellArgs(args: unknown): NormalizedKillShellArgs {
  const value = normalizeObjectArgs(args, killShellArgsGoStructType);
  const jobId = stringField(value, "job_id");
  if (jobId.typeError !== undefined) {
    throw invalidArgs(jobId.typeError);
  }
  if (jobId.value === "") {
    throw new Error("job_id is required");
  }
  return { jobId: jobId.value };
}

function normalizeWaitArgs(args: unknown): NormalizedWaitArgs {
  if ((typeof args === "string" && args.length === 0) || (args instanceof Uint8Array && args.byteLength === 0)) {
    return { jobIds: [], timeoutSeconds: 0 };
  }
  const value = normalizeObjectArgs(args, waitArgsGoStructType, true);
  const jobIds = stringArrayField(value, "job_ids");
  const timeoutSeconds = intField(value, "timeout_seconds");
  if (jobIds.typeError !== undefined) {
    throw invalidArgs(jobIds.typeError);
  }
  if (timeoutSeconds.typeError !== undefined) {
    throw invalidArgs(timeoutSeconds.typeError);
  }
  return { jobIds: jobIds.value, timeoutSeconds: timeoutSeconds.value };
}

const bashOutputArgsGoStructType = 'struct { JobID string "json:\\"job_id\\""; Filter string "json:\\"filter\\"" }';
const killShellArgsGoStructType = 'struct { JobID string "json:\\"job_id\\"" }';
const waitArgsGoStructType = 'struct { JobIDs []string "json:\\"job_ids\\""; TimeoutSeconds int "json:\\"timeout_seconds\\"" }';

type RawObjectFieldKind = "string" | "stringArray" | "int";
type RawObjectFieldResult = { value: unknown; typeError?: undefined } | { value?: undefined; typeError: string };

const bashOutputRawFields = {
  job_id: "string",
  filter: "string"
} as const satisfies Record<string, RawObjectFieldKind>;

const killShellRawFields = {
  job_id: "string"
} as const satisfies Record<string, RawObjectFieldKind>;

const waitRawFields = {
  job_ids: "stringArray",
  timeout_seconds: "int"
} as const satisfies Record<string, RawObjectFieldKind>;

function normalizeObjectArgs(args: unknown, goStructType: string, allowUndefined = false): Record<string, unknown> {
  if (args === undefined && allowUndefined) {
    return {};
  }
  if (typeof args === "string") {
    return normalizeRawObjectArgs(args, goStructType, rawFieldsForStruct(goStructType));
  }
  if (args instanceof Uint8Array) {
    return normalizeRawObjectArgs(new TextDecoder().decode(args), goStructType, rawFieldsForStruct(goStructType));
  }
  if (args === null || (args === undefined && allowUndefined)) {
    return {};
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    throw invalidArgs(`json: cannot unmarshal ${goJSONTokenKind(args)} into Go value of type ${goStructType}`);
  }
  return normalizeStructuredObjectArgs(args as Record<string, unknown>, rawFieldsForStruct(goStructType));
}

function rawFieldsForStruct(goStructType: string): Record<string, RawObjectFieldKind> {
  switch (goStructType) {
    case bashOutputArgsGoStructType:
      return bashOutputRawFields;
    case killShellArgsGoStructType:
      return killShellRawFields;
    case waitArgsGoStructType:
      return waitRawFields;
    default:
      return {};
  }
}

function normalizeRawObjectArgs(rawText: string, goStructType: string, fields: Record<string, RawObjectFieldKind>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let firstTypeError: string | undefined;
  const kind = new GoRawJSONUnmarshaller(rawText, (key, value) => {
    const field = key.toLowerCase();
    const fieldKind = fields[field];
    if (fieldKind === undefined || value.kind === "null") {
      return;
    }
    const decoded = rawObjectFieldValue(value, field, fieldKind);
    if (decoded.typeError !== undefined) {
      firstTypeError ??= decoded.typeError;
      return;
    }
    out[field] = decoded.value;
  }).unmarshal();
  if (kind !== "object" && kind !== "null") {
    throw invalidArgs(`json: cannot unmarshal ${kind === "bool" ? "bool" : kind} into Go value of type ${goStructType}`);
  }
  if (firstTypeError !== undefined) {
    throw invalidArgs(firstTypeError);
  }
  return out;
}

function normalizeStructuredObjectArgs(raw: Record<string, unknown>, fields: Record<string, RawObjectFieldKind>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let firstTypeError: string | undefined;
  for (const key of Object.keys(raw)) {
    const field = key.toLowerCase();
    const fieldKind = fields[field];
    if (fieldKind === undefined) {
      continue;
    }
    const value = raw[key];
    if (value === undefined || value === null) {
      continue;
    }
    const decoded = structuredObjectFieldValue(value, field, fieldKind);
    if (decoded.typeError !== undefined) {
      firstTypeError ??= decoded.typeError;
      continue;
    }
    out[field] = decoded.value;
  }
  if (firstTypeError !== undefined) {
    throw invalidArgs(firstTypeError);
  }
  return out;
}

function structuredObjectFieldValue(value: unknown, field: string, fieldKind: RawObjectFieldKind): RawObjectFieldResult {
  if (fieldKind === "string") {
    return typeof value === "string" ? { value: replaceIsolatedSurrogates(value) } : { typeError: goJSONTypeError(value, field, "string") };
  }
  if (fieldKind === "int") {
    return typeof value === "number" && Number.isInteger(value) && isGoIntLiteral(String(value))
      ? { value }
      : { typeError: goJSONTypeError(value, field, "int") };
  }
  if (!Array.isArray(value)) {
    return { typeError: `json: cannot unmarshal ${goJSONTokenKind(value)} into Go struct field .${field} of type []string` };
  }
  const out: string[] = [];
  for (const item of value) {
    if (item === null) {
      out.push("");
    } else if (typeof item === "string") {
      out.push(replaceIsolatedSurrogates(item));
    } else {
      return { typeError: `json: cannot unmarshal ${goJSONTokenKind(item)} into Go struct field .${field} of type string` };
    }
  }
  return { value: out };
}

function rawObjectFieldValue(value: ParsedRawJSONValue, field: string, fieldKind: RawObjectFieldKind): RawObjectFieldResult {
  if (fieldKind === "string") {
    return value.kind === "string"
      ? { value: value.stringValue ?? "" }
      : { typeError: goJSONTypeError(parsedJSONValueForError(value), field, "string", value.raw) };
  }
  if (fieldKind === "int") {
    if (value.kind !== "number") {
      return { typeError: goJSONTypeError(parsedJSONValueForError(value), field, "int", value.raw) };
    }
    if (!isGoIntLiteral(value.raw)) {
      return { typeError: goJSONTypeError(0, field, "int", value.raw) };
    }
    return { value: Number(value.raw) };
  }
  if (value.kind !== "array") {
    return { typeError: `json: cannot unmarshal ${value.kind === "bool" ? "bool" : value.kind} into Go struct field .${field} of type []string` };
  }
  const array = rawStringArrayField(value, field);
  return array.typeError !== undefined ? { typeError: array.typeError } : { value: array.value };
}

function rawStringArrayField(value: ParsedRawJSONValue, field: string): { value: string[]; typeError?: undefined } | { value?: undefined; typeError: string } {
  const items = JSON.parse(value.raw) as unknown[];
  const out: string[] = [];
  for (const item of items) {
    if (item === null) {
      out.push("");
    } else if (typeof item === "string") {
      out.push(replaceIsolatedSurrogates(item));
    } else {
      return { typeError: `json: cannot unmarshal ${goJSONTokenKind(item)} into Go struct field .${field} of type string` };
    }
  }
  return { value: out };
}

function stringField(value: Record<string, unknown>, field: string): { value: string; typeError?: string } {
  const fieldValue = value[field];
  if (fieldValue === undefined || fieldValue === null) {
    return { value: "" };
  }
  if (typeof fieldValue === "string") {
    return { value: replaceIsolatedSurrogates(fieldValue) };
  }
  return { value: "", typeError: goJSONTypeError(fieldValue, field, "string") };
}

function stringArrayField(value: Record<string, unknown>, field: string): { value: string[]; typeError?: string } {
  const fieldValue = value[field];
  if (fieldValue === undefined || fieldValue === null) {
    return { value: [] };
  }
  if (!Array.isArray(fieldValue)) {
    return { value: [], typeError: `json: cannot unmarshal ${goJSONTokenKind(fieldValue)} into Go struct field .${field} of type []string` };
  }
  const out: string[] = [];
  for (const item of fieldValue) {
    if (item === null) {
      out.push("");
    } else if (typeof item === "string") {
      out.push(replaceIsolatedSurrogates(item));
    } else {
      return { value: [], typeError: `json: cannot unmarshal ${goJSONTokenKind(item)} into Go struct field .${field} of type string` };
    }
  }
  return { value: out };
}

function intField(value: Record<string, unknown>, field: string): { value: number; typeError?: string } {
  const fieldValue = value[field];
  if (fieldValue === undefined || fieldValue === null) {
    return { value: 0 };
  }
  if (typeof fieldValue === "number" && Number.isInteger(fieldValue)) {
    return { value: fieldValue };
  }
  return { value: 0, typeError: goJSONTypeError(fieldValue, field, "int") };
}

function foregroundTimeoutMs(timeoutSeconds: number): number {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return 0;
  }
  return Math.max(1, Math.round(timeoutSeconds * 1000));
}

async function runShellCommand(options: {
  shell: ReasonixResolvedShell;
  command: string;
  workDir: string;
  preserveBackgroundProcesses: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (chunk: Uint8Array) => void;
  captureOutput?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<RunShellResult> {
  if (options.signal?.aborted === true) {
    return { output: "", code: null, signal: null, timedOut: false, canceled: true, waitDelayExpired: false };
  }

  const argv = shellArgv(options.shell, options.command);
  const child = spawn(argv[0], argv.slice(1), {
    cwd: options.workDir === "" ? undefined : options.workDir,
    env: bashCommandEnv(options.env),
    detached: process.platform !== "win32",
    windowsHide: true
  });

  return await new Promise<RunShellResult>((resolve) => {
    const captureOutput = options.captureOutput !== false;
    const chunks: Buffer[] = [];
    let timedOut = false;
    let canceled = false;
    let spawnError: Error | undefined;
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let waitDelayTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (waitDelayTimer !== undefined) {
        clearTimeout(waitDelayTimer);
      }
      options.signal?.removeEventListener("abort", abortListener);
    };

    const finish = (result: RunShellResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const output = (): string => (captureOutput ? Buffer.concat(chunks).toString("utf8") : "");
    const killTree = (): void => {
      killProcessTree(child);
    };
    const closeStdio = (): void => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const reapIfNeeded = (): void => {
      if (shouldReapAfterRun(options.shell, options.command, options.preserveBackgroundProcesses, timedOut || canceled)) {
        killTree();
      }
    };
    const finishRun = (waitDelayExpired: boolean): void => {
      reapIfNeeded();
      finish({
        output: output(),
        code: exitCode,
        signal: exitSignal,
        spawnError,
        timedOut,
        canceled,
        waitDelayExpired: waitDelayExpired && !(options.preserveBackgroundProcesses && !timedOut && !canceled)
      });
    };

    const timer =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree();
          }, options.timeoutMs)
        : undefined;

    const abortListener = (): void => {
      canceled = true;
      killTree();
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });

    const appendOutput = (chunk: Buffer): void => {
      if (captureOutput) {
        chunks.push(chunk);
      }
      options.onOutput?.(chunk);
    };
    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    child.on("error", (error) => {
      spawnError = error;
      finish({
        output: output(),
        code: null,
        signal: null,
        spawnError,
        timedOut,
        canceled,
        waitDelayExpired: false
      });
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      waitDelayTimer = setTimeout(() => {
        closeStdio();
        finishRun(true);
      }, bashWaitDelayMs);
    });
    child.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      finishRun(false);
    });
  });
}

function shouldReapAfterRun(
  shell: ReasonixResolvedShell,
  command: string,
  preserveBackgroundProcesses: boolean,
  canceledOrTimedOut: boolean
): boolean {
  if (canceledOrTimedOut) {
    return true;
  }
  if (preserveBackgroundProcesses) {
    return false;
  }
  return shell.kind !== "bash" || !hasExplicitBackgroundKeepalive(command);
}

function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    return;
  }

  if (process.platform === "win32") {
    killWindowsProcessTree(pid);
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best effort, matching Reasonix's cleanup posture when the process is already gone.
    }
  }
}

function killWindowsProcessTree(rootPid: number): void {
  const pids = collectWindowsProcessTree(rootPid);
  for (const pid of pids.reverse()) {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
  }
}

function collectWindowsProcessTree(rootPid: number): number[] {
  const seen = new Set<number>();
  const visit = (pid: number): void => {
    if (seen.has(pid) || pid <= 0) {
      return;
    }
    seen.add(pid);
    for (const childPid of windowsChildPids(pid)) {
      visit(childPid);
    }
  };
  visit(rootPid);
  return [...seen];
}

function windowsChildPids(parentPid: number): number[] {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | ForEach-Object { $_.ProcessId }`
    ],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function formatExitStatus(result: RunShellResult): string {
  if (result.spawnError !== undefined) {
    return result.spawnError.message;
  }
  if (result.signal !== null) {
    return `signal: ${result.signal}`;
  }
  return `exit status ${result.code ?? 1}`;
}

function shellResultError(result: RunShellResult, timeoutMs: number): Error | undefined {
  if (result.timedOut) {
    return new Error(`command timed out (> ${formatGoDuration(timeoutMs)})`);
  }
  if (result.canceled) {
    return new Error("command exited: context canceled");
  }
  if (result.spawnError !== undefined) {
    return new Error(`command exited: ${result.spawnError.message}`);
  }
  if (result.code !== 0) {
    return new Error(`command exited: ${formatExitStatus(result)}`);
  }
  if (result.waitDelayExpired) {
    return new Error(`command exited: ${errWaitDelayMessage}`);
  }
  return undefined;
}

function backgroundShellResultError(result: RunShellResult): Error | undefined {
  if (result.canceled) {
    return new Error("context canceled");
  }
  if (result.spawnError !== undefined) {
    return new Error(result.spawnError.message);
  }
  if (result.code !== 0) {
    return new Error(formatExitStatus(result));
  }
  if (result.waitDelayExpired) {
    return new Error(errWaitDelayMessage);
  }
  return undefined;
}

function bashRunError(message: string, output: string): Error {
  const error = new Error(message) as Error & { output: string };
  error.output = output;
  return error;
}

function commandPreview(command: string): string {
  const trimmed = command.trim().replace(/\n/gu, " ");
  const chars = [...trimmed];
  return chars.length > 48 ? `${chars.slice(0, 48).join("")}…` : trimmed;
}

function compileFilter(pattern: string): RE2JS {
  try {
    return RE2JS.compile(pattern);
  } catch (error) {
    throw new Error(`invalid filter regexp: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function applyFilter(text: string, regexp: RE2JS): string {
  return text
    .split("\n")
    .filter((line) => regexp.test(line))
    .join("\n");
}

function formatWaitResult(result: BashJobResult): string {
  const label = result.label === "" ? result.id : `${result.id} (${result.label})`;
  const header = `[${label}] ${result.status}`;
  return result.output.trim() === "" ? header : `${header}\n${result.output}`;
}

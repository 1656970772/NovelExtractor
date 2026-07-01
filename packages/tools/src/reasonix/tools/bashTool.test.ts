import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const goBashStruct =
  'struct { Command string "json:\\"command\\""; RunInBackground bool "json:\\"run_in_background\\""; PreserveBackgroundProcesses bool "json:\\"preserve_background_processes\\"" }';

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Reasonix bash tool parity", () => {
  it("preserves Reasonix protocol metadata and Go struct JSON decoding", async () => {
    const { Workspace, createBashTool } = await import("../index");
    const tool = createBashTool(
      new Workspace({
        shell: { kind: "powershell", path: "powershell", supportsChaining: false }
      })
    );

    expect(tool.name).toBe("bash");
    expect(tool.readOnly()).toBe(false);
    expect(tool.schema()).toEqual({
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
    });

    await expect(tool.execute({})).rejects.toThrow("command is required");
    await expect(tool.execute(null)).rejects.toThrow("command is required");
    await expect(tool.execute("null")).rejects.toThrow("command is required");
    await expect(tool.execute('{"command":null}')).rejects.toThrow("command is required");
    await expect(tool.execute("1")).rejects.toThrow(`invalid args: json: cannot unmarshal number into Go value of type ${goBashStruct}`);
    await expect(tool.execute("{invalid")).rejects.toThrow("invalid args: invalid character 'i' looking for beginning of object key string");
    await expect(tool.execute('{"command":1}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal number into Go struct field .command of type string"
    );
    await expect(tool.execute('{"command":"","run_in_background":"yes"}')).rejects.toThrow(
      "invalid args: json: cannot unmarshal string into Go struct field .run_in_background of type bool"
    );
    await expect(tool.execute('{"COMMAND":"Write-Output ok","RUN_IN_BACKGROUND":true}')).rejects.toThrow(
      "background execution is not available in this context"
    );
    await expect(tool.execute('{"command":"Write-Output ok","command":null,"run_in_background":true}')).rejects.toThrow(
      "background execution is not available in this context"
    );
  });

  it("builds shell argv and normalizes only cmd.exe-style nul redirects", async () => {
    const { normalizeNulRedirect, shellArgv, shellSupportsChaining } = await import("../shell");

    expect(normalizeNulRedirect("echo hi 2>nul", "/dev/null")).toBe("echo hi 2>/dev/null");
    expect(normalizeNulRedirect("build >nul 2>&1", "/dev/null")).toBe("build >/dev/null 2>&1");
    expect(normalizeNulRedirect("go test 1>>NUL", "/dev/null")).toBe("go test 1>>/dev/null");
    expect(normalizeNulRedirect("x > nul", "$null")).toBe("x >$null");
    expect(normalizeNulRedirect("probe &>nul", "/dev/null")).toBe("probe &>/dev/null");
    expect(normalizeNulRedirect("echo nul && cat nul.txt && echo nullish", "/dev/null")).toBe(
      "echo nul && cat nul.txt && echo nullish"
    );

    expect(shellArgv({ kind: "bash", path: "bash" }, "echo hi 2>nul")).toEqual(["bash", "-c", "echo hi 2>/dev/null"]);
    expect(shellArgv({ kind: "powershell", path: "powershell" }, "echo hi 2>nul")).toEqual([
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;echo hi 2>$null"
    ]);
    expect(shellSupportsChaining({ kind: "powershell", path: "powershell.exe" })).toBe(false);
    expect(shellSupportsChaining({ kind: "powershell", path: "pwsh.exe" })).toBe(true);
    expect(shellSupportsChaining({ kind: "bash", path: "bash" })).toBe(true);
  });

  it("rejects Windows PowerShell chaining only when operators are unquoted", async () => {
    const { Workspace, createBashTool } = await import("../index");
    const tool = createBashTool(
      new Workspace({
        shell: { kind: "powershell", path: "powershell.exe", supportsChaining: false }
      })
    );

    await expect(tool.execute({ command: "echo a && echo b" })).rejects.toThrow("Windows PowerShell");
    await expect(tool.execute({ command: "echo a || echo b" })).rejects.toThrow("does not parse '&&' or '||'");
    await expect(tool.execute({ command: 'Write-Output "a && b"', run_in_background: true })).rejects.toThrow(
      "background execution is not available in this context"
    );
  });

  it("allows callers to override the bash subprocess environment without changing the default env", async () => {
    const shell = shellFixture();
    if (shell === undefined) {
      return;
    }
    const { Workspace, createBashTool } = await import("../index");
    const previous = process.env.NOVEL_EXTRACTOR_REASONIX_ENV_PROBE;
    process.env.NOVEL_EXTRACTOR_REASONIX_ENV_PROBE = "leaked-parent-env";
    const tool = createBashTool(
      new Workspace({
        dir: await scratchDir(),
        shell: shell.config
      })
    );

    try {
      const command =
        shell.config.kind === "powershell"
          ? 'if ($env:NOVEL_EXTRACTOR_REASONIX_ENV_PROBE) { Write-Output $env:NOVEL_EXTRACTOR_REASONIX_ENV_PROBE } else { Write-Output "missing-env" }'
          : 'printf "%s\\n" "${NOVEL_EXTRACTOR_REASONIX_ENV_PROBE:-missing-env}"';
      const sanitizedEnv = { ...process.env };
      delete sanitizedEnv.NOVEL_EXTRACTOR_REASONIX_ENV_PROBE;
      await expect(tool.execute({ command })).resolves.toContain("leaked-parent-env");
      await expect(tool.execute({ command }, { env: sanitizedEnv })).resolves.toContain("missing-env");
    } finally {
      if (previous === undefined) {
        delete process.env.NOVEL_EXTRACTOR_REASONIX_ENV_PROBE;
      } else {
        process.env.NOVEL_EXTRACTOR_REASONIX_ENV_PROBE = previous;
      }
    }
  });

  it("runs commands in the workspace and returns combined stdout/stderr", async () => {
    const powershell = powershellPath();
    if (powershell === undefined) {
      return;
    }
    const dir = await scratchDir();
    const { Workspace, createBashTool } = await import("../index");
    const tool = createBashTool(new Workspace({ dir, shell: { kind: "powershell", path: powershell, supportsChaining: false } }));

    await writeFile(path.join(dir, "input.txt"), "hello", "utf8");
    const out = await tool.execute({
      command: "Write-Output reasonix-ok; Write-Error reasonix-err; Write-Output (Get-Location).Path; Get-Content input.txt"
    });

    expect(out).toContain("reasonix-ok");
    expect(out).toContain("reasonix-err");
    expect(out).toContain(dir);
    expect(out).toContain("hello");
  });

  it("returns partial output with command exited errors on non-zero exit", async () => {
    const powershell = powershellPath();
    if (powershell === undefined) {
      return;
    }
    const { Workspace, createBashTool } = await import("../index");
    const tool = createBashTool(new Workspace({ shell: { kind: "powershell", path: powershell, supportsChaining: false } }));

    await expect(tool.execute({ command: "Write-Output before-exit; exit 7" })).rejects.toThrow("command exited:");
    await expect(tool.execute({ command: "Write-Output before-exit; exit 7" })).rejects.toMatchObject({
      output: expect.stringContaining("before-exit")
    });
  });

  it("enforces configured foreground timeout and surfaces partial output", async () => {
    const powershell = powershellPath();
    if (powershell === undefined) {
      return;
    }
    const { Workspace, createBashTool } = await import("../index");
    const tool = createBashTool(
      new Workspace({
        shell: { kind: "powershell", path: powershell, supportsChaining: false },
        bashTimeoutSeconds: 0.15
      })
    );

    await expect(tool.execute({ command: "Write-Output before-timeout; Start-Sleep -Seconds 5" })).rejects.toMatchObject({
      message: expect.stringContaining("command timed out (> 150ms)"),
      output: expect.stringContaining("before-timeout")
    });
  });

  it("aborts foreground commands promptly and cleans process trees", async () => {
    const powershell = powershellPath();
    if (powershell === undefined) {
      return;
    }
    const dir = await scratchDir();
    const childPidFile = path.join(dir, "child.pid");
    const quotedPidFile = childPidFile.replace(/'/gu, "''");
    const command =
      `$p = Start-Process -FilePath '${powershell.replace(/'/gu, "''")}' -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30' -PassThru; ` +
      `Set-Content -LiteralPath '${quotedPidFile}' -Value $p.Id; Start-Sleep -Seconds 30`;

    const { Workspace, createBashTool } = await import("../index");
    const tool = createBashTool(new Workspace({ dir, shell: { kind: "powershell", path: powershell, supportsChaining: false } }));
    const controller = new AbortController();
    const run = tool.execute({ command }, { signal: controller.signal });
    const childPid = await waitForPidFile(childPidFile);

    controller.abort();
    await expect(run).rejects.toThrow();
    await expectProcessGone(childPid);
  }, 15000);

  it("reaps ordinary foreground children unless preservation is explicit", async () => {
    const powershell = powershellPath();
    if (powershell === undefined) {
      return;
    }
    const dir = await scratchDir();
    const childPidFile = path.join(dir, "foreground-child.pid");
    const quotedPidFile = childPidFile.replace(/'/gu, "''");
    const command =
      `$p = Start-Process -FilePath '${powershell.replace(/'/gu, "''")}' -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30' -PassThru; ` +
      `Set-Content -LiteralPath '${quotedPidFile}' -Value $p.Id`;

    const { Workspace, createBashTool } = await import("../index");
    const tool = createBashTool(new Workspace({ dir, shell: { kind: "powershell", path: powershell, supportsChaining: false } }));

    await expect(tool.execute({ command })).resolves.toBe("");
    const childPid = await waitForPidFile(childPidFile);
    await expectProcessGone(childPid);
  }, 15000);

  it("parses login-shell PATH output, merges paths, and detects explicit POSIX keepalive intent", async () => {
    const { hasExplicitBackgroundKeepalive, mergePathLists, parseShellPATH } = await import("../shell");
    const marker = "__REASONIX_BASH_PATH__=";
    const sep = path.delimiter;

    expect(parseShellPATH(Buffer.from(`noise\r\n${marker}/early${sep}/bin\r\n${marker}/late\r\n`), marker)).toBe("/late");
    expect(parseShellPATH(Buffer.from("no marker\n"), marker)).toBe("");
    expect(mergePathLists(`/a${sep}/b`, `/b${sep}/c${sep}${sep}`)).toBe(`/a${sep}/b${sep}/c`);
    expect(hasExplicitBackgroundKeepalive("nohup python train.py >train.log 2>&1 &")).toBe(true);
    expect(hasExplicitBackgroundKeepalive("sleep 60 >/dev/null 2>&1 &")).toBe(false);
    expect(hasExplicitBackgroundKeepalive("echo 'nohup sleep 60 &' &")).toBe(false);
    expect(hasExplicitBackgroundKeepalive("> nohup echo done &")).toBe(false);
  });

  it("starts background bash jobs and reads/waits output through Reasonix job tools", async () => {
    const shell = shellFixture();
    if (shell === undefined) {
      return;
    }
    const dir = await scratchDir();
    const { BashJobManager, Workspace, createBashOutputTool, createBashTool, createWaitTool } = await import("../index");
    const manager = new BashJobManager();
    const context = { jobManager: manager, sessionId: "session-a" };
    const workspace = new Workspace({ dir, shell: shell.config });
    const bash = createBashTool(workspace);
    const bashOutput = createBashOutputTool(workspace);
    const wait = createWaitTool(workspace);

    try {
      const start = await bash.execute({ command: shell.backgroundHello, run_in_background: true }, context);
      expect(start).toMatch(/Started background job "bash-\d+"/u);
      expect(start).toContain("read new output with bash_output");
      const jobId = extractJobId(start);

      const waitOut = await wait.execute({ job_ids: [jobId], timeout_seconds: 10 }, context);
      expect(waitOut).toContain(`[${jobId}`);
      expect(waitOut).toContain("done");
      expect(waitOut).toContain("hello");

      const firstOutput = await bashOutput.execute({ job_id: jobId }, context);
      expect(firstOutput).toContain(`[${jobId}] done`);
      expect(firstOutput).toContain("hello");

      await expect(bashOutput.execute({ job_id: jobId }, context)).resolves.toBe(`[${jobId}] done\n(no new output)`);
    } finally {
      await manager.close();
    }
  }, 20000);

  it("starts background bash under manager root cancellation as killed without shell output", async () => {
    const shell = shellFixture();
    if (shell === undefined) {
      return;
    }
    const dir = await scratchDir();
    const { BashJobManager, Workspace, createBashTool, createWaitTool } = await import("../index");
    const manager = new BashJobManager();
    const context = { jobManager: manager, sessionId: "session-a" };
    manager.setActiveSessionPath("session-a", path.join(dir, "session.jsonl"));
    const workspace = new Workspace({ dir, shell: shell.config });
    const bash = createBashTool(workspace);
    const wait = createWaitTool(workspace);

    await manager.closeWithGrace(0);
    const start = await bash.execute({ command: shell.afterCloseOutput, run_in_background: true }, context);
    const jobId = extractJobId(start);
    const waited = await wait.execute({ job_ids: [jobId], timeout_seconds: 1 }, context);
    expect(waited).toContain(`[${jobId}`);
    expect(waited).toContain("killed");
    expect(waited).not.toMatch(/\r?\nafter-close/u);
  }, 20000);

  it("keeps complete background output visible to wait and first bash_output beyond the tail window", async () => {
    const shell = shellFixture();
    if (shell === undefined) {
      return;
    }
    const dir = await scratchDir();
    const { BashJobManager, Workspace, createBashOutputTool, createBashTool, createWaitTool } = await import("../index");
    const manager = new BashJobManager();
    const context = { jobManager: manager, sessionId: "session-a" };
    const workspace = new Workspace({ dir, shell: shell.config });
    const bash = createBashTool(workspace);
    const bashOutput = createBashOutputTool(workspace);
    const wait = createWaitTool(workspace);

    try {
      const waitJobId = extractJobId(await bash.execute({ command: shell.largeOutput, run_in_background: true }, context));
      const waitOut = await wait.execute({ job_ids: [waitJobId], timeout_seconds: 10 }, context);
      expect(waitOut).toContain(`[${waitJobId}`);
      expect(waitOut).toContain("done");
      expect(waitOut).toContain("HEAD-MARKER");
      expect(waitOut).toContain("TAIL-MARKER");

      const outputJobId = extractJobId(await bash.execute({ command: shell.largeOutput, run_in_background: true }, context));
      await wait.execute({ job_ids: [outputJobId], timeout_seconds: 10 }, context);
      const firstOutput = await bashOutput.execute({ job_id: outputJobId }, context);
      expect(firstOutput).toContain(`[${outputJobId}] done`);
      expect(firstOutput).toContain("HEAD-MARKER");
      expect(firstOutput).toContain("TAIL-MARKER");

      await expect(bashOutput.execute({ job_id: outputJobId }, context)).resolves.toBe(`[${outputJobId}] done\n(no new output)`);
    } finally {
      await manager.close();
    }
  }, 20000);

  it("persists completed background output to artifacts and releases in-memory buffers", async () => {
    const { BashJobManager, Workspace, createBashOutputTool, createWaitTool } = await import("../index");
    const manager = new BashJobManager();
    const context = { jobManager: manager, sessionId: "session-a" };
    const workspace = new Workspace({});
    const wait = createWaitTool(workspace);
    const bashOutput = createBashOutputTool(workspace);

    try {
      const payload = Buffer.concat([
        Buffer.from("HEAD-MARKER\n", "utf8"),
        Buffer.alloc(70 * 1024, "x"),
        Buffer.from("\nTAIL-MARKER\n", "utf8")
      ]);
      const job = manager.startForSession("session-a", "bash", "large", (jobContext) => {
        jobContext.write(payload);
        return "";
      });

      const waitOut = await wait.execute({ job_ids: [job.id], timeout_seconds: 1 }, context);
      expect(waitOut).toContain(`[${job.id} (large)] done`);
      expect(waitOut).toContain("HEAD-MARKER");
      expect(waitOut).toContain("TAIL-MARKER");

      const firstOutput = await bashOutput.execute({ job_id: job.id }, context);
      expect(firstOutput).toContain(`[${job.id}] done`);
      expect(firstOutput).toContain("HEAD-MARKER");
      expect(firstOutput).toContain("TAIL-MARKER");
      await expect(bashOutput.execute({ job_id: job.id }, context)).resolves.toBe(`[${job.id}] done\n(no new output)`);

      const stored = [...((manager as unknown as { jobs: Map<string, unknown> }).jobs.values())][0] as {
        artifactPath?: string;
        output?: Buffer;
        tail?: Buffer;
        result?: string;
      };
      expect(typeof stored.artifactPath).toBe("string");
      const artifact = await readFile(stored.artifactPath!, "utf8");
      expect(artifact).toContain("HEAD-MARKER");
      expect(artifact).toContain("TAIL-MARKER");
      expect(stored.output?.length ?? 0).toBe(0);
      expect(stored.tail?.length ?? 0).toBe(0);
      expect(stored.result ?? "").toBe("");
    } finally {
      await manager.close();
    }
  });

  it("preserves UTF-8 bytes split across background output chunks for wait and bash_output", async () => {
    const { BashJobManager, Workspace, createBashOutputTool, createWaitTool } = await import("../index");
    const manager = new BashJobManager();
    const context = { jobManager: manager, sessionId: "session-a" };
    const workspace = new Workspace({});
    const wait = createWaitTool(workspace);
    const bashOutput = createBashOutputTool(workspace);

    try {
      const job = manager.startForSession("session-a", "bash", "utf8", (jobContext) => {
        jobContext.write(Uint8Array.from([0xe4]));
        jobContext.write(Uint8Array.from([0xb8, 0xad]));
        return "";
      });

      await expect(wait.execute({ job_ids: [job.id], timeout_seconds: 1 }, context)).resolves.toBe(`[${job.id} (utf8)] done\n中`);
      await expect(bashOutput.execute({ job_id: job.id }, context)).resolves.toBe(`[${job.id}] done\n中`);
    } finally {
      await manager.close();
    }
  });

  it("drains background completion notes once per session like Reasonix", async () => {
    const { BashJobManager } = await import("../index");
    const manager = new BashJobManager();
    const drains = manager as unknown as {
      drainCompletedNote?: () => string;
      drainCompletedNoteForSession?: (sessionId: string) => string;
    };

    expect(typeof drains.drainCompletedNote).toBe("function");
    expect(typeof drains.drainCompletedNoteForSession).toBe("function");

    let releaseRunning!: () => void;
    const running = manager.startForSession(
      "session-a",
      "bash",
      "running",
      () =>
        new Promise<string>((resolve) => {
          releaseRunning = () => resolve("");
        })
    );
    expect(drains.drainCompletedNoteForSession?.("session-a")).toBe("");
    releaseRunning();
    await manager.waitForSession(undefined, "session-a", [running.id], 1);
    expect(drains.drainCompletedNoteForSession?.("session-a")).toBe(completionNote(`${running.id} (running) \u2014 done`));
    expect(drains.drainCompletedNoteForSession?.("session-a")).toBe("");

    const sessionA = manager.startForSession("session-a", "bash", "a", () => "");
    const sessionB = manager.startForSession("session-b", "bash", "b", () => "");
    await manager.waitForSession(undefined, "session-a", [sessionA.id], 1);
    await manager.waitForSession(undefined, "session-b", [sessionB.id], 1);
    expect(drains.drainCompletedNoteForSession?.("session-a")).toBe(completionNote(`${sessionA.id} (a) \u2014 done`));
    expect(drains.drainCompletedNoteForSession?.("session-b")).toBe(completionNote(`${sessionB.id} (b) \u2014 done`));

    const failed = manager.startForSession("session-a", "bash", "bad", () => {
      throw new Error("boom");
    });
    await manager.waitForSession(undefined, "session-a", [failed.id], 1);
    expect(drains.drainCompletedNoteForSession?.("session-a")).toBe(completionNote(`${failed.id} (bad) \u2014 failed`));

    const killed = manager.startForSession(
      "session-a",
      "bash",
      "stop",
      ({ signal }) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve(""), { once: true });
        })
    );
    expect(manager.killForSession("session-a", killed.id)).toBe(true);
    await manager.waitForSession(undefined, "session-a", [killed.id], 1);
    expect(drains.drainCompletedNoteForSession?.("session-a")).toBe(completionNote(`${killed.id} (stop) \u2014 killed`));
    expect(drains.drainCompletedNoteForSession?.("session-a")).toBe("");

    const unscopedA = manager.startForSession("session-a", "bash", "all-a", () => "");
    const unscopedB = manager.startForSession("session-b", "bash", "all-b", () => "");
    await manager.waitForSession(undefined, "session-a", [unscopedA.id], 1);
    await manager.waitForSession(undefined, "session-b", [unscopedB.id], 1);
    expect(drains.drainCompletedNote?.()).toBe(
      completionNote(`${unscopedA.id} (all-a) \u2014 done`, `${unscopedB.id} (all-b) \u2014 done`)
    );
    expect(drains.drainCompletedNote?.()).toBe("");

    await manager.close();
  });

  it("consumes unread output before reporting an invalid bash_output filter", async () => {
    const { BashJobManager, Workspace, createBashOutputTool, createWaitTool } = await import("../index");
    const manager = new BashJobManager();
    const workspace = new Workspace({});
    const context = { jobManager: manager, sessionId: "session-a" };
    const wait = createWaitTool(workspace);
    const bashOutput = createBashOutputTool(workspace);
    try {
      const job = manager.startForSession("session-a", "bash", "filter", ({ write }) => {
        write("alpha\n");
        return "";
      });
      await wait.execute({ job_ids: [job.id], timeout_seconds: 1 }, context);

      await expect(bashOutput.execute({ job_id: job.id, filter: "[" }, context)).rejects.toThrow(/^invalid filter regexp: /u);
      await expect(bashOutput.execute({ job_id: job.id }, context)).resolves.toBe(`[${job.id}] done\n(no new output)`);
    } finally {
      await manager.close();
    }
  });

  it("returns after the Reasonix wait delay when preserved children keep stdio pipes open", async () => {
    const powershell = powershellPath();
    if (powershell === undefined) {
      return;
    }
    const dir = await scratchDir();
    const helperPath = path.join(dir, "hold-stdio.js");
    await writeFile(helperPath, "setTimeout(() => process.stdout.write('late-after-delay\\n'), 6500);\n", "utf8");
    const command =
      "$psi = [System.Diagnostics.ProcessStartInfo]::new(); " +
      `$psi.FileName = '${escapePowerShellSingleQuoted(process.execPath)}'; ` +
      `$psi.Arguments = '${escapePowerShellSingleQuoted(helperPath)}'; ` +
      `$psi.WorkingDirectory = '${escapePowerShellSingleQuoted(process.cwd())}'; ` +
      "$psi.UseShellExecute = $false; " +
      "[System.Diagnostics.Process]::Start($psi) | Out-Null";

    const { Workspace, createBashTool } = await import("../index");
    const tool = createBashTool(
      new Workspace({
        dir,
        shell: { kind: "powershell", path: powershell, supportsChaining: false },
        bashTimeoutSeconds: 10
      })
    );

    const startedAt = Date.now();
    const output = await tool.execute({ command, preserve_background_processes: true });
    const elapsedMs = Date.now() - startedAt;

    expect(output).not.toContain("late-after-delay");
    expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
    expect(elapsedMs).toBeLessThan(6_000);
  }, 15000);

  it("does not concatenate full stdout when a background bash command fails", async () => {
    const shell = shellFixture();
    if (shell === undefined) {
      return;
    }
    const dir = await scratchDir();
    const { BashJobManager, Workspace, createBashTool, createWaitTool } = await import("../index");
    const manager = new BashJobManager();
    const context = { jobManager: manager, sessionId: "session-a" };
    const workspace = new Workspace({ dir, shell: shell.config });
    const bash = createBashTool(workspace);
    const wait = createWaitTool(workspace);
    const originalConcat = Buffer.concat;
    let sawFullBackgroundCapture = false;
    const sentinel = "BACKGROUND-CAPTURE-SENTINEL";
    const concatSpy = vi.spyOn(Buffer, "concat").mockImplementation((list: readonly Uint8Array[], totalLength?: number) => {
      if (list.length === 1 && Buffer.from(list[0]).toString("utf8").includes(sentinel)) {
        sawFullBackgroundCapture = true;
      }
      return originalConcat(list, totalLength);
    });

    try {
      const jobId = extractJobId(await bash.execute({ command: shell.backgroundFailWithOutput(sentinel), run_in_background: true }, context));
      const waited = await wait.execute({ job_ids: [jobId], timeout_seconds: 10 }, context);

      expect(waited).toContain(`[${jobId}`);
      expect(waited).toContain("failed");
      expect(waited).toContain(sentinel);
      expect(waited).toContain("exit status 7");
      expect(sawFullBackgroundCapture).toBe(false);
    } finally {
      concatSpy.mockRestore();
      await manager.close();
    }
  }, 20000);

  it("checks bash_output job existence before compiling filters", async () => {
    const { BashJobManager, Workspace, createBashOutputTool } = await import("../index");
    const manager = new BashJobManager();
    const workspace = new Workspace({});
    const context = { jobManager: manager, sessionId: "session-a" };
    try {
      await expect(createBashOutputTool(workspace).execute({ job_id: "bash-missing", filter: "[" }, context)).rejects.toThrow(
        'no background job "bash-missing"'
      );
    } finally {
      await manager.close();
    }
  });

  it("does not compile bash_output filters when there is no new output", async () => {
    const { BashJobManager, Workspace, createBashOutputTool, createWaitTool } = await import("../index");
    const manager = new BashJobManager();
    const workspace = new Workspace({});
    const context = { jobManager: manager, sessionId: "session-a" };
    const wait = createWaitTool(workspace);
    const bashOutput = createBashOutputTool(workspace);
    try {
      const job = manager.startForSession("session-a", "bash", "filter-empty", ({ write }) => {
        write("alpha\n");
        return "";
      });
      await wait.execute({ job_ids: [job.id], timeout_seconds: 1 }, context);
      await expect(bashOutput.execute({ job_id: job.id }, context)).resolves.toContain("alpha");
      await expect(bashOutput.execute({ job_id: job.id, filter: "[" }, context)).resolves.toBe(`[${job.id}] done\n(no new output)`);
    } finally {
      await manager.close();
    }
  });

  it("filters background output, reports wait timeout progress, and kills running jobs", async () => {
    const shell = shellFixture();
    if (shell === undefined) {
      return;
    }
    const dir = await scratchDir();
    const { BashJobManager, Workspace, createBashOutputTool, createBashTool, createKillShellTool, createWaitTool } = await import("../index");
    const manager = new BashJobManager();
    const context = { jobManager: manager, sessionId: "session-a" };
    const workspace = new Workspace({ dir, shell: shell.config });
    const bash = createBashTool(workspace);
    const bashOutput = createBashOutputTool(workspace);
    const wait = createWaitTool(workspace);
    const killShell = createKillShellTool(workspace);

    try {
      const filterJobId = extractJobId(await bash.execute({ command: shell.alphaBeta, run_in_background: true }, context));
      await wait.execute({ job_ids: [filterJobId], timeout_seconds: 10 }, context);
      const filtered = await bashOutput.execute({ job_id: filterJobId, filter: "beta" }, context);
      expect(filtered).toContain(`[${filterJobId}] done`);
      expect(filtered).toContain("beta");
      expect(filtered).not.toContain("alpha");
      await expect(bashOutput.execute({ job_id: filterJobId, filter: "(?m)^beta" }, context)).resolves.toBe(
        `[${filterJobId}] done\n(no new output)`
      );

      const inlineFlagJobId = extractJobId(await bash.execute({ command: shell.alphaBeta, run_in_background: true }, context));
      await wait.execute({ job_ids: [inlineFlagJobId], timeout_seconds: 10 }, context);
      const inlineFlagFiltered = await bashOutput.execute({ job_id: inlineFlagJobId, filter: "(?m)^beta" }, context);
      expect(inlineFlagFiltered).toContain(`[${inlineFlagJobId}] done`);
      expect(inlineFlagFiltered).toContain("beta");
      expect(inlineFlagFiltered).not.toContain("alpha");

      const invalidFilterJobId = extractJobId(await bash.execute({ command: shell.alphaBeta, run_in_background: true }, context));
      await wait.execute({ job_ids: [invalidFilterJobId], timeout_seconds: 10 }, context);
      await expect(bashOutput.execute({ job_id: invalidFilterJobId, filter: "[" }, context)).rejects.toThrow(/^invalid filter regexp: /u);

      const unsupportedFilterJobId = extractJobId(await bash.execute({ command: shell.alphaBeta, run_in_background: true }, context));
      await wait.execute({ job_ids: [unsupportedFilterJobId], timeout_seconds: 10 }, context);
      await expect(bashOutput.execute({ job_id: unsupportedFilterJobId, filter: "(?<=a)b" }, context)).rejects.toThrow(
        /^invalid filter regexp: /u
      );

      const timeoutJobId = extractJobId(await bash.execute({ command: shell.longWithOutput, run_in_background: true }, context));
      const timed = await wait.execute({ job_ids: [timeoutJobId], timeout_seconds: 1 }, context);
      expect(timed).toContain(`[${timeoutJobId}`);
      expect(timed).toContain("running");
      expect(timed).toContain("before-wait-timeout");
      expect(await killShell.execute({ job_id: timeoutJobId }, context)).toBe(`Killed background job "${timeoutJobId}".`);
      const killed = await wait.execute({ job_ids: [timeoutJobId], timeout_seconds: 10 }, context);
      expect(killed).toContain("killed");

      expect(await killShell.execute({ job_id: "bash-missing" }, context)).toBe(
        'Background job "bash-missing" was not running (already finished or unknown).'
      );
      await expect(bashOutput.execute({ job_id: "bash-missing" }, context)).rejects.toThrow('no background job "bash-missing"');
    } finally {
      await manager.close();
    }
  }, 25000);

  it("matches Reasonix background bash failure result text", async () => {
    const shell = shellFixture();
    if (shell === undefined) {
      return;
    }
    const dir = await scratchDir();
    const { BashJobManager, Workspace, createBashTool, createWaitTool } = await import("../index");
    const manager = new BashJobManager();
    const context = { jobManager: manager, sessionId: "session-a" };
    const workspace = new Workspace({ dir, shell: shell.config });
    const bash = createBashTool(workspace);
    const wait = createWaitTool(workspace);

    try {
      const jobId = extractJobId(await bash.execute({ command: shell.exitSeven, run_in_background: true }, context));
      await expect(wait.execute({ job_ids: [jobId], timeout_seconds: 10 }, context)).resolves.toBe(
        `[${jobId} (${shell.exitSeven})] failed\nexit status 7`
      );
    } finally {
      await manager.close();
    }
  }, 20000);

  it("reports background job tool errors without a manager and waits no-op jobs like Reasonix", async () => {
    const { Workspace, createBashOutputTool, createKillShellTool, createWaitTool } = await import("../index");
    const workspace = new Workspace({});

    await expect(createBashOutputTool(workspace).execute({ job_id: "bash-1" })).rejects.toThrow(
      "background jobs are not available in this context"
    );
    await expect(createWaitTool(workspace).execute({})).rejects.toThrow("background jobs are not available in this context");
    await expect(createKillShellTool(workspace).execute({ job_id: "bash-1" })).rejects.toThrow(
      "background jobs are not available in this context"
    );

    const { BashJobManager } = await import("../index");
    const manager = new BashJobManager();
    try {
      await expect(createWaitTool(workspace).execute({}, { jobManager: manager })).resolves.toBe("No background jobs to wait for.");
      await expect(createWaitTool(workspace).execute("", { jobManager: manager })).resolves.toBe("No background jobs to wait for.");
      await expect(createWaitTool(workspace).execute(new Uint8Array(), { jobManager: manager })).resolves.toBe(
        "No background jobs to wait for."
      );

      let release!: () => void;
      const job = manager.startForSession("", "bash", "raw-empty", ({ write }) => {
        write("raw-empty");
        return new Promise<string>((resolve) => {
          release = () => resolve("");
        });
      });
      const waitRun = createWaitTool(workspace).execute("", { jobManager: manager });
      setTimeout(() => release(), 10);
      const waited = await waitRun;
      expect(waited).toContain(`[${job.id} (raw-empty)] done`);
      expect(waited).toContain("raw-empty");
    } finally {
      await manager.close();
    }
  });

  it("preserves Go JSON duplicate-field type errors for background job tools", async () => {
    const { BashJobManager, Workspace, createBashOutputTool, createKillShellTool, createWaitTool } = await import("../index");
    const manager = new BashJobManager();
    const workspace = new Workspace({});
    const context = { jobManager: manager };

    try {
      await expect(createBashOutputTool(workspace).execute('{"job_id":1,"job_id":"bash-1"}', context)).rejects.toThrow(
        "invalid args: json: cannot unmarshal number into Go struct field .job_id of type string"
      );
      await expect(createKillShellTool(workspace).execute('{"job_id":1,"job_id":"bash-1"}', context)).rejects.toThrow(
        "invalid args: json: cannot unmarshal number into Go struct field .job_id of type string"
      );
      await expect(createWaitTool(workspace).execute('{"job_ids":1,"job_ids":["bash-1"]}', context)).rejects.toThrow(
        "invalid args: json: cannot unmarshal number into Go struct field .job_ids of type []string"
      );
      await expect(createWaitTool(workspace).execute('{"job_ids":[1],"job_ids":["bash-1"]}', context)).rejects.toThrow(
        "invalid args: json: cannot unmarshal number into Go struct field .job_ids of type string"
      );
      await expect(createWaitTool(workspace).execute('{"timeout_seconds":"bad","timeout_seconds":1}', context)).rejects.toThrow(
        "invalid args: json: cannot unmarshal string into Go struct field .timeout_seconds of type int"
      );
      await expect(createBashOutputTool(workspace).execute({ JOB_ID: 1, job_id: "bash-1" }, context)).rejects.toThrow(
        "invalid args: json: cannot unmarshal number into Go struct field .job_id of type string"
      );
      await expect(createKillShellTool(workspace).execute({ JOB_ID: 1, job_id: "bash-1" }, context)).rejects.toThrow(
        "invalid args: json: cannot unmarshal number into Go struct field .job_id of type string"
      );
      await expect(createWaitTool(workspace).execute({ JOB_IDS: 1, job_ids: ["bash-1"] }, context)).rejects.toThrow(
        "invalid args: json: cannot unmarshal number into Go struct field .job_ids of type []string"
      );
      await expect(createWaitTool(workspace).execute({ timeout_seconds: Number.MAX_SAFE_INTEGER * 4096 }, context)).rejects.toThrow(
        "invalid args: json: cannot unmarshal number into Go struct field .timeout_seconds of type int"
      );
    } finally {
      await manager.close();
    }
  });
});

interface ShellFixture {
  config: { kind: "bash" | "powershell"; path: string; supportsChaining?: boolean };
  backgroundHello: string;
  afterCloseOutput: string;
  alphaBeta: string;
  largeOutput: string;
  longWithOutput: string;
  exitSeven: string;
  backgroundFailWithOutput(sentinel: string): string;
}

function powershellPath(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  for (const name of ["powershell", "pwsh"]) {
    const result = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
    const first = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line !== "");
    if (result.status === 0 && first !== undefined) {
      return first;
    }
  }
  return undefined;
}

function shellFixture(): ShellFixture | undefined {
  const powershell = powershellPath();
  if (powershell !== undefined) {
    return {
      config: { kind: "powershell", path: powershell, supportsChaining: false },
      backgroundHello: "Write-Output hello; Start-Sleep -Milliseconds 300",
      afterCloseOutput: "Write-Output after-close",
      alphaBeta: "Write-Output alpha; Write-Output beta",
      largeOutput: "Write-Output 'HEAD-MARKER'; [Console]::Out.Write(('x' * 70000)); Write-Output ''; Write-Output 'TAIL-MARKER'",
      longWithOutput: "Write-Output before-wait-timeout; Start-Sleep -Seconds 30",
      exitSeven: "exit 7",
      backgroundFailWithOutput: (sentinel: string) => `Write-Output '${escapePowerShellSingleQuoted(sentinel)}'; exit 7`
    };
  }
  if (process.platform !== "win32") {
    return {
      config: { kind: "bash", path: "sh" },
      backgroundHello: "printf 'hello\\n'; sleep 0.3",
      afterCloseOutput: "printf 'after-close\\n'",
      alphaBeta: "printf 'alpha\\nbeta\\n'",
      largeOutput: `${posixSingleQuote(process.execPath)} -e ${posixSingleQuote("process.stdout.write('HEAD-MARKER\\n' + 'x'.repeat(70000) + '\\nTAIL-MARKER\\n')")}`,
      longWithOutput: "printf 'before-wait-timeout\\n'; sleep 30",
      exitSeven: "exit 7",
      backgroundFailWithOutput: (sentinel: string) => `printf '%s\\n' ${posixSingleQuote(sentinel)}; exit 7`
    };
  }
  return undefined;
}

function escapePowerShellSingleQuoted(text: string): string {
  return text.replace(/'/gu, "''");
}

function posixSingleQuote(text: string): string {
  return `'${text.replace(/'/gu, "'\\''")}'`;
}

function extractJobId(text: string): string {
  const match = /"(?<id>bash-\d+)"/u.exec(text);
  if (match?.groups?.id === undefined) {
    throw new Error(`missing bash job id in ${text}`);
  }
  return match.groups.id;
}

function completionNote(...items: string[]): string {
  return `Background job updates since your last message: ${items.join("; ")}. Read their output with bash_output or wait if you still need it.`;
}

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reasonix-bash-"));
  scratchDirs.push(dir);
  return dir;
}

async function waitForPidFile(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // keep polling
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for child pid file ${pidFile}`);
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!windowsProcessAlive(pid)) {
      return;
    }
    await sleep(50);
  }
  killWindowsPID(pid);
  throw new Error(`child process ${pid} survived bash cleanup`);
}

function windowsProcessAlive(pid: number): boolean {
  const result = spawnSync("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`
  ]);
  return result.status === 0;
}

function killWindowsPID(pid: number): void {
  spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

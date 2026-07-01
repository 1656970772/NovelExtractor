import {
  closeSync,
  copyFileSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Dirent
} from "node:fs";
import os from "node:os";
import path from "node:path";

export type BashJobStatus = "running" | "done" | "failed" | "killed";
export type BashJobNoticeLevel = "info" | "warn";

export interface BashJobEvent {
  kind: "notice";
  level: BashJobNoticeLevel;
  text: string;
}

export interface BashJobEventSink {
  emit(event: BashJobEvent): void;
}

export interface BashJobManagerOptions {
  eventSink?: BashJobEventSink | ((event: BashJobEvent) => void);
  stalledWarningMs?: number;
  teardownGraceMs?: number;
}

export interface BashJobView {
  id: string;
  kind: string;
  label: string;
  status: BashJobStatus;
  startedAt: number;
}

export interface BashJobResult {
  id: string;
  kind: string;
  label: string;
  status: BashJobStatus;
  output: string;
}

export interface BashJobRunContext {
  signal: AbortSignal;
  write(chunk: string | Uint8Array): void;
}

export interface BashTeardownJob {
  id: string;
  kind: string;
  label: string;
  waitedMs: number;
}

export interface BashTeardownResult {
  timedOut: BashTeardownJob[];
  cause: "done" | "timeout" | "abort";
  hasTimedOut(): boolean;
}

interface BashTeardownTarget {
  info: Omit<BashTeardownJob, "waitedMs">;
  done: Promise<void>;
  isDone(): boolean;
}

export interface BashSessionTeardown {
  sessionId: string;
  targets: BashTeardownTarget[];
  isAsync(): boolean;
  donePromises(): Promise<void>[];
}

interface BashJob {
  id: string;
  kind: string;
  label: string;
  sessionId: string;
  status: BashJobStatus;
  tail: Buffer;
  output: Buffer;
  readOffset: number;
  result: string;
  resultRead: boolean;
  artifactPath: string;
  artifactMetaPath: string;
  artifactFd: number | undefined;
  artifactComplete: boolean;
  artifactErr: string;
  tombstone: boolean;
  startedAt: number;
  finishedAt: number;
  activityAt: number;
  runReturned: boolean;
  stalled: boolean;
  stalledTimer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
  controller: AbortController;
  done: Promise<void>;
  resolveDone(): void;
}

interface BashCompletionNote {
  sessionId: string;
  text: string;
}

interface ArtifactMeta {
  id: string;
  kind: string;
  label?: string;
  sessionId?: string;
  status: BashJobStatus;
  startedAt: number;
  finishedAt?: number;
  artifactComplete: boolean;
  artifactError?: string;
  logPath?: string;
}

const defaultTailBytes = 64 * 1024;
const defaultTeardownGraceMs = 15_000;
const jobLogExt = ".log";
const jobMetaExt = ".json";

export class BashJobManager {
  private seq = 0;
  private readonly jobs = new Map<string, BashJob>();
  private readonly order: string[] = [];
  private readonly tempRoot: string | undefined;
  private readonly tempRootErr: string;
  private readonly eventSink: BashJobEventSink;
  private readonly stalledWarningMs: number;
  private readonly teardownGraceMs: number;
  private readonly artifactDirs = new Map<string, string>();
  private readonly loaded = new Set<string>();
  private readonly destroying = new Set<string>();
  private completed: BashCompletionNote[] = [];
  private activeSession = "";
  private closed = false;
  private cleanupScheduled = false;

  constructor(options: BashJobManagerOptions = {}) {
    const artifactRoot = path.join(os.tmpdir(), "reasonix-bash-jobs-");
    let tempRoot: string | undefined;
    let tempRootErr = "";
    try {
      tempRoot = mkdtempSync(artifactRoot);
    } catch (error) {
      tempRootErr = errorMessage(error);
    }
    this.tempRoot = tempRoot;
    this.tempRootErr = tempRootErr;
    this.eventSink = normalizeEventSink(options.eventSink);
    this.stalledWarningMs = options.stalledWarningMs !== undefined && options.stalledWarningMs > 0 ? options.stalledWarningMs : 0;
    this.teardownGraceMs = options.teardownGraceMs !== undefined && options.teardownGraceMs >= 0 ? options.teardownGraceMs : defaultTeardownGraceMs;
  }

  startForSession(
    sessionId: string,
    kind: string,
    label: string,
    run: (context: BashJobRunContext) => Promise<string> | string
  ): BashJobView {
    const normalizedSession = sessionId.trim();
    this.seq += 1;
    const id = `${kind}-${this.seq}`;
    const controller = new AbortController();
    if (this.closed) {
      controller.abort();
    }
    const startedAt = Date.now();
    const artifact = this.openArtifact(normalizedSession, id);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const job: BashJob = {
      id,
      kind,
      label,
      sessionId: normalizedSession,
      status: "running",
      tail: Buffer.alloc(0),
      output: Buffer.alloc(0),
      readOffset: 0,
      result: "",
      resultRead: false,
      artifactPath: artifact.path,
      artifactMetaPath: artifact.metaPath,
      artifactFd: artifact.fd,
      artifactComplete: artifact.err === "",
      artifactErr: artifact.err,
      tombstone: false,
      startedAt,
      finishedAt: 0,
      activityAt: startedAt,
      runReturned: false,
      stalled: false,
      stalledTimer: undefined,
      settled: false,
      controller,
      done,
      resolveDone
    };
    this.jobs.set(jobKey(normalizedSession, id), job);
    this.order.push(jobKey(normalizedSession, id));

    this.emitIfActive(normalizedSession, { kind: "notice", level: "info", text: startedText(kind, id, label) });
    this.scheduleStalledCheck(job);
    void this.runJob(job, run);
    return this.view(job);
  }

  outputForSession(sessionId: string, id: string, consume = true): { text: string; status: BashJobStatus; found: boolean } {
    const job = this.find(sessionId, id);
    if (job === undefined) {
      return { text: "", status: "running", found: false };
    }
    let text = "";
    const shouldReadArtifact = canReadArtifactLog(job);
    let artifactReadFailed = false;
    if (shouldReadArtifact) {
      const artifact = this.readArtifactSinceOffset(job, consume);
      text = artifact.text;
      artifactReadFailed = !artifact.ok;
    }
    if (text === "" && (artifactReadFailed || !shouldReadArtifact) && job.readOffset < job.tail.length) {
      text = job.tail.subarray(job.readOffset).toString("utf8");
      if (consume) {
        job.readOffset = job.tail.length;
      }
    }
    if (text === "" && job.status !== "running" && job.result !== "" && !job.resultRead) {
      text = job.result;
      if (consume) {
        job.resultRead = true;
      }
    }
    return { text: appendArtifactWarning(text, job), status: job.status, found: true };
  }

  killForSession(sessionId: string, id: string): boolean {
    const job = this.find(sessionId, id);
    if (job === undefined || job.status !== "running") {
      return false;
    }
    job.status = "killed";
    job.controller.abort();
    return true;
  }

  async waitForSession(parentSignal: AbortSignal | undefined, sessionId: string, ids: readonly string[], timeoutSeconds: number): Promise<BashJobResult[]> {
    const targets = this.resolve(sessionId, ids);
    if (targets.length === 0) {
      return [];
    }

    const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise =
      timeoutMs > 0
        ? new Promise<"timeout">((resolve) => {
            timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
          })
        : undefined;
    let abortListener: (() => void) | undefined;
    const abortPromise =
      parentSignal === undefined
        ? undefined
        : new Promise<"abort">((resolve) => {
            if (parentSignal.aborted) {
              resolve("abort");
              return;
            }
            abortListener = () => resolve("abort");
            parentSignal.addEventListener("abort", abortListener, { once: true });
          });

    try {
      for (const job of targets) {
        if (job.settled) {
          continue;
        }
        const waits: Promise<unknown>[] = [job.done];
        if (timeoutPromise !== undefined) {
          waits.push(timeoutPromise);
        }
        if (abortPromise !== undefined) {
          waits.push(abortPromise);
        }
        const winner = await Promise.race(waits);
        if (winner === "timeout" || winner === "abort") {
          return targets.map((target) => this.result(target));
        }
      }
      return targets.map((target) => this.result(target));
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      if (parentSignal !== undefined && abortListener !== undefined) {
        parentSignal.removeEventListener("abort", abortListener);
      }
    }
  }

  runningForSession(sessionId: string): BashJobView[] {
    return this.order.flatMap((key) => {
      const job = this.jobs.get(key);
      if (job === undefined || !sessionMatches(sessionId, job.sessionId) || job.status !== "running") {
        return [];
      }
      return [this.view(job)];
    });
  }

  hasUnfinishedForSession(sessionId: string): boolean {
    return this.order.some((key) => {
      const job = this.jobs.get(key);
      return job !== undefined && sessionMatches(sessionId, job.sessionId) && !job.settled;
    });
  }

  drainCompletedNote(): string {
    return this.drainCompletedNoteForSession("");
  }

  drainCompletedNoteForSession(sessionId: string): string {
    const normalizedSession = sessionId.trim();
    const notes: string[] = [];
    if (normalizedSession === "") {
      for (const item of this.completed) {
        notes.push(item.text);
      }
      this.completed = [];
    } else {
      const remaining: BashCompletionNote[] = [];
      for (const item of this.completed) {
        if (item.sessionId === normalizedSession) {
          notes.push(item.text);
        } else {
          remaining.push(item);
        }
      }
      this.completed = remaining;
    }
    if (notes.length === 0) {
      return "";
    }
    return `Background job updates since your last message: ${notes.join("; ")}. Read their output with bash_output or wait if you still need it.`;
  }

  setActiveSession(sessionId: string): void {
    this.activeSession = sessionId.trim();
  }

  setActiveSessionPath(sessionId: string, sessionPath: string): void {
    const normalizedSession = sessionId.trim();
    const normalizedPath = sessionPath.trim();
    this.activeSession = normalizedSession;
    if (normalizedSession === "" || normalizedPath === "") {
      return;
    }

    const hadPersistentDir = this.artifactDirs.has(normalizedSession);
    let oldDir = this.artifactDirForSession(normalizedSession);
    const adoptDefault = !hadPersistentDir && this.hasUnscopedJobs();
    if (adoptDefault) {
      oldDir = this.artifactDirForSession("");
    }
    const newDir = sessionArtifactDir(normalizedPath);
    this.artifactDirs.set(normalizedSession, newDir);

    if (oldDir !== "" && newDir !== "" && path.resolve(oldDir) !== path.resolve(newDir)) {
      const oldSession = adoptDefault ? "" : normalizedSession;
      const migrateErr = this.migrateArtifactDirForSession(oldSession, oldDir, newDir);
      if (adoptDefault) {
        this.adoptUnscopedJobs(normalizedSession);
      }
      if (migrateErr !== "") {
        this.recordArtifactMigrationError(normalizedSession, migrateErr);
      }
    } else if (adoptDefault) {
      this.adoptUnscopedJobs(normalizedSession);
    }

    if (!this.loaded.has(normalizedSession)) {
      this.loadSessionArtifacts(normalizedSession, newDir);
    }
  }

  beginDestroySession(sessionId: string): BashSessionTeardown {
    const normalizedSession = sessionId.trim();
    if (normalizedSession === "") {
      return makeSessionTeardown("", []);
    }
    this.destroying.add(normalizedSession);
    this.completed = this.completed.filter((item) => item.sessionId !== normalizedSession);

    const targets: BashTeardownTarget[] = [];
    for (const key of this.order) {
      const job = this.jobs.get(key);
      if (job === undefined || !sessionMatches(normalizedSession, job.sessionId)) {
        continue;
      }
      if (job.status === "running") {
        job.status = "killed";
        job.controller.abort();
        targets.push(teardownTarget(job));
      } else if (job.status === "killed" && !job.settled) {
        targets.push(teardownTarget(job));
      }
    }
    return makeSessionTeardown(normalizedSession, targets);
  }

  destroySession(sessionId: string): Promise<void>[] {
    return this.beginDestroySession(sessionId).donePromises();
  }

  async waitTeardown(parentSignal: AbortSignal | undefined, handle: BashSessionTeardown, graceMs: number): Promise<BashTeardownResult> {
    const result = await waitTeardownTargets(parentSignal, handle.targets, graceMs);
    if (result.hasTimedOut()) {
      this.emitTeardownTimeout(`destroy session ${handle.sessionId}`, result);
    }
    return result;
  }

  isDestroying(sessionId: string): boolean {
    const normalizedSession = sessionId.trim();
    return normalizedSession !== "" && this.destroying.has(normalizedSession);
  }

  finishDestroySession(sessionId: string): void {
    const normalizedSession = sessionId.trim();
    if (normalizedSession === "") {
      return;
    }
    this.destroying.delete(normalizedSession);
    this.artifactDirs.delete(normalizedSession);
    this.loaded.delete(normalizedSession);
    this.purgeSession(normalizedSession);
  }

  async closeWithGrace(graceMs: number = this.teardownGraceMs): Promise<BashTeardownResult> {
    this.closed = true;
    const targets = this.closeTargets();
    const result = await waitTeardownTargets(undefined, targets, graceMs);
    if (result.hasTimedOut()) {
      this.emitTeardownTimeout("close", result);
      this.scheduleCleanupAfter(targets);
      return result;
    }
    this.removeTempRoot();
    return result;
  }

  closeAsync(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const targets = this.closeTargets();
    this.scheduleCleanupAfter(targets);
  }

  async close(): Promise<void> {
    await this.closeWithGrace(this.teardownGraceMs);
  }

  private async runJob(job: BashJob, run: (context: BashJobRunContext) => Promise<string> | string): Promise<void> {
    const write = (chunk: string | Uint8Array): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      job.activityAt = Date.now();
      job.tail = appendTail(job.tail, bytes, defaultTailBytes);
      this.writeArtifact(job, bytes);
    };

    let result = "";
    let caught: unknown;
    try {
      result = await run({ signal: job.controller.signal, write });
    } catch (error) {
      caught = error;
    } finally {
      job.runReturned = true;
    }

    let status: BashJobStatus;
    if (job.controller.signal.aborted || job.status === "killed") {
      status = "killed";
    } else if (caught !== undefined) {
      status = "failed";
      if (result === "") {
        result = errorMessage(caught);
      }
    } else {
      status = "done";
    }

    if (result !== "") {
      if (job.artifactFd === undefined) {
        job.result = result;
      }
      write(result);
    }

    this.closeArtifact(job);
    if (job.artifactErr !== "") {
      job.artifactComplete = false;
    }
    job.finishedAt = Date.now();

    const targetDir = this.artifactTargetDirForJob(job);
    if (targetDir !== "") {
      const moveErr = this.moveArtifactToDir(job, targetDir);
      if (moveErr !== "") {
        noteArtifactErr(job, `migration: ${moveErr}`);
      }
    }
    const metaErr = this.writeJobMeta(job, status);
    if (metaErr !== "") {
      noteArtifactErr(job, `metadata: ${metaErr}`);
    }

    this.recordCompletion(job, status, caught);
    if (job.status !== "killed") {
      job.status = status;
    }
    if (job.artifactPath !== "" && job.artifactComplete) {
      job.output = Buffer.alloc(0);
      job.tail = Buffer.alloc(0);
      job.result = "";
    }
    if (job.stalledTimer !== undefined) {
      clearTimeout(job.stalledTimer);
      job.stalledTimer = undefined;
    }
    job.settled = true;
    job.resolveDone();
  }

  private scheduleStalledCheck(job: BashJob): void {
    if (this.stalledWarningMs <= 0) {
      return;
    }
    const check = (): void => {
      if (job.settled || job.runReturned || job.status !== "running") {
        return;
      }
      const idle = Date.now() - job.activityAt;
      if (idle >= this.stalledWarningMs && !job.stalled) {
        job.stalled = true;
        this.recordStalled(job);
        return;
      }
      const wait = Math.max(1, this.stalledWarningMs - idle);
      job.stalledTimer = setTimeout(check, wait);
    };
    job.stalledTimer = setTimeout(check, this.stalledWarningMs);
  }

  private openArtifact(sessionId: string, id: string): { path: string; metaPath: string; fd: number | undefined; err: string } {
    const dir = this.artifactDirForSession(sessionId);
    if (dir === "") {
      return { path: "", metaPath: "", fd: undefined, err: this.tempRootErr || "artifact directory unavailable" };
    }
    const artifactPath = path.join(dir, `${safeArtifactName(id)}${jobLogExt}`);
    const metaPath = path.join(dir, `${safeArtifactName(id)}${jobMetaExt}`);
    try {
      mkdirSync(dir, { recursive: true });
      return { path: artifactPath, metaPath, fd: openSync(artifactPath, "w"), err: "" };
    } catch (error) {
      return { path: artifactPath, metaPath, fd: undefined, err: errorMessage(error) };
    }
  }

  private writeArtifact(job: BashJob, bytes: Buffer): void {
    if (job.artifactFd === undefined) {
      return;
    }

    try {
      const written = writeSync(job.artifactFd, bytes, 0, bytes.length);
      if (written !== bytes.length) {
        job.artifactErr = `short write: wrote ${written} of ${bytes.length} bytes`;
        job.artifactComplete = false;
      }
    } catch (error) {
      job.artifactErr = errorMessage(error);
      job.artifactComplete = false;
    }
  }

  private closeArtifact(job: BashJob): void {
    if (job.artifactFd === undefined) {
      return;
    }
    try {
      closeSync(job.artifactFd);
    } catch (error) {
      if (job.artifactErr === "") {
        job.artifactErr = errorMessage(error);
      }
      job.artifactComplete = false;
    } finally {
      job.artifactFd = undefined;
    }
  }

  private recordCompletion(job: BashJob, status: BashJobStatus, error: unknown): void {
    if (status === "running") {
      return;
    }
    const normalizedSession = job.sessionId.trim();
    if (normalizedSession !== "" && this.destroying.has(normalizedSession)) {
      return;
    }
    const tag = jobTag(job);
    this.completed.push({
      sessionId: normalizedSession,
      text: `${tag} \u2014 ${status}`
    });

    let level: BashJobNoticeLevel = "info";
    let text = `background ${job.kind} finished: ${job.id}`;
    if (status === "failed") {
      level = "warn";
      text = `background ${job.kind} failed: ${job.id} \u2014 ${errorMessage(error)}`;
    } else if (status === "killed") {
      text = `background ${job.kind} killed: ${job.id}`;
    }
    this.emitIfActive(normalizedSession, { kind: "notice", level, text });
  }

  private recordStalled(job: BashJob): void {
    const normalizedSession = job.sessionId.trim();
    if (normalizedSession !== "" && this.destroying.has(normalizedSession)) {
      return;
    }
    const duration = formatDuration(this.stalledWarningMs);
    const tag = jobTag(job);
    const text = `${tag} may be stalled \u2014 still running after ${duration} with no visible output. Inspect it with wait or bash_output, or stop it with kill_shell.`;
    this.completed.push({ sessionId: normalizedSession, text });
    this.emitIfActive(normalizedSession, {
      kind: "notice",
      level: "warn",
      text: `background ${job.kind} may be stalled: ${job.id} \u2014 still running after ${duration} with no visible output; inspect with wait/bash_output or stop with kill_shell`
    });
  }

  private emitIfActive(sessionId: string, event: BashJobEvent): void {
    const active = this.activeSession.trim();
    const normalizedSession = sessionId.trim();
    if (active === "" || normalizedSession === "" || active === normalizedSession) {
      this.eventSink.emit(event);
    }
  }

  private emitTeardownTimeout(action: string, result: BashTeardownResult): void {
    if (result.timedOut.length === 0) {
      return;
    }
    const details = result.timedOut
      .map((job) => {
        const label = job.label.trim() === "" ? "" : ` label="${job.label}"`;
        return `${job.id} kind=${job.kind}${label} waited=${formatDuration(job.waitedMs)}`;
      })
      .join("; ");
    this.eventSink.emit({
      kind: "notice",
      level: "warn",
      text: `background job teardown timed out during ${action.trim()}: ${details}`
    });
  }

  private find(sessionId: string, id: string): BashJob | undefined {
    const normalizedSession = sessionId.trim();
    const normalizedId = id.trim();
    if (normalizedSession !== "") {
      return this.jobs.get(jobKey(normalizedSession, normalizedId));
    }
    for (const key of this.order) {
      const job = this.jobs.get(key);
      if (job?.id === normalizedId) {
        return job;
      }
    }
    return undefined;
  }

  private resolve(sessionId: string, ids: readonly string[]): BashJob[] {
    if (ids.length === 0) {
      return this.order.flatMap((key) => {
        const job = this.jobs.get(key);
        return job !== undefined && sessionMatches(sessionId, job.sessionId) && job.status === "running" ? [job] : [];
      });
    }
    return ids.flatMap((id) => {
      const job = this.find(sessionId, id);
      return job === undefined ? [] : [job];
    });
  }

  private view(job: BashJob): BashJobView {
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      startedAt: job.startedAt
    };
  }

  private result(job: BashJob): BashJobResult {
    const output = appendArtifactWarning(this.resultOutput(job), job);
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      output
    };
  }

  private resultOutput(job: BashJob): string {
    if (job.result !== "") {
      return job.result;
    }
    if (canReadArtifactLog(job)) {
      const artifact = this.readArtifactAll(job);
      if (artifact !== "") {
        return artifact;
      }
    }
    return job.tail.toString("utf8");
  }

  private readArtifactSinceOffset(job: BashJob, consume: boolean): { text: string; ok: boolean } {
    if (job.artifactPath === "") {
      return { text: "", ok: true };
    }
    let fd: number | undefined;
    try {
      fd = openSync(job.artifactPath, "r");
      const size = fstatSync(fd).size;
      if (job.readOffset > size) {
        if (consume) {
          job.readOffset = size;
        }
        return { text: "", ok: true };
      }

      const start = job.readOffset;
      const length = size - start;
      if (length <= 0) {
        if (consume) {
          job.readOffset = size;
        }
        return { text: "", ok: true };
      }

      const chunks: Buffer[] = [];
      let readTotal = 0;
      while (readTotal < length) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, length - readTotal));
        const read = readSync(fd, chunk, 0, chunk.length, start + readTotal);
        if (read <= 0) {
          break;
        }
        chunks.push(read === chunk.length ? chunk : chunk.subarray(0, read));
        readTotal += read;
      }
      if (consume) {
        job.readOffset = size;
      }
      return { text: Buffer.concat(chunks, readTotal).toString("utf8"), ok: true };
    } catch (error) {
      if (job.artifactErr === "") {
        job.artifactErr = errorMessage(error);
      }
      job.artifactComplete = false;
      return { text: "", ok: false };
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  }

  private readArtifactAll(job: BashJob): string {
    if (job.artifactPath === "") {
      return "";
    }
    try {
      return readFileSync(job.artifactPath, "utf8");
    } catch (error) {
      if (job.artifactErr === "") {
        job.artifactErr = errorMessage(error);
      }
      job.artifactComplete = false;
      return "";
    }
  }

  private artifactDirForSession(sessionId: string): string {
    const normalizedSession = sessionId.trim();
    if (normalizedSession !== "") {
      const persistent = this.artifactDirs.get(normalizedSession)?.trim();
      if (persistent !== undefined && persistent !== "") {
        return persistent;
      }
    }
    if (this.tempRoot === undefined || this.tempRoot.trim() === "") {
      return "";
    }
    return path.join(this.tempRoot, normalizedSession === "" ? "default" : safeArtifactName(normalizedSession));
  }

  private artifactTargetDirForJob(job: BashJob): string {
    const session = job.sessionId.trim();
    if (session === "") {
      return "";
    }
    return this.artifactDirs.get(session)?.trim() ?? "";
  }

  private writeJobMeta(job: BashJob, status: BashJobStatus): string {
    if (job.artifactMetaPath === "") {
      return "";
    }
    const meta: ArtifactMeta = {
      id: job.id,
      kind: job.kind,
      status,
      startedAt: job.startedAt,
      artifactComplete: job.artifactComplete && job.artifactErr === ""
    };
    if (job.label !== "") {
      meta.label = job.label;
    }
    if (job.sessionId !== "") {
      meta.sessionId = job.sessionId;
    }
    if (job.finishedAt > 0) {
      meta.finishedAt = job.finishedAt;
    }
    if (job.artifactErr !== "") {
      meta.artifactError = job.artifactErr;
    }
    if (job.artifactPath !== "") {
      meta.logPath = path.basename(job.artifactPath);
    }

    try {
      mkdirSync(path.dirname(job.artifactMetaPath), { recursive: true });
      const tmp = path.join(path.dirname(job.artifactMetaPath), `.job-meta-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
      writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf8");
      renameSync(tmp, job.artifactMetaPath);
      return "";
    } catch (error) {
      return errorMessage(error);
    }
  }

  private loadSessionArtifacts(sessionId: string, dir: string): void {
    let maxSeq = 0;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() || path.extname(entry.name) !== jobMetaExt) {
          continue;
        }
        const meta = readMeta(path.join(dir, entry.name));
        if (meta === undefined || meta.id.trim() === "") {
          continue;
        }
        const id = meta.id.trim();
        maxSeq = Math.max(maxSeq, maxJobSeq(id));
        const key = jobKey(sessionId, id);
        if (this.jobs.has(key)) {
          continue;
        }
        const artifactPath = path.join(dir, meta.logPath?.trim() ? path.basename(meta.logPath) : `${safeArtifactName(id)}${jobLogExt}`);
        const job = this.restoredJob(sessionId, meta, artifactPath, path.join(dir, `${safeArtifactName(id)}${jobMetaExt}`));
        this.jobs.set(key, job);
        this.order.push(key);
      }
    } catch {
      // Missing or unreadable sidecars simply mean there is nothing to restore.
    }
    if (maxSeq > this.seq) {
      this.seq = maxSeq;
    }
    this.loaded.add(sessionId);
  }

  private restoredJob(sessionId: string, meta: ArtifactMeta, artifactPath: string, artifactMetaPath: string): BashJob {
    const controller = new AbortController();
    const done = Promise.resolve();
    return {
      id: meta.id,
      kind: meta.kind,
      label: meta.label ?? "",
      sessionId,
      status: meta.status,
      tail: Buffer.alloc(0),
      output: Buffer.alloc(0),
      readOffset: 0,
      result: "",
      resultRead: false,
      artifactPath,
      artifactMetaPath,
      artifactFd: undefined,
      artifactComplete: meta.artifactComplete,
      artifactErr: meta.artifactError ?? "",
      tombstone: true,
      startedAt: meta.startedAt,
      finishedAt: meta.finishedAt ?? meta.startedAt,
      activityAt: meta.finishedAt ?? meta.startedAt,
      runReturned: true,
      stalled: false,
      stalledTimer: undefined,
      settled: true,
      controller,
      done,
      resolveDone: () => undefined
    };
  }

  private hasUnscopedJobs(): boolean {
    for (const job of this.jobs.values()) {
      if (job.sessionId.trim() === "") {
        return true;
      }
    }
    return false;
  }

  private adoptUnscopedJobs(sessionId: string): void {
    const normalizedSession = sessionId.trim();
    if (normalizedSession === "") {
      return;
    }
    for (const item of this.completed) {
      if (item.sessionId.trim() === "") {
        item.sessionId = normalizedSession;
      }
    }
    for (const [oldKey, job] of [...this.jobs]) {
      if (job.sessionId.trim() !== "") {
        continue;
      }
      const newKey = jobKey(normalizedSession, job.id);
      const existing = this.jobs.get(newKey);
      if (existing !== undefined && existing !== job) {
        noteArtifactErr(job, "migration: job id collision while adopting temporary session");
        continue;
      }
      this.jobs.delete(oldKey);
      job.sessionId = normalizedSession;
      this.jobs.set(newKey, job);
      for (let index = 0; index < this.order.length; index += 1) {
        if (this.order[index] === oldKey) {
          this.order[index] = newKey;
        }
      }
    }
  }

  private migrateArtifactDirForSession(sessionId: string, oldDir: string, newDir: string): string {
    const skip = new Set<string>();
    const jobsByArtifactName = new Map<string, BashJob[]>();
    const cleanOld = path.resolve(oldDir);
    for (const job of this.jobs.values()) {
      if (!sessionMatches(sessionId, job.sessionId) || !artifactPathInDir(job.artifactPath, cleanOld)) {
        continue;
      }
      if (job.artifactFd !== undefined) {
        if (job.artifactPath !== "") {
          skip.add(path.basename(job.artifactPath));
        }
        if (job.artifactMetaPath !== "") {
          skip.add(path.basename(job.artifactMetaPath));
        }
        continue;
      }
      if (job.artifactPath !== "") {
        pushArtifactJob(jobsByArtifactName, path.basename(job.artifactPath), job);
      }
      if (job.artifactMetaPath !== "") {
        pushArtifactJob(jobsByArtifactName, path.basename(job.artifactMetaPath), job);
      }
    }

    try {
      let entries: Dirent[];
      try {
        entries = readdirSync(oldDir, { withFileTypes: true });
      } catch (error) {
        return isNotFoundError(error) ? "" : errorMessage(error);
      }
      mkdirSync(newDir, { recursive: true });
      for (const entry of entries) {
        if (entry.isDirectory() || skip.has(entry.name)) {
          continue;
        }
        const destination = path.join(newDir, entry.name);
        moveArtifactFile(path.join(oldDir, entry.name), destination);
        for (const job of jobsByArtifactName.get(entry.name) ?? []) {
          if (path.basename(job.artifactPath) === entry.name) {
            job.artifactPath = destination;
          }
          if (path.basename(job.artifactMetaPath) === entry.name) {
            job.artifactMetaPath = destination;
          }
        }
      }
      try {
        rmSync(oldDir, { recursive: false, force: true });
      } catch {
        // Best effort: matching Go, migration success does not depend on removing an empty temp dir.
      }
      return "";
    } catch (error) {
      return errorMessage(error);
    }
  }

  private moveArtifactToDir(job: BashJob, dir: string): string {
    if (dir.trim() === "" || job.artifactPath === "") {
      return "";
    }
    if (artifactPathInDir(job.artifactPath, dir)) {
      return "";
    }
    try {
      mkdirSync(dir, { recursive: true });
      const newLogPath = path.join(dir, path.basename(job.artifactPath));
      moveArtifactFile(job.artifactPath, newLogPath);
      job.artifactPath = newLogPath;
      if (job.artifactMetaPath !== "") {
        job.artifactMetaPath = path.join(dir, path.basename(job.artifactMetaPath));
      }
      return "";
    } catch (error) {
      return errorMessage(error);
    }
  }

  private recordArtifactMigrationError(sessionId: string, message: string): void {
    for (const job of this.jobs.values()) {
      if (sessionMatches(sessionId, job.sessionId) && job.artifactErr === "") {
        noteArtifactErr(job, `migration: ${message}`);
      }
    }
    this.emitIfActive(sessionId, {
      kind: "notice",
      level: "warn",
      text: `job artifact migration failed: ${message}`
    });
  }

  private purgeSession(sessionId: string): void {
    const kept: string[] = [];
    for (const key of this.order) {
      const job = this.jobs.get(key);
      if (job === undefined || sessionMatches(sessionId, job.sessionId)) {
        this.jobs.delete(key);
      } else {
        kept.push(key);
      }
    }
    this.order.length = 0;
    this.order.push(...kept);
    this.completed = this.completed.filter((item) => item.sessionId !== sessionId);
  }

  private closeTargets(): BashTeardownTarget[] {
    const targets: BashTeardownTarget[] = [];
    for (const key of this.order) {
      const job = this.jobs.get(key);
      if (job === undefined || job.settled) {
        continue;
      }
      if (job.status === "running") {
        job.status = "killed";
        job.controller.abort();
        targets.push(teardownTarget(job));
      } else if (job.status === "killed") {
        targets.push(teardownTarget(job));
      }
    }
    return targets;
  }

  private scheduleCleanupAfter(targets: readonly BashTeardownTarget[]): void {
    if (this.cleanupScheduled) {
      return;
    }
    this.cleanupScheduled = true;
    void Promise.allSettled(targets.map((target) => target.done)).then(() => {
      this.removeTempRoot();
    });
  }

  private removeTempRoot(): void {
    if (this.tempRoot !== undefined) {
      rmSync(this.tempRoot, { recursive: true, force: true });
    }
  }
}

export function sessionFromContext(context: { sessionId?: string } | undefined): string {
  return context?.sessionId?.trim() ?? "";
}

function normalizeEventSink(sink: BashJobManagerOptions["eventSink"]): BashJobEventSink {
  if (typeof sink === "function") {
    return { emit: sink };
  }
  if (sink !== undefined && typeof sink.emit === "function") {
    return sink;
  }
  return { emit: () => undefined };
}

function makeSessionTeardown(sessionId: string, targets: BashTeardownTarget[]): BashSessionTeardown {
  return {
    sessionId,
    targets,
    isAsync: () => targets.length > 0,
    donePromises: () => targets.map((target) => target.done)
  };
}

function teardownTarget(job: BashJob): BashTeardownTarget {
  return {
    info: { id: job.id, kind: job.kind, label: job.label },
    done: job.done,
    isDone: () => job.settled
  };
}

async function waitTeardownTargets(parentSignal: AbortSignal | undefined, targets: readonly BashTeardownTarget[], graceMs: number): Promise<BashTeardownResult> {
  if (targets.length === 0) {
    return teardownResult([], "done");
  }
  const start = Date.now();
  const allDone = Promise.allSettled(targets.map((target) => target.done)).then(() => "done" as const);
  const races: Promise<"done" | "timeout" | "abort">[] = [allDone];
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  if (graceMs >= 0) {
    races.push(
      new Promise<"timeout">((resolve) => {
        graceTimer = setTimeout(() => resolve("timeout"), graceMs);
      })
    );
  }
  let abortListener: (() => void) | undefined;
  if (parentSignal !== undefined) {
    races.push(
      new Promise<"abort">((resolve) => {
        if (parentSignal.aborted) {
          resolve("abort");
          return;
        }
        abortListener = () => resolve("abort");
        parentSignal.addEventListener("abort", abortListener, { once: true });
      })
    );
  }
  try {
    const winner = await Promise.race(races);
    if (winner === "done") {
      return teardownResult([], "done");
    }
    const waitedMs = Math.max(1, Date.now() - start);
    return teardownResult(
      targets.flatMap((target) => {
        if (target.isDone()) {
          return [];
        }
        return [{ ...target.info, waitedMs }];
      }),
      winner
    );
  } finally {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
    }
    if (parentSignal !== undefined && abortListener !== undefined) {
      parentSignal.removeEventListener("abort", abortListener);
    }
  }
}

function teardownResult(timedOut: BashTeardownJob[], cause: BashTeardownResult["cause"]): BashTeardownResult {
  return {
    timedOut,
    cause,
    hasTimedOut: () => cause === "timeout" && timedOut.length > 0
  };
}

function appendTail(current: Buffer, chunk: Buffer, limit: number): Buffer {
  const joined = Buffer.concat([current, chunk], current.length + chunk.length);
  if (joined.length <= limit) {
    return joined;
  }
  return joined.subarray(joined.length - limit);
}

function appendArtifactWarning(text: string, job: BashJob): string {
  if (job.artifactErr === "") {
    return text;
  }
  const prefix = text === "" ? "" : `${text}\n`;
  return `${prefix}job artifact incomplete: ${job.artifactErr}`;
}

function noteArtifactErr(job: BashJob, message: string): void {
  const trimmed = message.trim();
  if (trimmed === "") {
    return;
  }
  if (job.artifactErr === "") {
    job.artifactErr = trimmed;
  } else {
    job.artifactErr = `${job.artifactErr}; ${trimmed}`;
  }
  job.artifactComplete = false;
}

function canReadArtifactLog(job: Pick<BashJob, "artifactPath" | "artifactErr">): boolean {
  return job.artifactPath !== "" && artifactErrorKeepsLogReadable(job.artifactErr);
}

function artifactErrorKeepsLogReadable(error: string): boolean {
  const trimmed = error.trim();
  if (trimmed === "") {
    return true;
  }
  return trimmed.split(";").every((part) => {
    const item = part.trim();
    return item.startsWith("migration:") || item.startsWith("metadata:");
  });
}

function readMeta(metaPath: string): ArtifactMeta | undefined {
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<ArtifactMeta>;
    if (typeof parsed.id !== "string" || typeof parsed.kind !== "string" || typeof parsed.status !== "string") {
      return undefined;
    }
    if (!["running", "done", "failed", "killed"].includes(parsed.status)) {
      return undefined;
    }
    return {
      id: parsed.id,
      kind: parsed.kind,
      label: typeof parsed.label === "string" ? parsed.label : undefined,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      status: parsed.status as BashJobStatus,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      finishedAt: typeof parsed.finishedAt === "number" ? parsed.finishedAt : undefined,
      artifactComplete: parsed.artifactComplete === true,
      artifactError: typeof parsed.artifactError === "string" ? parsed.artifactError : undefined,
      logPath: typeof parsed.logPath === "string" ? parsed.logPath : undefined
    };
  } catch {
    return undefined;
  }
}

function moveArtifactFile(source: string, destination: string): void {
  try {
    renameSync(source, destination);
    return;
  } catch {
    copyFileSync(source, destination);
    unlinkSync(source);
  }
}

function sessionArtifactDir(sessionPath: string): string {
  const trimmed = sessionPath.trim();
  if (trimmed === "") {
    return "";
  }
  return `${trimmed.replace(/\.jsonl$/u, "")}.jobs`;
}

function artifactPathInDir(artifactPath: string, dir: string): boolean {
  if (artifactPath.trim() === "" || dir.trim() === "") {
    return false;
  }
  return path.resolve(path.dirname(artifactPath)) === path.resolve(dir);
}

function pushArtifactJob(jobsByArtifactName: Map<string, BashJob[]>, name: string, job: BashJob): void {
  const jobs = jobsByArtifactName.get(name);
  if (jobs === undefined) {
    jobsByArtifactName.set(name, [job]);
    return;
  }
  if (!jobs.includes(job)) {
    jobs.push(job);
  }
}

function maxJobSeq(id: string): number {
  const index = id.lastIndexOf("-");
  if (index < 0) {
    return 0;
  }
  const value = Number.parseInt(id.slice(index + 1), 10);
  return Number.isFinite(value) ? value : 0;
}

function safeArtifactName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function jobTag(job: Pick<BashJob, "id" | "label">): string {
  return job.label === "" ? job.id : `${job.id} (${job.label})`;
}

function startedText(kind: string, id: string, label: string): string {
  return label === "" ? `background ${kind} started: ${id}` : `background ${kind} started: ${id} (${label})`;
}

function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  let seconds = Math.round(Math.abs(ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (hours > 0) {
    return `${sign}${hours}h${minutes}m${seconds}s`;
  }
  if (minutes > 0) {
    return `${sign}${minutes}m${seconds}s`;
  }
  return `${sign}${seconds}s`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionMatches(filter: string, jobSession: string): boolean {
  const normalized = filter.trim();
  return normalized === "" || jobSession.trim() === normalized;
}

function jobKey(sessionId: string, id: string): string {
  return `${sessionId.trim()}\0${id.trim()}`;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

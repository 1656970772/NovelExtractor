import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ReasonixResolvedShell } from "./workspace";

export const psUTF8Prologue = "$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";

const nulRedirect = /((?:\d+|&)?>>?)\s*nul([\s;&|<>)]|$)/giu;
const shellPathMarker = "__REASONIX_BASH_PATH__=";
const shellPathCache = new Map<string, string>();

export function normalizeNulRedirect(command: string, sink: string): string {
  return command.replace(nulRedirect, (_match, redirect: string, delimiter: string) => `${redirect}${sink}${delimiter}`);
}

export function shellArgv(shell: ReasonixResolvedShell, command: string): string[] {
  const shellPath = shell.path === "" ? shell.kind : shell.path;
  if (shell.kind === "powershell") {
    return [shellPath, "-NoProfile", "-NonInteractive", "-Command", psUTF8Prologue + normalizeNulRedirect(command, "$null")];
  }
  return [shellPath, "-c", normalizeNulRedirect(command, "/dev/null")];
}

export function shellSupportsChaining(shell: ReasonixResolvedShell): boolean {
  if (shell.kind !== "powershell") {
    return true;
  }
  const base = path.basename(shell.path).toLowerCase();
  return base === "pwsh" || base === "pwsh.exe";
}

export function hasUnquotedSeq(input: string, seq: "&&" | "||"): boolean {
  let quote = "";
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote !== "") {
      if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (input.startsWith(seq, index)) {
      return true;
    }
  }
  return false;
}

export function hasExplicitBackgroundKeepalive(command: string): boolean {
  if (!hasUnquotedBackgroundOperator(command)) {
    return false;
  }
  return hasShellCommandWord(command, new Set(["disown", "nohup", "setsid"]));
}

export function parseShellPATH(output: Buffer | string, marker = shellPathMarker): string {
  const lines = output.toString().replace(/\r\n/gu, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith(marker)) {
      return lines[index].slice(marker.length).trim();
    }
  }
  return "";
}

export function mergePathLists(primary: string, secondary: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    for (const part of value.split(path.delimiter)) {
      const item = part.trim();
      if (item === "" || seen.has(item)) {
        continue;
      }
      seen.add(item);
      out.push(item);
    }
  };
  add(primary);
  add(secondary);
  return out.join(path.delimiter);
}

export function bashCommandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform === "win32") {
    return env;
  }

  const currentPath = env.PATH ?? "";
  const shellPath = cachedBashShellPATH().trim();
  if (shellPath !== "") {
    const merged = mergePathLists(shellPath, currentPath);
    if (merged !== currentPath) {
      env.PATH = merged;
    }
  }
  return env;
}

function cachedBashShellPATH(): string {
  const shell = loginShell();
  const cached = shellPathCache.get(shell);
  if (cached !== undefined) {
    return cached;
  }
  const value = defaultBashShellPATH(shell);
  shellPathCache.set(shell, value);
  return value;
}

function defaultBashShellPATH(shell: string): string {
  if (process.platform === "win32" || shell === "") {
    return "";
  }
  const script = `printf '\\n${shellPathMarker}%s\\n' "$PATH"`;
  for (const args of [
    ["-l", "-i", "-c", script],
    ["-l", "-c", script],
    ["-c", script]
  ]) {
    const result = spawnSync(shell, args, { input: "", timeout: 2000, encoding: "buffer", windowsHide: true });
    const parsed = parseShellPATH(result.stdout);
    if (parsed !== "") {
      return parsed;
    }
  }
  return "";
}

function loginShell(): string {
  const shell = (process.env.SHELL ?? "").trim();
  if (shell !== "") {
    if (hasPathSeparator(shell)) {
      if (isExecutableFile(shell)) {
        return shell;
      }
    } else {
      const resolved = lookPath(shell);
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }

  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return "";
}

function lookPath(command: string): string | undefined {
  const result = spawnSync("which", [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "");
}

function hasPathSeparator(input: string): boolean {
  return input.includes("/") || input.includes("\\");
}

function isExecutableFile(candidate: string): boolean {
  try {
    const info = fs.statSync(candidate);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function hasUnquotedBackgroundOperator(input: string): boolean {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== "") {
      if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== "&") {
      continue;
    }
    if (input[index + 1] === "&") {
      index += 1;
      continue;
    }
    if (previousNonSpace(input, index) === ">") {
      continue;
    }
    if (nextNonSpace(input, index + 1) === ">") {
      continue;
    }
    return true;
  }
  return false;
}

function hasShellCommandWord(input: string, want: ReadonlySet<string>): boolean {
  let expectCommand = true;
  let skipNextWord = false;
  for (let index = 0; index < input.length; ) {
    const char = input[index];
    if (isShellSpace(char)) {
      index += 1;
      continue;
    }
    switch (char) {
      case ";":
      case "\n":
      case "&":
      case "|":
      case "(":
        if (input.startsWith("&&", index) || input.startsWith("||", index)) {
          index += 2;
        } else {
          index += 1;
        }
        expectCommand = true;
        skipNextWord = false;
        continue;
      case "<":
      case ">":
        index = skipShellRedirect(input, index);
        skipNextWord = true;
        continue;
    }

    const [word, next] = readShellWord(input, index);
    index = next;
    if (word === "") {
      continue;
    }
    if (skipNextWord) {
      skipNextWord = false;
      continue;
    }
    if (!expectCommand) {
      continue;
    }
    if (isShellAssignment(word)) {
      continue;
    }
    const base = shellWordBase(word);
    if (want.has(base)) {
      return true;
    }
    if (base === "command" || base === "env") {
      continue;
    }
    expectCommand = false;
  }
  return false;
}

function readShellWord(input: string, start: number): [string, number] {
  let out = "";
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (isShellSpace(char) || ";|&()<>".includes(char)) {
      return [out, index];
    }
    switch (char) {
      case "\\":
        if (index + 1 < input.length) {
          index += 1;
          out += input[index];
        }
        break;
      case "'":
        for (index += 1; index < input.length && input[index] !== "'"; index += 1) {
          out += input[index];
        }
        break;
      case '"':
        for (index += 1; index < input.length && input[index] !== '"'; index += 1) {
          if (input[index] === "\\" && index + 1 < input.length) {
            index += 1;
          }
          out += input[index];
        }
        break;
      default:
        out += char;
        break;
    }
  }
  return [out, input.length];
}

function skipShellRedirect(input: string, index: number): number {
  while (index < input.length && (input[index] === "<" || input[index] === ">" || input[index] === "&")) {
    index += 1;
  }
  return index;
}

function previousNonSpace(input: string, before: number): string {
  for (let index = before - 1; index >= 0; index -= 1) {
    if (!isShellSpace(input[index])) {
      return input[index];
    }
  }
  return "";
}

function nextNonSpace(input: string, after: number): string {
  for (let index = after; index < input.length; index += 1) {
    if (!isShellSpace(input[index])) {
      return input[index];
    }
  }
  return "";
}

function isShellSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function isShellAssignment(word: string): boolean {
  const separator = word.indexOf("=");
  if (separator <= 0) {
    return false;
  }
  const name = word.slice(0, separator);
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name);
}

function shellWordBase(word: string): string {
  const slash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  return slash >= 0 ? word.slice(slash + 1) : word;
}

export function formatGoDuration(milliseconds: number): string {
  if (milliseconds <= 0) {
    return "0s";
  }
  if (milliseconds < 1000) {
    return `${trimDurationNumber(milliseconds)}ms`;
  }
  const totalSeconds = milliseconds / 1000;
  const hours = Math.trunc(totalSeconds / 3600);
  const minutes = Math.trunc((totalSeconds % 3600) / 60);
  const seconds = totalSeconds - hours * 3600 - minutes * 60;
  const secondText = `${trimDurationNumber(seconds)}s`;
  if (hours > 0) {
    return `${hours}h${minutes}m${secondText}`;
  }
  if (minutes > 0) {
    return `${minutes}m${secondText}`;
  }
  return secondText;
}

function trimDurationNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(9).replace(/0+$/u, "").replace(/\.$/u, "");
}

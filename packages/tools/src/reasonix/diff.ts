export type ReasonixDiffKind = "create" | "modify" | "delete";

export interface ReasonixDiffChange {
  path: string;
  kind: ReasonixDiffKind;
  oldText: string;
  newText: string;
  added: number;
  removed: number;
  diff: string;
  binary: boolean;
}

const defaultContext = 3;
const maxDiffEdits = 2000;

enum OpType {
  Equal,
  Delete,
  Insert
}

interface Op {
  type: OpType;
  line: string;
}

interface LineRef {
  op: Op;
  oldNo: number;
  newNo: number;
}

interface Hunk {
  start: number;
  end: number;
}

export function buildChange(path: string, oldText: string, newText: string, kind: ReasonixDiffKind): ReasonixDiffChange {
  const change: ReasonixDiffChange = {
    path,
    kind,
    oldText,
    newText,
    added: 0,
    removed: 0,
    diff: "",
    binary: false
  };

  if (isBinary(oldText) || isBinary(newText)) {
    change.binary = true;
    return change;
  }
  if (oldText === newText) {
    return change;
  }

  const oldSplit = splitLines(oldText);
  const newSplit = splitLines(newText);
  const result = myers(oldSplit.lines, newSplit.lines);
  if (result === undefined) {
    const tally = approxTally(oldSplit.lines, newSplit.lines);
    change.added = tally.added;
    change.removed = tally.removed;
    change.diff = `(diff omitted: change too large to render \u2014 +${change.added} / -${change.removed} lines)`;
    return change;
  }

  for (const op of result) {
    if (op.type === OpType.Insert) {
      change.added += 1;
    } else if (op.type === OpType.Delete) {
      change.removed += 1;
    }
  }
  change.diff = unified(path, result, oldSplit.endsWithNewline, newSplit.endsWithNewline, defaultContext);
  return change;
}

export const Build = buildChange;

function approxTally(oldLines: string[], newLines: string[]): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of oldLines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  let added = 0;
  for (const line of newLines) {
    const count = counts.get(line) ?? 0;
    if (count > 0) {
      counts.set(line, count - 1);
    } else {
      added += 1;
    }
  }

  let removed = 0;
  for (const count of counts.values()) {
    removed += count;
  }
  return { added, removed };
}

function isBinary(value: string): boolean {
  return value.includes("\0");
}

function splitLines(value: string): { lines: string[]; endsWithNewline: boolean } {
  if (value === "") {
    return { lines: [], endsWithNewline: true };
  }

  const endsWithNewline = value.endsWith("\n");
  const body = endsWithNewline ? value.slice(0, -1) : value;
  return { lines: body.split("\n"), endsWithNewline };
}

function myers(a: string[], b: string[]): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) {
    return [];
  }

  const maxD = myersMaxD(n, m);
  const offset = maxD;
  const v = Array<number>(myersVectorLen(maxD)).fill(0);
  const trace: number[][] = [];

  for (let d = 0; d <= maxD; d += 1) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }

      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, a, b, offset);
      }
    }
  }

  return undefined;
}

function myersMaxD(n: number, m: number): number {
  if (n >= maxDiffEdits) {
    return maxDiffEdits;
  }

  let maxD = n;
  for (let i = 0; i < m && maxD < maxDiffEdits; i += 1) {
    maxD += 1;
  }
  return maxD;
}

function myersVectorLen(maxD: number): number {
  let width = 1;
  for (let i = 0; i < maxD; i += 1) {
    width += 2;
  }
  return width;
}

function backtrack(trace: number[][], a: string[], b: string[], offset: number): Op[] {
  let x = a.length;
  let y = b.length;
  const ops: Op[] = [];

  for (let d = trace.length - 1; d > 0; d -= 1) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: OpType.Equal, line: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ type: OpType.Insert, line: b[y - 1] });
    } else {
      ops.push({ type: OpType.Delete, line: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }

  while (x > 0 && y > 0) {
    ops.push({ type: OpType.Equal, line: a[x - 1] });
    x -= 1;
    y -= 1;
  }

  return ops.reverse();
}

function unified(path: string, ops: Op[], oldEOL: boolean, newEOL: boolean, context: number): string {
  const refs = numberLines(ops);
  const hunks = group(refs, context);
  if (hunks.length === 0) {
    return "";
  }

  let out = `--- a/${path}\n+++ b/${path}\n`;
  const last = lastLineNumbers(refs);
  for (const hunk of hunks) {
    out += hunkHeader(refs, hunk);
    for (let index = hunk.start; index < hunk.end; index += 1) {
      const ref = refs[index];
      switch (ref.op.type) {
        case OpType.Equal:
          out += ` ${ref.op.line}\n`;
          break;
        case OpType.Delete:
          out += `-${ref.op.line}\n`;
          if (!oldEOL && ref.oldNo === last.old) {
            out += "\\ No newline at end of file\n";
          }
          break;
        case OpType.Insert:
          out += `+${ref.op.line}\n`;
          if (!newEOL && ref.newNo === last.new) {
            out += "\\ No newline at end of file\n";
          }
          break;
      }
    }
  }
  return out;
}

function numberLines(ops: Op[]): LineRef[] {
  let oldNo = 0;
  let newNo = 0;

  return ops.map((op) => {
    const ref: LineRef = { op, oldNo: 0, newNo: 0 };
    switch (op.type) {
      case OpType.Equal:
        oldNo += 1;
        newNo += 1;
        ref.oldNo = oldNo;
        ref.newNo = newNo;
        break;
      case OpType.Delete:
        oldNo += 1;
        ref.oldNo = oldNo;
        break;
      case OpType.Insert:
        newNo += 1;
        ref.newNo = newNo;
        break;
    }
    return ref;
  });
}

function lastLineNumbers(refs: LineRef[]): { old: number; new: number } {
  let old = 0;
  let newer = 0;
  for (const ref of refs) {
    old = Math.max(old, ref.oldNo);
    newer = Math.max(newer, ref.newNo);
  }
  return { old, new: newer };
}

function group(refs: LineRef[], context: number): Hunk[] {
  const changes: number[] = [];
  refs.forEach((ref, index) => {
    if (ref.op.type !== OpType.Equal) {
      changes.push(index);
    }
  });
  if (changes.length === 0) {
    return [];
  }

  const hunks: Hunk[] = [];
  let start = Math.max(0, changes[0] - context);
  let end = Math.min(refs.length, changes[0] + context + 1);
  for (const changeIndex of changes.slice(1)) {
    if (changeIndex - context <= end) {
      end = Math.min(refs.length, changeIndex + context + 1);
      continue;
    }

    hunks.push({ start, end });
    start = changeIndex - context;
    end = Math.min(refs.length, changeIndex + context + 1);
  }
  hunks.push({ start, end });
  return hunks;
}

function hunkHeader(refs: LineRef[], hunk: Hunk): string {
  let oldStart = 0;
  let oldCount = 0;
  let newStart = 0;
  let newCount = 0;

  for (let index = hunk.start; index < hunk.end; index += 1) {
    const ref = refs[index];
    if (ref.oldNo !== 0) {
      if (oldStart === 0) {
        oldStart = ref.oldNo;
      }
      oldCount += 1;
    }
    if (ref.newNo !== 0) {
      if (newStart === 0) {
        newStart = ref.newNo;
      }
      newCount += 1;
    }
  }

  if (oldCount === 0) {
    oldStart = 0;
  }
  if (newCount === 0) {
    newStart = 0;
  }

  return `@@ -${rangeSpec(oldStart, oldCount)} +${rangeSpec(newStart, newCount)} @@\n`;
}

function rangeSpec(start: number, count: number): string {
  if (count === 1) {
    return String(start);
  }
  return `${start},${count}`;
}

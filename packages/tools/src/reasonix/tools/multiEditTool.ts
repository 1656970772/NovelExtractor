import { buildChange, type ReasonixDiffChange } from "../diff";
import {
  goStyleFsError,
  readExistingFileForEdit,
  utf8TextToRawByteString,
  writeEditedFileEncoded,
  type EditableEncodedFileContent
} from "../encodedFile";
import {
  GoRawJSONUnmarshaller,
  goJSONTokenKind,
  invalidArgs,
  parsedJSONValueForError,
  replaceIsolatedSurrogates,
  type ParsedRawJSONValue,
  type RawJSONValueKind
} from "../goJson";
import { assertWritablePath, resolveInWorkspace } from "../pathResolver";
import type { ReasonixPreviewableTool } from "../registry";
import { applyOldStringEdit } from "../textEdit";
import type { Workspace } from "../workspace";

const multiEditArgsGoStructType = 'struct { Path string "json:\\"path\\""; Edits []builtin.editStep "json:\\"edits\\"" }';
const editStepGoType = "builtin.editStep";
const editStepSliceGoType = "[]builtin.editStep";

interface NormalizedMultiEditArgs {
  path: string;
  edits: NormalizedMultiEditStep[];
}

interface NormalizedMultiEditStep {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

interface MultiEditApplyResult {
  updated: string;
  applied: number;
  fuzzy: boolean;
}

export function createMultiEditTool(workspace: Workspace): ReasonixPreviewableTool {
  const [definition] = workspace.tools(["multi_edit"]);

  return {
    ...definition,
    async preview(args: unknown): Promise<ReasonixDiffChange> {
      const params = normalizeArgs(args);
      const targetPath = resolveInWorkspace(workspace.dir, params.path);
      const existing = await readExistingFileForEdit(targetPath);
      const applied = applyEditsOrThrow(existing.content, paramsForEditableContent(existing, params));

      return buildChange(targetPath, existing.content, applied.updated, "modify");
    },
    async execute(args: unknown): Promise<string> {
      const params = normalizeArgs(args);
      const targetPath = resolveInWorkspace(workspace.dir, params.path);
      assertWritablePath(workspace.realWriteRoots, targetPath);

      const existing = await readExistingFileForEdit(targetPath);
      const applied = applyEditsOrThrow(existing.content, paramsForEditableContent(existing, params));
      try {
        await writeEditedFileEncoded(targetPath, applied.updated, existing);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(`write ${targetPath}: `)) {
          throw error;
        }
        throw new Error(`write ${targetPath}: ${goStyleFsError(error)}`);
      }

      const suffix = applied.fuzzy ? " (fuzzy match)" : "";
      return `multi_edit ${targetPath}: ${params.edits.length} edits applied (${applied.applied} total replacements)${suffix}`;
    }
  };
}

function paramsForEditableContent(existing: EditableEncodedFileContent, params: NormalizedMultiEditArgs): NormalizedMultiEditArgs {
  if (!existing.contentUsesRawBytes) {
    return params;
  }

  return {
    path: params.path,
    edits: params.edits.map((step) => ({
      oldString: utf8TextToRawByteString(step.oldString),
      newString: utf8TextToRawByteString(step.newString),
      replaceAll: step.replaceAll
    }))
  };
}

function applyEditsOrThrow(content: string, params: NormalizedMultiEditArgs): MultiEditApplyResult {
  let updated = content;
  let appliedCount = 0;
  let usedFuzzy = false;

  params.edits.forEach((step, index) => {
    if (step.oldString === "") {
      throw new Error(`edit ${index + 1}: old_string is required`);
    }

    const applied = applyOldStringEdit(updated, step.oldString, step.newString, step.replaceAll);
    if (applied.applied > 0) {
      updated = applied.updated;
      appliedCount += applied.applied;
      usedFuzzy ||= applied.fuzzy;
      return;
    }
    if (applied.matches === 0) {
      throw new Error(`edit ${index + 1}: old_string not found`);
    }
    throw new Error(`edit ${index + 1}: old_string is not unique; add more surrounding context or set replace_all`);
  });

  return { updated, applied: appliedCount, fuzzy: usedFuzzy };
}

function normalizeArgs(args: unknown): NormalizedMultiEditArgs {
  if (typeof args === "string") {
    return normalizeRawJSONArgs(args);
  }
  if (args instanceof Uint8Array) {
    return normalizeRawJSONArgs(new TextDecoder().decode(args));
  }

  return normalizeStructuredArgs(args);
}

function normalizeRawJSONArgs(rawText: string): NormalizedMultiEditArgs {
  const result = new RawMultiEditArgsUnmarshaller(rawText).unmarshal();
  if (result.kind !== "object" && result.kind !== "null") {
    throw invalidArgs(`json: cannot unmarshal ${result.kind === "bool" ? "bool" : result.kind} into Go value of type ${multiEditArgsGoStructType}`);
  }
  if (result.typeError !== undefined) {
    throw invalidArgs(result.typeError);
  }
  validateRequiredArgs(result.path, result.edits);

  return {
    path: result.path,
    edits: result.edits
  };
}

function normalizeStructuredArgs(raw: unknown): NormalizedMultiEditArgs {
  if (raw === null) {
    raw = {};
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidArgs(`json: cannot unmarshal ${goJSONTokenKind(raw)} into Go value of type ${multiEditArgsGoStructType}`);
  }

  const value = raw as Record<string, unknown>;
  let pathValue = "";
  let editsValue: NormalizedMultiEditStep[] = [];
  let firstTypeError: string | undefined;

  for (const key of Object.keys(value)) {
    const field = multiEditArgField(key);
    if (field === undefined) {
      continue;
    }

    const fieldValue = value[key];
    if (field === "path") {
      if (fieldValue === undefined || fieldValue === null) {
        pathValue = "";
      } else if (typeof fieldValue === "string") {
        pathValue = replaceIsolatedSurrogates(fieldValue);
      } else {
        firstTypeError ??= goJSONTypeErrorForValue(fieldValue, "path", "string");
      }
      continue;
    }

    if (fieldValue === undefined || fieldValue === null) {
      editsValue = [];
    } else if (Array.isArray(fieldValue)) {
      const normalized = normalizeStructuredEditSteps(fieldValue);
      editsValue = normalized.edits;
      firstTypeError ??= normalized.typeError;
    } else {
      firstTypeError ??= goJSONTypeErrorForValue(fieldValue, "edits", editStepSliceGoType);
    }
  }

  if (firstTypeError !== undefined) {
    throw invalidArgs(firstTypeError);
  }
  validateRequiredArgs(pathValue, editsValue);

  return {
    path: pathValue,
    edits: editsValue
  };
}

function validateRequiredArgs(pathValue: string, editsValue: NormalizedMultiEditStep[]): void {
  if (pathValue === "") {
    throw new Error("path is required");
  }
  if (editsValue.length === 0) {
    throw new Error("edits must not be empty");
  }
}

function normalizeStructuredEditSteps(rawEdits: unknown[]): { edits: NormalizedMultiEditStep[]; typeError?: string } {
  const edits: NormalizedMultiEditStep[] = [];
  let firstTypeError: string | undefined;

  rawEdits.forEach((rawStep) => {
    if (rawStep === null) {
      edits.push(emptyStep());
      return;
    }
    if (typeof rawStep !== "object" || Array.isArray(rawStep)) {
      firstTypeError ??= goJSONTypeErrorForValue(rawStep, "edits", editStepGoType);
      edits.push(emptyStep());
      return;
    }

    const normalized = normalizeStructuredEditStep(rawStep as Record<string, unknown>);
    edits.push(normalized.step);
    firstTypeError ??= normalized.typeError;
  });

  return { edits, typeError: firstTypeError };
}

function normalizeStructuredEditStep(value: Record<string, unknown>): { step: NormalizedMultiEditStep; typeError?: string } {
  let oldString = "";
  let newString = "";
  let replaceAll = false;
  let firstTypeError: string | undefined;

  for (const key of Object.keys(value)) {
    const field = multiEditStepField(key);
    if (field === undefined) {
      continue;
    }

    const fieldValue = value[key];
    if (fieldValue === undefined || fieldValue === null) {
      if (field === "old_string") {
        oldString = "";
      } else if (field === "new_string") {
        newString = "";
      } else {
        replaceAll = false;
      }
      continue;
    }
    if (field === "replace_all") {
      if (typeof fieldValue === "boolean") {
        replaceAll = fieldValue;
      } else {
        firstTypeError ??= goJSONTypeErrorForValue(fieldValue, "edits.replace_all", "bool");
      }
      continue;
    }
    if (typeof fieldValue === "string") {
      const text = replaceIsolatedSurrogates(fieldValue);
      if (field === "old_string") {
        oldString = text;
      } else {
        newString = text;
      }
      continue;
    }
    firstTypeError ??= goJSONTypeErrorForValue(fieldValue, `edits.${field}`, "string");
  }

  return {
    step: { oldString, newString, replaceAll },
    typeError: firstTypeError
  };
}

class RawMultiEditArgsUnmarshaller {
  private path = "";
  private edits: NormalizedMultiEditStep[] = [];
  private firstTypeError: string | undefined;

  constructor(private readonly json: string) {}

  unmarshal(): { kind: RawJSONValueKind; path: string; edits: NormalizedMultiEditStep[]; typeError?: string } {
    const kind = new GoRawJSONUnmarshaller(this.json, (key, value) => this.unmarshalKnownField(key, value)).unmarshal();
    return {
      kind,
      path: this.path,
      edits: this.edits,
      typeError: this.firstTypeError
    };
  }

  private unmarshalKnownField(key: string, value: ParsedRawJSONValue): void {
    const field = multiEditArgField(key);
    if (field === undefined) {
      return;
    }

    if (field === "path") {
      if (value.kind === "null") {
        return;
      } else if (value.kind === "string") {
        this.path = value.stringValue ?? "";
      } else {
        this.firstTypeError ??= goJSONTypeErrorForParsedValue(value, "path", "string");
      }
      return;
    }

    if (value.kind === "null") {
      this.edits = [];
      return;
    }
    if (value.kind === "array") {
      const normalized = normalizeRawEditSteps(value.raw);
      this.firstTypeError ??= normalized.typeError;
      this.edits = normalized.edits;
      return;
    }
    this.firstTypeError ??= goJSONTypeErrorForParsedValue(value, "edits", editStepSliceGoType);
  }
}

function normalizeRawEditSteps(raw: string): { edits: NormalizedMultiEditStep[]; typeError?: string } {
  const edits: NormalizedMultiEditStep[] = [];
  let firstTypeError: string | undefined;
  new RawJSONReader(raw).readArray((value) => {
    if (value.kind === "null") {
      edits.push(emptyStep());
      return;
    }
    if (value.kind !== "object") {
      firstTypeError ??= goJSONTypeErrorForParsedValue(value, "edits", editStepGoType);
      edits.push(emptyStep());
      return;
    }
    const normalized = normalizeRawEditStep(value.raw);
    edits.push(normalized.step);
    firstTypeError ??= normalized.typeError;
  });
  return { edits, typeError: firstTypeError };
}

function normalizeRawEditStep(raw: string): { step: NormalizedMultiEditStep; typeError?: string } {
  let oldString = "";
  let newString = "";
  let replaceAll = false;
  let firstTypeError: string | undefined;

  new RawJSONReader(raw).readObject((key, value) => {
    const field = multiEditStepField(key);
    if (field === undefined) {
      return;
    }
    if (value.kind === "null") {
      return;
    }
    if (field === "replace_all") {
      if (value.kind === "bool") {
        replaceAll = value.raw === "true";
      } else {
        firstTypeError ??= goJSONTypeErrorForParsedValue(value, "edits.replace_all", "bool");
      }
      return;
    }
    if (value.kind === "string") {
      if (field === "old_string") {
        oldString = value.stringValue ?? "";
      } else {
        newString = value.stringValue ?? "";
      }
    } else {
      firstTypeError ??= goJSONTypeErrorForParsedValue(value, `edits.${field}`, "string");
    }
  });

  return {
    step: { oldString, newString, replaceAll },
    typeError: firstTypeError
  };
}

class RawJSONReader {
  private index = 0;

  constructor(private readonly json: string) {}

  readArray(onValue: (value: ParsedRawJSONValue) => void): void {
    this.index = this.skipWhitespace(0);
    this.expect("[");
    let allowEnd = true;
    for (;;) {
      this.index = this.skipWhitespace(this.index);
      if (this.json[this.index] === "]") {
        this.index += 1;
        return;
      }
      if (!allowEnd && this.json[this.index] === undefined) {
        return;
      }

      onValue(this.parseValue());
      this.index = this.skipWhitespace(this.index);
      if (this.json[this.index] === ",") {
        this.index += 1;
        allowEnd = false;
        continue;
      }
      if (this.json[this.index] === "]") {
        this.index += 1;
        return;
      }
      return;
    }
  }

  readObject(onField: (key: string, value: ParsedRawJSONValue) => void): void {
    this.index = this.skipWhitespace(0);
    this.expect("{");
    let allowEnd = true;
    for (;;) {
      this.index = this.skipWhitespace(this.index);
      if (this.json[this.index] === "}") {
        this.index += 1;
        return;
      }
      if (!allowEnd && this.json[this.index] === undefined) {
        return;
      }

      const key = this.parseJSONString().value;
      this.index = this.skipWhitespace(this.index);
      this.expect(":");
      const value = this.parseValue();
      onField(key, value);
      this.index = this.skipWhitespace(this.index);
      if (this.json[this.index] === ",") {
        this.index += 1;
        allowEnd = false;
        continue;
      }
      if (this.json[this.index] === "}") {
        this.index += 1;
        return;
      }
      return;
    }
  }

  private parseValue(): ParsedRawJSONValue {
    this.index = this.skipWhitespace(this.index);
    const start = this.index;
    const char = this.json[this.index];
    if (char === "{") {
      this.skipComposite("{", "}");
      return { kind: "object", raw: this.json.slice(start, this.index) };
    }
    if (char === "[") {
      this.skipComposite("[", "]");
      return { kind: "array", raw: this.json.slice(start, this.index) };
    }
    if (char === "\"") {
      const parsed = this.parseJSONString();
      return { kind: "string", raw: parsed.raw, stringValue: parsed.value };
    }
    if (char === "-" || isJSONDigit(char)) {
      this.parseJSONNumber();
      return { kind: "number", raw: this.json.slice(start, this.index) };
    }
    if (char === "t") {
      this.index += "true".length;
      return { kind: "bool", raw: this.json.slice(start, this.index) };
    }
    if (char === "f") {
      this.index += "false".length;
      return { kind: "bool", raw: this.json.slice(start, this.index) };
    }
    if (char === "n") {
      this.index += "null".length;
      return { kind: "null", raw: this.json.slice(start, this.index) };
    }
    return { kind: "null", raw: "null" };
  }

  private parseJSONString(): { raw: string; value: string } {
    const start = this.index;
    this.index += 1;
    for (;;) {
      const char = this.json[this.index];
      if (char === undefined) {
        break;
      }
      if (char === "\"") {
        this.index += 1;
        const raw = this.json.slice(start, this.index);
        return { raw, value: replaceIsolatedSurrogates(JSON.parse(raw) as string) };
      }
      if (char === "\\") {
        this.index += 2;
        if (this.json[this.index - 1] === "u") {
          this.index += 4;
        }
        continue;
      }
      this.index += 1;
    }
    const raw = this.json.slice(start, this.index);
    return { raw, value: replaceIsolatedSurrogates(JSON.parse(raw) as string) };
  }

  private skipComposite(open: "{" | "[", close: "}" | "]"): void {
    let depth = 0;
    for (;;) {
      const char = this.json[this.index];
      if (char === undefined) {
        return;
      }
      if (char === "\"") {
        this.parseJSONString();
        continue;
      }
      if (char === open) {
        depth += 1;
      } else if (char === close) {
        depth -= 1;
        this.index += 1;
        if (depth === 0) {
          return;
        }
        continue;
      }
      this.index += 1;
    }
  }

  private parseJSONNumber(): void {
    if (this.json[this.index] === "-") {
      this.index += 1;
    }
    if (this.json[this.index] === "0") {
      this.index += 1;
    } else {
      while (isJSONDigit(this.json[this.index])) {
        this.index += 1;
      }
    }
    if (this.json[this.index] === ".") {
      this.index += 1;
      while (isJSONDigit(this.json[this.index])) {
        this.index += 1;
      }
    }
    if (this.json[this.index] === "e" || this.json[this.index] === "E") {
      this.index += 1;
      if (this.json[this.index] === "+" || this.json[this.index] === "-") {
        this.index += 1;
      }
      while (isJSONDigit(this.json[this.index])) {
        this.index += 1;
      }
    }
  }

  private skipWhitespace(index: number): number {
    while (index < this.json.length && isJSONWhitespace(this.json[index])) {
      index += 1;
    }
    return index;
  }

  private expect(char: string): void {
    if (this.json[this.index] === char) {
      this.index += 1;
    }
  }
}

function multiEditArgField(key: string): "path" | "edits" | undefined {
  const folded = key.toLowerCase();
  switch (folded) {
    case "path":
    case "edits":
      return folded;
    default:
      return undefined;
  }
}

function multiEditStepField(key: string): "old_string" | "new_string" | "replace_all" | undefined {
  const folded = key.toLowerCase();
  switch (folded) {
    case "old_string":
    case "new_string":
    case "replace_all":
      return folded;
    default:
      return undefined;
  }
}

function emptyStep(): NormalizedMultiEditStep {
  return { oldString: "", newString: "", replaceAll: false };
}

function goJSONTypeErrorForParsedValue(value: ParsedRawJSONValue, field: string, goType: string): string {
  return goJSONTypeErrorForValue(parsedJSONValueForError(value), field, goType);
}

function goJSONTypeErrorForValue(value: unknown, field: string, goType: string): string {
  return `json: cannot unmarshal ${goJSONTokenKind(value)} into Go struct field .${field} of type ${goType}`;
}

function isJSONWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function isJSONDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

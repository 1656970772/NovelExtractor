export type RawJSONValueKind = "string" | "number" | "object" | "array" | "bool" | "null";

export interface ParsedRawJSONValue {
  kind: RawJSONValueKind;
  raw: string;
  stringValue?: string;
}

const goInt64Min = -(1n << 63n);
const goInt64Max = (1n << 63n) - 1n;

export class GoRawJSONUnmarshaller {
  private index = 0;

  constructor(
    private readonly json: string,
    private readonly onTopLevelField?: (key: string, value: ParsedRawJSONValue) => void
  ) {}

  unmarshal(): RawJSONValueKind {
    this.index = this.skipWhitespace(0);
    if (this.index >= this.json.length) {
      this.syntaxError("unexpected end of JSON input");
    }

    const char = this.json[this.index];
    let kind: RawJSONValueKind;
    if (char === "{") {
      kind = "object";
      this.parseTopLevelObject();
    } else {
      kind = this.parseValue().kind;
    }

    this.index = this.skipWhitespace(this.index);
    if (this.index < this.json.length) {
      this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} after top-level value`);
    }

    return kind;
  }

  private parseTopLevelObject(): void {
    this.index += 1;
    let allowEnd = true;
    for (;;) {
      this.index = this.skipWhitespace(this.index);
      if (this.index >= this.json.length) {
        this.syntaxError("unexpected end of JSON input");
      }
      if (this.json[this.index] === "}") {
        if (!allowEnd) {
          this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} looking for beginning of object key string`);
        }
        this.index += 1;
        return;
      }
      if (this.json[this.index] !== "\"") {
        this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} looking for beginning of object key string`);
      }

      const key = this.parseJSONString();
      this.index = this.skipWhitespace(this.index);
      if (this.index >= this.json.length) {
        this.syntaxError("unexpected end of JSON input");
      }
      if (this.json[this.index] !== ":") {
        this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} after object key`);
      }

      this.index = this.skipWhitespace(this.index + 1);
      if (this.index >= this.json.length) {
        this.syntaxError("unexpected end of JSON input");
      }
      const value = this.parseValue();
      this.onTopLevelField?.(key, value);

      this.index = this.skipWhitespace(this.index);
      if (this.index >= this.json.length) {
        this.syntaxError("unexpected end of JSON input");
      }
      if (this.json[this.index] === ",") {
        this.index += 1;
        allowEnd = false;
        continue;
      }
      if (this.json[this.index] === "}") {
        this.index += 1;
        return;
      }
      this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} after object key:value pair`);
    }
  }

  private parseObject(): void {
    this.index += 1;
    let allowEnd = true;
    for (;;) {
      this.index = this.skipWhitespace(this.index);
      if (this.index >= this.json.length) {
        this.syntaxError("unexpected end of JSON input");
      }
      if (this.json[this.index] === "}") {
        if (!allowEnd) {
          this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} looking for beginning of object key string`);
        }
        this.index += 1;
        return;
      }
      if (this.json[this.index] !== "\"") {
        this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} looking for beginning of object key string`);
      }

      this.parseJSONString();
      this.index = this.skipWhitespace(this.index);
      if (this.index >= this.json.length) {
        this.syntaxError("unexpected end of JSON input");
      }
      if (this.json[this.index] !== ":") {
        this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} after object key`);
      }

      this.index = this.skipWhitespace(this.index + 1);
      if (this.index >= this.json.length) {
        this.syntaxError("unexpected end of JSON input");
      }
      this.parseValue();

      this.index = this.skipWhitespace(this.index);
      if (this.index >= this.json.length) {
        this.syntaxError("unexpected end of JSON input");
      }
      if (this.json[this.index] === ",") {
        this.index += 1;
        allowEnd = false;
        continue;
      }
      if (this.json[this.index] === "}") {
        this.index += 1;
        return;
      }
      this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} after object key:value pair`);
    }
  }

  private parseArray(): void {
    this.index += 1;
    let allowEnd = true;
    for (;;) {
      this.index = this.skipWhitespace(this.index);
      if (this.index >= this.json.length) {
        this.syntaxError("unexpected end of JSON input");
      }
      if (this.json[this.index] === "]") {
        if (!allowEnd) {
          this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} looking for beginning of value`);
        }
        this.index += 1;
        return;
      }

      this.parseValue();
      this.index = this.skipWhitespace(this.index);
      if (this.index >= this.json.length) {
        this.syntaxError("unexpected end of JSON input");
      }
      if (this.json[this.index] === ",") {
        this.index += 1;
        allowEnd = false;
        continue;
      }
      if (this.json[this.index] === "]") {
        this.index += 1;
        return;
      }
      this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} after array element`);
    }
  }

  private parseValue(): ParsedRawJSONValue {
    this.index = this.skipWhitespace(this.index);
    if (this.index >= this.json.length) {
      this.syntaxError("unexpected end of JSON input");
    }

    const start = this.index;
    const char = this.json[this.index];
    if (char === "{") {
      this.parseObject();
      return { kind: "object", raw: this.json.slice(start, this.index) };
    }
    if (char === "[") {
      this.parseArray();
      return { kind: "array", raw: this.json.slice(start, this.index) };
    }
    if (char === "\"") {
      const stringValue = this.parseJSONString();
      return { kind: "string", raw: this.json.slice(start, this.index), stringValue };
    }
    if (char === "-" || isJSONDigit(char)) {
      this.parseJSONNumber();
      return { kind: "number", raw: this.json.slice(start, this.index) };
    }
    if (char === "t") {
      this.parseLiteral("true");
      return { kind: "bool", raw: this.json.slice(start, this.index) };
    }
    if (char === "f") {
      this.parseLiteral("false");
      return { kind: "bool", raw: this.json.slice(start, this.index) };
    }
    if (char === "n") {
      this.parseLiteral("null");
      return { kind: "null", raw: this.json.slice(start, this.index) };
    }
    this.syntaxError(`invalid character ${goQuotedJSONChar(char)} looking for beginning of value`);
  }

  private parseJSONString(): string {
    const start = this.index;
    this.index += 1;
    for (;;) {
      if (this.index >= this.json.length) {
        this.syntaxError("unexpected end of JSON input");
      }
      const char = this.json[this.index];
      const code = this.json.charCodeAt(this.index);
      if (char === "\"") {
        this.index += 1;
        return decodeJSONStringLiteral(this.json.slice(start, this.index));
      }
      if (code <= 0x1f) {
        this.syntaxError(`invalid character ${goQuotedJSONChar(char)} in string literal`);
      }
      if (char === "\\") {
        this.index += 1;
        if (this.index >= this.json.length) {
          this.syntaxError("unexpected end of JSON input");
        }
        const escape = this.json[this.index];
        if (escape === "u") {
          for (let offset = 1; offset <= 4; offset += 1) {
            const hex = this.json[this.index + offset];
            if (hex === undefined) {
              this.syntaxError("unexpected end of JSON input");
            }
            if (!/[0-9a-fA-F]/u.test(hex)) {
              this.syntaxError(`invalid character ${goQuotedJSONChar(hex)} in \\u hexadecimal character escape`);
            }
          }
          this.index += 5;
          continue;
        }
        if (!["\"", "\\", "/", "b", "f", "n", "r", "t"].includes(escape)) {
          this.syntaxError(`invalid character ${goQuotedJSONChar(escape)} in string escape code`);
        }
        this.index += 1;
        continue;
      }
      this.index += 1;
    }
  }

  private parseJSONNumber(): void {
    if (this.json[this.index] === "-") {
      this.index += 1;
      if (this.index >= this.json.length) {
        this.syntaxError("unexpected end of JSON input");
      }
    }

    if (this.json[this.index] === "0") {
      this.index += 1;
    } else if (isJSONDigit1To9(this.json[this.index])) {
      do {
        this.index += 1;
      } while (isJSONDigit(this.json[this.index]));
    } else {
      this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} in numeric literal`);
    }

    if (this.json[this.index] === ".") {
      this.index += 1;
      if (!isJSONDigit(this.json[this.index])) {
        if (this.index >= this.json.length) {
          this.syntaxError("unexpected end of JSON input");
        }
        this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} after decimal point in numeric literal`);
      }
      do {
        this.index += 1;
      } while (isJSONDigit(this.json[this.index]));
    }

    if (this.json[this.index] === "e" || this.json[this.index] === "E") {
      this.index += 1;
      if (this.json[this.index] === "+" || this.json[this.index] === "-") {
        this.index += 1;
      }
      if (!isJSONDigit(this.json[this.index])) {
        if (this.index >= this.json.length) {
          this.syntaxError("unexpected end of JSON input");
        }
        this.syntaxError(`invalid character ${goQuotedJSONChar(this.json[this.index])} in exponent of numeric literal`);
      }
      do {
        this.index += 1;
      } while (isJSONDigit(this.json[this.index]));
    }
  }

  private parseLiteral(literal: "true" | "false" | "null"): void {
    for (let offset = 0; offset < literal.length; offset += 1) {
      const char = this.json[this.index + offset];
      if (char === undefined) {
        this.syntaxError("unexpected end of JSON input");
      }
      if (char !== literal[offset]) {
        this.syntaxError(`invalid character ${goQuotedJSONChar(char)} in literal ${literal} (expecting ${goQuotedJSONChar(literal[offset])})`);
      }
    }
    this.index += literal.length;
  }

  private skipWhitespace(index: number): number {
    while (index < this.json.length && isJSONWhitespace(this.json[index])) {
      index += 1;
    }
    return index;
  }

  private syntaxError(message: string): never {
    throw invalidArgs(message);
  }
}

export function invalidArgs(message: string): Error {
  return new Error(`invalid args: ${message}`);
}

export function parsedJSONValueForError(value: ParsedRawJSONValue): unknown {
  switch (value.kind) {
    case "string":
      return "";
    case "number":
      return 0;
    case "object":
      return {};
    case "array":
      return [];
    case "bool":
      return false;
    case "null":
      return null;
  }
}

export function goJSONTypeError(value: unknown, field: string, goType: "string" | "int" | "bool", rawNumberLiteral?: string): string {
  if (typeof value === "number") {
    const token =
      goType === "int" && rawNumberLiteral !== undefined ? `number ${rawNumberLiteral}` : goType === "int" && !Number.isInteger(value) ? `number ${value}` : "number";
    return `json: cannot unmarshal ${token} into Go struct field .${field} of type ${goType}`;
  }
  return `json: cannot unmarshal ${goJSONTokenKind(value)} into Go struct field .${field} of type ${goType}`;
}

export function goJSONTokenKind(value: unknown): string {
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "boolean") {
    return "bool";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (value !== null && typeof value === "object") {
    return "object";
  }
  return typeof value;
}

export function isGoIntLiteral(rawLiteral: string): boolean {
  if (!/^-?(?:0|[1-9]\d*)$/u.test(rawLiteral)) {
    return false;
  }
  const value = BigInt(rawLiteral);
  return value >= goInt64Min && value <= goInt64Max;
}

export function replaceIsolatedSurrogates(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index] + value[index + 1];
        index += 1;
      } else {
        out += "\ufffd";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\ufffd";
      continue;
    }
    out += value[index];
  }
  return out;
}

function decodeJSONStringLiteral(rawLiteral: string): string {
  return replaceIsolatedSurrogates(JSON.parse(rawLiteral) as string);
}

function isJSONWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function isJSONDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function isJSONDigit1To9(char: string | undefined): boolean {
  return char !== undefined && char >= "1" && char <= "9";
}

function goQuotedJSONChar(char: string): string {
  switch (char) {
    case "\n":
      return "'\\n'";
    case "\r":
      return "'\\r'";
    case "\t":
      return "'\\t'";
    case "'":
      return "'\\''";
    default:
      return `'${char}'`;
  }
}

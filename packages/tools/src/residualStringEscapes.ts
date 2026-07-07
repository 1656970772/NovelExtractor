export interface DecodedResidualEscapes {
  text: string;
  rawStarts: number[];
  rawEnds: number[];
  changed: boolean;
}

export function decodeResidualStringEscapes(value: string): string {
  return decodeResidualStringEscapesWithMap(value).text;
}

export function decodeResidualStringEscapesWithMap(value: string): DecodedResidualEscapes {
  const chunks: string[] = [];
  const rawStarts: number[] = [];
  const rawEnds: number[] = [];
  let changed = false;

  const append = (text: string, rawStart: number, rawEnd: number): void => {
    chunks.push(text);
    for (let index = 0; index < text.length; index += 1) {
      rawStarts.push(rawStart);
      rawEnds.push(rawEnd);
    }
  };

  for (let index = 0; index < value.length; ) {
    if (value[index] !== "\\") {
      append(value[index], index, index + 1);
      index += 1;
      continue;
    }

    if (index + 1 >= value.length) {
      append("\\", index, index + 1);
      index += 1;
      continue;
    }

    const next = value[index + 1];
    const simple = decodeSimpleEscape(next);
    if (simple !== undefined) {
      append(simple, index, index + 2);
      changed = true;
      index += 2;
      continue;
    }

    if (next === "x") {
      const hex = value.slice(index + 2, index + 4);
      if (/^[0-9a-fA-F]{2}$/u.test(hex)) {
        append(String.fromCharCode(Number.parseInt(hex, 16)), index, index + 4);
        changed = true;
        index += 4;
        continue;
      }
    }

    if (next === "u") {
      const braced = decodeBracedUnicodeEscape(value, index);
      if (braced !== undefined) {
        append(braced.text, index, braced.end);
        changed = true;
        index = braced.end;
        continue;
      }

      const hex = value.slice(index + 2, index + 6);
      if (/^[0-9a-fA-F]{4}$/u.test(hex)) {
        append(String.fromCharCode(Number.parseInt(hex, 16)), index, index + 6);
        changed = true;
        index += 6;
        continue;
      }
    }

    append("\\", index, index + 1);
    index += 1;
  }

  return { text: chunks.join(""), rawStarts, rawEnds, changed };
}

function decodeSimpleEscape(value: string): string | undefined {
  switch (value) {
    case "\"":
      return "\"";
    case "'":
      return "'";
    case "\\":
      return "\\";
    case "/":
      return "/";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "v":
      return "\v";
    case "0":
      return "\0";
    default:
      return undefined;
  }
}

function decodeBracedUnicodeEscape(value: string, slashIndex: number): { text: string; end: number } | undefined {
  if (value[slashIndex + 2] !== "{") {
    return undefined;
  }

  const closeIndex = value.indexOf("}", slashIndex + 3);
  if (closeIndex === -1) {
    return undefined;
  }

  const hex = value.slice(slashIndex + 3, closeIndex);
  if (!/^[0-9a-fA-F]{1,6}$/u.test(hex)) {
    return undefined;
  }

  const codePoint = Number.parseInt(hex, 16);
  if (codePoint > 0x10ffff) {
    return undefined;
  }

  return { text: String.fromCodePoint(codePoint), end: closeIndex + 1 };
}

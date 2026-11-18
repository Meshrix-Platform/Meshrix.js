import { RE2JS } from "re2js";

export interface Re2PatternProgram {
  test(value: string): boolean;
}

const MAX_PATTERN_LENGTH = 160;
const MAX_REWRITTEN_REPEAT_SEGMENTS = 64;
const MAX_TRANSLATED_PATTERN_LENGTH = 16_384;
const WHITESPACE_CODE_POINTS = Object.freeze([
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
  ...Array.from({ length: 11 }, (_value, index) => 0x2000 + index),
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff
]);
const WHITESPACE_MEMBERS = WHITESPACE_CODE_POINTS.map((value) => `\\x{${value.toString(16)}}`).join("");
const GENERAL_CATEGORY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  C: "C", Other: "C", Cc: "Cc", Control: "Cc", Cf: "Cf", Format: "Cf",
  Cn: "Cn", Unassigned: "Cn", Co: "Co", Private_Use: "Co", Cs: "Cs", Surrogate: "Cs",
  L: "L", Letter: "L", LC: "LC", Cased_Letter: "LC", Ll: "Ll", Lowercase_Letter: "Ll", Lm: "Lm", Modifier_Letter: "Lm",
  Lo: "Lo", Other_Letter: "Lo", Lt: "Lt", Titlecase_Letter: "Lt", Lu: "Lu", Uppercase_Letter: "Lu",
  M: "M", Mark: "M", Mc: "Mc", Spacing_Mark: "Mc", Me: "Me", Enclosing_Mark: "Me",
  Mn: "Mn", Nonspacing_Mark: "Mn", N: "N", Number: "N", Nd: "Nd", Decimal_Number: "Nd",
  Nl: "Nl", Letter_Number: "Nl", No: "No", Other_Number: "No", P: "P", Punctuation: "P",
  Pc: "Pc", Connector_Punctuation: "Pc", Pd: "Pd", Dash_Punctuation: "Pd", Pe: "Pe",
  Close_Punctuation: "Pe", Pf: "Pf", Final_Punctuation: "Pf", Pi: "Pi", Initial_Punctuation: "Pi",
  Po: "Po", Other_Punctuation: "Po", Ps: "Ps", Open_Punctuation: "Ps", S: "S", Symbol: "S",
  Sc: "Sc", Currency_Symbol: "Sc", Sk: "Sk", Modifier_Symbol: "Sk", Sm: "Sm", Math_Symbol: "Sm",
  So: "So", Other_Symbol: "So", Z: "Z", Separator: "Z", Zl: "Zl", Line_Separator: "Zl",
  Zp: "Zp", Paragraph_Separator: "Zp", Zs: "Zs", Space_Separator: "Zs"
});
const SCRIPT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  Arab: "Arabic", Armn: "Armenian", Beng: "Bengali", Bopo: "Bopomofo", Cher: "Cherokee",
  Cyrl: "Cyrillic", Deva: "Devanagari", Ethi: "Ethiopic", Geor: "Georgian", Grek: "Greek",
  Hang: "Hangul", Hani: "Han", Hebr: "Hebrew", Hira: "Hiragana",
  Kana: "Katakana", Khmr: "Khmer", Knda: "Kannada", Laoo: "Lao", Latn: "Latin", Mlym: "Malayalam",
  Mymr: "Myanmar", Orya: "Oriya", Sinh: "Sinhala", Taml: "Tamil", Telu: "Telugu", Thai: "Thai",
  Tibt: "Tibetan", Zinh: "Inherited", Zyyy: "Common", Zzzz: "Unknown"
});

function syntaxError(): TypeError {
  return new TypeError("Pattern is outside the bounded ECMAScript regular-expression subset.");
}

function codePointWidth(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1;
}

function findClosingBrace(source: string, start: number): number {
  const end = source.indexOf("}", start + 1);
  if (end < 0) throw syntaxError();
  return end;
}

function findClassEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length;) {
    if (source[index] === "\\") {
      index = readEscapeEnd(source, index);
    } else if (source[index] === "]") {
      return index;
    } else {
      index += codePointWidth(source.codePointAt(index)!);
    }
  }
  throw syntaxError();
}

function readEscapeEnd(source: string, start: number): number {
  const escape = source[start + 1];
  if (escape === undefined) throw syntaxError();
  if ((escape === "p" || escape === "P") && source[start + 2] === "{") {
    return findClosingBrace(source, start + 2) + 1;
  }
  if (escape === "u" && source[start + 2] === "{") {
    return findClosingBrace(source, start + 2) + 1;
  }
  if (escape === "u") {
    const first = source.slice(start + 2, start + 6);
    if (/^[0-9A-Fa-f]{4}$/u.test(first)) {
      const high = Number.parseInt(first, 16);
      const secondStart = start + 6;
      const second = source.slice(secondStart + 2, secondStart + 6);
      if (high >= 0xd800 && high <= 0xdbff && source.startsWith("\\u", secondStart) &&
        /^[0-9A-Fa-f]{4}$/u.test(second)) {
        const low = Number.parseInt(second, 16);
        if (low >= 0xdc00 && low <= 0xdfff) return secondStart + 6;
      }
      return start + 6;
    }
  }
  if (escape === "x") return Math.min(source.length, start + 4);
  if (escape === "c") return Math.min(source.length, start + 3);
  return Math.min(source.length, start + 2);
}

function readQuantifier(source: string, start: number): Readonly<{
  end: number;
  minimum: number;
  maximum: number | null;
}> {
  const match = /^\{([0-9]+)(?:,([0-9]*))?\}/u.exec(source.slice(start));
  if (!match) throw syntaxError();
  const minimum = Number(match[1]);
  const maximum = match[2] === undefined
    ? minimum
    : match[2] === ""
      ? null
      : Number(match[2]);
  if (!Number.isSafeInteger(minimum) || minimum < 0 ||
    maximum !== null && (!Number.isSafeInteger(maximum) || maximum < minimum)) {
    throw syntaxError();
  }
  return Object.freeze({ end: start + match[0].length, minimum, maximum });
}

function boundedRepeatParts(minimum: number, maximum: number | null): readonly [number, number | null][] {
  const parts: [number, number | null][] = [];
  const add = (min: number, max: number | null): void => {
    parts.push([min, max]);
    if (parts.length > MAX_REWRITTEN_REPEAT_SEGMENTS) throw syntaxError();
  };
  let lower = minimum;
  let upper = maximum;
  while (lower > 1000) {
    add(1000, 1000);
    lower -= 1000;
    if (upper !== null) upper -= 1000;
  }
  if (upper === null) {
    add(lower, null);
  } else if (upper <= 1000) {
    add(lower, upper);
  } else {
    add(lower, 1000);
    upper -= 1000;
    while (upper > 1000) {
      add(0, 1000);
      upper -= 1000;
    }
    add(0, upper);
  }
  return parts;
}

function renderQuantifier(minimum: number, maximum: number | null): string {
  if (maximum === null) return `{${minimum},}`;
  return minimum === maximum ? `{${minimum}}` : `{${minimum},${maximum}}`;
}

function expandLargeQuantifiers(source: string): string {
  const output: string[] = [];
  const groupStarts: { sourceStart: number; outputStart: number }[] = [];
  let atomStart: number | null = null;
  let atomOutputStart: number | null = null;
  let rewrittenSegments = 0;
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (character === "\\") {
      const end = readEscapeEnd(source, index);
      atomOutputStart = output.length;
      output.push(source.slice(index, end));
      atomStart = index;
      index = end;
      continue;
    }
    if (character === "[") {
      const end = findClassEnd(source, index);
      atomOutputStart = output.length;
      output.push(source.slice(index, end + 1));
      atomStart = index;
      index = end + 1;
      continue;
    }
    if (character === "(") {
      groupStarts.push({ sourceStart: index, outputStart: output.length });
      output.push(character);
      atomStart = null;
      atomOutputStart = null;
      index += 1;
      continue;
    }
    if (character === ")") {
      const group = groupStarts.pop();
      if (!group) throw syntaxError();
      output.push(character);
      atomStart = group.sourceStart;
      atomOutputStart = group.outputStart;
      index += 1;
      continue;
    }
    if (character === "|") {
      output.push(character);
      atomStart = null;
      atomOutputStart = null;
      index += 1;
      continue;
    }
    if (character === "^" || character === "$") {
      output.push(character);
      atomStart = null;
      atomOutputStart = null;
      index += 1;
      continue;
    }
    if (character === "*" || character === "+" || character === "?") {
      output.push(character);
      index += 1;
      if (source[index] === "?") {
        // Greediness does not change the boolean language tested by JSON Schema.
        index += 1;
      }
      atomStart = null;
      atomOutputStart = null;
      continue;
    }
    if (character === "{") {
      if (atomStart === null || atomOutputStart === null) throw syntaxError();
      const quantifier = readQuantifier(source, index);
      if (quantifier.minimum <= 1000 &&
        (quantifier.maximum === null || quantifier.maximum <= 1000)) {
        output.push(source.slice(index, quantifier.end));
      } else {
        const atom = source.slice(atomStart, index);
        const parts = boundedRepeatParts(quantifier.minimum, quantifier.maximum);
        rewrittenSegments += parts.length;
        if (rewrittenSegments > MAX_REWRITTEN_REPEAT_SEGMENTS) throw syntaxError();
        output.splice(atomOutputStart);
        for (const [minimum, maximum] of parts) {
          output.push(`(?:${atom})${renderQuantifier(minimum, maximum)}`);
        }
      }
      index = quantifier.end;
      if (source[index] === "?") index += 1;
      atomStart = null;
      atomOutputStart = null;
      continue;
    }
    const codePoint = source.codePointAt(index)!;
    atomOutputStart = output.length;
    output.push(source.slice(index, index + codePointWidth(codePoint)));
    atomStart = index;
    index += codePointWidth(codePoint);
  }
  const expanded = output.join("");
  if (expanded.length > MAX_TRANSLATED_PATTERN_LENGTH) throw syntaxError();
  return expanded;
}

function classHasEscape(source: string, target: string): boolean {
  for (let index = 0; index < source.length;) {
    if (source[index] !== "\\") {
      index += codePointWidth(source.codePointAt(index)!);
      continue;
    }
    if (source[index + 1] === target) return true;
    index = readEscapeEnd(source, index);
  }
  return false;
}

function removeClassEscape(source: string, target: string): string {
  const output: string[] = [];
  for (let index = 0; index < source.length;) {
    if (source[index] === "\\" && source[index + 1] === target) {
      index += 2;
      continue;
    }
    if (source[index] === "\\") {
      const end = readEscapeEnd(source, index);
      output.push(source.slice(index, end));
      index = end;
      continue;
    }
    const width = codePointWidth(source.codePointAt(index)!);
    output.push(source.slice(index, index + width));
    index += width;
  }
  return output.join("");
}

function escapeCodePoint(codePoint: number): string {
  return `\\x{${codePoint.toString(16)}}`;
}

function translateUnicodePropertyEscape(escape: string, property: string, inClass: boolean): string | null {
  if (property !== "ASCII") return null;
  const range = escape === "p" ? "\\x{0}-\\x{7f}" : "\\x{80}-\\x{10ffff}";
  return inClass ? range : `[${range}]`;
}

function normalizeCharacterClass(source: string): string {
  const negated = source.startsWith("^");
  const members = negated ? source.slice(1) : source;
  if (classHasEscape(members, "S")) {
    let others: RegExp;
    try {
      others = new RegExp(`^[${removeClassEscape(members, "S")}]$`, "u");
    } catch {
      throw syntaxError();
    }
    const excludedWhitespace = WHITESPACE_CODE_POINTS
      .filter((codePoint) => !others.test(String.fromCodePoint(codePoint)))
      .map(escapeCodePoint).join("");
    if (negated) return excludedWhitespace ? `[${excludedWhitespace}]` : "[^\\s\\S]";
    return excludedWhitespace ? `[^${excludedWhitespace}]` : "[\\s\\S]";
  }
  return `[${negated ? "^" : ""}${translateClassMembers(members)}]`;
}

function translateClassMembers(source: string): string {
  const output: string[] = [];
  for (let index = 0; index < source.length;) {
    if (source[index] === "\\") {
      const escape = source[index + 1];
      if (escape === "s") {
        output.push(WHITESPACE_MEMBERS);
        index += 2;
      } else if ((escape === "p" || escape === "P") && source[index + 2] === "{") {
        const end = findClosingBrace(source, index + 2);
        const property = normalizeUnicodeProperty(source.slice(index + 3, end));
        const translated = translateUnicodePropertyEscape(escape, property, true);
        output.push(translated ?? `\\${escape}{${property}}`);
        index = end + 1;
      } else if (escape === "u" && isSurrogatePairEscape(source, index)) {
        const combined = combinedSurrogateEscape(source, index)!;
        output.push(escapeCodePoint(combined.codePoint));
        index = combined.end;
      } else {
        const end = readEscapeEnd(source, index);
        output.push(source.slice(index, end));
        index = end;
      }
      continue;
    }
    const width = codePointWidth(source.codePointAt(index)!);
    output.push(source.slice(index, index + width));
    index += width;
  }
  return output.join("");
}

function combinedSurrogateEscape(source: string, start: number): Readonly<{ codePoint: number; end: number }> | null {
  const firstText = source.slice(start + 2, start + 6);
  const secondStart = start + 6;
  if (!/^[0-9A-Fa-f]{4}$/u.test(firstText) || !source.startsWith("\\u", secondStart)) return null;
  const secondText = source.slice(secondStart + 2, secondStart + 6);
  if (!/^[0-9A-Fa-f]{4}$/u.test(secondText)) return null;
  const high = Number.parseInt(firstText, 16);
  const low = Number.parseInt(secondText, 16);
  if (high < 0xd800 || high > 0xdbff || low < 0xdc00 || low > 0xdfff) return null;
  return {
    codePoint: 0x10000 + (high - 0xd800) * 0x400 + low - 0xdc00,
    end: secondStart + 6
  };
}

function isSurrogatePairEscape(source: string, index: number): boolean {
  return combinedSurrogateEscape(source, index) !== null;
}

function normalizeGeneralCategory(value: string): string {
  return GENERAL_CATEGORY_ALIASES[value] ?? value;
}

function normalizeUnicodeProperty(value: string): string {
  const separator = value.indexOf("=");
  if (separator < 0) return normalizeGeneralCategory(value);
  const property = value.slice(0, separator);
  const propertyValue = value.slice(separator + 1);
  if (property === "General_Category" || property === "gc") {
    return normalizeGeneralCategory(propertyValue);
  }
  if (property === "Script" || property === "sc") {
    return SCRIPT_ALIASES[propertyValue] ?? propertyValue;
  }
  if (property === "Script_Extensions" || property === "scx") throw syntaxError();
  return value;
}

function translateEcmaPattern(source: string): string {
  const output: string[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (character === "[") {
      const end = findClassEnd(source, index);
      output.push(normalizeCharacterClass(source.slice(index + 1, end)));
      index = end + 1;
      continue;
    }
    if (character === "\\") {
      const escape = source[index + 1];
      if (escape === "s") {
        output.push(`[${WHITESPACE_MEMBERS}]`);
        index += 2;
      } else if (escape === "S") {
        output.push(`[^${WHITESPACE_MEMBERS}]`);
        index += 2;
      } else if (escape === "u" && isSurrogatePairEscape(source, index)) {
        const combined = combinedSurrogateEscape(source, index)!;
        output.push(escapeCodePoint(combined.codePoint));
        index = combined.end;
      } else if ((escape === "p" || escape === "P") && source[index + 2] === "{") {
        const end = findClosingBrace(source, index + 2);
        const property = normalizeUnicodeProperty(source.slice(index + 3, end));
        output.push(translateUnicodePropertyEscape(escape, property, false) ??
          `\\${escape}{${property}}`);
        index = end + 1;
      } else {
        const end = readEscapeEnd(source, index);
        output.push(source.slice(index, end));
        index = end;
      }
      continue;
    }
    if (character === ".") {
      output.push("[^\\n\\r\\x{2028}\\x{2029}]");
      index += 1;
      continue;
    }
    const width = codePointWidth(source.codePointAt(index)!);
    output.push(source.slice(index, index + width));
    index += width;
  }
  return output.join("");
}

export function compileRe2Pattern(source: string): Re2PatternProgram {
  if (typeof source !== "string" || source.length > MAX_PATTERN_LENGTH) throw syntaxError();
  new RegExp(source, "u");
  const expanded = expandLargeQuantifiers(source);
  const translated = translateEcmaPattern(expanded);
  if (translated.length > MAX_TRANSLATED_PATTERN_LENGTH) throw syntaxError();
  const re2Source = RE2JS.translateRegExp(translated);
  const regex = RE2JS.compile(re2Source);
  return Object.freeze({ test: (value: string): boolean => regex.test(value) });
}

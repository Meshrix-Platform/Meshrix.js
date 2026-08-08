// Release journey PDF verification (pure Node, no external dependencies).
//
// Verifies that the release journey converted a
// converted Chinese TXT became a real PDF with embedded CJK glyphs:
// 1. `%PDF-` magic.
// 2. Byte-length sanity bound.
// 3. FlateDecode streams inflate; embedded font names include a Noto CJK face.
// 4. ToUnicode CMaps map every distinct Han codepoint of the source fixture
//    (real glyphs, not .notdef tofu).
import { inflateSync } from "node:zlib";

const BASE_FONT_PATTERN: any = /\/BaseFont\s*\/([A-Za-z0-9+_,.-]+)/g;
const FONT_NAME_PATTERN: any = /\/FontName\s*\/([A-Za-z0-9+_,.-]+)/g;
const HEX_CODEPOINT_PATTERN: any = /<([0-9A-Fa-f]{4})>/g;
const NOTO_CJK_PATTERN: any = /Noto(?:Sans|Serif)CJK/u;

export function distinctHanCodepoints(text: any = "") : any {
  const codepoints: any = new Set<any>();
  for (const char of String(text)) {
    if (char >= "一" && char <= "鿿") {
      codepoints.add(char.codePointAt(0));
    }
  }
  return [...codepoints].sort((left?: any, right?: any) : any => left - right);
}

export function inflatePdfStreams(pdf?: any) : any {
  // Scan in latin1 so character offsets equal byte offsets; Buffer-to-string
  // coercion defaults to utf8 and would shift every offset after binary data.
  const text: any = Buffer.isBuffer(pdf) ? pdf.toString("latin1") : String(pdf);
  const inflated: any[] = [];
  const streamPattern: any = /(?<!end)stream\r?\n/g;
  let match: any;
  while ((match = streamPattern.exec(text)) !== null) {
    const start: any = match.index + match[0].length;
    // The byte sequence "endstream" may occur inside compressed data; walk
    // candidate terminators until one actually closes a FlateDecode stream.
    let end: any = text.indexOf("endstream", start);
    while (end >= 0) {
      try {
        inflated.push(inflateSync(Buffer.from(text.slice(start, end), "latin1")));
        break;
      } catch {
        end = text.indexOf("endstream", end + 1);
      }
    }
  }
  return inflated;
}

export function embeddedFontNames(haystacks: any = []) : any {
  const fonts: any = new Set<any>();
  for (const haystack of haystacks) {
    const text: any = Buffer.isBuffer(haystack) ? haystack.toString("latin1") : String(haystack);
    for (const pattern of [BASE_FONT_PATTERN, FONT_NAME_PATTERN]) {
      pattern.lastIndex = 0;
      let match: any;
      while ((match = pattern.exec(text)) !== null) {
        fonts.add(match[1]);
      }
    }
  }
  return [...fonts].sort();
}

export function toUnicodeCodepoints(haystacks: any = []) : any {
  const codepoints: any = new Set<any>();
  for (const haystack of haystacks) {
    const text: any = Buffer.isBuffer(haystack) ? haystack.toString("latin1") : String(haystack);
    if (!text.includes("beginbfchar") && !text.includes("beginbfrange")) {
      continue;
    }
    HEX_CODEPOINT_PATTERN.lastIndex = 0;
    let match: any;
    while ((match = HEX_CODEPOINT_PATTERN.exec(text)) !== null) {
      codepoints.add(Number.parseInt(match[1], 16));
    }
  }
  return codepoints;
}

/**
 * Verify a converted PDF against the source text.
 *
 * @param {Buffer} pdfBytes
 * @param {string} sourceText UTF-8 source document text
 * @param {{minBytes?: number, maxBytes?: number, requireFullHanCoverage?: boolean}} options
 */
export function verifyConvertedPdf(pdfBytes?: any, sourceText?: any, options: Record<string, any> = {}) : any {
  if (!Buffer.isBuffer(pdfBytes) || pdfBytes.length === 0) {
    throw new TypeError("verifyConvertedPdf requires the PDF bytes.");
  }
  const minBytes: any = Number.isSafeInteger(options.minBytes) ? options.minBytes : 1024;
  const maxBytes: any = Number.isSafeInteger(options.maxBytes) ? options.maxBytes : 64 * 1024 * 1024;
  const requireFullHanCoverage: any = options.requireFullHanCoverage !== false;

  const magicOk: any = pdfBytes.subarray(0, 5).toString("latin1") === "%PDF-";
  const byteLength: any = pdfBytes.length;
  const sizeOk: any = byteLength >= minBytes && byteLength <= maxBytes;

  const haystacks: any[] = [pdfBytes.toString("latin1"), ...inflatePdfStreams(pdfBytes).map((stream?: any) : any => stream.toString("latin1"))];
  const fonts: any = embeddedFontNames(haystacks);
  const notoCjkEmbedded: any = fonts.some((font?: any) : any => NOTO_CJK_PATTERN.test(font));

  const hanCodepoints: any = distinctHanCodepoints(sourceText);
  const mapped: any = toUnicodeCodepoints(haystacks);
  const covered: any = hanCodepoints.filter((codepoint?: any) : any => mapped.has(codepoint));
  const missing: any = hanCodepoints
    .filter((codepoint?: any) : any => !mapped.has(codepoint))
    .slice(0, 10)
    .map((codepoint?: any) : any => `U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}`);
  const fullCoverage: any = hanCodepoints.length > 0 && covered.length === hanCodepoints.length;

  const ok: any = magicOk && sizeOk && notoCjkEmbedded && (!requireFullHanCoverage || fullCoverage);
  return {
    ok,
    magic: pdfBytes.subarray(0, 8).toString("latin1"),
    magicOk,
    byteLength,
    sizeOk,
    inflatedStreamCount: haystacks.length - 1,
    fonts,
    notoCjkEmbedded,
    hanCodepointsInSource: hanCodepoints.length,
    hanCodepointsMapped: covered.length,
    hanFullCoverage: fullCoverage,
    hanCoverageRequired: requireFullHanCoverage,
    missingHanCodepoints: missing
  };
}

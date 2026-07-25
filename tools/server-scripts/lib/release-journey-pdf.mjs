// Release journey PDF verification (pure Node, no external dependencies).
//
// Ports the stdlib-only checks from Meshrix-Services
// build/cjk-proof/verify_pdf.py so the release journey gate can prove that a
// converted Chinese TXT became a real PDF with embedded CJK glyphs:
// 1. `%PDF-` magic.
// 2. Byte-length sanity bound.
// 3. FlateDecode streams inflate; embedded font names include a Noto CJK face.
// 4. ToUnicode CMaps map every distinct Han codepoint of the source fixture
//    (real glyphs, not .notdef tofu).
import { inflateSync } from "node:zlib";

const BASE_FONT_PATTERN = /\/BaseFont\s*\/([A-Za-z0-9+_,.-]+)/g;
const FONT_NAME_PATTERN = /\/FontName\s*\/([A-Za-z0-9+_,.-]+)/g;
const HEX_CODEPOINT_PATTERN = /<([0-9A-Fa-f]{4})>/g;
const NOTO_CJK_PATTERN = /Noto(?:Sans|Serif)CJK/u;

export function distinctHanCodepoints(text = "") {
  const codepoints = new Set();
  for (const char of String(text)) {
    if (char >= "一" && char <= "鿿") {
      codepoints.add(char.codePointAt(0));
    }
  }
  return [...codepoints].sort((left, right) => left - right);
}

export function inflatePdfStreams(pdf) {
  // Scan in latin1 so character offsets equal byte offsets; Buffer-to-string
  // coercion defaults to utf8 and would shift every offset after binary data.
  const text = Buffer.isBuffer(pdf) ? pdf.toString("latin1") : String(pdf);
  const inflated = [];
  const streamPattern = /(?<!end)stream\r?\n/g;
  let match;
  while ((match = streamPattern.exec(text)) !== null) {
    const start = match.index + match[0].length;
    // The byte sequence "endstream" may occur inside compressed data; walk
    // candidate terminators until one actually closes a FlateDecode stream.
    let end = text.indexOf("endstream", start);
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

export function embeddedFontNames(haystacks = []) {
  const fonts = new Set();
  for (const haystack of haystacks) {
    const text = Buffer.isBuffer(haystack) ? haystack.toString("latin1") : String(haystack);
    for (const pattern of [BASE_FONT_PATTERN, FONT_NAME_PATTERN]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        fonts.add(match[1]);
      }
    }
  }
  return [...fonts].sort();
}

export function toUnicodeCodepoints(haystacks = []) {
  const codepoints = new Set();
  for (const haystack of haystacks) {
    const text = Buffer.isBuffer(haystack) ? haystack.toString("latin1") : String(haystack);
    if (!text.includes("beginbfchar") && !text.includes("beginbfrange")) {
      continue;
    }
    HEX_CODEPOINT_PATTERN.lastIndex = 0;
    let match;
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
export function verifyConvertedPdf(pdfBytes, sourceText, options = {}) {
  if (!Buffer.isBuffer(pdfBytes) || pdfBytes.length === 0) {
    throw new TypeError("verifyConvertedPdf requires the PDF bytes.");
  }
  const minBytes = Number.isSafeInteger(options.minBytes) ? options.minBytes : 1024;
  const maxBytes = Number.isSafeInteger(options.maxBytes) ? options.maxBytes : 64 * 1024 * 1024;
  const requireFullHanCoverage = options.requireFullHanCoverage !== false;

  const magicOk = pdfBytes.subarray(0, 5).toString("latin1") === "%PDF-";
  const byteLength = pdfBytes.length;
  const sizeOk = byteLength >= minBytes && byteLength <= maxBytes;

  const haystacks = [pdfBytes.toString("latin1"), ...inflatePdfStreams(pdfBytes).map((stream) => stream.toString("latin1"))];
  const fonts = embeddedFontNames(haystacks);
  const notoCjkEmbedded = fonts.some((font) => NOTO_CJK_PATTERN.test(font));

  const hanCodepoints = distinctHanCodepoints(sourceText);
  const mapped = toUnicodeCodepoints(haystacks);
  const covered = hanCodepoints.filter((codepoint) => mapped.has(codepoint));
  const missing = hanCodepoints
    .filter((codepoint) => !mapped.has(codepoint))
    .slice(0, 10)
    .map((codepoint) => `U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}`);
  const fullCoverage = hanCodepoints.length > 0 && covered.length === hanCodepoints.length;

  const ok = magicOk && sizeOk && notoCjkEmbedded && (!requireFullHanCoverage || fullCoverage);
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

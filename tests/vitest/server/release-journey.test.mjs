import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";

import {
  distinctHanCodepoints,
  embeddedFontNames,
  inflatePdfStreams,
  toUnicodeCodepoints,
  verifyConvertedPdf
} from "../../../tools/server-scripts/lib/release-journey-pdf.mjs";
import {
  createRedaction,
  createReleaseJourneyReport,
  finalizeReleaseJourneyReport,
  stepReceipt
} from "../../../tools/server-scripts/lib/release-journey-report.mjs";
import { safePublicToolSegment } from "../../../tools/server-scripts/lib/release-journey-mcp.mjs";

const FIXTURE_TEXT = "格式转换服务中文验收样例\n第一段：Meshrix 格式转换服务将 UTF-8 纯文本文档转换为 DOCX 或 PDF。";

function streamOf(payload) {
  return Buffer.concat([Buffer.from("stream\n"), deflateSync(payload), Buffer.from("\nendstream")]);
}

function syntheticPdf({ fontName = "BAAAAA+NotoSerifCJKjp-Regular-VKana", codepoints = [] } = {}) {
  const font = streamOf(Buffer.from(`/BaseFont /${fontName} /FontName /${fontName}`, "latin1"));
  const cmapEntries = codepoints.map((codepoint) => `<${codepoint.toString(16).toUpperCase().padStart(4, "0")}>`).join(" ");
  const cmap = streamOf(Buffer.from(`beginbfchar ${cmapEntries} endbfchar`, "latin1"));
  return Buffer.concat([Buffer.from("%PDF-1.6\n"), Buffer.alloc(2048, 0x20), font, cmap, Buffer.from("%%EOF")]);
}

describe("release-journey-pdf", () => {
  it("collects distinct Han codepoints from the source text", () => {
    const codepoints = distinctHanCodepoints(FIXTURE_TEXT);
    expect(codepoints.length).toBeGreaterThan(10);
    expect(codepoints).toContain("格".codePointAt(0));
    expect(codepoints).toContain("样".codePointAt(0));
    expect(new Set(codepoints).size).toBe(codepoints.length);
  });

  it("inflates FlateDecode streams and finds embedded fonts", () => {
    const pdf = syntheticPdf();
    const inflated = inflatePdfStreams(pdf);
    expect(inflated.length).toBe(2);
    const fonts = embeddedFontNames([pdf, ...inflated]);
    expect(fonts).toContain("BAAAAA+NotoSerifCJKjp-Regular-VKana");
  });

  it("collects ToUnicode codepoints only from CMap streams", () => {
    const codepoint = "验".codePointAt(0);
    const pdf = syntheticPdf({ codepoints: [codepoint] });
    const mapped = toUnicodeCodepoints([pdf, ...inflatePdfStreams(pdf)]);
    expect(mapped.has(codepoint)).toBe(true);
    expect(mapped.has("格".codePointAt(0))).toBe(false);
  });

  it("accepts a fully covered CJK PDF", () => {
    const codepoints = distinctHanCodepoints(FIXTURE_TEXT);
    const result = verifyConvertedPdf(syntheticPdf({ codepoints }), FIXTURE_TEXT);
    expect(result.ok).toBe(true);
    expect(result.magicOk).toBe(true);
    expect(result.notoCjkEmbedded).toBe(true);
    expect(result.hanFullCoverage).toBe(true);
    expect(result.hanCodepointsMapped).toBe(result.hanCodepointsInSource);
  });

  it("rejects a PDF without an embedded Noto CJK font", () => {
    const codepoints = distinctHanCodepoints(FIXTURE_TEXT);
    const result = verifyConvertedPdf(
      syntheticPdf({ fontName: "CAAAAA+LiberationSerif", codepoints }),
      FIXTURE_TEXT
    );
    expect(result.ok).toBe(false);
    expect(result.notoCjkEmbedded).toBe(false);
  });

  it("rejects incomplete ToUnicode Han coverage and reports missing codepoints", () => {
    const result = verifyConvertedPdf(syntheticPdf({ codepoints: [] }), FIXTURE_TEXT);
    expect(result.ok).toBe(false);
    expect(result.hanFullCoverage).toBe(false);
    expect(result.hanCodepointsMapped).toBe(0);
    expect(result.missingHanCodepoints.length).toBeGreaterThan(0);
    expect(result.missingHanCodepoints[0]).toMatch(/^U\+[0-9A-F]{4}$/u);
  });

  it("rejects non-PDF bytes and undersized payloads", () => {
    expect(verifyConvertedPdf(Buffer.from("not a pdf at all"), FIXTURE_TEXT).ok).toBe(false);
    expect(verifyConvertedPdf(Buffer.from("%PDF-"), FIXTURE_TEXT).sizeOk).toBe(false);
  });
});

describe("release-journey-mcp safePublicToolSegment", () => {
  it("matches the server-side segment encoding for upstream identities", () => {
    expect(safePublicToolSegment("file-parser/format-convert")).toBe("file-parser-format-convert");
    expect(safePublicToolSegment("svc_z6cc0xJR6qEUsDv9EtHH4-jOtmyk0-ddwYmK5G3mTe4")).toBe("svc_z6cc0xJR6qEUsDv9EtHH4-jOtmyk0-ddwYmK5G3mTe4");
    expect(safePublicToolSegment("convert")).toBe("convert");
    expect(safePublicToolSegment("///")).toBe("service");
  });
});

describe("release-journey-report", () => {
  it("redacts runtime secrets and local paths from free text", () => {
    const { addNeedle, redact } = createRedaction({ repoRoot: "/repo/root" });
    addNeedle("sap_superSecretPassword123");
    const text = redact("login with sap_superSecretPassword123 at /repo/root/tools ok");
    expect(text).not.toContain("sap_superSecretPassword123");
    expect(text).toContain("[redacted-secret]");
  });

  it("fails closed when a secret survives into the report", () => {
    const { addNeedle, assertNoLeak } = createRedaction({ repoRoot: "/repo/root" });
    addNeedle("token-abcdef123456");
    const report = createReleaseJourneyReport({});
    report.steps.push(stepReceipt("preflight", { status: "passed", receipt: { note: "token-abcdef123456" } }));
    expect(() => finalizeReleaseJourneyReport(report, { assertNoLeak })).toThrow(/secret/u);
  });

  it("computes releaseReady from step and cleanup outcomes", () => {
    const report = createReleaseJourneyReport({});
    report.steps.push(stepReceipt("preflight", { status: "passed", durationMs: 12 }));
    report.steps.push(stepReceipt("mcp-journey", { status: "passed", durationMs: 34 }));
    report.cleanup.performed = true;
    report.cleanup.details.push({ id: "compose-down", status: "passed" });
    const { report: finalized, serialized } = finalizeReleaseJourneyReport(report);
    expect(finalized.releaseReady).toBe(true);
    expect(finalized.generatedAt).toBeTruthy();
    expect(serialized.endsWith("\n")).toBe(true);

    const failed = createReleaseJourneyReport({});
    failed.steps.push(stepReceipt("connector-install", { status: "failed", error: { message: "boom" } }));
    expect(finalizeReleaseJourneyReport(failed).report.releaseReady).toBe(false);
  });

  it("produces step receipts with bounded error payloads", () => {
    const receipt = stepReceipt("adapter-seed", {
      status: "failed",
      durationMs: 3.7,
      error: { code: "release_journey_adapter_source_missing", message: "x".repeat(2000) }
    });
    expect(receipt.durationMs).toBe(4);
    expect(receipt.error.message.length).toBeLessThanOrEqual(800);
    expect(receipt.error.code).toBe("release_journey_adapter_source_missing");
  });
});

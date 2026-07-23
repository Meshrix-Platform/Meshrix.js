import { describe, expect, it } from "vitest";

import {
  createReport,
  scanText
} from "../../../tools/config-scanner.mjs";

describe("repository local-info hygiene report redaction", () => {
  it("records only location, category, length, and an irreversible fingerprint", () => {
    const sensitiveValue = ["/", "Users", "/", "fixture-account", "/", "private-project"].join("");
    const findings = scanText("fixtures/local-path.txt", sensitiveValue, Buffer.alloc(32, 7));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: "developer-macos-home-path",
      rule: "developer-macos-home-path",
      file: "fixtures/local-path.txt",
      line: 1,
      column: 1,
      matchLength: Buffer.byteLength(sensitiveValue, "utf8")
    });
    expect(findings[0].fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(findings[0]).not.toHaveProperty("match");
    expect(JSON.stringify(findings)).not.toContain(sensitiveValue);

    const report = createReport(findings, "2026-07-10T00:00:00.000Z");
    expect(report.summary.reportLeakScan).toBe(true);
    expect(JSON.stringify(report)).not.toContain(sensitiveValue);
  });

  it("uses a keyed fingerprint so identical values cannot be correlated across scan keys", () => {
    const sensitiveValue = ["/", "home", "/", "fixture-account", "/", "private-project"].join("");
    const first = scanText("fixture.txt", sensitiveValue, Buffer.alloc(32, 1));
    const second = scanText("fixture.txt", sensitiveValue, Buffer.alloc(32, 2));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].fingerprint).not.toBe(second[0].fingerprint);
  });

  it("fails closed when report metadata itself contains local information", () => {
    const unsafeFile = ["/", "Users", "/", "fixture-account", "/", "finding.txt"].join("");
    let thrown;
    try {
      createReport([{
        severity: "warning",
        rule: "developer-macos-home-path",
        category: "developer-macos-home-path",
        file: unsafeFile,
        line: 1,
        column: 1,
        matchLength: 1,
        fingerprint: "a".repeat(64),
        message: "Use a placeholder."
      }]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).not.toContain(unsafeFile);
  });
});

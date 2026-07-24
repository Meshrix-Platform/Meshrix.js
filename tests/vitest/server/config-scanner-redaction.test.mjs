import { describe, expect, it } from "vitest";

import {
  createReport,
  scanText
} from "../../../tools/config-scanner.mjs";

const scanKey = Buffer.alloc(32, 7);

function macosHome(username, ...parts) {
  return ["", "Users", username, ...parts].join("/");
}

function linuxHome(username, ...parts) {
  return ["", "home", username, ...parts].join("/");
}

function windowsHome(username, ...parts) {
  return ["C:", "Users", username, ...parts].join("\\");
}

describe("repository local-info hygiene report redaction", () => {
  it("records only location, category, length, and an irreversible fingerprint", () => {
    const sensitiveValue = ["/", "Users", "/", "fixture-account", "/", "private-project"].join("");
    const findings = scanText("fixtures/local-path.txt", sensitiveValue, scanKey);

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

describe("repository local-info hygiene home-path classification", () => {
  it("allows syntactic username placeholders on macOS, Linux, and Windows", () => {
    const placeholderPaths = [
      macosHome("<user>", "project"),
      macosHome("$USER", "project"),
      macosHome("${USER}", "project"),
      macosHome("{{user}}", "project"),
      linuxHome("<user>", "project"),
      linuxHome("$USER", "project"),
      linuxHome("${USER}", "project"),
      linuxHome("{{user}}", "project"),
      windowsHome("<user>", "project"),
      windowsHome("%USERNAME%", "project"),
      windowsHome("${USERNAME}", "project"),
      windowsHome("{{user}}", "project")
    ];

    for (const [index, placeholderPath] of placeholderPaths.entries()) {
      expect(scanText(`fixtures/placeholder-home-${index}.txt`, placeholderPath, scanKey)).toEqual([]);
    }
  });

  it("reports realistic ASCII account names, including bare user and example", () => {
    const realisticPaths = [
      ["developer-macos-home-path", macosHome("user", "project")],
      ["developer-macos-home-path", macosHome("example", "project")],
      ["developer-macos-home-path", macosHome("_service", "project")],
      ["developer-linux-home-path", linuxHome("user", "project")],
      ["developer-linux-home-path", linuxHome("example", "project")],
      ["developer-linux-home-path", linuxHome("daemon$", "project")],
      ["windows-user-profile-path", windowsHome("user", "project")],
      ["windows-user-profile-path", windowsHome("service.name", "project")],
      ["windows-user-profile-path", windowsHome("example", "project")]
    ];

    for (const [expectedRule, realisticPath] of realisticPaths) {
      expect(scanText("fixtures/real-home.txt", realisticPath, scanKey)).toMatchObject([
        { rule: expectedRule }
      ]);
    }
  });

  it("still reports a real account when a later path component is a placeholder", () => {
    const realisticPaths = [
      ["developer-macos-home-path", macosHome("fixture-account", "<repo-root>")],
      ["developer-linux-home-path", linuxHome("fixture-account", "<repo-root>")],
      ["windows-user-profile-path", windowsHome("fixture-account", "<repo-root>")]
    ];

    for (const [expectedRule, realisticPath] of realisticPaths) {
      expect(scanText("fixtures/real-home-placeholder-tail.txt", realisticPath, scanKey)).toMatchObject([
        { rule: expectedRule }
      ]);
    }
  });

  it("does not partially match invalid account components", () => {
    const invalidUsernames = [
      ".hidden",
      "-prefixed",
      "trailing.",
      "name@placeholder"
    ];

    for (const invalidUsername of invalidUsernames) {
      expect(scanText("fixtures/invalid-home.txt", macosHome(invalidUsername), scanKey)).toEqual([]);
      expect(scanText("fixtures/invalid-home.txt", linuxHome(invalidUsername), scanKey)).toEqual([]);
      expect(scanText("fixtures/invalid-home.txt", windowsHome(invalidUsername), scanKey)).toEqual([]);
    }
  });
});

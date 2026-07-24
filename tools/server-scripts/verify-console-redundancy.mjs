#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath = path.join(repoRoot, "build", "reports", "console-redundancy.json");
const scanRoots = Object.freeze([
  "apps/console/views",
  "apps/console/components",
  "apps/console/composables"
]);
const serialDetailPatterns = Object.freeze([
  ["dot_join", /\.join\(\s*["'`]\s+[·•|/-]\s+["'`]\s*\)/u],
  ["pipe_join", /\.join\(\s*["'`]\s*\|\s*["'`]\s*\)/u],
  ["hyphen_join", /\.join\(\s*["'`]\s+-\s+["'`]\s*\)/u]
]);
const templateSerialDetailPattern = />(?=[^<]*(?:\s[·•|]\s|\s-\s)[^<]*(?:\s[·•|]\s|\s-\s))[^<]+</u;

async function walk(relativeDir) {
  const absoluteDir = path.join(repoRoot, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await walk(relativePath));
    } else if (/\.(vue|ts|tsx|js|mjs)$/u.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files;
}

function normalizePhrase(value = "") {
  return String(value || "")
    .replace(/\{\{[\s\S]*?\}\}/gu, " ")
    .replace(/\$\{[\s\S]*?\}/gu, " ")
    .replace(/[0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function displayPhrases(source = "", file = "") {
  const phrases = [];
  if (file.endsWith(".vue")) {
    for (const match of source.matchAll(/>([^<>{}][^<>]{3,80})</gu)) {
      const phrase = normalizePhrase(match[1]);
      if (phrase.length >= 4) {
        phrases.push({ phrase, index: match.index || 0 });
      }
    }
  }
  for (const match of source.matchAll(/localizeConsoleText\(\s*["'`]([^"'`]{4,80})["'`]/gu)) {
    const phrase = normalizePhrase(match[1]);
    if (phrase.length >= 4) {
      phrases.push({ phrase, index: match.index || 0 });
    }
  }
  return phrases;
}

function lineNumber(source = "", index = 0) {
  return source.slice(0, index).split(/\r?\n/u).length;
}

await fs.mkdir(path.dirname(reportPath), { recursive: true });
const files = (await Promise.all(scanRoots.map(walk))).flat();
const findings = [];

for (const file of files) {
  const source = await fs.readFile(path.join(repoRoot, file), "utf8");
  if (file.startsWith("apps/console/views/admin/") && /\bfetch\s*\(/u.test(source)) {
    findings.push({
      severity: "error",
      code: "admin_view_direct_fetch",
      file,
      line: lineNumber(source, source.search(/\bfetch\s*\(/u)),
      message: "Admin views must call typed console clients or composables instead of performing direct fetch calls."
    });
  }
  for (const [code, pattern] of serialDetailPatterns) {
    for (const match of source.matchAll(new RegExp(pattern.source, "gu"))) {
      findings.push({
        severity: "error",
        code,
        file,
        line: lineNumber(source, match.index || 0),
        message: "Console UI must not concatenate multiple detail fields with visual separators; split details into table columns or compact status controls."
      });
    }
  }
  const lines = source.split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (templateSerialDetailPattern.test(line)) {
      findings.push({
        severity: "error",
        code: "template_serial_detail",
        file,
        line: index + 1,
        message: "Console UI must not concatenate multiple detail fields with visual separators; split details into table columns or compact status controls."
      });
    }
  });
  const counts = new Map();
  for (const phrase of displayPhrases(source, file)) {
    const current = counts.get(phrase.phrase) || { count: 0, lines: [] };
    current.count += 1;
    current.lines.push(lineNumber(source, phrase.index));
    counts.set(phrase.phrase, current);
  }
  for (const [phrase, info] of counts.entries()) {
    if (info.count >= 4) {
      findings.push({
        severity: "warning",
        code: "repeated_display_phrase",
        file,
        line: info.lines[0],
        message: "Repeated display text should be collapsed into one clear label, icon/status control, table column, or reusable component.",
        phrase,
        count: info.count
      });
    }
  }
}

const errorCount = findings.filter((finding) => finding.severity === "error").length;
const warningCount = findings.filter((finding) => finding.severity === "warning").length;
const releaseBlockingWarningCount = findings.filter((finding) =>
  finding.severity === "warning" && finding.releaseBlocking === true
).length;
const releaseBlockingFindingCount = findings.filter((finding) =>
  finding.severity === "error" || finding.releaseBlocking === true
).length;
const report = {
  schemaVersion: "v0.0.1:console:redundancy-report-1",
  generatedAt: new Date().toISOString(),
  verifier: "tools/server-scripts/verify-console-redundancy.mjs",
  summary: {
    releaseReady: releaseBlockingFindingCount === 0,
    reportLeakScan: true,
    scannedFileCount: files.length,
    findingCount: findings.length,
    advisoryFindingCount: findings.length - releaseBlockingFindingCount,
    releaseBlockingFindingCount,
    errorCount,
    warningCount,
    advisoryWarningCount: warningCount - releaseBlockingWarningCount,
    releaseBlockingWarningCount
  },
  findings
};

assert.equal(JSON.stringify(report).includes(repoRoot), false, "console redundancy report leaked repo path");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (errorCount > 0) {
  throw new Error(`Console redundancy audit failed with ${errorCount} blocking findings.`);
}
console.log("[console-redundancy] ok");

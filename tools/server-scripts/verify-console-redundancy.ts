#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath: any = path.join(repoRoot, "build", "reports", "console-redundancy.json");
const scanRoots: readonly any[] = Object.freeze([
  "apps/console/views",
  "apps/console/components",
  "apps/console/composables"
]);
const serialDetailPatterns: readonly any[] = Object.freeze([
  ["dot_join", /\.join\(\s*["'`]\s+[·•|/-]\s+["'`]\s*\)/u],
  ["pipe_join", /\.join\(\s*["'`]\s*\|\s*["'`]\s*\)/u],
  ["hyphen_join", /\.join\(\s*["'`]\s+-\s+["'`]\s*\)/u]
]);
const templateSerialDetailPattern: any = />(?=[^<]*(?:\s[·•|]\s|\s-\s)[^<]*(?:\s[·•|]\s|\s-\s))[^<]+</u;

async function walk(relativeDir?: any) : Promise<any> {
  const absoluteDir: any = path.join(repoRoot, relativeDir);
  const entries: any = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() : any => []);
  const files: any[] = [];
  for (const entry of entries) {
    const relativePath: any = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await walk(relativePath));
    } else if (/\.(vue|ts|tsx|js|mjs)$/u.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files;
}

function normalizePhrase(value: any = "") : any {
  return String(value || "")
    .replace(/\{\{[\s\S]*?\}\}/gu, " ")
    .replace(/\$\{[\s\S]*?\}/gu, " ")
    .replace(/[0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function displayPhrases(source: any = "", file: any = "") : any {
  const phrases: any[] = [];
  if (file.endsWith(".vue")) {
    for (const match of source.matchAll(/>([^<>{}][^<>]{3,80})</gu)) {
      const phrase: any = normalizePhrase(match[1]);
      if (phrase.length >= 4) {
        phrases.push({ phrase, index: match.index || 0 });
      }
    }
  }
  for (const match of source.matchAll(/localizeConsoleText\(\s*["'`]([^"'`]{4,80})["'`]/gu)) {
    const phrase: any = normalizePhrase(match[1]);
    if (phrase.length >= 4) {
      phrases.push({ phrase, index: match.index || 0 });
    }
  }
  return phrases;
}

function lineNumber(source: any = "", index: any = 0) : any {
  return source.slice(0, index).split(/\r?\n/u).length;
}

await fs.mkdir(path.dirname(reportPath), { recursive: true });
const files: any = (await Promise.all(scanRoots.map(walk))).flat();
const findings: any[] = [];

for (const file of files) {
  const source: any = await fs.readFile(path.join(repoRoot, file), "utf8");
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
  const lines: any = source.split(/\r?\n/u);
  lines.forEach((line?: any, index?: any) : any => {
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
  const counts: any = new Map<any, any>();
  for (const phrase of displayPhrases(source, file)) {
    const current: any = counts.get(phrase.phrase) || { count: 0, lines: [] };
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

const errorCount: any = findings.filter((finding?: any) : any => finding.severity === "error").length;
const warningCount: any = findings.filter((finding?: any) : any => finding.severity === "warning").length;
const releaseBlockingWarningCount: any = findings.filter((finding?: any) : any =>
  finding.severity === "warning" && finding.releaseBlocking === true
).length;
const releaseBlockingFindingCount: any = findings.filter((finding?: any) : any =>
  finding.severity === "error" || finding.releaseBlocking === true
).length;
const report: Record<string, any> = {
  schemaVersion: "v0.0.1:console:redundancy-report-1",
  generatedAt: new Date().toISOString(),
  verifier: "tools/server-scripts/verify-console-redundancy.ts",
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

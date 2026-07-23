#!/usr/bin/env node
/**
 * Repository local-info hygiene scanner.
 *
 * Scans source, docs, fixtures, tests, and tool files for developer-machine,
 * server-machine, and production deployment details. High-risk findings always
 * fail the process. Lower-risk findings remain informational unless
 * --fail-on-warning is used for a broader local cleanup pass.
 *
 * Usage:
 *   node tools/config-scanner.mjs
 *   node tools/config-scanner.mjs --json
 *   node tools/config-scanner.mjs --fail-on-warning
 */

import fs from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertNoLeak } from "./server-scripts/lib/report-evidence-safety.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".dart_tool",
  ".gradle",
  ".next",
  ".pub-cache",
  "build",
  "coverage",
  "dist",
  "ephemeral",
  "node_modules",
  "target"
]);

const IGNORED_RELATIVE_PATHS = new Set([
  "tools/config-scanner.mjs"
]);

const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".conf",
  ".css",
  ".csv",
  ".dockerignore",
  ".env",
  ".example",
  ".gitignore",
  ".html",
  ".js",
  ".json",
  ".jsonl",
  ".lock",
  ".md",
  ".mjs",
  ".ps1",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".yaml",
  ".yml"
]);

const MATCH_FINGERPRINT_KEY = randomBytes(32);

const RULES = [
  {
    id: "ssh-public-key-material",
    severity: "high-risk",
    message: "Committed SSH public keys are production access metadata. Use a placeholder such as <admin-ssh-public-key> in templates and keep real keys outside Git.",
    pattern: /\bssh-(?:ed25519|rsa|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/]{20,}={0,3}(?:\s+[^\r\n]*)?/g
  },
  {
    id: "public-ipv4-literal",
    severity: "high-risk",
    message: "Public routable IP literals are production infrastructure metadata. Use <origin-ipv4>, <server-ip>, or an RFC 5737 documentation address.",
    pattern: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
    shouldReport: ({ match, relativePath }) => !relativePath.endsWith(".svg") && isPublicIpv4Literal(match)
  },
  {
    id: "public-ipv6-literal",
    severity: "high-risk",
    message: "Public routable IPv6 literals are production infrastructure metadata. Use <origin-ipv6>, <server-ipv6>, or the RFC 3849 documentation prefix.",
    pattern: /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]{1,39}\b/gi,
    shouldReport: ({ match }) => isPublicIpv6Literal(match)
  },
  {
    id: "deployment-public-hostname",
    severity: "high-risk",
    message: "Production deployment files must not name real public domains or hosts. Use placeholders such as <public-api-host>, <app-domain>, or <public-website-domain>.",
    pattern: /\b(?:https?:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?|(?:LICO_DOMAIN|LICO_PUBLIC_BASE_URL|hostname|Domain|Hostname equals)\s*[:=]\s*(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?)\b/gi,
    appliesTo: (relativePath) => relativePath.startsWith("ops/private-production/"),
    shouldReport: ({ match }) => isDeploymentPublicHostname(match)
  },
  {
    id: "admin-ssh-endpoint",
    severity: "high-risk",
    message: "Admin SSH endpoints are production access metadata. Use <admin-user>@<admin-host>:<ssh-port>.",
    pattern: /\b[A-Za-z0-9._-]+@[A-Za-z0-9._-]+(?::\d+)\b/g,
    shouldReport: ({ match }) => isProductionSshEndpoint(match)
  },
  {
    id: "deployment-provider-resource-id",
    severity: "high-risk",
    message: "Provider resource IDs are production infrastructure metadata. Keep real cloud IDs outside Git and use placeholders in templates.",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    appliesTo: (relativePath) => relativePath.startsWith("ops/private-production/")
  },
  {
    id: "non-placeholder-email-address",
    severity: "high-risk",
    message: "Email fixtures and docs must use reserved domains such as user@example.com or user@team.example, not real personal or organization mail domains.",
    pattern: /\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g,
    shouldReport: ({ match, relativePath }) => isRealEmailAddress(match, relativePath)
  },
  {
    id: "developer-macos-home-path",
    severity: "warning",
    message: "Use <user-home>, <repo-root>, <input-file>, or another placeholder instead of a macOS user home path.",
    pattern: /\/Users\/[^/\s`'")]+(?:\/[^\s`'")]*)?/g
  },
  {
    id: "developer-linux-home-path",
    severity: "warning",
    message: "Use <user-home>, <repo-root>, <input-file>, or another placeholder instead of a Linux user home path.",
    pattern: /\/home\/(?!lico\b)[^/\s`'")]+(?:\/[^\s`'")]*)?/g
  },
  {
    id: "windows-user-profile-path",
    severity: "warning",
    message: "Use <user-home>, <repo-root>, <input-file>, or another placeholder instead of a Windows user profile path.",
    pattern: /\b[A-Za-z]:[\\/]Users[\\/][^\s`'")]+/g
  },
  {
    id: "private-network-service-url",
    severity: "warning",
    message: "Use <server-url> or <service-url> instead of a private-network URL.",
    pattern: /\bhttps?:\/\/(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(?::\d+)?(?:\/[^\s`'")]*)?/gi
  }
];

function stripUrlParts(value) {
  return String(value || "")
    .replace(/^https?:\/\//iu, "")
    .replace(/\/.*$/u, "")
    .replace(/:\d+$/u, "")
    .toLowerCase();
}

function ipv4ToNumber(value) {
  const parts = String(value || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts.reduce((accumulator, part) => ((accumulator << 8) >>> 0) + part, 0) >>> 0;
}

function ipv4InRange(value, start, end) {
  const numeric = ipv4ToNumber(value);
  const low = ipv4ToNumber(start);
  const high = ipv4ToNumber(end);
  return numeric !== null && low !== null && high !== null && numeric >= low && numeric <= high;
}

function isPublicIpv4Literal(value) {
  const address = String(value || "");
  if (!net.isIP(address)) {
    return false;
  }
  const safeRanges = [
    ["0.0.0.0", "0.255.255.255"],
    ["10.0.0.0", "10.255.255.255"],
    ["100.64.0.0", "100.127.255.255"],
    ["127.0.0.0", "127.255.255.255"],
    ["169.254.0.0", "169.254.255.255"],
    ["172.16.0.0", "172.31.255.255"],
    ["192.0.0.0", "192.0.0.255"],
    ["192.0.2.0", "192.0.2.255"],
    ["192.168.0.0", "192.168.255.255"],
    ["198.18.0.0", "198.19.255.255"],
    ["198.51.100.0", "198.51.100.255"],
    ["203.0.113.0", "203.0.113.255"],
    ["224.0.0.0", "255.255.255.255"]
  ];
  return !safeRanges.some(([start, end]) => ipv4InRange(address, start, end));
}

function trimIpv6Candidate(value) {
  return String(value || "").replace(/^[\[\s]+|[\]\s.,;)]+$/gu, "").toLowerCase();
}

function isPublicIpv6Literal(value) {
  const address = trimIpv6Candidate(value);
  if (net.isIP(address) !== 6) {
    return false;
  }
  const parts = address.split(":");
  if (
    address === "::" ||
    address === "::1" ||
    (parts.length === 8 && parts.slice(0, 7).every((part) => Number.parseInt(part || "0", 16) === 0) && Number.parseInt(parts[7] || "0", 16) === 1) ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    address.startsWith("fe80:") ||
    address.startsWith("2001:db8:")
  ) {
    return false;
  }
  return true;
}

function isDeploymentPublicHostname(value) {
  const host = stripUrlParts(value);
  if (!host || host.includes("<") || host.endsWith(".example") || host.endsWith(".example.com")) {
    return false;
  }
  const allowedHosts = new Set([
    "github.com",
    "localhost"
  ]);
  return !allowedHosts.has(host);
}

function emailDomain(value) {
  const match = String(value || "").toLowerCase().match(/@([^@\s>]+)$/u);
  return match ? match[1].replace(/[.,;:)\]]+$/u, "") : "";
}

function isReservedEmailDomain(domain) {
  return (
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    domain === "local" ||
    domain.endsWith(".local") ||
    domain === "invalid" ||
    domain.endsWith(".invalid") ||
    domain === "test" ||
    domain.endsWith(".test") ||
    domain === "example" ||
    domain.endsWith(".example") ||
    domain === "example.com" ||
    domain.endsWith(".example.com") ||
    domain === "example.org" ||
    domain.endsWith(".example.org") ||
    domain === "example.net" ||
    domain.endsWith(".example.net")
  );
}

function isRealEmailAddress(value, relativePath) {
  if (relativePath.endsWith("package-lock.json") || relativePath.endsWith("Cargo.lock")) {
    return false;
  }
  const domain = emailDomain(value);
  if (!domain || isReservedEmailDomain(domain)) {
    return false;
  }
  const publicServiceDomains = new Set([
    "amazon.com",
    "github.com",
    "patreon.com",
    "steampowered.com"
  ]);
  return !publicServiceDomains.has(domain);
}

function isSafeHostAddress(host) {
  const value = stripUrlParts(host);
  if (value === "localhost") {
    return true;
  }
  if (net.isIP(value) === 4) {
    return !isPublicIpv4Literal(value);
  }
  if (net.isIP(value) === 6) {
    return !isPublicIpv6Literal(value);
  }
  return false;
}

function isProductionSshEndpoint(value) {
  const match = String(value || "").match(/@([^:]+):\d+$/u);
  return match ? !isSafeHostAddress(match[1]) : true;
}

function parseArgs(argv) {
  const options = {
    json: false,
    failOnWarning: false,
    maxPrint: 120,
    report: path.join(repoRoot, "build", "reports", "local-info-hygiene.json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fail-on-warning") {
      options.failOnWarning = true;
    } else if (arg === "--no-report") {
      options.report = "";
    } else if (arg === "--report") {
      options.report = path.resolve(repoRoot, argv[++index] || "");
    } else if (arg.startsWith("--report=")) {
      options.report = path.resolve(repoRoot, arg.slice("--report=".length));
    } else if (arg === "--max-print") {
      options.maxPrint = Number(argv[++index] || options.maxPrint);
    } else if (arg.startsWith("--max-print=")) {
      options.maxPrint = Number(arg.slice("--max-print=".length) || options.maxPrint);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.maxPrint) || options.maxPrint < 0) {
    options.maxPrint = 120;
  }
  return options;
}

function printHelp() {
  console.log(`Repository local-info hygiene scanner

Usage:
  node tools/config-scanner.mjs
  node tools/config-scanner.mjs --json
  node tools/config-scanner.mjs --fail-on-warning

High-risk production/deployment findings always fail. Use --fail-on-warning only
when a cleanup pass should also reject lower-risk developer-machine warnings.`);
}

function toRepoPath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function isTextCandidate(filePath) {
  const basename = path.basename(filePath);
  if (basename === "Dockerfile" || basename.includes(".env")) {
    return true;
  }
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function collectFiles(directory, files = []) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      collectFiles(path.join(directory, entry.name), files);
    } else if (entry.isFile()) {
      const filePath = path.join(directory, entry.name);
      const relativePath = toRepoPath(filePath);
      if (!IGNORED_RELATIVE_PATHS.has(relativePath) && isTextCandidate(filePath)) {
        files.push(filePath);
      }
    }
  }
  return files;
}

function lineAndColumn(text, index) {
  const prefix = text.slice(0, index);
  const lines = prefix.split(/\r?\n/u);
  return {
    line: lines.length,
    column: lines.at(-1).length + 1
  };
}

function fingerprintMatch(ruleId, value, key = MATCH_FINGERPRINT_KEY) {
  return createHmac("sha256", key)
    .update("licomesh-local-info-finding\0", "utf8")
    .update(String(ruleId || ""), "utf8")
    .update("\0", "utf8")
    .update(String(value || ""), "utf8")
    .digest("hex");
}

export function scanText(relativePath, text, fingerprintKey = MATCH_FINGERPRINT_KEY) {
  const findings = [];
  for (const rule of RULES) {
    if (typeof rule.appliesTo === "function" && !rule.appliesTo(relativePath)) {
      continue;
    }
    for (const match of text.matchAll(rule.pattern)) {
      if (/<[^>\r\n]+>/u.test(match[0])) {
        continue;
      }
      if (typeof rule.shouldReport === "function" && !rule.shouldReport({ match: match[0], relativePath, text })) {
        continue;
      }
      const position = lineAndColumn(text, match.index || 0);
      findings.push({
        severity: rule.severity,
        rule: rule.id,
        category: rule.id,
        file: relativePath,
        line: position.line,
        column: position.column,
        matchLength: Buffer.byteLength(match[0], "utf8"),
        fingerprint: fingerprintMatch(rule.id, match[0], fingerprintKey),
        message: rule.message
      });
    }
  }
  return findings;
}

function scanRepository() {
  const findings = [];
  for (const filePath of collectFiles(repoRoot)) {
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) {
      continue;
    }
    const text = buffer.toString("utf8");
    findings.push(...scanText(toRepoPath(filePath), text));
  }
  return findings.sort((left, right) =>
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    left.rule.localeCompare(right.rule)
  );
}

function summarize(findings) {
  const byRule = {};
  const bySeverity = {};
  for (const finding of findings) {
    byRule[finding.rule] = (byRule[finding.rule] || 0) + 1;
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
  }
  return {
    findingCount: findings.length,
    highRiskCount: bySeverity["high-risk"] || 0,
    warningCount: bySeverity.warning || 0,
    bySeverity,
    byRule
  };
}

function printHuman(findings, options) {
  if (findings.length === 0) {
    console.log("[local-info-hygiene] no developer/server local-info findings found");
    return;
  }
  const summary = summarize(findings);
  if (summary.highRiskCount > 0) {
    console.error(`[local-info-hygiene] HIGH-RISK: ${summary.highRiskCount} production/deployment metadata finding(s) block commit and CI.`);
  }
  if (summary.warningCount > 0) {
    console.warn(`[local-info-hygiene] WARNING: ${summary.warningCount} developer/server local-info marker(s) found.`);
  }
  console.warn("[local-info-hygiene] Replace real details with placeholders such as <repo-root>, <user-home>, <server-url>, <server-data-dir>, <service-url>, <public-api-host>, <origin-ipv4>, <admin-host>, <input-file>, or <output-file>.");
  for (const [severity, count] of Object.entries(summary.bySeverity).sort((left, right) => left[0].localeCompare(right[0]))) {
    console.warn(`[local-info-hygiene] ${severity}: ${count}`);
  }
  for (const [rule, count] of Object.entries(summary.byRule).sort((left, right) => left[0].localeCompare(right[0]))) {
    console.warn(`[local-info-hygiene] ${rule}: ${count}`);
  }
  const printable = findings.slice(0, options.maxPrint);
  for (const finding of printable) {
    const level = finding.severity === "high-risk" ? "HIGH-RISK" : "WARNING";
    const write = finding.severity === "high-risk" ? console.error : console.warn;
    write(`${level} ${finding.file}:${finding.line}:${finding.column} [${finding.rule}] fingerprint=${finding.fingerprint} length=${finding.matchLength}`);
    write(`  ${finding.message}`);
  }
  if (findings.length > printable.length) {
    console.warn(`[local-info-hygiene] ${findings.length - printable.length} additional warning(s) omitted from console output; see the JSON report.`);
  }
}

export function createReport(findings, generatedAt = new Date().toISOString()) {
  const summary = summarize(findings);
  const releaseReady = summary.highRiskCount === 0 && summary.warningCount === 0;
  const report = {
    schemaVersion: "v0.0.1:repository:local-info-hygiene-report-0.0.2",
    generatedAt,
    verifier: "tools/config-scanner.mjs",
    sourceOfTruth: "tools/config-scanner.mjs#repo-local-info-hygiene",
    repoRootPlaceholder: "<repo-root>",
    summary: {
      ...summary,
      releaseReady,
      reportLeakScan: false
    },
    findings
  };
  assertReportSafe(report);
  report.summary.reportLeakScan = true;
  assertReportSafe(report);
  return report;
}

function assertReportSafe(report) {
  assertNoLeak(report, "repository local-info hygiene report");
  const reportFindings = scanText(
    "build/reports/local-info-hygiene.json",
    JSON.stringify(report),
    MATCH_FINGERPRINT_KEY
  );
  if (reportFindings.length > 0) {
    const categories = [...new Set(reportFindings.map((finding) => finding.category))].sort();
    throw new Error(`Repository local-info hygiene report failed its leak scan: ${categories.join(",")}`);
  }
}

function writeReport(reportPath, findings) {
  if (!reportPath) {
    return;
  }
  const report = createReport(findings);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const findings = scanRepository();
  writeReport(options.report, findings);
  if (options.json) {
    console.log(JSON.stringify({ summary: summarize(findings), findings }, null, 2));
  } else {
    printHuman(findings, options);
    if (options.report) {
      console.log(`[local-info-hygiene] report: ${toRepoPath(options.report)}`);
    }
  }
  const summary = summarize(findings);
  if (summary.highRiskCount > 0 || (options.failOnWarning && summary.warningCount > 0)) {
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}

#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ZERO_OID = "0".repeat(40);
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const PRIVATE_PATH_PREFIXES = Object.freeze([
  "build/",
  "cache/",
  "coverage/",
  "docs/plans/",
  "docs/reports/",
  "node_modules/"
]);
const PRIVATE_FILE_PATTERN = /(?:^|\/)(?:\.env(?:\.|$)|[^/]+\.(?:db|dump|har|heapsnapshot|log|mbox|pem|pfx|p12|prof|sqlite3?|trace))$/iu;
const MACHINE_IDENTITY_PATH_PATTERN = new RegExp([
  "(?:^|[\\s\"'`=(,:])(?:",
  ["", "Users", "[^/\\s\"'`]+", ""].join("/"),
  "|",
  ["", "home", "[^/\\s\"'`]+", ""].join("/"),
  "|",
  ["", "private", "var", "folders", ""].join("/"),
  "|[A-Za-z]:[\\\\/]Users[\\\\/][^\\\\/\\s\"'`]+[\\\\/]",
  "|file:",
  ["", "", "", "(?:Users|home)", "[^/\\s\"'`]+", ""].join("/"),
  ")"
].join(""), "imu");
const TEXT_RULES = Object.freeze([
  ["private-key", /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u],
  ["aws-access-key-id", /\bAKIA[0-9A-Z]{16}\b/u],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/u],
  ["openai-api-key", /\bsk-[A-Za-z0-9]{20,}\b/u],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/u],
  ["machine-identity-path", MACHINE_IDENTITY_PATH_PATTERN]
]);

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: options.encoding === "buffer" ? null : options.encoding ?? "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"]
  });
}

function digest(rule, candidatePath, line) {
  return crypto
    .createHash("sha256")
    .update(`${rule}\0${candidatePath}\0${line}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function lineForOffset(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function finding(rule, candidatePath, line = 0) {
  return {
    rule,
    file: candidatePath,
    line,
    severity: "high",
    digest: digest(rule, candidatePath, line)
  };
}

function scanPath(candidatePath) {
  const normalized = candidatePath.replaceAll("\\", "/");
  if (
    PRIVATE_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    PRIVATE_FILE_PATTERN.test(normalized)
  ) {
    return [finding("private-publication-path", normalized)];
  }
  return [];
}

function scanBytes(candidatePath, bytes) {
  const findings = scanPath(candidatePath);
  if (bytes.length > MAX_TEXT_BYTES) {
    findings.push(finding("oversized-publication-candidate", candidatePath));
    return findings;
  }
  if (bytes.includes(0)) {
    findings.push(finding("binary-publication-candidate", candidatePath));
    return findings;
  }
  const text = bytes.toString("utf8");
  for (const [rule, pattern] of TEXT_RULES) {
    const match = pattern.exec(text);
    if (match) findings.push(finding(rule, candidatePath, lineForOffset(text, match.index)));
  }
  return findings;
}

function assertClean(findings, label) {
  if (findings.length === 0) {
    console.log(`[git-publication] ${label}: ready`);
    return;
  }
  console.error(`[git-publication] ${label}: blocked (${findings.length} finding(s))`);
  for (const item of findings.slice(0, 100)) {
    console.error(
      `[git-publication] ${item.rule} ${item.file}${item.line ? `:${item.line}` : ""} ${item.digest}`
    );
  }
  if (findings.length > 100) {
    console.error(`[git-publication] ${findings.length - 100} additional finding(s) omitted`);
  }
  process.exitCode = 1;
}

function parseIndex() {
  const output = git(["ls-files", "--stage", "-z"]);
  return output.split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    return { mode, oid, stage, file: record.slice(tab + 1) };
  });
}

function stagedPaths() {
  return git([
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--diff-filter=ACMRT"
  ]).split("\0").filter(Boolean);
}

function verifyIndexEntries(entries, label, { guardIndex = true } = {}) {
  const before = guardIndex ? git(["write-tree"]).trim() : "";
  const findings = [];
  for (const entry of entries) {
    if (entry.stage !== "0") {
      findings.push(finding("unmerged-index-entry", entry.file));
      continue;
    }
    const bytes = git(["cat-file", "blob", entry.oid], { encoding: "buffer" });
    findings.push(...scanBytes(entry.file, bytes));
    if (entry.mode === "120000") {
      const target = bytes.toString("utf8");
      if (path.isAbsolute(target)) findings.push(finding("absolute-symbolic-link", entry.file));
    }
  }
  if (guardIndex) {
    const after = git(["write-tree"]).trim();
    if (before !== after) findings.push(finding("index-changed-during-scan", "<git-index>"));
  }
  assertClean(findings, label);
}

export function verifyIndex() {
  verifyIndexEntries(parseIndex(), "index");
}

export function verifyStaged() {
  const changed = new Set(stagedPaths());
  verifyIndexEntries(
    parseIndex().filter((entry) => changed.has(entry.file)),
    "staged-changes",
    { guardIndex: false }
  );
}

export function verifyMessage(messagePath) {
  const bytes = fs.readFileSync(messagePath);
  assertClean(scanBytes("<commit-message>", bytes), "commit-message");
}

function commitMessage(commit) {
  const raw = git(["cat-file", "commit", commit]);
  const boundary = raw.indexOf("\n\n");
  return Buffer.from(boundary >= 0 ? raw.slice(boundary + 2) : "", "utf8");
}

function treeEntries(commit) {
  const output = git(["ls-tree", "-rz", commit]);
  return output.split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    return { mode, type, oid, file: record.slice(tab + 1) };
  });
}

export function verifyOutgoingUpdates(input) {
  const findings = [];
  const scannedBlobs = new Set();
  const scannedCommits = new Set();
  for (const line of input.split(/\r?\n/u).filter(Boolean)) {
    const [, localOid, , remoteOid] = line.trim().split(/\s+/u);
    if (!localOid || localOid === ZERO_OID) continue;
    const range = remoteOid && remoteOid !== ZERO_OID
      ? [localOid, `^${remoteOid}`]
      : [localOid, "--not", "--remotes"];
    const commits = git(["rev-list", ...range]).split(/\s+/u).filter(Boolean);
    for (const commit of commits) {
      if (!scannedCommits.has(commit)) {
        scannedCommits.add(commit);
        findings.push(...scanBytes(`<commit-message:${commit.slice(0, 12)}>`, commitMessage(commit)));
      }
      for (const entry of treeEntries(commit)) {
        findings.push(...scanPath(entry.file));
        if (entry.type !== "blob" || scannedBlobs.has(entry.oid)) continue;
        scannedBlobs.add(entry.oid);
        const bytes = git(["cat-file", "blob", entry.oid], { encoding: "buffer" });
        findings.push(...scanBytes(entry.file, bytes));
        if (entry.mode === "120000" && path.isAbsolute(bytes.toString("utf8"))) {
          findings.push(finding("absolute-symbolic-link", entry.file));
        }
      }
    }
  }
  assertClean(findings, "outgoing-history");
}

export function runSelfTest() {
  const cases = [
    {
      label: "relative source path",
      bytes: Buffer.from("packages/server-runtime/src/index.mjs"),
      expected: []
    },
    {
      label: "private key",
      bytes: Buffer.from(["-----BEGIN ", "PRIVATE KEY-----"].join("")),
      expected: ["private-key"]
    },
    {
      label: "developer home",
      bytes: Buffer.from(["", "Users", "developer", "workspace"].join("/")),
      expected: ["machine-identity-path"]
    },
    {
      label: "private runtime file",
      file: "build/runtime.sqlite",
      bytes: Buffer.from(""),
      expected: ["private-publication-path"]
    }
  ];
  for (const testCase of cases) {
    const actual = scanBytes(
      testCase.file || "fixture.txt",
      testCase.bytes
    ).map((item) => item.rule);
    if (JSON.stringify(actual) !== JSON.stringify(testCase.expected)) {
      throw new Error(`Git publication self-test failed: ${testCase.label}`);
    }
  }
  console.log(`[git-publication] ${cases.length} policy fixtures passed`);
}

function main(args) {
  if (args.length === 1 && args[0] === "--self-test") {
    runSelfTest();
    return;
  }
  if (args.length === 1 && args[0] === "--index") {
    verifyIndex();
    return;
  }
  if (args.length === 1 && args[0] === "--staged") {
    verifyStaged();
    return;
  }
  if (args.length === 2 && args[0] === "--message-file") {
    verifyMessage(args[1]);
    return;
  }
  if (args.length === 1 && args[0] === "--pre-push") {
    verifyOutgoingUpdates(fs.readFileSync(0, "utf8"));
    return;
  }
  throw new Error("Usage: verify-git-publication.mjs --self-test | --index | --staged | --message-file <path> | --pre-push");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch {
    console.error("[git-publication] verification failed");
    process.exitCode = 1;
  }
}

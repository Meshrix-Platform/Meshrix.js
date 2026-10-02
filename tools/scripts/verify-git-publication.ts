#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ZERO_OID: any = "0".repeat(40);
const MAX_TEXT_BYTES: any = 5 * 1024 * 1024;
const REPOSITORY_ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACTIUM_ARCHIVE_PATH: any = "vendor/pactium-0.8.0.tgz";
const PACTIUM_ARCHIVE_INTEGRITY: any = "sha512-/Qs9JJ8ElyGcqEx1nf9+YH9to4rECAKkfXGu4RgR4tg5Z+JMgAFgOw7lXC5l/KGp69ZHf+Qro3L1sXjlKNKvNg==";
const PRIVATE_PATH_PREFIXES: readonly any[] = Object.freeze([
  "build/",
  "cache/",
  "coverage/",
  "docs/plans/",
  "docs/reports/",
  "node_modules/"
]);
const PRIVATE_FILE_PATTERN: any = /(?:^|\/)(?:\.env(?:\.|$)|[^/]+\.(?:db|dump|har|heapsnapshot|log|mbox|pem|pfx|p12|prof|sqlite3?|trace))$/iu;
const MACHINE_IDENTITY_PATH_PATTERN: any = new RegExp([
  "(?:^|[\\s\"'`=(,:])(?:",
  ["", "Users", "[A-Za-z0-9._-]+", ""].join("/"),
  "|",
  ["", "home", "[A-Za-z0-9._-]+", ""].join("/"),
  "|",
  ["", "private", "var", "folders", ""].join("/"),
  "|[A-Za-z]:[\\\\/]Users[\\\\/][^\\\\/\\s\"'`]+[\\\\/]",
  "|file:",
  ["", "", "", "(?:Users|home)", "[^/\\s\"'`]+", ""].join("/"),
  ")"
].join(""), "imu");
const TEXT_RULES: readonly any[] = Object.freeze([
  ["private-key", /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u],
  ["aws-access-key-id", /\bAKIA[0-9A-Z]{16}\b/u],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/u],
  ["openai-api-key", /\bsk-[A-Za-z0-9]{20,}\b/u],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/u],
  ["machine-identity-path", MACHINE_IDENTITY_PATH_PATTERN]
]);

function git(args?: any, options: Record<string, any> = {}) : any {
  return execFileSync("git", args, {
    encoding: options.encoding === "buffer" ? null : options.encoding ?? "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"]
  });
}

function digest(rule?: any, candidatePath?: any, line?: any) : any {
  return crypto
    .createHash("sha256")
    .update(`${rule}\0${candidatePath}\0${line}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function lineForOffset(text?: any, offset?: any) : any {
  let line: any = 1;
  for (let index: any = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function finding(rule?: any, candidatePath?: any, line: any = 0) : any {
  return {
    rule,
    file: candidatePath,
    line,
    severity: "high",
    digest: digest(rule, candidatePath, line)
  };
}

function scanPath(candidatePath?: any) : any {
  const normalized: any = candidatePath.replaceAll("\\", "/");
  if (
    PRIVATE_PATH_PREFIXES.some((prefix?: any) : any => normalized.startsWith(prefix)) ||
    PRIVATE_FILE_PATTERN.test(normalized)
  ) {
    return [finding("private-publication-path", normalized)];
  }
  return [];
}

function integrityMatches(bytes?: any, integrity?: any) : any {
  const supportedAlgorithms: Readonly<Record<string, number>> = Object.freeze({
    sha256: 32,
    sha384: 48,
    sha512: 64
  });
  for (const item of String(integrity || "").trim().split(/\s+/u)) {
    const separator: any = item.indexOf("-");
    if (separator < 1) continue;
    const algorithm: any = item.slice(0, separator).toLowerCase();
    const byteLength: any = supportedAlgorithms[algorithm];
    if (!byteLength) continue;
    const expected: any = Buffer.from(item.slice(separator + 1), "base64");
    if (expected.length !== byteLength) continue;
    const actual: any = crypto.createHash(algorithm).update(bytes).digest();
    if (crypto.timingSafeEqual(actual, expected)) return true;
  }
  return false;
}

function isAuthorizedVendoredBinary(candidatePath?: any, bytes?: any) : any {
  if (candidatePath !== PACTIUM_ARCHIVE_PATH) return false;
  return integrityMatches(bytes, PACTIUM_ARCHIVE_INTEGRITY);
}

function scanBytes(candidatePath?: any, bytes?: any) : any {
  const findings: any = scanPath(candidatePath);
  if (bytes.length > MAX_TEXT_BYTES) {
    findings.push(finding("oversized-publication-candidate", candidatePath));
    return findings;
  }
  if (bytes.includes(0)) {
    if (isAuthorizedVendoredBinary(candidatePath, bytes)) return findings;
    findings.push(finding("binary-publication-candidate", candidatePath));
    return findings;
  }
  const text: any = bytes.toString("utf8");
  for (const [rule, pattern] of TEXT_RULES) {
    const match: any = pattern.exec(text);
    if (match) findings.push(finding(rule, candidatePath, lineForOffset(text, match.index)));
  }
  return findings;
}

function assertClean(findings?: any, label?: any) : any {
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

function parseIndex() : any {
  const output: any = git(["ls-files", "--stage", "-z"]);
  return output.split("\0").filter(Boolean).map((record?: any) : any => {
    const tab: any = record.indexOf("\t");
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    return { mode, oid, stage, file: record.slice(tab + 1) };
  });
}

function stagedPaths() : any {
  return git([
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--diff-filter=ACMRT"
  ]).split("\0").filter(Boolean);
}

interface BlobEntry { oid: string; file: string; mode: string }

/** Read Git's immutable objects in bounded batches, preserving bytes and per-path policy. */
function* readBlobs<T extends BlobEntry>(entries: T[]): Generator<{ entry: T; bytes: Buffer | null }> {
  if (!entries.length) return;
  const objectIds = [...new Set(entries.map((entry) => entry.oid))];
  const sizes = new Map<string, number>();
  const metadata = String(git(["cat-file", "--batch-check"], { input: `${objectIds.join("\n")}\n` })).trimEnd().split("\n");
  if (metadata.length !== objectIds.length) throw new Error("Incomplete Git object metadata");
  for (const [index, line] of metadata.entries()) {
    const [oid, type, sizeText] = line.split(" ");
    const size = Number(sizeText);
    if (oid !== objectIds[index] || type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("Invalid Git blob metadata");
    }
    sizes.set(oid, size);
  }
  let cursor = 0;
  while (cursor < entries.length) {
    const batch: T[] = [];
    const requested = new Set<string>();
    let expectedBytes = 0;
    while (cursor < entries.length && batch.length < 256) {
      const entry = entries[cursor];
      const size = sizes.get(entry.oid)!;
      const additionalBytes = size > MAX_TEXT_BYTES || requested.has(entry.oid) ? 0 : size;
      if (batch.length && expectedBytes + additionalBytes > 8 * 1024 * 1024) break;
      batch.push(entry);
      cursor++;
      expectedBytes += additionalBytes;
      if (size <= MAX_TEXT_BYTES) requested.add(entry.oid);
    }
    const blobs = new Map<string, Buffer>();
    if (requested.size) {
      const output: Buffer = git(["cat-file", "--batch"], { encoding: "buffer", input: `${[...requested].join("\n")}\n` });
      let offset = 0;
      for (const oid of requested) {
        const size = sizes.get(oid)!;
        const header = Buffer.from(`${oid} blob ${size}\n`);
        if (!output.subarray(offset, offset + header.length).equals(header)) throw new Error("Invalid Git blob header");
        offset += header.length;
        if (output[offset + size] !== 10) throw new Error("Incomplete Git blob body");
        blobs.set(oid, output.subarray(offset, offset + size));
        offset += size + 1;
      }
      if (offset !== output.length) throw new Error("Unexpected Git blob output");
    }
    for (const entry of batch) yield { entry, bytes: blobs.get(entry.oid) ?? null };
  }
}

function scanBlob(entry: BlobEntry, bytes: Buffer | null): any[] {
  if (bytes === null) return [...scanPath(entry.file), finding("oversized-publication-candidate", entry.file)];
  const findings = scanBytes(entry.file, bytes);
  if (entry.mode === "120000" && path.isAbsolute(bytes.toString("utf8"))) {
    findings.push(finding("absolute-symbolic-link", entry.file));
  }
  return findings;
}

function verifyIndexEntries(
  entries?: any,
  label?: any,
  { guardIndex = true }: Record<string, any> = {}
) : any {
  const before: any = guardIndex ? git(["write-tree"]).trim() : "";
  const findings: any[] = [];
  for (const entry of entries) {
    if (entry.stage !== "0") {
      findings.push(finding("unmerged-index-entry", entry.file));
    }
  }
  for (const { entry, bytes } of readBlobs<BlobEntry>(entries.filter((entry: { stage: string }) => entry.stage === "0"))) {
    findings.push(...scanBlob(entry, bytes));
  }
  if (guardIndex) {
    const after: any = git(["write-tree"]).trim();
    if (before !== after) findings.push(finding("index-changed-during-scan", "<git-index>"));
  }
  assertClean(findings, label);
}

export function verifyIndex() : any {
  verifyIndexEntries(parseIndex(), "index");
}

export function verifyStaged() : any {
  const entries: any = parseIndex();
  const changed: any = new Set<any>(stagedPaths());
  verifyIndexEntries(
    entries.filter((entry?: any) : any => changed.has(entry.file)),
    "staged-changes",
    { guardIndex: false }
  );
}

export function verifyMessage(messagePath?: any) : any {
  const bytes: any = fs.readFileSync(messagePath);
  assertClean(scanBytes("<commit-message>", bytes), "commit-message");
}

function commitMessage(commit?: any) : any {
  const raw: any = git(["cat-file", "commit", commit]);
  const boundary: any = raw.indexOf("\n\n");
  return Buffer.from(boundary >= 0 ? raw.slice(boundary + 2) : "", "utf8");
}

function treeEntries(commit?: any) : any {
  const output: any = git(["ls-tree", "-rz", commit]);
  return output.split("\0").filter(Boolean).map((record?: any) : any => {
    const tab: any = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    return { mode, type, oid, file: record.slice(tab + 1) };
  });
}

export function verifyOutgoingUpdates(input?: any) : any {
  const findings: any[] = [];
  const scannedBlobs: any = new Set<any>();
  const scannedCommits: any = new Set<any>();
  for (const line of input.split(/\r?\n/u).filter(Boolean)) {
    const [, localOid, , remoteOid] = line.trim().split(/\s+/u);
    if (!localOid || localOid === ZERO_OID) continue;
    const range: any = remoteOid && remoteOid !== ZERO_OID
      ? [localOid, `^${remoteOid}`]
      : [localOid, "--not", "--remotes"];
    const commits: any = git(["rev-list", ...range]).split(/\s+/u).filter(Boolean);
    for (const commit of commits) {
      const entries: any = treeEntries(commit);
      if (!scannedCommits.has(commit)) {
        scannedCommits.add(commit);
        findings.push(...scanBytes(`<commit-message:${commit.slice(0, 12)}>`, commitMessage(commit)));
      }
      const unscanned: BlobEntry[] = [];
      for (const entry of entries) {
        findings.push(...scanPath(entry.file));
        const identity = `${entry.mode}\0${entry.file}\0${entry.oid}`;
        if (entry.type !== "blob" || scannedBlobs.has(identity)) continue;
        scannedBlobs.add(identity);
        unscanned.push(entry);
      }
      for (const { entry, bytes } of readBlobs(unscanned)) {
        findings.push(...scanBlob(entry, bytes));
      }
    }
  }
  assertClean(findings, "outgoing-history");
}

export function runSelfTest() : any {
  const vendoredBytes: any = fs.readFileSync(path.join(REPOSITORY_ROOT, PACTIUM_ARCHIVE_PATH));
  const mismatchedVendoredBytes: any = Buffer.from(vendoredBytes);
  mismatchedVendoredBytes[0] ^= 1;
  const cases: any[] = [
    {
      label: "relative source path",
      bytes: Buffer.from("packages/server-runtime/src/index.ts"),
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
      label: "documented home placeholder",
      bytes: Buffer.from(["", "home", "<user>", "workspace"].join("/")),
      expected: []
    },
    {
      label: "private runtime file",
      file: "build/runtime.sqlite",
      bytes: Buffer.from(""),
      expected: ["private-publication-path"]
    },
    {
      label: "retained source archive matches its independent recorded integrity",
      file: PACTIUM_ARCHIVE_PATH,
      bytes: vendoredBytes,
      expected: []
    },
    {
      label: "retained source archive integrity mismatch",
      file: PACTIUM_ARCHIVE_PATH,
      bytes: mismatchedVendoredBytes,
      expected: ["binary-publication-candidate"]
    }
  ];
  for (const testCase of cases) {
    const actual: any = scanBytes(
      testCase.file || "fixture.txt",
      testCase.bytes
    ).map((item?: any) : any => item.rule);
    if (JSON.stringify(actual) !== JSON.stringify(testCase.expected)) {
      throw new Error(`Git publication self-test failed: ${testCase.label}`);
    }
  }
  console.log(`[git-publication] ${cases.length} policy fixtures passed`);
}

function main(args?: any) : any {
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
  throw new Error("Usage: verify-git-publication.ts --self-test | --index | --staged | --message-file <path> | --pre-push");
}

const invokedPath: any = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch {
    console.error("[git-publication] verification failed");
    process.exitCode = 1;
  }
}

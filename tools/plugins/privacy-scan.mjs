#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { repoRoot, sanitizeError, sha256, walkFiles } from "./lib/repository.mjs";

const ACCOUNT_COMPONENT_SOURCE = "[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_$-])?";
const COMMON_TEXT_TERMINATOR_SOURCE = "[" + String.raw`\s` + "\"'`),;:" + String.raw`\]` + "}>!?]";
const POSIX_HOME_PREFIX_SOURCE = `(?:/${["Users", "home"].join("/|/")}/)`;
const WINDOWS_HOME_PREFIX_SOURCE = "[A-Za-z]:\\\\" + "Users" + "\\\\";
const POSIX_HOME_PATH_PATTERN = new RegExp(
  `${POSIX_HOME_PREFIX_SOURCE}${ACCOUNT_COMPONENT_SOURCE}(?=/|$|${COMMON_TEXT_TERMINATOR_SOURCE})`,
  "u"
);
const WINDOWS_HOME_PATH_PATTERN = new RegExp(
  `${WINDOWS_HOME_PREFIX_SOURCE}${ACCOUNT_COMPONENT_SOURCE}(?=[\\\\/]|$|${COMMON_TEXT_TERMINATOR_SOURCE})`,
  "iu"
);

const RULES = Object.freeze([
  ["local-home-path", POSIX_HOME_PATH_PATTERN],
  ["windows-home-path", WINDOWS_HOME_PATH_PATTERN],
  ["credential-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/u],
  ["authorization-value", /\bAuthorization\s*[:=]\s*["'](?:Bearer|Basic)\s+[^"']+/iu],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u]
]);

function included(relative) {
  return !excludedDirectory(relative);
}

function excludedDirectory(relative) {
  const segments = String(relative || "").split("/");
  return segments.some((segment) => segment === "node_modules" || segment === "dist") ||
    [".git", ".local", ".claude", "build", "docs/plan"].some(
      (prefix) => relative === prefix || relative.startsWith(`${prefix}/`)
    );
}

export function findPrivacyFindings(relative, text) {
  const findings = [];
  for (const [ruleId, pattern] of RULES) {
    const match = pattern.exec(text);
    if (!match) continue;
    findings.push({
      ruleId,
      path: relative,
      line: text.slice(0, match.index).split("\n").length,
      digest: sha256(Buffer.from(match[0])).slice(7, 23)
    });
  }
  return findings;
}

async function main() {
  const findings = [];
  const files = await walkFiles(repoRoot, {
    excludeDirectory: excludedDirectory,
    include: included
  });
  for (const file of files) {
    if (!/\.(?:md|json|mjs|js|yaml|yml|toml|txt|d\.mts)$/iu.test(file.relative)) continue;
    const bytes = await fs.readFile(file.absolute);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    findings.push(...findPrivacyFindings(file.relative, text));
  }
  if (findings.length > 0) {
    for (const finding of findings) console.error(JSON.stringify(finding));
    throw new Error(`Privacy scan found ${findings.length} candidate disclosure(s)`);
  }
  console.log(JSON.stringify({ ok: true, checkedFiles: files.length, findings: 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root: any = process.cwd();

const scanRoots: any[] = [""];

const excludedPathPrefixes: any[] = [
  ".git/",
  ".codex-research/",
  ".kilo/node_modules/",
  "build/release/",
  "node_modules/",
  "tests/fixtures/"
];

const scannedExtensions: any = new Set<any>([
  ".js",
  ".ts",
  ".cjs",
  ".ts",
  ".tsx",
  ".vue",
  ".dart",
  ".rs",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
  ".eml",
  ".mbox"
]);

const secretPatterns: any[] = [
  {
    id: "private-key",
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u
  },
  {
    id: "aws-access-key-id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/u
  },
  {
    id: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/u
  },
  {
    id: "openai-api-key",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/u
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u
  }
];

const emailArtifactSecretPatterns: any[] = [
  {
    id: "email-inline-token",
    pattern: /\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|msg[_-]?token|emk[_-]?token|token)\s*(?:=|:|%3D|=3D)\s*["']?[A-Za-z0-9._~+/=%-]{20,}/iu
  },
  {
    id: "email-password-reset-link",
    pattern: /\b(?:Reset password|begin_password_reset|personal access token)\b/iu
  }
];

function toPosix(value?: any) : any {
  return value.split(path.sep).join("/");
}

function shouldSkip(relativePath?: any) : any {
  const normalized: any = toPosix(relativePath);
  return excludedPathPrefixes.some((prefix?: any) : any => normalized.startsWith(prefix));
}

function shouldScanFile(relativePath?: any) : any {
  if (path.basename(relativePath).startsWith(".env")) {
    return true;
  }
  return scannedExtensions.has(path.extname(relativePath));
}

async function collectFiles(directory?: any, relativePath: any = "") : Promise<any> {
  if (shouldSkip(relativePath)) {
    return [];
  }

  let entries: any;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: any[] = [];
  for (const entry of entries) {
    const childRelativePath: any = relativePath
      ? path.join(relativePath, entry.name)
      : entry.name;
    if (shouldSkip(childRelativePath)) {
      continue;
    }
    const childPath: any = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(childPath, childRelativePath));
      continue;
    }
    if (entry.isFile() && shouldScanFile(childRelativePath)) {
      files.push(childRelativePath);
    }
  }
  return files;
}

function lineNumberForOffset(text?: any, offset?: any) : any {
  let line: any = 1;
  for (let index: any = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

const violations: any[] = [];

for (const scanRoot of scanRoots) {
  const files: any = await collectFiles(path.join(root, scanRoot), scanRoot);
  for (const relativePath of files) {
    const absolutePath: any = path.join(root, relativePath);
    const text: any = await fs.readFile(absolutePath, "utf8").catch(() : any => "");
    const filePatterns: any = [".eml", ".mbox"].includes(path.extname(relativePath))
      ? [...secretPatterns, ...emailArtifactSecretPatterns]
      : secretPatterns;
    for (const { id, pattern } of filePatterns) {
      const match: any = pattern.exec(text);
      if (match) {
        violations.push({
          id,
          path: toPosix(relativePath),
          line: lineNumberForOffset(text, match.index)
        });
      }
    }
  }
}

if (violations.length > 0) {
  const lines: any[] = ["Secret hygiene failed:"];
  for (const violation of violations) {
    lines.push(`- ${violation.id}: ${violation.path}:${violation.line}`);
  }
  lines.push("");
  lines.push("Move real credentials to local environment files or secret managers. Keep only placeholders in source.");
  process.stderr.write(`${lines.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("Secret hygiene passed.\n");

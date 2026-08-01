import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_TEXT_FILE_BYTES: any = 8 * 1024 * 1024;

const TEXT_EXTENSIONS: any = new Set<any>([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".ts",
  ".md",
  ".sh",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);

const TEXT_FILE_NAMES: any = new Set<any>([
  ".dockerignore",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  "Dockerfile",
  "LICENSE",
  "NOTICE",
  "meshrix-mcp"
]);

const FORBIDDEN_PATH_PREFIX_RULES: readonly any[] = Object.freeze([
  {
    ruleId: "private_process_documentation",
    prefixes: ["docs/plans", "docs/reports"]
  },
  {
    ruleId: "local_runtime_data",
    prefixes: [
      ".cache",
      ".meshrix-agent-history",
      ".meshrix-server-data",
      ".meshrix-data",
      "meshrix-data"
    ]
  },
  {
    ruleId: "private_test_corpus",
    prefixes: ["tests/email-corpus", "tests/fixtures"]
  }
]);

const FORBIDDEN_PATH_SEGMENT_RULES: readonly any[] = Object.freeze([
  {
    ruleId: "repository_or_dependency_metadata",
    segments: [".git", "node_modules"]
  },
  {
    ruleId: "generated_or_local_output",
    segments: [
      ".cache",
      ".dart_tool",
      ".gradle",
      ".next",
      ".nuxt",
      "__pycache__",
      "build",
      "coverage",
      "dist",
      "downloads",
      "output",
      "outputs",
      "reports",
      "target",
      "test-results"
    ]
  }
]);

const FORBIDDEN_FILE_EXTENSIONS: any = new Set<any>([
  ".db",
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pfx",
  ".sqlite",
  ".sqlite3"
]);

const LOCAL_PATH_DETECTOR_SOURCE_EXCLUSIONS: any = new Set<any>([
  "tools/config-scanner.ts",
  "tools/server-scripts/lib/public-artifact-boundary.ts",
  "tools/server-scripts/verify-privacy-placeholders.ts"
]);

function normalizeRelativePath(value: any = "") : any {
  return String(value || "")
    .split(path.sep)
    .join("/")
    .replace(/^\.\//u, "");
}

function pathMatchesPrefix(relativePath?: any, prefix?: any) : any {
  return relativePath === prefix || relativePath.startsWith(prefix + "/");
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

function createFinding(ruleId?: any, relativePath?: any, line: any = 0) : any {
  const normalizedPath: any = normalizeRelativePath(relativePath);
  const normalizedLine: any = Number.isInteger(line) && line > 0 ? line : 0;
  const digest: any = createHash("sha256")
    .update(ruleId + "\0" + normalizedPath + "\0" + normalizedLine)
    .digest("hex")
    .slice(0, 16);
  return {
    ruleId,
    relativePath: normalizedPath,
    ...(normalizedLine > 0 ? { line: normalizedLine } : {}),
    digest
  };
}

function pathFinding(relativePath?: any, options: Record<string, any> = {}) : any {
  const normalizedPath: any = normalizeRelativePath(relativePath);
  const allowedGeneratedOutputSegments: any = new Set<any>(
    options.allowedGeneratedOutputSegments || []
  );
  for (const rule of FORBIDDEN_PATH_PREFIX_RULES) {
    if (rule.prefixes.some((prefix?: any) : any => pathMatchesPrefix(normalizedPath, prefix))) {
      return createFinding(rule.ruleId, normalizedPath);
    }
  }

  const segments: any = normalizedPath.split("/");
  for (const rule of FORBIDDEN_PATH_SEGMENT_RULES) {
    if (segments.some((segment?: any) : any => (
      rule.segments.includes(segment) &&
      !(rule.ruleId === "generated_or_local_output" && allowedGeneratedOutputSegments.has(segment))
    ))) {
      return createFinding(rule.ruleId, normalizedPath);
    }
  }

  const basename: any = path.posix.basename(normalizedPath);
  if (basename === ".DS_Store" || basename === "Thumbs.db") {
    return createFinding("operating_system_metadata", normalizedPath);
  }
  if (basename === ".npmrc" || basename === "npmrc") {
    return createFinding("package_registry_credentials_file", normalizedPath);
  }
  if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) {
    return createFinding("environment_credentials_file", normalizedPath);
  }
  if (FORBIDDEN_FILE_EXTENSIONS.has(path.posix.extname(basename).toLowerCase())) {
    return createFinding("credential_or_runtime_database_file", normalizedPath);
  }
  return null;
}

function isTextFile(relativePath?: any) : any {
  const basename: any = path.posix.basename(relativePath);
  return TEXT_FILE_NAMES.has(basename) ||
    TEXT_EXTENSIONS.has(path.posix.extname(basename).toLowerCase());
}

function contentRules() : any {
  const join: any = (...parts: any[]) : any => parts.join("");
  return [
    {
      ruleId: "private_key_material",
      pattern: new RegExp(join("-----BEGIN ", "(?:RSA |DSA |EC |OPENSSH |PGP )?", "PRIVATE KEY-----"), "u")
    },
    {
      ruleId: "bearer_credential",
      pattern: new RegExp(join("\\bBearer", "\\s+", "(?!\\[redacted\\]|<[^>]+>)", "[A-Za-z0-9._~+\\/=-]{16,}"), "iu")
    },
    {
      ruleId: "aws_access_key",
      pattern: new RegExp(join("\\bAK", "IA[0-9A-Z]{16}\\b"), "u")
    },
    {
      ruleId: "github_credential",
      pattern: new RegExp(join("\\bgh", "[pousr]_[A-Za-z0-9_]{36,}\\b|\\bgithub_pat_[A-Za-z0-9_]{40,}\\b"), "u")
    },
    {
      ruleId: "openai_credential",
      pattern: new RegExp(join("\\bsk", "-[A-Za-z0-9]{20,}\\b"), "u")
    },
    {
      ruleId: "slack_credential",
      pattern: new RegExp(join("\\bxox", "[baprs]-[A-Za-z0-9-]{20,}\\b"), "u")
    },
    {
      ruleId: "google_api_credential",
      pattern: new RegExp(join("\\bAI", "za[0-9A-Za-z_-]{35}\\b"), "u")
    },
    {
      ruleId: "npm_credential",
      pattern: new RegExp(join("\\bnpm", "_[A-Za-z0-9]{36}\\b"), "u")
    },
    {
      ruleId: "url_embedded_credentials",
      pattern: new RegExp(join("https?:\\/\\/", "[^\\s/:@]+:[^\\s/@]+@", "[^\\s]+"), "iu")
    }
  ];
}

function normalizeLocalNeedles(values: any = []) : any {
  const candidates: any = [...values, os.homedir()]
    .map((value?: any) : any => String(value || "").trim())
    .filter((value?: any) : any => value.length >= 4 && path.isAbsolute(value));
  return [...new Set<any>(candidates)];
}

function localPathNeedleIndex(text?: any, needle?: any) : any {
  const boundary: any = /[\s"'`()\[\]{}<>=,:;]/u;
  let offset: any = 0;
  while (offset < text.length) {
    const matchIndex: any = text.indexOf(needle, offset);
    if (matchIndex < 0) return -1;
    const endIndex: any = matchIndex + needle.length;
    const preceding: any = matchIndex > 0 ? text[matchIndex - 1] : "";
    const following: any = endIndex < text.length ? text[endIndex] : "";
    const startsAtBoundary: any =
      matchIndex === 0 ||
      boundary.test(preceding) ||
      text.slice(Math.max(0, matchIndex - 7), matchIndex).endsWith("file://");
    const endsAtBoundary: any =
      endIndex === text.length ||
      boundary.test(following) ||
      following === "/" ||
      following === "\\";
    if (startsAtBoundary && endsAtBoundary) return matchIndex;
    offset = matchIndex + 1;
  }
  return -1;
}

async function collectArtifactFiles(rootPath?: any) : Promise<any> {
  const files: any[] = [];
  const findings: any[] = [];

  async function visit(directory?: any, relativeDirectory: any = "") : Promise<any> {
    const entries: any = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left?: any, right?: any) : any => left.name.localeCompare(right.name))) {
      const relativePath: any = normalizeRelativePath(
        relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name
      );
      const forbidden: any = pathFinding(relativePath);
      if (forbidden) {
        findings.push(forbidden);
        continue;
      }
      const absolutePath: any = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        findings.push(createFinding("symbolic_link_not_allowed", relativePath));
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        files.push({ absolutePath, relativePath });
      }
    }
  }

  await visit(rootPath);
  return { files, findings };
}

async function scanCollectedArtifactFiles(files?: any, findings?: any, options: Record<string, any> = {}) : Promise<any> {
  const localNeedles: any = normalizeLocalNeedles(options.localNeedles || []);
  const rules: any = contentRules();
  let scannedTextFileCount: any = 0;
  let skippedBinaryOrOversizedFileCount: any = 0;
  let localPathDetectorExcludedFileCount: any = 0;

  for (const file of files) {
    const fileStat: any = await fs.stat(file.absolutePath);
    if (!isTextFile(file.relativePath)) {
      skippedBinaryOrOversizedFileCount += 1;
      continue;
    }
    if (fileStat.size > MAX_TEXT_FILE_BYTES) {
      findings.push(createFinding("text_file_scan_size_limit_exceeded", file.relativePath));
      skippedBinaryOrOversizedFileCount += 1;
      continue;
    }
    const text: any = await fs.readFile(file.absolutePath, "utf8");
    scannedTextFileCount += 1;
    for (const rule of rules) {
      const match: any = rule.pattern.exec(text);
      if (match) {
        findings.push(createFinding(
          rule.ruleId,
          file.relativePath,
          lineNumberForOffset(text, match.index)
        ));
      }
    }

    if (LOCAL_PATH_DETECTOR_SOURCE_EXCLUSIONS.has(file.relativePath)) {
      localPathDetectorExcludedFileCount += 1;
      continue;
    }
    for (const needle of localNeedles) {
      const matchIndex: any = localPathNeedleIndex(text, needle);
      if (matchIndex >= 0) {
        findings.push(createFinding(
          "local_absolute_path",
          file.relativePath,
          lineNumberForOffset(text, matchIndex)
        ));
        break;
      }
    }
  }

  findings.sort((left?: any, right?: any) : any =>
    left.relativePath.localeCompare(right.relativePath) ||
    left.ruleId.localeCompare(right.ruleId) ||
    Number(left.line || 0) - Number(right.line || 0)
  );
  const ruleFindingCounts: Record<string, any> = {};
  for (const finding of findings) {
    ruleFindingCounts[finding.ruleId] = (ruleFindingCounts[finding.ruleId] || 0) + 1;
  }

  return {
    schemaVersion: "v0.0.1:release:public-artifact-boundary-scan-1",
    ok: findings.length === 0,
    summary: {
      scannedFileCount: files.length,
      scannedTextFileCount,
      skippedBinaryOrOversizedFileCount,
      localPathDetectorExcludedFileCount,
      findingCount: findings.length,
      ruleFindingCounts
    },
    findings
  };
}

export async function scanPublicArtifactFiles(rootPath?: any, relativePaths: any = [], options: Record<string, any> = {}) : Promise<any> {
  const absoluteRoot: any = path.resolve(rootPath);
  const files: any[] = [];
  const findings: any[] = [];
  for (const candidate of [...new Set<any>(relativePaths.map(normalizeRelativePath))].sort()) {
    if (!candidate || path.isAbsolute(candidate) || candidate.startsWith("../") || candidate.includes("/../")) {
      findings.push(createFinding("artifact_path_outside_root", candidate || "invalid-path"));
      continue;
    }
    const forbidden: any = pathFinding(candidate, options);
    if (forbidden) {
      findings.push(forbidden);
      continue;
    }
    const absolutePath: any = path.resolve(absoluteRoot, candidate);
    const stat: any = await fs.lstat(absolutePath).catch(() : any => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      findings.push(createFinding(
        stat?.isSymbolicLink() ? "symbolic_link_not_allowed" : "artifact_file_missing",
        candidate
      ));
      continue;
    }
    files.push({ absolutePath, relativePath: candidate });
  }
  return scanCollectedArtifactFiles(files, findings, options);
}

export async function scanPublicArtifact(rootPath?: any, options: Record<string, any> = {}) : Promise<any> {
  const absoluteRoot: any = path.resolve(rootPath);
  const stat: any = await fs.stat(absoluteRoot).catch(() : any => null);
  if (!stat?.isDirectory()) {
    throw new Error("public_artifact_scan_root_missing");
  }
  const { files, findings } = await collectArtifactFiles(absoluteRoot);
  return scanCollectedArtifactFiles(files, findings, options);
}

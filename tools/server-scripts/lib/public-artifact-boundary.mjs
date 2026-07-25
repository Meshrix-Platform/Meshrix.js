import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
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

const TEXT_FILE_NAMES = new Set([
  ".dockerignore",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  "Dockerfile",
  "LICENSE",
  "NOTICE",
  "meshrix-mcp"
]);

const FORBIDDEN_PATH_PREFIX_RULES = Object.freeze([
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

const FORBIDDEN_PATH_SEGMENT_RULES = Object.freeze([
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

const FORBIDDEN_FILE_EXTENSIONS = new Set([
  ".db",
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pfx",
  ".sqlite",
  ".sqlite3"
]);

const LOCAL_PATH_DETECTOR_SOURCE_EXCLUSIONS = new Set([
  "tools/config-scanner.mjs",
  "tools/server-scripts/lib/public-artifact-boundary.mjs",
  "tools/server-scripts/verify-privacy-placeholders.mjs"
]);

function normalizeRelativePath(value = "") {
  return String(value || "")
    .split(path.sep)
    .join("/")
    .replace(/^\.\//u, "");
}

function pathMatchesPrefix(relativePath, prefix) {
  return relativePath === prefix || relativePath.startsWith(prefix + "/");
}

function lineNumberForOffset(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function createFinding(ruleId, relativePath, line = 0) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const normalizedLine = Number.isInteger(line) && line > 0 ? line : 0;
  const digest = createHash("sha256")
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

function pathFinding(relativePath) {
  const normalizedPath = normalizeRelativePath(relativePath);
  for (const rule of FORBIDDEN_PATH_PREFIX_RULES) {
    if (rule.prefixes.some((prefix) => pathMatchesPrefix(normalizedPath, prefix))) {
      return createFinding(rule.ruleId, normalizedPath);
    }
  }

  const segments = normalizedPath.split("/");
  for (const rule of FORBIDDEN_PATH_SEGMENT_RULES) {
    if (segments.some((segment) => rule.segments.includes(segment))) {
      return createFinding(rule.ruleId, normalizedPath);
    }
  }

  const basename = path.posix.basename(normalizedPath);
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

function isTextFile(relativePath) {
  const basename = path.posix.basename(relativePath);
  return TEXT_FILE_NAMES.has(basename) ||
    TEXT_EXTENSIONS.has(path.posix.extname(basename).toLowerCase());
}

function contentRules() {
  const join = (...parts) => parts.join("");
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

function normalizeLocalNeedles(values = []) {
  const candidates = [...values, os.homedir()]
    .map((value) => String(value || "").trim())
    .filter((value) => value.length >= 4 && path.isAbsolute(value));
  return [...new Set(candidates)];
}

async function collectArtifactFiles(rootPath) {
  const files = [];
  const findings = [];

  async function visit(directory, relativeDirectory = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = normalizeRelativePath(
        relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name
      );
      const forbidden = pathFinding(relativePath);
      if (forbidden) {
        findings.push(forbidden);
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
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

async function scanCollectedArtifactFiles(files, findings, options = {}) {
  const localNeedles = normalizeLocalNeedles(options.localNeedles || []);
  const rules = contentRules();
  let scannedTextFileCount = 0;
  let skippedBinaryOrOversizedFileCount = 0;
  let localPathDetectorExcludedFileCount = 0;

  for (const file of files) {
    const fileStat = await fs.stat(file.absolutePath);
    if (!isTextFile(file.relativePath)) {
      skippedBinaryOrOversizedFileCount += 1;
      continue;
    }
    if (fileStat.size > MAX_TEXT_FILE_BYTES) {
      findings.push(createFinding("text_file_scan_size_limit_exceeded", file.relativePath));
      skippedBinaryOrOversizedFileCount += 1;
      continue;
    }
    const text = await fs.readFile(file.absolutePath, "utf8");
    scannedTextFileCount += 1;
    for (const rule of rules) {
      const match = rule.pattern.exec(text);
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
      const matchIndex = text.indexOf(needle);
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

  findings.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath) ||
    left.ruleId.localeCompare(right.ruleId) ||
    Number(left.line || 0) - Number(right.line || 0)
  );
  const ruleFindingCounts = {};
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

export async function scanPublicArtifactFiles(rootPath, relativePaths = [], options = {}) {
  const absoluteRoot = path.resolve(rootPath);
  const files = [];
  const findings = [];
  for (const candidate of [...new Set(relativePaths.map(normalizeRelativePath))].sort()) {
    if (!candidate || path.isAbsolute(candidate) || candidate.startsWith("../") || candidate.includes("/../")) {
      findings.push(createFinding("artifact_path_outside_root", candidate || "invalid-path"));
      continue;
    }
    const forbidden = pathFinding(candidate);
    if (forbidden) {
      findings.push(forbidden);
      continue;
    }
    const absolutePath = path.resolve(absoluteRoot, candidate);
    const stat = await fs.lstat(absolutePath).catch(() => null);
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

export async function scanPublicArtifact(rootPath, options = {}) {
  const absoluteRoot = path.resolve(rootPath);
  const stat = await fs.stat(absoluteRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error("public_artifact_scan_root_missing");
  }
  const { files, findings } = await collectArtifactFiles(absoluteRoot);
  return scanCollectedArtifactFiles(files, findings, options);
}

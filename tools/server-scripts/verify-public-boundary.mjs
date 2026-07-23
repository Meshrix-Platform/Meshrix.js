#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";

await init;

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const join = (...parts) => parts.join("");
const escaped = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "build",
  "dist",
  "target",
  "coverage",
  ".dart_tool",
  ".gradle"
]);

const PROCESS_DOCUMENTATION_PATH_PREFIXES = Object.freeze([
  "docs/plans",
  "docs/reports"
]);

const REQUIRED_GITIGNORE_ENTRIES = Object.freeze([
  "/licomesh-data/",
  "/build/",
  "/cache/",
  "/docs/plans/",
  "/docs/reports/"
]);

const TEXT_FILE_RE = /\.(?:cjs|css|html|js|json|jsx|mjs|md|svg|ts|tsx|txt|vue|yaml|yml)$/i;
const TEXT_FILE_NAMES = new Set(["Dockerfile"]);
const PLUGIN_PRODUCTION_SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx", ".vue"]);
const PLUGIN_NON_PRODUCTION_SEGMENTS = new Set(["tests", "verifiers"]);
const PRIVATE_MONOREPO_SOURCE_ROOTS = new Set(["apps", "packages", "tools"]);

const PROHIBITED = [
  {
    id: "restricted client repository marker",
    pattern: new RegExp(`${escaped(join("Lico"))}-${escaped(join("Arc"))}`, "iu")
  },
  {
    id: "restricted client wording",
    pattern: new RegExp(`${join("official")}\\s+${join("client")}`, "iu")
  },
  {
    id: "restricted client implementation wording",
    pattern: new RegExp(`${join("out-of")}[-\\s]*${join("repo")}\\s+${join("client")}\\s+${join("implementation")}`, "iu")
  },
  {
    id: "restricted service wording",
    pattern: new RegExp(`${join("pri", "vate")}\\s+${join("sa", "as")}|${join("私", "有")}\\s*${join("S", "aa", "S")}`, "iu")
  },
  {
    id: "restricted client UI framework wording",
    pattern: new RegExp(`\\b${join("Flut", "ter")}\\b`, "u")
  },
  {
    id: "restricted client native helper wording",
    pattern: new RegExp(`${join("native")}\\s+${join("side", "car")}`, "iu")
  },
  {
    id: "restricted client application path",
    pattern: new RegExp(escaped(`${join("apps")}/${join("desktop")}`), "u")
  },
  {
    id: "restricted client native crate path",
    pattern: new RegExp(escaped(`${join("crates")}/${join("lico")}-${join("client")}-${join("native")}`), "u")
  },
  {
    id: "restricted client contract path",
    pattern: new RegExp(escaped(`${join("packages")}/${join("contracts")}/${join("client")}`), "u")
  },
  {
    id: "restricted native client protocol path",
    pattern: new RegExp(escaped(`${join("packages")}/${join("protocols")}/${join("native")}-${join("client")}`), "u")
  },
  {
    id: "restricted client desktop doc id",
    pattern: new RegExp(`${join("CLIENT")}-${join("DESKTOP")}`, "u")
  }
];

function repoRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function isProcessDocumentationPath(relativePath) {
  return PROCESS_DOCUMENTATION_PATH_PREFIXES.some((prefix) =>
      relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  );
}

function isPluginProductionSource(relativePath) {
  const segments = relativePath.split("/");
  return segments[0] === "plugins" &&
    segments.length >= 3 &&
    !segments.slice(2, -1).some((segment) => PLUGIN_NON_PRODUCTION_SEGMENTS.has(segment)) &&
    PLUGIN_PRODUCTION_SOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function moduleSourceForFile(source, filePath) {
  if (path.extname(filePath).toLowerCase() !== ".vue") {
    return source;
  }
  return [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)]
    .map((match) => match[1])
    .join("\n");
}

function privateMonorepoImportSpecifiers(source, filePath) {
  const [imports] = parse(moduleSourceForFile(source, filePath));
  return imports
    .map((entry) => entry.n)
    .filter((specifier) => typeof specifier === "string" && specifier.startsWith("."))
    .filter((specifier) => {
      const target = repoRelative(path.resolve(path.dirname(filePath), specifier));
      return PRIVATE_MONOREPO_SOURCE_ROOTS.has(target.split("/")[0]);
    });
}

async function walk(dir, files = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nextDir = path.join(dir, entry.name);
      if (!SKIPPED_DIRS.has(entry.name) && !isProcessDocumentationPath(repoRelative(nextDir))) {
        await walk(nextDir, files);
      }
      continue;
    }
    if (
      entry.isFile() &&
      !isProcessDocumentationPath(repoRelative(path.join(dir, entry.name))) &&
      (TEXT_FILE_RE.test(entry.name) || TEXT_FILE_NAMES.has(entry.name))
    ) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

const files = await walk(repoRoot);
const findings = [];
const gitignore = await fs.readFile(path.join(repoRoot, ".gitignore"), "utf8");
for (const requiredIgnore of REQUIRED_GITIGNORE_ENTRIES) {
  if (!gitignore.split(/\r?\n/u).includes(requiredIgnore)) {
    findings.push({ file: ".gitignore", line: 1, id: `missing public-boundary ignore ${requiredIgnore}` });
  }
}

for (const file of files) {
  const relativeFile = repoRelative(file);
  if (relativeFile === "tools/server-scripts/verify-public-boundary.mjs") {
    continue;
  }
  const text = await fs.readFile(file, "utf8");
  for (const rule of PROHIBITED) {
    const match = text.match(rule.pattern);
    if (match) {
      const before = text.slice(0, match.index || 0);
      const line = before.split(/\r?\n/u).length;
      findings.push({ file: repoRelative(file), line, id: rule.id });
    }
  }
  if (isPluginProductionSource(relativeFile)) {
    const specifierOffsets = new Map();
    for (const specifier of privateMonorepoImportSpecifiers(text, file)) {
      const matchIndex = text.indexOf(specifier, specifierOffsets.get(specifier) || 0);
      specifierOffsets.set(specifier, Math.max(0, matchIndex) + specifier.length);
      const line = text.slice(0, Math.max(0, matchIndex)).split(/\r?\n/u).length;
      findings.push({
        file: relativeFile,
        line,
        id: `plugin production source imports private monorepo path ${specifier}`
      });
    }
  }
}

if (findings.length > 0) {
  console.error("Boundary hygiene verification failed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} ${finding.id}`);
  }
  process.exit(1);
}

console.log(`[boundary-hygiene] ok (${files.length} files scanned)`);

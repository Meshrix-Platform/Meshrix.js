import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..", "..");
const FACT_SOURCE_KEY_PATTERN = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u;

function normalizeRepoPath(value = "") {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/gu, "")
    .replace(/^\.\//u, "")
    .split(/[\\/]+/u)
    .join("/");
}

function isSafeRepoRelativePath(value) {
  const text = normalizeRepoPath(value);
  return Boolean(text) &&
    !text.startsWith("/") &&
    !/^[a-z]+:\/\//iu.test(text) &&
    !/^[A-Za-z]:\\/u.test(text) &&
    !text.split("/").includes("..");
}

async function pathExists(rootDir, relativePath) {
  try {
    await access(resolve(rootDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

function add(findings, source, kind, detail) {
  findings.push({ source, kind, detail });
}

export async function validateFactSourceAuthorityFindings(data, options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const registryPath = options.registryPath || "tools/registry/fact-source-authority.registry.json";
  const findings = [];

  if (data?.policy?.singleAuthority !== true ||
    data?.policy?.uniqueFactKeys !== true ||
    data?.policy?.projectionOnlyReports !== true ||
    data?.policy?.noDocumentOverrides !== true) {
    add(findings, registryPath, "policy-not-strict", "authority registry must require one authority, unique fact keys, projection-only reports, and no document overrides");
  }

  const authorities = Array.isArray(data?.authorities) ? data.authorities : [];
  if (authorities.length === 0) {
    add(findings, registryPath, "authority-list-empty", "authorities must be a non-empty array");
    return findings;
  }

  const packageJson = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8"));
  const packageScripts = new Set(Object.keys(packageJson.scripts || {}));
  const ids = new Set();
  const factKeys = new Map();

  for (const authority of authorities) {
    const id = String(authority.id || "").trim();
    const factKey = String(authority.factKey || "").trim();
    const authorityPath = normalizeRepoPath(authority.authorityPath);
    const label = id || authorityPath || "(missing id)";

    if (!id) {
      add(findings, registryPath, "authority-id-missing", authorityPath || "(missing authorityPath)");
    } else if (ids.has(id)) {
      add(findings, registryPath, "authority-id-duplicate", id);
    }
    ids.add(id);

    if (!factKey || !FACT_SOURCE_KEY_PATTERN.test(factKey)) {
      add(findings, registryPath, "authority-fact-key-invalid", `${label}:${factKey || "(missing factKey)"}`);
    } else if (factKeys.has(factKey)) {
      add(findings, registryPath, "authority-fact-key-duplicate", `${factKey}:${factKeys.get(factKey)}:${label}`);
    } else {
      factKeys.set(factKey, label);
    }

    if (!isSafeRepoRelativePath(authorityPath) || !await pathExists(rootDir, authorityPath)) {
      add(findings, registryPath, "authority-path-invalid", `${label}:${authorityPath || "(missing path)"}`);
    }
    if (!String(authority.domain || "").trim()) {
      add(findings, registryPath, "authority-domain-missing", label);
    }
    if (!String(authority.authorityRole || "").trim()) {
      add(findings, registryPath, "authority-role-missing", label);
    }

    const consumerPaths = Array.isArray(authority.consumerPaths) ? authority.consumerPaths.map(normalizeRepoPath) : [];
    if (consumerPaths.length === 0) {
      add(findings, registryPath, "authority-consumers-missing", label);
    }
    for (const consumerPath of consumerPaths) {
      if (!isSafeRepoRelativePath(consumerPath) || !await pathExists(rootDir, consumerPath)) {
        add(findings, registryPath, "authority-consumer-invalid", `${label}:${consumerPath || "(missing consumer)"}`);
      }
    }

    const projectionPaths = Array.isArray(authority.projectionPaths) ? authority.projectionPaths.map(normalizeRepoPath) : [];
    for (const projectionPath of projectionPaths) {
      if (!isSafeRepoRelativePath(projectionPath)) {
        add(findings, registryPath, "authority-projection-path-unsafe", `${label}:${projectionPath || "(missing projection)"}`);
      }
      if (projectionPath === authorityPath) {
        add(findings, registryPath, "projection-equals-authority", `${label}:${projectionPath}`);
      }
      const generatedProjection = projectionPath.startsWith("build/reports/") ||
        projectionPath.startsWith("build/acceptance-evidence/");
      if (projectionPath && !generatedProjection && !await pathExists(rootDir, projectionPath)) {
        add(findings, registryPath, "authority-projection-path-missing", `${label}:${projectionPath}`);
      }
    }

    const verification = Array.isArray(authority.verification) ? authority.verification : [];
    if (verification.length === 0) {
      add(findings, registryPath, "authority-verification-missing", label);
    }
    for (const command of verification) {
      const text = String(command || "").trim();
      const npmRun = text.match(/^npm run ([^\s]+)$/u);
      const npmTest = text === "npm test";
      const nodeScript = text.match(/^node ([^\s]+\.mjs)$/u);
      if (npmTest) {
        if (!packageScripts.has("test")) {
          add(findings, registryPath, "authority-verification-script-missing", `${label}:test`);
        }
      } else if (npmRun) {
        if (!packageScripts.has(npmRun[1])) {
          add(findings, registryPath, "authority-verification-script-missing", `${label}:${npmRun[1]}`);
        }
      } else if (nodeScript) {
        if (!isSafeRepoRelativePath(nodeScript[1]) || !await pathExists(rootDir, nodeScript[1])) {
          add(findings, registryPath, "authority-verification-node-script-missing", `${label}:${nodeScript[1]}`);
        }
      } else {
        add(findings, registryPath, "authority-verification-command-unsupported", `${label}:${text}`);
      }
    }

    if (!Array.isArray(authority.nonAuthorityBoundaries) || authority.nonAuthorityBoundaries.length === 0) {
      add(findings, registryPath, "authority-non-authority-boundaries-missing", label);
    }
  }

  return findings;
}

export async function validateFactSourceAuthorityRegistry(data, options = {}) {
  const findings = await validateFactSourceAuthorityFindings(data, options);
  return findings.map((finding) => `fact-source-authority: ${finding.kind}: ${finding.detail}`);
}

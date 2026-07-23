#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath = path.join(repoRoot, "build", "reports", "path-abstraction-audit.json");
const scanRoots = [
  "packages/agents/src/agent-workspace",
  "packages/agents/src/workspace-contribution",
  "packages/protocols/mcp/adapter",
  "packages/protocols/http/controllers"
];
const helperAllowlist = new Set([
  "packages/foundation/src/security/local-path-boundary.mjs",
  "packages/foundation/src/security/client-strings.mjs",
  "packages/foundation/src/module-system/plugin-data-capability.mjs",
  "packages/agents/src/workspace-contribution/index.mjs",
  "packages/agents/src/workspace-contribution/storage-helpers.mjs",
  "packages/agents/src/agent-workspace/index.mjs"
]);
const ignoredFiles = new Set([
  "packages/protocols/mcp/adapter/gateway-installer/bin/lico-mcp.mjs"
]);
const requiredHelpers = [
  "normalizeSandboxRelativePath",
  "resolveVirtualPathWithinRoot",
  "createPluginDataCapability",
  "normalizeRelativePath"
];

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(path.join(repoRoot, dir), { withFileTypes: true }).catch(() => [])) {
    const relative = path.join(dir, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      out.push(...await walk(relative));
    } else if (/\.(mjs|js|ts|vue)$/u.test(entry.name)) {
      out.push(relative);
    }
  }
  return out;
}

await fs.mkdir(path.dirname(reportPath), { recursive: true });
const files = (await Promise.all(scanRoots.map(walk))).flat();
const findings = [];
for (const relative of files) {
  const source = await fs.readFile(path.join(repoRoot, relative), "utf8");
  if (helperAllowlist.has(relative) || ignoredFiles.has(relative)) {
    continue;
  }
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    if (/\bpath\.(join|resolve)\s*\(/u.test(line) && /(input|payload|params|body|request|workspaceId|mountRef|relativePath|localPath|sourcePath)/u.test(line)) {
      findings.push({
        file: relative,
        line: index + 1,
        code: "path_composition_outside_helper"
      });
    }
  });
}
const helperSources = await Promise.all([...helperAllowlist].map(async (relative) =>
  fs.readFile(path.join(repoRoot, relative), "utf8").catch(() => "")
));
const missingHelpers = requiredHelpers.filter((name) => !helperSources.some((source) => source.includes(name)));
const pathAbstractionAcceptanceReady = findings.length === 0 && missingHelpers.length === 0;
const report = {
  schemaVersion: "v0.0.1:platform:path-abstraction-audit-report-1",
  verifier: "tools/server-scripts/verify-path-abstraction-audit.mjs",
  generatedAt: new Date().toISOString(),
  summary: {
    pathAbstractionAcceptanceReady,
    reportLeakScan: true,
    scannedFileCount: files.length,
    findingCount: findings.length,
    missingHelperCount: missingHelpers.length
  },
  findings,
  missingHelpers
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (!pathAbstractionAcceptanceReady) {
  throw new Error(`Path abstraction audit failed: ${findings.length} findings, ${missingHelpers.length} missing helpers.`);
}
console.log("[path-abstraction-audit] ok");

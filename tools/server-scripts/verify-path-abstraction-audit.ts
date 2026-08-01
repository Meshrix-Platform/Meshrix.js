#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath: any = path.join(repoRoot, "build", "reports", "path-abstraction-audit.json");
const scanRoots: any[] = [
  "packages/agents/src/agent-workspace",
  "packages/agents/src/workspace-contribution",
  "packages/protocols/mcp/adapter",
  "packages/protocols/http/controllers"
];
const helperAllowlist: any = new Set<any>([
  "packages/foundation/src/security/local-path-boundary.ts",
  "packages/foundation/src/security/client-strings.ts",
  "packages/foundation/src/module-system/plugin-data-capability.ts",
  "packages/agents/src/workspace-contribution/index.ts",
  "packages/agents/src/workspace-contribution/storage-helpers.ts",
  "packages/agents/src/agent-workspace/index.ts"
]);
const ignoredFiles: any = new Set<any>([
  "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts"
]);
const requiredHelpers: any[] = [
  "normalizeSandboxRelativePath",
  "resolveVirtualPathWithinRoot",
  "createPluginDataCapability",
  "normalizeRelativePath"
];

async function walk(dir?: any) : Promise<any> {
  const out: any[] = [];
  for (const entry of await fs.readdir(path.join(repoRoot, dir), { withFileTypes: true }).catch(() : any => [])) {
    const relative: any = path.join(dir, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      out.push(...await walk(relative));
    } else if (/\.(mjs|js|ts|vue)$/u.test(entry.name)) {
      out.push(relative);
    }
  }
  return out;
}

await fs.mkdir(path.dirname(reportPath), { recursive: true });
const files: any = (await Promise.all(scanRoots.map(walk))).flat();
const findings: any[] = [];
for (const relative of files) {
  const source: any = await fs.readFile(path.join(repoRoot, relative), "utf8");
  if (helperAllowlist.has(relative) || ignoredFiles.has(relative)) {
    continue;
  }
  const lines: any = source.split("\n");
  lines.forEach((line?: any, index?: any) : any => {
    if (/\bpath\.(join|resolve)\s*\(/u.test(line) && /(input|payload|params|body|request|workspaceId|mountRef|relativePath|localPath|sourcePath)/u.test(line)) {
      findings.push({
        file: relative,
        line: index + 1,
        code: "path_composition_outside_helper"
      });
    }
  });
}
const helperSources: any = await Promise.all([...helperAllowlist].map(async (relative?: any) : Promise<any> =>
  fs.readFile(path.join(repoRoot, relative), "utf8").catch(() : any => "")
));
const missingHelpers: any = requiredHelpers.filter((name?: any) : any => !helperSources.some((source?: any) : any => source.includes(name)));
const pathAbstractionAcceptanceReady: any = findings.length === 0 && missingHelpers.length === 0;
const report: Record<string, any> = {
  schemaVersion: "v0.0.1:platform:path-abstraction-audit-report-1",
  verifier: "tools/server-scripts/verify-path-abstraction-audit.ts",
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

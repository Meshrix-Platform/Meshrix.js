#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectGovernedVersionOccurrences,
  GOVERNED_VERSION_PATTERN,
  VERSION_SCAN_ROOTS
} from "../../packages/foundation/src/version-control/version-scan.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function collectGovernedVersionShapeFindings() : any {
  const findings: any[] = [];
  for (const [value, occurrences] of collectGovernedVersionOccurrences({ repoRoot })) {
    if (GOVERNED_VERSION_PATTERN.test(value)) continue;
    for (const occurrence of occurrences) {
      findings.push({
        id: "malformed-governed-version",
        ...occurrence,
        message: "Governed Version String must contain exactly platform, domain, and numeric subsection segments without migration-boundary names."
      });
    }
  }
  return findings;
}

function verifyVersionNaming() : any {
  const findings: any[] = collectGovernedVersionShapeFindings();
  const report: Record<string, any> = {
    ok: findings.length === 0,
    checkedAt: new Date().toISOString(),
    checkedRoots: VERSION_SCAN_ROOTS,
    findingCount: findings.length,
    findings
  };
  const reportPath: any = path.join(repoRoot, "build/reports/version-naming/latest.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

const report: any = verifyVersionNaming();
if (!report.ok) {
  console.error(`[version-naming] failed (${report.findingCount} findings)`);
  for (const finding of report.findings.slice(0, 30)) {
    console.error(`${finding.relativePath}:${finding.line}:${finding.column} [${finding.id}] ${finding.value}`);
  }
  process.exitCode = 1;
} else {
  console.log("[version-naming] ok");
}

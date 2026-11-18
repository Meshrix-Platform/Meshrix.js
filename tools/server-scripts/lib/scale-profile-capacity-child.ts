#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const reportPath: any = path.resolve(String(process.argv[2] || ""));
const capacityVerifier: any = path.join(repoRoot, "tools/server-scripts/verify-job-work-queue-ceiling-conformance.ts");

async function main() : Promise<any> {
  const result: any = spawnSync(process.execPath, [capacityVerifier], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    env: {
      ...process.env,
      NO_COLOR: "1",
      MESHRIX_SCALE_PROFILE: "scale",
      MESHRIX_M7_SCALE_PROFILE: "scale",
    },
  });
  const childReport: any = JSON.parse(await fs.readFile(
    path.join(repoRoot, "build/reports/job-work-queue-ceiling-conformance.json"),
    "utf8",
  ));
  const payload: Record<string, any> = {
    schemaVersion: "v0.0.1:scale:scale-profile-capacity-child-1",
    generatedAt: new Date().toISOString(),
    profile: "scale",
    accepted: result.status === 0 && childReport.summary?.verificationPassed === true,
    childExitCode: result.status ?? 1,
    capacityReport: {
      verificationPassed: childReport.summary?.verificationPassed === true,
      replayPassed: childReport.retention?.journal?.replayPassed === true,
    },
    privacySafe: true,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  if (!payload.accepted) process.exitCode = 1;
}

main().catch(() : any => {
  process.exitCode = 1;
});

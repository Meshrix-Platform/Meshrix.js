#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const reportPath = path.resolve(String(process.argv[2] || ""));
const capacityVerifier = path.join(repoRoot, "tools/server-scripts/verify-job-work-queue-capacity.mjs");

async function main() {
  const result = spawnSync(process.execPath, [capacityVerifier], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    env: {
      ...process.env,
      NO_COLOR: "1",
      LICO_SCALE_PROFILE: "scale",
      LICO_M7_SCALE_PROFILE: "scale",
    },
  });
  const childReport = JSON.parse(await fs.readFile(
    path.join(repoRoot, "build/reports/job-work-queue-capacity.json"),
    "utf8",
  ));
  const payload = {
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

main().catch(() => {
  process.exitCode = 1;
});

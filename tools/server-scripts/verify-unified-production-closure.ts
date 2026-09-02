#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateFileAtomic } from "../../packages/foundation/src/storage/private-file-atomic.ts";
import { resolveCurrentAcceptedCandidate } from "./lib/platform-acceptance-generation-store.ts";
import { assertNoSensitiveReportLeak } from "./lib/sensitive-report-scan.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const outputPath = path.join(repoRoot, "build", "reports", "unified-production-closure.json");

async function json(relativePath: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), "utf8"));
  } catch {
    return null;
  }
}

async function acceptedCandidate(): Promise<{ sourceRevision: string; candidateDigest: string } | null> {
  try {
    const accepted = await resolveCurrentAcceptedCandidate(repoRoot);
    const sourceRevision = String(accepted.receipt.sourceRevision || "");
    const candidateDigest = String(accepted.receipt.candidateDigest || "");
    if (!/^[a-f0-9]{40}$/u.test(sourceRevision) || !/^[a-f0-9]{64}$/u.test(candidateDigest)) return null;
    return { sourceRevision, candidateDigest };
  } catch {
    return null;
  }
}

async function main() {
  const reasons: string[] = [];
  const accepted = await acceptedCandidate();
  const sourceRevision = accepted?.sourceRevision || "";
  const candidateDigest = accepted?.candidateDigest || "";
  const acceptedGenerationReady = accepted !== null;
  if (!acceptedGenerationReady) {
    reasons.push("accepted_candidate_missing");
  }

  const native = await json("build/reports/native-orb-production-use.json");
  const nativeProductionUseReady = acceptedGenerationReady
    && native?.schemaVersion === "v0.0.1:deployment:native-orb-production-use-report-2"
    && native?.verifier === "tools/server-scripts/native-orb-deploy.ts"
    && native?.releaseReady === true
    && native?.sourceRevision === sourceRevision
    && native?.candidateDigest === candidateDigest
    && native?.existingServiceActiveBeforeUpgrade === true
    && native?.rollbackAvailable === true;
  const liveCoreReady = nativeProductionUseReady
    && native?.healthOk === true
    && native?.consoleOk === true
    && native?.candidateActive === true;
  const activeServiceReady = nativeProductionUseReady && native?.serviceActive === true;
  if (!nativeProductionUseReady || !liveCoreReady || !activeServiceReady) {
    reasons.push("native_production_use_not_bound");
  }
  const promotion = await json("build/reports/branch-promotion.json");
  const promotedBranches = promotion?.branches || {};
  const branchPromotionReady = acceptedGenerationReady
    && promotion?.schemaVersion === "v0.0.1:release:branch-promotion-report-1"
    && promotion?.verifier === "tools/server-scripts/promote-release-branches.ts"
    && promotion?.releaseReady === true
    && promotion?.sourceRevision === sourceRevision
    && promotion?.stableAuthorityValid === true
    && promotion?.releaseAuthorityValid === true
    && ["nightly", "stable", "release"].every((branch) => promotedBranches[branch] === sourceRevision)
    && promotion?.publicationPerformed === false
    && promotion?.policyMutationPerformed === false;
  if (!branchPromotionReady) {
    reasons.push("branch_promotion_not_bound");
  }

  const report: any = {
    schemaVersion: "v0.0.1:release:unified-production-closure-report-2",
    verifier: "tools/server-scripts/verify-unified-production-closure.ts",
    generatedAt: new Date().toISOString(),
    sourceRevision,
    candidateDigest,
    acceptedGenerationReady,
    nativeProductionUseReady,
    liveCoreReady,
    activeServiceReady,
    branchPromotionReady,
    coreOnlyBoundary: true,
    publicationPerformed: false,
    reasons,
    releaseReady: reasons.length === 0,
    reportLeakScan: true
  };
  assertNoSensitiveReportLeak(report, "unified production closure report");
  await writePrivateFileAtomic(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!report.releaseReady) process.exitCode = 1;
}

await main();

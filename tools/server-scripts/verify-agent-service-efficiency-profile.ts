#!/usr/bin/env node
import { runAgentServiceEfficiencyProfile } from "./efficiency-profile.ts";

try {
  const result: any = await runAgentServiceEfficiencyProfile({
    writeReport: true,
    runFocusedTests: true
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    reportPath: result.reportPath,
    namedProfile: result.report.namedProfile,
    capacityCertified: result.report.capacityCertified,
    nonCertificationReason: result.report.nonCertificationReason,
    pairCount: result.report.summary.pairCount,
    completenessPassed: result.report.summary.completenessPassed,
    privacyPassed: result.report.summary.privacyPassed,
    safetyPassed: result.report.summary.safetyPassed,
    recoveryPassed: result.report.summary.recoveryPassed,
    warmThresholdsPassed: result.report.summary.warmThresholdsPassed,
    callReductionPercent: result.report.summary.warm.callReductionPercent,
    byteReductionPercent: result.report.summary.warm.byteReductionPercent,
    deterministicReplay: result.report.summary.deterministicReplay,
    focusedSuitePassed: result.report.summary.focusedSuitePassed
  })}\n`);
} catch (error: any) {
  const message: any = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

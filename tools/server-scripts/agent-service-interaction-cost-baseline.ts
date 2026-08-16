#!/usr/bin/env node
import { runAgentServiceInteractionCostBaseline } from "./interaction-cost-baseline.ts";

try {
  const result: any = await runAgentServiceInteractionCostBaseline({
    writeReport: true,
    runFocusedTests: true
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    reportPath: result.reportPath,
    capacityCertified: result.report.capacityCertified,
    nonCertificationReason: result.report.nonCertificationReason,
    pairCount: result.report.summary.pairCount,
    deterministicReplay: result.report.summary.deterministicReplay,
    focusedSuitePassed: result.report.summary.focusedSuitePassed
  })}\n`);
} catch (error: any) {
  const message: any = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

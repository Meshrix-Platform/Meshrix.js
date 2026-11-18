export function summarizeMcpInstallerConvergenceReport(report: Record<string, any>): Record<string, number | boolean> {
  const tests = Array.isArray(report.tests) ? report.tests : [];
  const destructiveTests = Array.isArray(report.destructiveTests) ? report.destructiveTests : [];
  const failedTestCount = [...tests, ...destructiveTests]
    .filter((test: Record<string, any>) => test?.status !== "passed").length;
  const executionFailureCount = report.executionFailure && failedTestCount === 0 ? 1 : 0;
  const failedCount = failedTestCount + executionFailureCount;
  return {
    testCount: tests.length,
    destructiveTestCount: destructiveTests.length,
    failedCount,
    executionFailureCount,
    releaseReady: tests.length > 0 && failedCount === 0
  };
}

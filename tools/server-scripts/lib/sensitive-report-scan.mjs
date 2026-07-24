import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function computeVerifierSourceRevision(repoRoot, sourceFiles = []) {
  const digest = crypto.createHash("sha256");
  for (const relativePath of [...new Set(sourceFiles.map(String))].sort()) {
    digest.update(relativePath);
    digest.update("\0");
    digest.update(await fs.readFile(path.join(repoRoot, relativePath)));
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

export {
  WINDOWS_LOCAL_PATH_PATTERN,
  SENSITIVE_REPORT_PATTERNS,
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  containsSensitiveReportData,
  finalizeAndPublishSensitiveReport,
  finalizeSensitiveReport,
  reportPayloadDigest,
  redactReportText,
  sanitizeSensitiveError,
  sanitizeSensitiveReport,
  sensitiveReportFindings
} from "../../../packages/foundation/src/observability/sensitive-report-scan.mjs";

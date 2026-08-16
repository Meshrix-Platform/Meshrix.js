#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH: any = "build/reports/core-platform-documentation-convergence.json";

const DOCS: readonly any[] = Object.freeze([
  "README.md",
  "README.zh-CN.md",
  "docs/README.md",
  "docs/RUNBOOK.md",
  "docs/architecture/ARCHITECTURE.md",
  "docs/architecture/EXECUTION-SANDBOX.md",
  "docs/protocols/PROTOCOLS.md",
  "docs/COMPATIBILITY.md",
  "packages/protocols/mcp/adapter/native-installer/README.md",
  "packages/protocols/mcp/adapter/gateway-installer/README.md",
  "docs/functionality/GATEWAY.md",
  "docs/functionality/OPERATION-PERMISSION.md",
  "docs/functionality/WORKSPACE-ASSETS.md",
  "docs/functionality/AGENT-COLLABORATION.md",
  "docs/functionality/OPERATIONS-OBSERVABILITY.md",
  "docs/functionality/SECURITY-AUTHORIZATION.md",
  "docs/functionality/INGESTION-JOBS.md",
  "docs/functionality/SERVER-RUNTIME.md"
]);

const INTERNAL_DOCUMENTATION_REFERENCE_PATTERNS: readonly any[] = Object.freeze([
  ["docs_plan", /\bdocs\/plan\b|\]\(plan\/|\]\(\.\.\/plan\//iu],
  ["docs_report", /\bdocs\/report\b|\]\(report\/|\]\(\.\.\/report\//iu],
  ["docs_decisions", /\bdocs\/decisions\b|\]\(decisions\/|\]\(\.\.\/decisions\//iu],
  ["docs_agents", /\bdocs\/AGENTS\.md\b|\]\(AGENTS\.md\)/u]
]);

const DOCUMENT_AUTHORING_MARKER_PATTERNS: readonly any[] = Object.freeze([
  ["authoring_todo", /(?:^|\s)(?:TODO|FIXME)(?=\s|:|$)/imu]
]);

function documentAuthoringMarkerMatches(documentText?: any) : any {
  return DOCUMENT_AUTHORING_MARKER_PATTERNS
    .filter(([, pattern]: any[]) : any => pattern.test(documentText))
    .map(([id]: any[]) : any => id);
}

function verifyDocumentationPolicyContract() : any {
  const truthfulLimitations: any = [
    "A missing dependency fails before startup.",
    "Exactly-once effects remain remaining required work until a durable fencing comparison exists.",
    "Operators cannot enable an unselected plugin."
  ].join("\n");
  if (documentAuthoringMarkerMatches(truthfulLimitations).length !== 0) {
    throw new Error("documentation_policy_rejects_truthful_limitations");
  }
  if (documentAuthoringMarkerMatches("TODO: replace this text").length !== 1) {
    throw new Error("documentation_policy_authoring_marker_not_rejected");
  }
}

const SENSITIVE_REPORT_PATTERNS: readonly any[] = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\]|<redacted-secret>)\S+/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{8,}\b|upstream-secret-value/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op|relay_session|relay_turn|delegated_mcp)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u],
  ["raw_payload", /raw prompt body|private file content/u]
]);

const PRE_RELEASE_READMES: readonly any[] = Object.freeze([
  "README.md",
  "README.zh-CN.md"
]);

const INSTALLER_READMES: readonly any[] = Object.freeze([
  "packages/protocols/mcp/adapter/native-installer/README.md"
]);

function repoPath(relativePath?: any) : any {
  return path.join(repoRoot, relativePath);
}

async function readText(relativePath?: any) : Promise<any> {
  return fs.readFile(repoPath(relativePath), "utf8");
}

function assertNoReportLeak(report?: any) : any {
  const text: any = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Documentation convergence report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

async function main() : Promise<any> {
  verifyDocumentationPolicyContract();
  const docs: Record<string, any> = {};
  for (const relativePath of DOCS) {
    docs[relativePath] = await readText(relativePath);
  }
  const securityPolicy: any = await readText("SECURITY.md");
  const preReleasePolicyActive: any = /\bpre-release\b/iu.test(securityPolicy);

  const rows: any = (Object.entries(docs) as [string, any][]).map(([relativePath, text]: any[]) : any => {
    const missingRequiredTerms: any[] = [];
    const internalReferenceMatches: any = INTERNAL_DOCUMENTATION_REFERENCE_PATTERNS
      .filter(([, pattern]: any[]) : any => pattern.test(text))
      .map(([id]: any[]) : any => id);
    const staleMatches: any = documentAuthoringMarkerMatches(text);
    const policyMatches: any[] = [];
    if (preReleasePolicyActive && PRE_RELEASE_READMES.includes(relativePath) && !/\bpre-release\b/iu.test(text)) {
      policyMatches.push("missing_pre_release_state");
    }
    if (preReleasePolicyActive && INSTALLER_READMES.includes(relativePath)) {
      if (!text.includes("After the release gate passes")) {
        policyMatches.push("release_command_not_conditioned_on_gate");
      }
      if (!text.includes("After GitHub Release publication")) {
        policyMatches.push("unattended_release_command_not_conditioned_on_publication");
      }
    }
    return {
      path: relativePath,
      requiredTermCount: 0,
      missingRequiredTerms,
      internalReferenceMatches,
      staleMatches,
      policyMatches,
      releaseReady: missingRequiredTerms.length === 0 &&
        internalReferenceMatches.length === 0 &&
        staleMatches.length === 0 &&
        policyMatches.length === 0
    };
  });

  const failingRows: any = rows.filter((row?: any) : any => !row.releaseReady);
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:platform:documentation-convergence-report-1",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/verify-core-platform-documentation-convergence.ts",
    algorithm: {
      requiredCapabilityReferences: "Keep public documents free of internal process paths and unresolved authoring markers.",
      documentationQualityScan: "Reject unresolved authoring markers while preserving truthful fail-closed behavior and remaining-required-work statements.",
      publicDocumentationBoundary: "Public documentation may link only to user-facing usage, operation, architecture, protocol, compatibility, state-machine, and functionality documents; local process documents are kept out of commits by .gitignore.",
      preReleasePublicationScan: "When SECURITY.md declares pre-release state, require public READMEs to say pre-release and require GitHub Release installer commands to be conditional on release publication.",
      leakScan: "Reject local absolute paths, bearer values, secret-looking tokens, runtime ids, raw prompts, and private payload markers in the report."
    },
    policy: {
      preReleasePolicyActive,
      publicDocumentPaths: DOCS
    },
    docs: rows,
    summary: {
      documentCount: rows.length,
      failingDocumentCount: failingRows.length,
      policySelfTest: true,
      missingRequiredTermCount: rows.reduce((count?: any, row?: any) : any => count + row.missingRequiredTerms.length, 0),
      internalReferenceMatchCount: rows.reduce((count?: any, row?: any) : any => count + row.internalReferenceMatches.length, 0),
      staleMatchCount: rows.reduce((count?: any, row?: any) : any => count + row.staleMatches.length, 0),
      policyMatchCount: rows.reduce((count?: any, row?: any) : any => count + row.policyMatches.length, 0),
      failingDocuments: failingRows.map((row?: any) : any => ({
        path: row.path,
        missingRequiredTerms: row.missingRequiredTerms,
        internalReferenceMatches: row.internalReferenceMatches,
        staleMatches: row.staleMatches,
        policyMatches: row.policyMatches
      })),
      releaseReady: failingRows.length === 0,
      reportLeakScan: true
    }
  };

  assertNoReportLeak(report);
  await fs.mkdir(repoPath(path.dirname(REPORT_PATH)), { recursive: true });
  await fs.writeFile(repoPath(REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (failingRows.length > 0) {
    console.error(`[core-platform-documentation-convergence] report=${REPORT_PATH}`);
    for (const row of failingRows) {
      console.error(`- ${row.path}: terms=${row.missingRequiredTerms.join(",")} internal=${row.internalReferenceMatches.join(",")} stale=${row.staleMatches.join(",")} policy=${row.policyMatches.join(",")}`);
    }
    process.exit(1);
  }

  console.log(`[core-platform-documentation-convergence] documents=${rows.length} releaseReady=true report=${REPORT_PATH}`);
}

await main();

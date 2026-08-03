import { createHash } from "node:crypto";
import { RELEASE_JOURNEY_VISUAL_CHECKPOINT_IDS } from "./release-journey-visual-contract.ts";

export const UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_RECEIPT_SCHEMA: any =
  "v0.0.1:report:upstream-service-publishing-candidate-1";

export const UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_REPORT_PATH: any =
  "build/reports/upstream-service-publishing-candidate.json";

const CORE_REPORT_PATH: any = "build/reports/upstream-service-publishing.json";
const JOURNEY_REPORT_PATH: any = "build/reports/release-journey.json";
const HTML_REPORT_PATH: any = "build/reports/upstream-service-publishing.html";
const BASIC_CONFIG_PATH: any =
  "build/reports/upstream-service-publishing/upstream-service-basic-config.json";
const SCREENSHOT_ROOT: any =
  "build/reports/upstream-service-publishing/screenshots/";
export const UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_ARTIFACT_PATHS: any =
  Object.freeze([
    CORE_REPORT_PATH,
    JOURNEY_REPORT_PATH,
    BASIC_CONFIG_PATH,
    HTML_REPORT_PATH,
    ...RELEASE_JOURNEY_VISUAL_CHECKPOINT_IDS.map((id?: any) : any => `${SCREENSHOT_ROOT}${id}.png`)
  ].sort());
const SHA_PATTERN: any = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const DIGEST_PATTERN: any = /^sha256:[a-f0-9]{64}$/u;
const RAW_SECRET_ASSIGNMENT_PATTERN: any =
  /\b(?:access[_-]?token|api[_-]?key|authorization|password|secret|token)\s*[=:]\s*(?!\[redacted(?:-secret)?\])\S+/iu;
const PRIVACY_UNSAFE_PATTERNS: readonly any[] = Object.freeze([
  /(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/root\/|\/(?:tmp|var\/tmp)\/)[^\s"'`]*/u,
  /(?:^|[^A-Za-z0-9_])[A-Za-z]:\\{1,2}(?:Users|ProgramData|Program Files|Windows|Temp|tmp)\\[^\s"'`]*/u,
  /\bhttps?:\/\/[^\s/"'@]+:[^\s/"'@]+@/iu,
  /\bhttps?:\/\/[^\s"']+[?&](?:access[_-]?token|api[_-]?key|authorization|password|secret|token)=[^&#\s"']+/iu,
  /Bearer\s+(?!\[redacted\])\S+/iu,
  /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]{8,}\b/u,
  /-----BEGIN|-----END/u
]);

function fail(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  throw error;
}

export function candidateSourceLookupFailure(args: any[] = []) : Error & Record<string, any> {
  const tagLookup: any = args[0] === "rev-parse" &&
    /^refs\/tags\/[^\s]+\^\{commit\}$/u.test(String(args[1] || ""));
  const error: Error & Record<string, any> = new Error(
    tagLookup
      ? "The release candidate tag is unavailable."
      : "The release candidate source identity is unavailable."
  );
  error.code = tagLookup
    ? "upstream_service_publishing_candidate_tag_unavailable"
    : "upstream_service_publishing_candidate_source_unavailable";
  return error;
}

function sha256(bytes?: any) : any {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function asBuffer(value?: any) : any {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return null;
}

function parseJsonArtifact(artifacts?: any, artifactPath?: any) : any {
  const bytes: any = asBuffer(artifacts.get(artifactPath));
  if (!bytes) {
    fail(
      "upstream_service_publishing_candidate_artifact_mismatch",
      "A required candidate artifact is missing."
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(
      "upstream_service_publishing_candidate_artifact_mismatch",
      "A required candidate artifact is not valid JSON."
    );
  }
}

function assertPrivacySafe(artifacts?: any) : any {
  for (const [artifactPath, value] of artifacts) {
    if (artifactPath.endsWith(".png")) continue;
    const bytes: any = asBuffer(value);
    const text: any = bytes?.toString("utf8") || "";
    if (
      PRIVACY_UNSAFE_PATTERNS.some((pattern?: any) : any => pattern.test(text))
      || RAW_SECRET_ASSIGNMENT_PATTERN.test(text)
    ) {
      fail(
        "upstream_service_publishing_candidate_privacy_unsafe",
        "A candidate artifact failed the privacy scan."
      );
    }
  }
}

function freezeReceipt(receipt?: any) : any {
  Object.freeze(receipt.release);
  Object.freeze(receipt.source);
  for (const artifact of receipt.artifacts) Object.freeze(artifact);
  Object.freeze(receipt.artifacts);
  return Object.freeze(receipt);
}

export function createUpstreamServicePublishingCandidateReceipt({
  releaseDefinitionText,
  expectedTag,
  source,
  artifacts,
  generatedAt = new Date().toISOString()
}: Record<string, any> = {}) : any {
  if (
    typeof releaseDefinitionText !== "string"
    || !(artifacts instanceof Map)
    || !source
    || typeof source !== "object"
  ) {
    fail(
      "upstream_service_publishing_candidate_input_invalid",
      "The candidate receipt input is incomplete."
    );
  }

  let releaseDefinition: any;
  try {
    releaseDefinition = JSON.parse(releaseDefinitionText);
  } catch {
    fail(
      "upstream_service_publishing_candidate_definition_invalid",
      "The release definition is not valid JSON."
    );
  }
  const releaseVersion: any = String(releaseDefinition?.release?.version || "");
  const releaseTag: any = String(releaseDefinition?.release?.tag || "");
  const definitionVersion: any = String(releaseDefinition?.version || "");
  const definitionSha256: any = sha256(Buffer.from(releaseDefinitionText, "utf8"));
  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u
      .test(releaseVersion)
    || releaseTag !== `v${releaseVersion}`
    || !definitionVersion
    || expectedTag !== releaseTag
    || (
      releaseDefinition.prepublication !== undefined
      && (
        releaseDefinition.prepublication?.requiredClaim !==
          "upstream-publishing-prepublication-passed"
        || releaseDefinition.prepublication?.candidateReceipt !==
          UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_REPORT_PATH
        || JSON.stringify(
          [...(releaseDefinition.prepublication?.artifacts || [])].sort()
        ) !== JSON.stringify(UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_ARTIFACT_PATHS)
      )
    )
  ) {
    fail(
      "upstream_service_publishing_candidate_definition_invalid",
      "The release definition does not identify the expected tag."
    );
  }
  const sourceCommit: any = String(source.commit || "");
  const sourceTree: any = String(source.tree || "");
  const expectedCoreSourceRevision: any = source.coreSourceRevision === undefined
    ? sourceCommit
    : String(source.coreSourceRevision || "");
  if (
    source.worktreeClean !== true
    || !SHA_PATTERN.test(sourceCommit)
    || !SHA_PATTERN.test(sourceTree)
    || String(source.tagCommit || "") !== sourceCommit
    || (
      source.coreSourceRevision !== undefined
      && !DIGEST_PATTERN.test(expectedCoreSourceRevision)
    )
  ) {
    fail(
      "upstream_service_publishing_candidate_not_immutable",
      "The candidate source is not an immutable clean tagged tree."
    );
  }

  const journeyReport: any = parseJsonArtifact(artifacts, JOURNEY_REPORT_PATH);
  const coreReport: any = parseJsonArtifact(artifacts, CORE_REPORT_PATH);
  const expectedScreenshotPaths: any = RELEASE_JOURNEY_VISUAL_CHECKPOINT_IDS.map(
    (id?: any) : any => `${SCREENSHOT_ROOT}${id}.png`
  );
  const expectedPaths: any = UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_ARTIFACT_PATHS;
  const actualPaths: any = [...artifacts.keys()].map(String).sort();
  if (
    JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)
    || actualPaths.some((artifactPath?: any) : any => asBuffer(artifacts.get(artifactPath)) === null)
  ) {
    fail(
      "upstream_service_publishing_candidate_artifact_mismatch",
      "The candidate artifact set is incomplete or contains unexpected files."
    );
  }

  if (
    journeyReport?.schemaVersion !== "v0.0.1:report:release-journey-1"
    || journeyReport?.verifier !== "verify:release-journey"
    || journeyReport?.releaseReady !== true
    || journeyReport?.failure !== null && journeyReport?.failure !== undefined
    || journeyReport?.cleanup?.performed !== true
    || !Array.isArray(journeyReport?.visualEvidence)
    || journeyReport.visualEvidence.length !== RELEASE_JOURNEY_VISUAL_CHECKPOINT_IDS.length
    || journeyReport?.candidate?.releaseTag !== releaseTag
    || journeyReport?.candidate?.sourceCommit !== sourceCommit
    || journeyReport?.candidate?.sourceTree !== sourceTree
    || journeyReport?.candidate?.releaseDefinitionSha256 !== definitionSha256
  ) {
    fail(
      "upstream_service_publishing_candidate_stale",
      "The release journey is not bound to this immutable candidate."
    );
  }

  for (const [index, id] of RELEASE_JOURNEY_VISUAL_CHECKPOINT_IDS.entries()) {
    const evidence: any = journeyReport.visualEvidence[index];
    const artifactPath: any = expectedScreenshotPaths[index];
    const bytes: any = asBuffer(artifacts.get(artifactPath));
    if (
      evidence?.id !== id
      || evidence?.file !== artifactPath
      || !Number.isSafeInteger(evidence?.byteLength)
      || evidence.byteLength !== bytes?.byteLength
      || !/^[a-f0-9]{64}$/u.test(String(evidence?.sha256 || ""))
      || `sha256:${evidence.sha256}` !== sha256(bytes)
    ) {
      fail(
        "upstream_service_publishing_candidate_artifact_mismatch",
        "A visual evidence binding does not match its candidate artifact."
      );
    }
  }

  if (
    coreReport?.schemaVersion !==
      "v0.0.1:upstream-service-publishing:server-report-3"
    || coreReport?.verifier !==
      "tools/server-scripts/verify-upstream-service-publishing.ts"
    || coreReport?.summary?.verificationPassed !== true
    || coreReport?.summary?.failedCount !== 0
    || coreReport?.summary?.reportLeakScan !== true
    || coreReport?.sourceRevision !== expectedCoreSourceRevision
  ) {
    fail(
      "upstream_service_publishing_candidate_artifact_mismatch",
      "The Core upstream publishing report is not verified for this candidate."
    );
  }

  assertPrivacySafe(artifacts);

  const artifactBindings: any = expectedPaths.map((artifactPath?: any) : any => {
    const bytes: any = asBuffer(artifacts.get(artifactPath));
    return {
      path: artifactPath,
      bytes: bytes.byteLength,
      sha256: sha256(bytes)
    };
  });
  const receiptPayload: Record<string, any> = {
    schemaVersion: UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_RECEIPT_SCHEMA,
    claim: "upstream-publishing-prepublication-passed",
    generatedAt: String(generatedAt || ""),
    release: {
      version: releaseVersion,
      tag: releaseTag,
      definitionVersion,
      definitionSha256
    },
    source: {
      commit: sourceCommit,
      tree: sourceTree
    },
    artifacts: artifactBindings
  };
  const receipt: Record<string, any> = {
    ...receiptPayload,
    receiptSha256: sha256(Buffer.from(JSON.stringify(receiptPayload), "utf8"))
  };
  if (
    !Number.isFinite(Date.parse(receipt.generatedAt))
    || !DIGEST_PATTERN.test(receipt.receiptSha256)
  ) {
    fail(
      "upstream_service_publishing_candidate_input_invalid",
      "The candidate receipt timestamp is invalid."
    );
  }
  return freezeReceipt(receipt);
}

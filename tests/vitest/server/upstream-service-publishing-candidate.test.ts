import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_RECEIPT_SCHEMA,
  createUpstreamServicePublishingCandidateReceipt
} from "../../../tools/server-scripts/lib/upstream-service-publishing-candidate-receipt.ts";

const SOURCE_COMMIT: any = "a".repeat(40);
const SOURCE_TREE: any = "b".repeat(40);
const RELEASE_TAG: any = "v0.0.1";
const SCREENSHOT_IDS: readonly any[] = Object.freeze([
  "console-authenticated",
  "console-upstream-basic-config",
  "console-upstream-operation-config",
  "console-upstream-published",
  "console-published-tool",
  "console-token-authorization-pending",
  "console-token-authorization-consumed",
  "console-operation-approval-pending",
  "console-operation-approval-completed",
  "console-downstream-mcp-call"
]);
const CORE_REPORT_PATH: any = "build/reports/upstream-service-publishing.json";
const JOURNEY_REPORT_PATH: any = "build/reports/release-journey.json";
const HTML_REPORT_PATH: any = "build/reports/upstream-service-publishing.html";
const BASIC_CONFIG_PATH: any =
  "build/reports/upstream-service-publishing/upstream-service-basic-config.json";

function sha256(bytes?: any) : any {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifact(path?: any, bytes?: any) : any {
  return [path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)];
}

function candidateFixture() : any {
  const releaseDefinitionText: any = `${JSON.stringify({
    version: "v0.0.1:registry:release-definition-1",
    product: "Meshrix",
    release: { version: "0.0.1", tag: RELEASE_TAG, channel: "stable" },
    acceptance: {
      profile: "enterprise-single-node",
      commandId: "platform-acceptance",
      requiredClaim: "functional-complete"
    }
  }, null, 2)}\n`;
  const releaseDefinitionSha256: any = sha256(releaseDefinitionText);
  const screenshotArtifacts: any = SCREENSHOT_IDS.map((id?: any, index?: any) : any =>
    artifact(
      `build/reports/upstream-service-publishing/screenshots/${id}.png`,
      Buffer.from(`synthetic-png-${index}`)
    )
  );
  const journeyReport: Record<string, any> = {
    schemaVersion: "v0.0.1:report:release-journey-1",
    verifier: "verify:release-journey",
    startedAt: "2026-07-29T00:00:00.000Z",
    finishedAt: "2026-07-29T00:04:00.000Z",
    generatedAt: "2026-07-29T00:04:00.000Z",
    releaseReady: true,
    candidate: {
      releaseTag: RELEASE_TAG,
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
      releaseDefinitionSha256
    },
    cleanup: {
      performed: true,
      durationMs: 1_200,
      details: [{ id: "compose-down", status: "passed", durationMs: 800 }]
    },
    visualEvidence: screenshotArtifacts.map(([path, bytes]: any[], index?: any) : any => ({
      id: SCREENSHOT_IDS[index],
      file: path,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes).slice("sha256:".length)
    }))
  };
  const coreReport: Record<string, any> = {
    schemaVersion: "v0.0.1:upstream-service-publishing:server-report-3",
    verifier: "tools/server-scripts/verify-upstream-service-publishing.ts",
    sourceRevision: SOURCE_COMMIT,
    summary: {
      verificationPassed: true,
      failedCount: 0,
      reportLeakScan: true
    }
  };
  const artifacts: any = new Map<any, any>([
    artifact(CORE_REPORT_PATH, `${JSON.stringify(coreReport, null, 2)}\n`),
    artifact(JOURNEY_REPORT_PATH, `${JSON.stringify(journeyReport, null, 2)}\n`),
    artifact(
      BASIC_CONFIG_PATH,
      `${JSON.stringify({ descriptor: { id: "synthetic-upstream-service" } }, null, 2)}\n`
    ),
    artifact(
      HTML_REPORT_PATH,
      "<!doctype html><html><body data-report-authority=\"scoped-candidate\">verified</body></html>\n"
    ),
    ...screenshotArtifacts
  ]);

  return {
    releaseDefinitionText,
    expectedTag: RELEASE_TAG,
    source: {
      commit: SOURCE_COMMIT,
      tree: SOURCE_TREE,
      tagCommit: SOURCE_COMMIT,
      worktreeClean: true
    },
    artifacts,
    generatedAt: "2026-07-29T00:04:01.000Z"
  };
}

function expectCandidateFailure(input?: any, expectedCode?: any) : any {
  let caught: any;
  try {
    createUpstreamServicePublishingCandidateReceipt(input);
  } catch (error: any) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught?.code).toBe(expectedCode);
}

describe("upstream service publishing candidate receipt", () : any => {
  it("binds one immutable release candidate to every complete report artifact", () : any => {
    const input: any = candidateFixture();
    const receipt: any = createUpstreamServicePublishingCandidateReceipt(input);
    const expectedPaths: any = [...input.artifacts.keys()].sort();

    expect(receipt).toMatchObject({
      schemaVersion: UPSTREAM_SERVICE_PUBLISHING_CANDIDATE_RECEIPT_SCHEMA,
      claim: "upstream-publishing-prepublication-passed",
      release: {
        version: "0.0.1",
        tag: RELEASE_TAG,
        definitionVersion: "v0.0.1:registry:release-definition-1",
        definitionSha256: sha256(input.releaseDefinitionText)
      },
      source: {
        commit: SOURCE_COMMIT,
        tree: SOURCE_TREE
      }
    });
    expect(receipt.artifacts.map((entry?: any) : any => entry.path)).toEqual(expectedPaths);
    expect(receipt.artifacts).toHaveLength(14);
    for (const binding of receipt.artifacts) {
      const bytes: any = input.artifacts.get(binding.path);
      expect(binding).toEqual({
        path: binding.path,
        bytes: bytes.byteLength,
        sha256: sha256(bytes)
      });
    }
    expect(receipt.receiptSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.artifacts)).toBe(true);
    expect(Object.isFrozen(receipt.artifacts[0])).toBe(true);

    const serialized: any = JSON.stringify(receipt);
    expect(serialized).not.toContain("functional-complete");
    expect(serialized).not.toContain("releaseReady");
    expect(serialized).not.toContain("Meshrix-Services");
    expect(serialized).not.toContain("Meshrix-Plugins");
  });

  it("rejects one changed artifact byte instead of blessing a mismatched bundle", () : any => {
    const input: any = candidateFixture();
    const screenshotPath: any =
      "build/reports/upstream-service-publishing/screenshots/console-authenticated.png";
    input.artifacts.set(screenshotPath, Buffer.from("changed-after-journey"));

    expectCandidateFailure(
      input,
      "upstream_service_publishing_candidate_artifact_mismatch"
    );
  });

  it("rejects cached journey evidence bound to an older source candidate", () : any => {
    const input: any = candidateFixture();
    const journey: any = JSON.parse(input.artifacts.get(JOURNEY_REPORT_PATH).toString("utf8"));
    journey.candidate.sourceCommit = "c".repeat(40);
    input.artifacts.set(
      JOURNEY_REPORT_PATH,
      Buffer.from(`${JSON.stringify(journey, null, 2)}\n`)
    );

    expectCandidateFailure(
      input,
      "upstream_service_publishing_candidate_stale"
    );
  });

  it("rejects a dirty source or a tag that resolves to another commit", () : any => {
    const dirty: any = candidateFixture();
    dirty.source.worktreeClean = false;
    expectCandidateFailure(
      dirty,
      "upstream_service_publishing_candidate_not_immutable"
    );

    const movedTag: any = candidateFixture();
    movedTag.source.tagCommit = "d".repeat(40);
    expectCandidateFailure(
      movedTag,
      "upstream_service_publishing_candidate_not_immutable"
    );
  });

  it("rejects privacy-unsafe report bytes without redisclosing them", () : any => {
    const input: any = candidateFixture();
    const privateValue: any = ["/", "Users", "private", "runtime", "report"].join("/");
    input.artifacts.set(
      HTML_REPORT_PATH,
      Buffer.from(`<html><body>token=synthetic-secret-value ${privateValue}</body></html>`)
    );

    expectCandidateFailure(
      input,
      "upstream_service_publishing_candidate_privacy_unsafe"
    );
  });
});

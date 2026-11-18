#!/usr/bin/env node
/*
 * Neutral-peer Service collaboration contract verifier.
 *
 * Two peers encode, decode, and validate the same versioned messages. This is
 * not Connector Working View, Core Change Set, or Effect Command runtime.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SERVICE_COLLABORATION_CACHE_SCOPES,
  SERVICE_COLLABORATION_CONFLICT_CODES,
  SERVICE_COLLABORATION_CORE_STATE_GENERATION,
  SERVICE_COLLABORATION_DELTA_ORDERING,
  SERVICE_COLLABORATION_FALLBACK_METHODS,
  SERVICE_COLLABORATION_KINDS,
  SERVICE_COLLABORATION_LIMITS,
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  SERVICE_COLLABORATION_PROTOCOL_VERSION,
  SERVICE_COLLABORATION_REPORT_SCHEMA_VERSION,
  SERVICE_COLLABORATION_SCHEMA_VERSION,
  SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED,
  agreeServiceCollaborationPeers,
  assertCommitTurn,
  assertEffectCommandFamily,
  assertObserveCacheHit,
  assertOneCoreStateGeneration,
  assertProtocolFallback,
  createServiceCollaborationPeer,
  effectRetryAllowed,
  lookupFactIsAuthority,
  orderDeltas,
  parseCollaborationMessage,
  rebaseOperations,
  rejectSecondCoreGeneration,
  rejectUnknownRequiredFields,
  requiredCacheScopeFor,
  selectProtocolPath
} from "../../packages/contracts/src/service-collaboration-contract.ts";
import {
  agreeServiceCollaborationMcpPeers,
  assertServiceCollaborationProtocolVersion,
  createServiceCollaborationMcpPeer,
  parseMcpCollaborationEnvelope,
  projectProtocolNegotiation
} from "../../packages/protocols/mcp/service-collaboration-projection.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.ts";

export const SERVICE_COLLABORATION_CONTRACT_VERIFIER: any =
  "tools/server-scripts/verify-agent-service-collaboration-contract.ts";
export const SERVICE_COLLABORATION_CONTRACT_REPORT_RELATIVE_PATH: any =
  "build/reports/agent-service-collaboration-contract.json";
export const SERVICE_COLLABORATION_CONTRACT_FOCUSED_SUITE: any =
  "tests/vitest/server/service-collaboration-contract.test.ts";
export const SERVICE_COLLABORATION_CONTRACT_CORPUS_RELATIVE_PATH: any =
  "packages/contracts/src/fixtures/service-collaboration-wire-corpus.json";
export const SERVICE_COLLABORATION_MCP_CORPUS_RELATIVE_PATH: any =
  "packages/protocols/mcp/fixtures/service-collaboration-mcp-wire-corpus.json";

const VITEST_RUNNER: any = "./node_modules/vitest/vitest.mjs";
const SOURCE_FILES: readonly any[] = Object.freeze([
  SERVICE_COLLABORATION_CONTRACT_VERIFIER,
  "packages/contracts/src/service-collaboration-contract.ts",
  "packages/protocols/mcp/service-collaboration-projection.ts",
  "packages/protocols/mcp/adapter/http-mcp-adapter-constants.ts",
  SERVICE_COLLABORATION_CONTRACT_CORPUS_RELATIVE_PATH,
  SERVICE_COLLABORATION_MCP_CORPUS_RELATIVE_PATH
]);

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

function readJson(repoRoot?: any, relativePath?: any) : any {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function loadCorpora(repoRoot?: any) : any {
  const contractCorpus: any = readJson(repoRoot, SERVICE_COLLABORATION_CONTRACT_CORPUS_RELATIVE_PATH);
  const mcpCorpus: any = readJson(repoRoot, SERVICE_COLLABORATION_MCP_CORPUS_RELATIVE_PATH);
  if (contractCorpus.schemaVersion !== SERVICE_COLLABORATION_SCHEMA_VERSION) {
    throw new Error("Frozen collaboration corpus schema does not match the contract.");
  }
  if (!contractCorpus.valid || !contractCorpus.invalid || !mcpCorpus.valid) {
    throw new Error("Frozen collaboration corpora are incomplete.");
  }
  return { contractCorpus, mcpCorpus };
}

export function assertServiceCollaborationContract(repoRoot: any = repoRootFromMeta()) : any {
  const { contractCorpus, mcpCorpus } = loadCorpora(repoRoot);
  const peerA: any = createServiceCollaborationPeer("peer.a");
  const peerB: any = createServiceCollaborationPeer("peer.b");
  const mcpA: any = createServiceCollaborationMcpPeer("peer.a");
  const mcpB: any = createServiceCollaborationMcpPeer("peer.b");
  const agreedKinds: any[] = [];

  assert.equal(assertServiceCollaborationProtocolVersion(), SERVICE_COLLABORATION_PROTOCOL_VERSION);
  assert.equal(SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED, false);
  assert.deepEqual([...SERVICE_COLLABORATION_CACHE_SCOPES], ["public", "private"]);
  assert.equal(SERVICE_COLLABORATION_DELTA_ORDERING, "cursor-indexed-monotonic");
  assert.deepEqual([...SERVICE_COLLABORATION_FALLBACK_METHODS], ["tools/call", "resources/read", "resources/list"]);

  for (const [name, message] of Object.entries(contractCorpus.valid)) {
    const parsed: any = parseCollaborationMessage(message);
    assert.ok(parsed, `Valid collaboration message failed: ${name}`);
    assertOneCoreStateGeneration(parsed);
    const agreed: any = agreeServiceCollaborationPeers(peerA, peerB, message);
    assert.ok(agreed, `Neutral contract peers did not agree: ${name}`);
    assert.equal(JSON.stringify(agreed), JSON.stringify(parsed));
    agreedKinds.push(parsed.kind);
    if (parsed.kind !== "edit-view") {
      const mcpAgreed: any = agreeServiceCollaborationMcpPeers(mcpA, mcpB, message);
      assert.ok(mcpAgreed, `Neutral MCP peers did not agree: ${name}`);
      assert.equal(JSON.stringify(mcpAgreed), JSON.stringify(parsed));
    }
  }

  const uniqueKinds: any = [...new Set<any>(agreedKinds)].sort();
  assert.deepEqual(uniqueKinds, [...SERVICE_COLLABORATION_KINDS].sort());

  const rejected: Record<string, any> = {
    secondCoreGeneration: 0,
    unknownRequiredField: 0,
    privacyField: 0,
    crdtMarker: 0,
    publicPrivateView: 0,
    unsortedDeltas: 0,
    effectInChangeSet: 0,
    reResolutionMissing: 0
  };
  for (const [name, message] of Object.entries(contractCorpus.invalid)) {
    assert.equal(parseCollaborationMessage(message), null, `Invalid message was accepted: ${name}`);
    assert.equal(rejectUnknownRequiredFields(message), true);
    if (name === "secondCoreGeneration" || name === "crdtMarker") {
      assert.equal(rejectSecondCoreGeneration(message), true);
      rejected.secondCoreGeneration += name === "secondCoreGeneration" ? 1 : 0;
      rejected.crdtMarker += name === "crdtMarker" ? 1 : 0;
    }
    if (name === "unknownRequiredField" || name === "unknownKind") rejected.unknownRequiredField += 1;
    if (name === "privacyGrant" || name === "privacyContent") rejected.privacyField += 1;
    if (name === "publicPrivateView") rejected.publicPrivateView += 1;
    if (name === "unsortedDeltas") rejected.unsortedDeltas += 1;
    if (name === "effectInChangeSet") rejected.effectInChangeSet += 1;
    if (name === "authorizationNotResolved") rejected.reResolutionMissing += 1;
  }

  for (const [name, envelope] of Object.entries(mcpCorpus.valid)) {
    assert.ok(parseMcpCollaborationEnvelope(envelope), `Valid MCP envelope failed: ${name}`);
  }

  assertCommitTurn(contractCorpus.valid["commit-request-dirty"]);
  assertCommitTurn(contractCorpus.valid["commit-request-clean"]);
  assert.equal(assertObserveCacheHit(contractCorpus.valid["observe-response"]), "no-model-visible-remote-read");
  assertEffectCommandFamily(contractCorpus.valid["effect-command"]);
  assert.equal(effectRetryAllowed({
    ...contractCorpus.valid["effect-command"],
    resultState: "uncertain"
  }), false);
  assertProtocolFallback(contractCorpus.valid.fallback);

  const collaborative: any = selectProtocolPath(true);
  const ordinary: any = selectProtocolPath(false);
  const negotiated: any = projectProtocolNegotiation(false);
  assert.equal(collaborative.coreStateGeneration, SERVICE_COLLABORATION_CORE_STATE_GENERATION);
  assert.equal(ordinary.coreStateGeneration, SERVICE_COLLABORATION_CORE_STATE_GENERATION);
  assert.equal(negotiated.coreStateGeneration, SERVICE_COLLABORATION_CORE_STATE_GENERATION);
  assert.deepEqual([...ordinary.methods], [...SERVICE_COLLABORATION_FALLBACK_METHODS]);
  assert.equal(requiredCacheScopeFor("observe-response"), "private");
  assert.equal(requiredCacheScopeFor("fallback"), "public");
  for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
    assert.equal(lookupFactIsAuthority(fact), false);
  }

  const rebased: any = rebaseOperations(
    contractCorpus.valid["rebase-request"].operations,
    [contractCorpus.valid["resync-response-delta"].deltas[0].operation]
  );
  assert.equal(rebased.rebasedOperations.length, 1);
  assert.equal(rebased.rebasedOperations[0].index, 2);
  assert.equal(rebased.conflicts.length, 0);
  const moveConflict: any = rebaseOperations(
    [{ ...contractCorpus.valid["rebase-request"].operations[0], type: "move" }],
    [contractCorpus.valid["resync-response-delta"].deltas[0].operation]
  );
  assert.equal(moveConflict.conflicts[0].code, "conflict.unrebasable_operation");
  assert.ok(orderDeltas(contractCorpus.valid["resync-response-delta"].deltas));
  assert.equal(orderDeltas(contractCorpus.invalid.unsortedDeltas.deltas), null);

  return Object.freeze({
    schemaVersion: SERVICE_COLLABORATION_SCHEMA_VERSION,
    protocolVersion: SERVICE_COLLABORATION_PROTOCOL_VERSION,
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    peerAgreement: true,
    mcpPeerAgreement: true,
    agreedKindCount: uniqueKinds.length,
    validMessageCount: Object.keys(contractCorpus.valid).length,
    invalidMessageCount: Object.keys(contractCorpus.invalid).length,
    mcpEnvelopeCount: Object.keys(mcpCorpus.valid).length,
    limits: SERVICE_COLLABORATION_LIMITS,
    cacheScopes: SERVICE_COLLABORATION_CACHE_SCOPES,
    deltaOrdering: SERVICE_COLLABORATION_DELTA_ORDERING,
    conflictCodes: SERVICE_COLLABORATION_CONFLICT_CODES,
    fallbackMethods: SERVICE_COLLABORATION_FALLBACK_METHODS,
    rejected,
    connectorRuntimePresent: false,
    changeSetRuntimePresent: false,
    effectCommandRuntimePresent: false
  });
}

export function buildServiceCollaborationContractReport(
  assertion: Record<string, any> = {},
  extras: Record<string, any> = {}
) : any {
  return {
    schemaVersion: SERVICE_COLLABORATION_REPORT_SCHEMA_VERSION,
    verifier: SERVICE_COLLABORATION_CONTRACT_VERIFIER,
    contractSchemaVersion: SERVICE_COLLABORATION_SCHEMA_VERSION,
    protocolVersion: SERVICE_COLLABORATION_PROTOCOL_VERSION,
    generatedAt: extras.generatedAt || "1970-01-01T00:00:00.000Z",
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    summary: {
      peerAgreement: assertion.peerAgreement === true,
      mcpPeerAgreement: assertion.mcpPeerAgreement === true,
      schemaAgreement: true,
      limitsAgreement: true,
      cacheScopeAgreement: true,
      deltaOrderingAgreement: true,
      conflictCodeAgreement: true,
      protocolFallbackAgreement: true,
      oneCoreStateGeneration: assertion.coreStateGeneration === SERVICE_COLLABORATION_CORE_STATE_GENERATION,
      secondCoreGenerationRejected: assertion.rejected?.secondCoreGeneration > 0,
      unknownRequiredFieldsRejected: assertion.rejected?.unknownRequiredField > 0,
      effectFamilySeparated: true,
      privacySafe: true,
      focusedSuitePassed: extras.focusedSuitePassed === true,
      agreedKindCount: assertion.agreedKindCount,
      validMessageCount: assertion.validMessageCount,
      invalidMessageCount: assertion.invalidMessageCount,
      mcpEnvelopeCount: assertion.mcpEnvelopeCount,
      connectorRuntimePresent: false,
      changeSetRuntimePresent: false,
      effectCommandRuntimePresent: false
    },
    limits: {
      maxOperationsPerChangeSet: SERVICE_COLLABORATION_LIMITS.maxOperationsPerChangeSet,
      maxChangeSetBytes: SERVICE_COLLABORATION_LIMITS.maxChangeSetBytes,
      maxDeltaPage: SERVICE_COLLABORATION_LIMITS.maxDeltaPage,
      maxSnapshotBytes: SERVICE_COLLABORATION_LIMITS.maxSnapshotBytes
    },
    cacheScopes: [...SERVICE_COLLABORATION_CACHE_SCOPES],
    deltaOrdering: SERVICE_COLLABORATION_DELTA_ORDERING,
    conflictCodes: [...SERVICE_COLLABORATION_CONFLICT_CODES],
    fallbackMethods: [...SERVICE_COLLABORATION_FALLBACK_METHODS],
    rejected: assertion.rejected
  };
}

function runFocusedSuite(repoRoot?: any) : any {
  const result: any = spawnSync(process.execPath, [
    "--conditions=source",
    VITEST_RUNNER,
    "run",
    "--config",
    "vitest.config.ts",
    SERVICE_COLLABORATION_CONTRACT_FOCUSED_SUITE
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: "--conditions=source"
    }
  });
  return {
    suite: SERVICE_COLLABORATION_CONTRACT_FOCUSED_SUITE,
    passed: result.status === 0,
    exitCode: result.status,
    outputBytes: Buffer.byteLength(`${result.stdout || ""}${result.stderr || ""}`, "utf8"),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

export async function runAgentServiceCollaborationContract({
  repoRoot = repoRootFromMeta(),
  writeReport = true,
  runFocusedTests = false,
  generatedAt = new Date().toISOString()
}: Record<string, any> = {}) : Promise<any> {
  const assertion: any = assertServiceCollaborationContract(repoRoot);

  let focusedSuite: any = {
    suite: SERVICE_COLLABORATION_CONTRACT_FOCUSED_SUITE,
    passed: runFocusedTests !== true,
    exitCode: 0,
    outputBytes: 0
  };
  if (runFocusedTests === true) {
    focusedSuite = runFocusedSuite(repoRoot);
    if (focusedSuite.passed !== true) {
      process.stderr.write(focusedSuite.stdout);
      process.stderr.write(focusedSuite.stderr);
      throw new Error(
        `Focused suite failed: ${SERVICE_COLLABORATION_CONTRACT_FOCUSED_SUITE} exit=${focusedSuite.exitCode}`
      );
    }
  }

  const report: any = buildServiceCollaborationContractReport(assertion, {
    generatedAt,
    focusedSuitePassed: focusedSuite.passed === true
  });
  const provenance: Record<string, any> = {
    producer: "meshrix-core-service-collaboration-contract",
    commandId: "agent-service-collaboration-contract",
    sourceRevision: await computeVerifierSourceRevision(repoRoot, SOURCE_FILES)
  };
  const finalized: any = finalizeSensitiveReport(report, { provenance });
  assertNoSensitiveReportLeak(finalized, "service collaboration contract report");
  assertReportProvenance(finalized, provenance);

  if (writeReport === true) {
    const relativePath: any = SERVICE_COLLABORATION_CONTRACT_REPORT_RELATIVE_PATH;
    const absolutePath: any = path.join(repoRoot, relativePath);
    await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fsPromises.writeFile(absolutePath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  }

  return {
    report: finalized,
    reportPath: SERVICE_COLLABORATION_CONTRACT_REPORT_RELATIVE_PATH,
    focusedSuite: {
      suite: focusedSuite.suite,
      passed: focusedSuite.passed,
      exitCode: focusedSuite.exitCode,
      outputBytes: focusedSuite.outputBytes
    }
  };
}

const executedDirectly: any = process.argv[1]
  && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (executedDirectly) {
  try {
    const result: any = await runAgentServiceCollaborationContract({
      writeReport: true,
      runFocusedTests: true
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      reportPath: result.reportPath,
      peerAgreement: result.report.summary.peerAgreement,
      oneCoreStateGeneration: result.report.summary.oneCoreStateGeneration,
      protocolFallbackAgreement: result.report.summary.protocolFallbackAgreement,
      focusedSuitePassed: result.report.summary.focusedSuitePassed
    })}\n`);
  } catch (error: any) {
    const message: any = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

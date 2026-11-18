import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { containsSensitiveReportData } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import {
  SERVICE_COLLABORATION_CONFLICT_CODES,
  SERVICE_COLLABORATION_CORE_STATE_GENERATION,
  SERVICE_COLLABORATION_DELTA_ORDERING,
  SERVICE_COLLABORATION_FALLBACK_METHODS,
  SERVICE_COLLABORATION_KINDS,
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  SERVICE_COLLABORATION_PROTOCOL_VERSION,
  SERVICE_COLLABORATION_SCHEMA_VERSION,
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
} from "../../../packages/contracts/src/service-collaboration-contract.ts";
import {
  agreeServiceCollaborationMcpPeers,
  assertServiceCollaborationProtocolVersion,
  createServiceCollaborationMcpPeer,
  parseMcpCollaborationEnvelope
} from "../../../packages/protocols/mcp/service-collaboration-projection.ts";
import {
  SERVICE_COLLABORATION_CONTRACT_REPORT_RELATIVE_PATH,
  SERVICE_COLLABORATION_CONTRACT_VERIFIER,
  assertServiceCollaborationContract,
  buildServiceCollaborationContractReport
} from "../../../tools/server-scripts/verify-agent-service-collaboration-contract.ts";

const PROJECT_ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ABSOLUTE_PATH_PATTERN: any = /(?:\/(?:Users|home|private|var\/folders|root)\/|[A-Za-z]:\\)/u;
const corpus: any = JSON.parse(fs.readFileSync(
  path.join(PROJECT_ROOT, "packages/contracts/src/fixtures/service-collaboration-wire-corpus.json"),
  "utf8"
));
const mcpCorpus: any = JSON.parse(fs.readFileSync(
  path.join(PROJECT_ROOT, "packages/protocols/mcp/fixtures/service-collaboration-mcp-wire-corpus.json"),
  "utf8"
));

describe("agent-service collaboration contract", () : any => {
  it("freezes versioned schemas, limits, cache scope, delta ordering, and conflict codes", () : any => {
    expect(SERVICE_COLLABORATION_SCHEMA_VERSION).toBe("v0.0.1:service-collaboration:wire-1");
    expect(SERVICE_COLLABORATION_PROTOCOL_VERSION).toBe("2026-07-28");
    expect(assertServiceCollaborationProtocolVersion()).toBe("2026-07-28");
    expect(SERVICE_COLLABORATION_CORE_STATE_GENERATION).toBe("meshrix-core-state-1");
    expect(SERVICE_COLLABORATION_DELTA_ORDERING).toBe("cursor-indexed-monotonic");
    expect([...SERVICE_COLLABORATION_FALLBACK_METHODS]).toEqual([
      "tools/call",
      "resources/read",
      "resources/list"
    ]);
    expect(SERVICE_COLLABORATION_CONFLICT_CODES).toContain("conflict.second_core_generation");
    expect(requiredCacheScopeFor("observe-response")).toBe("private");
    expect(requiredCacheScopeFor("fallback")).toBe("public");
    for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
      expect(lookupFactIsAuthority(fact)).toBe(false);
    }
  });

  it("lets two neutral peers agree on every frozen valid message", () : any => {
    const peerA: any = createServiceCollaborationPeer("peer.a");
    const peerB: any = createServiceCollaborationPeer("peer.b");
    const kinds: any[] = [];
    for (const [name, message] of Object.entries(corpus.valid)) {
      const parsed: any = parseCollaborationMessage(message);
      expect(parsed, name).toBeTruthy();
      expect(agreeServiceCollaborationPeers(peerA, peerB, message)).toEqual(parsed);
      kinds.push(parsed.kind);
    }
    expect([...new Set<any>(kinds)].sort()).toEqual([...SERVICE_COLLABORATION_KINDS].sort());
  });

  it("lets two neutral MCP peers project the same envelopes and keep ordinary fallback", () : any => {
    const peerA: any = createServiceCollaborationMcpPeer("peer.a");
    const peerB: any = createServiceCollaborationMcpPeer("peer.b");
    for (const [name, envelope] of Object.entries(mcpCorpus.valid)) {
      expect(parseMcpCollaborationEnvelope(envelope), name).toBeTruthy();
    }
    expect(agreeServiceCollaborationMcpPeers(peerA, peerB, corpus.valid["open-request"]))
      .toEqual(parseCollaborationMessage(corpus.valid["open-request"]));
    expect(agreeServiceCollaborationMcpPeers(peerA, peerB, corpus.valid["resource-updated"]))
      .toEqual(parseCollaborationMessage(corpus.valid["resource-updated"]));
    const ordinary: any = selectProtocolPath(false);
    expect(ordinary.profile).toBe("ordinary-mcp");
    expect(ordinary.coreStateGeneration).toBe(SERVICE_COLLABORATION_CORE_STATE_GENERATION);
    expect(assertProtocolFallback(corpus.valid.fallback)).toBe(true);
  });

  it("rejects a second Core generation, unknown required fields, and privacy or CRDT markers", () : any => {
    for (const [name, message] of Object.entries(corpus.invalid)) {
      expect(parseCollaborationMessage(message), name).toBeNull();
      expect(rejectUnknownRequiredFields(message)).toBe(true);
    }
    expect(rejectSecondCoreGeneration(corpus.invalid.secondCoreGeneration)).toBe(true);
    expect(rejectSecondCoreGeneration(corpus.invalid.crdtMarker)).toBe(true);
    expect(() : any => assertOneCoreStateGeneration(corpus.invalid.secondCoreGeneration)).toThrow(
      /one Core state generation/
    );
  });

  it("keeps Change Sets, cache hits, and Effect Commands on separate contract families", () : any => {
    expect(assertCommitTurn(corpus.valid["commit-request-dirty"])).toBe(true);
    expect(assertCommitTurn(corpus.valid["commit-request-clean"])).toBe(true);
    expect(assertObserveCacheHit(corpus.valid["observe-response"])).toBe("no-model-visible-remote-read");
    expect(assertEffectCommandFamily(corpus.valid["effect-command"])).toBe(true);
    expect(effectRetryAllowed({
      ...corpus.valid["effect-command"],
      resultState: "uncertain"
    })).toBe(false);
    expect(parseCollaborationMessage(corpus.invalid.effectInChangeSet)).toBeNull();
  });

  it("rebases only relevant indexed operations and orders cursor-indexed deltas", () : any => {
    const local: any = corpus.valid["rebase-request"].operations;
    const remote: any = [corpus.valid["resync-response-delta"].deltas[0].operation];
    const rebased: any = rebaseOperations(local, remote);
    expect(rebased.rebasedOperations).toHaveLength(1);
    expect(rebased.rebasedOperations[0].index).toBe(2);
    expect(rebased.conflicts).toEqual([]);
    expect(rebaseOperations([{ ...local[0], type: "move" }], remote).conflicts[0].code)
      .toBe("conflict.unrebasable_operation");
    expect(orderDeltas(corpus.valid["resync-response-delta"].deltas)).toHaveLength(1);
    expect(orderDeltas(corpus.invalid.unsortedDeltas.deltas)).toBeNull();
    expect(corpus.valid["resync-response-snapshot"].outcome).toBe("snapshot-tail");
    expect(corpus.valid["resync-response-snapshot"].cursor.cursorState).toBe("expired");
  });

  it("writes a privacy-safe agreement report without runtime claims", () : any => {
    const assertion: any = assertServiceCollaborationContract(PROJECT_ROOT);
    const report: any = buildServiceCollaborationContractReport(assertion, {
      generatedAt: "1970-01-01T00:00:00.000Z",
      focusedSuitePassed: true
    });
    const text: any = JSON.stringify(report);
    expect(assertion.peerAgreement).toBe(true);
    expect(assertion.coreStateGeneration).toBe(SERVICE_COLLABORATION_CORE_STATE_GENERATION);
    expect(report.verifier).toBe(SERVICE_COLLABORATION_CONTRACT_VERIFIER);
    expect(SERVICE_COLLABORATION_CONTRACT_REPORT_RELATIVE_PATH.startsWith("build/reports/")).toBe(true);
    expect(report.summary.oneCoreStateGeneration).toBe(true);
    expect(report.summary.protocolFallbackAgreement).toBe(true);
    expect(report.summary.connectorRuntimePresent).toBe(false);
    expect(containsSensitiveReportData(report)).toBe(false);
    expect(ABSOLUTE_PATH_PATTERN.test(text)).toBe(false);
  });
});

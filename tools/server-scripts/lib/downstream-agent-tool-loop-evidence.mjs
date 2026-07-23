import crypto from "node:crypto";

import {
  MCP_SUPPORTED_TARGETS
} from "../../../packages/protocols/mcp/adapter/mcp-release-targets.mjs";
import {
  UPSTREAM_FIXTURE_TOOL_PREFIX
} from "./upstream-fixture-grant.mjs";

export const DOWNSTREAM_AGENT_TOOL_LOOP_REPORT_PATH = "build/reports/downstream-agent-tool-loop.json";
export const DOWNSTREAM_AGENT_TOOL_LOOP_SCHEMA_VERSION = "v0.0.1:downstream-gateway:agent-tool-loop-report-1";
export const DOWNSTREAM_AGENT_TOOL_LOOP_VERIFIER = "tools/server-scripts/verify-downstream-agent-tool-loop.mjs";
export const DOWNSTREAM_AGENT_TOOL_LOOP_READINESS_SOURCE =
  "tools/server-scripts/lib/downstream-agent-tool-loop-evidence.mjs#createDownstreamAgentToolLoopReadiness";
export const DOWNSTREAM_AGENT_CLIENT_TARGETS = MCP_SUPPORTED_TARGETS;
export const DOWNSTREAM_AGENT_CANCELLATION_TARGET = DOWNSTREAM_AGENT_CLIENT_TARGETS.includes("codex")
  ? "codex"
  : DOWNSTREAM_AGENT_CLIENT_TARGETS[0];
export const DOWNSTREAM_AGENT_SCENARIO_ENV = "LICO_DOWNSTREAM_AGENT_SCENARIO";

const PUBLIC_TOOL = (toolName) => `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.${toolName}`;
const TURN_KINDS = Object.freeze(["initialize", "tools/list", "tools/call"]);

export const DOWNSTREAM_AGENT_CORE_TURN_IDS = Object.freeze([
  "initialize",
  "list-tools",
  "read-only-call",
  "identity-call",
  "denied-destructive-call"
]);

export function defaultDownstreamAgentScenario() {
  return [
    {
      turnId: "initialize",
      kind: "initialize"
    },
    {
      turnId: "list-tools",
      kind: "tools/list",
      expect: {
        visibleTools: [PUBLIC_TOOL("records.search"), PUBLIC_TOOL("session.identity")],
        hiddenTools: [PUBLIC_TOOL("records.purge")]
      }
    },
    {
      turnId: "read-only-call",
      kind: "tools/call",
      toolName: PUBLIC_TOOL("records.search"),
      arguments: { query: "alpha" },
      expect: { upstreamMcp: true }
    },
    {
      turnId: "identity-call",
      kind: "tools/call",
      toolName: PUBLIC_TOOL("session.identity"),
      arguments: {},
      expect: { upstreamMcp: true, credentialProof: true }
    },
    {
      turnId: "denied-destructive-call",
      kind: "tools/call",
      toolName: PUBLIC_TOOL("records.purge"),
      arguments: {},
      expect: { deniedTool: true }
    }
  ];
}

export function normalizeDownstreamAgentScenario(rawTurns) {
  if (!Array.isArray(rawTurns) || rawTurns.length === 0) {
    throw new Error("Downstream agent scenario must be a non-empty array of turns.");
  }
  const seenTurnIds = new Set();
  const turns = rawTurns.map((rawTurn, index) => {
    const turn = rawTurn && typeof rawTurn === "object" && !Array.isArray(rawTurn) ? rawTurn : {};
    const turnId = String(turn.turnId || "").trim();
    const kind = String(turn.kind || "").trim();
    if (!turnId) {
      throw new Error(`Downstream agent scenario turn ${index} is missing turnId.`);
    }
    if (seenTurnIds.has(turnId)) {
      throw new Error(`Downstream agent scenario turnId is duplicated: ${turnId}`);
    }
    seenTurnIds.add(turnId);
    if (!TURN_KINDS.includes(kind)) {
      throw new Error(`Downstream agent scenario turn ${turnId} has unsupported kind: ${kind || "(empty)"}`);
    }
    const toolName = String(turn.toolName || "").trim();
    if (kind === "tools/call" && !toolName) {
      throw new Error(`Downstream agent scenario turn ${turnId} requires toolName for tools/call.`);
    }
    const args = turn.arguments && typeof turn.arguments === "object" && !Array.isArray(turn.arguments)
      ? turn.arguments
      : {};
    const expect = turn.expect && typeof turn.expect === "object" && !Array.isArray(turn.expect)
      ? turn.expect
      : {};
    return {
      turnId,
      kind,
      ...(kind === "tools/call" ? { toolName, arguments: args } : {}),
      expect: {
        ...(Array.isArray(expect.visibleTools) ? { visibleTools: expect.visibleTools.map(String) } : {}),
        ...(Array.isArray(expect.hiddenTools) ? { hiddenTools: expect.hiddenTools.map(String) } : {}),
        ...(expect.upstreamMcp === true ? { upstreamMcp: true } : {}),
        ...(expect.credentialProof === true ? { credentialProof: true } : {}),
        ...(expect.deniedTool === true ? { deniedTool: true } : {})
      }
    };
  });
  const missingCoreTurnIds = DOWNSTREAM_AGENT_CORE_TURN_IDS.filter((turnId) => !seenTurnIds.has(turnId));
  if (missingCoreTurnIds.length > 0) {
    throw new Error(`Downstream agent scenario is missing core turns: ${missingCoreTurnIds.join(", ")}`);
  }
  return turns;
}

export function stableDownstreamAgentRefHash(value = "") {
  const raw = String(value || "").trim();
  return raw ? crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12) : "";
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function includesEvery(actual, expected) {
  const set = new Set(asStringArray(actual));
  return expected.every((item) => set.has(item));
}

export function createDownstreamAgentToolLoopReadiness(report = {}) {
  const record = asRecord(report);
  const summary = asRecord(record.summary);
  const evidence = asRecord(record.evidence);
  const scenario = asRecord(evidence.scenario);
  const secretStoreCredentialBinding = asRecord(evidence.secretStoreCredentialBinding);
  const cancellationPropagation = asRecord(evidence.cancellationPropagation);
  const targetRuns = asArray(evidence.proxyClientTargets);
  const failure = asRecord(record.failure);
  const reasons = [];

  if (record.schemaVersion !== DOWNSTREAM_AGENT_TOOL_LOOP_SCHEMA_VERSION) {
    reasons.push("downstream-agent-tool-loop-schema-mismatch");
  }
  if (record.verifier !== DOWNSTREAM_AGENT_TOOL_LOOP_VERIFIER) {
    reasons.push("downstream-agent-tool-loop-verifier-mismatch");
  }
  if (summary.reportLeakScan !== true) {
    reasons.push("downstream-agent-tool-loop-report-leak-scan-missing");
  }
  if (summary.serviceConfigured !== true) {
    reasons.push("downstream-agent-tool-loop-service-not-configured");
  }
  if (summary.selfContained !== true) {
    reasons.push("downstream-agent-tool-loop-not-self-contained");
  }
  if (Object.keys(failure).length > 0) {
    reasons.push("downstream-agent-tool-loop-runtime-failure");
  }
  if (!evidence || Object.keys(evidence).length === 0) {
    reasons.push("downstream-agent-tool-loop-evidence-missing");
  }

  if (!["embedded", "custom"].includes(String(scenario.source || ""))) {
    reasons.push("downstream-agent-tool-loop-scenario-source-invalid");
  }
  if (Number(scenario.turnCount || 0) < DOWNSTREAM_AGENT_CORE_TURN_IDS.length) {
    reasons.push("downstream-agent-tool-loop-scenario-turns-incomplete");
  }
  if (!includesEvery(scenario.turnIds, DOWNSTREAM_AGENT_CORE_TURN_IDS)) {
    reasons.push("downstream-agent-tool-loop-core-turns-missing");
  }

  if (secretStoreCredentialBinding.accepted !== true) {
    reasons.push("downstream-agent-tool-loop-secret-store-credential-binding-not-accepted");
  }
  if (Number(secretStoreCredentialBinding.serviceCredentialRefCount || 0) <= 0) {
    reasons.push("downstream-agent-tool-loop-secret-store-credential-ref-missing");
  }
  if (Number(secretStoreCredentialBinding.resolvedCredentialRefCount || 0) !==
    Number(secretStoreCredentialBinding.serviceCredentialRefCount || 0)) {
    reasons.push("downstream-agent-tool-loop-secret-store-credential-ref-not-resolved");
  }
  if (!secretStoreCredentialBinding.credentialRefHash) {
    reasons.push("downstream-agent-tool-loop-secret-store-credential-ref-hash-missing");
  }
  if (secretStoreCredentialBinding.rawSecretRedacted !== true) {
    reasons.push("downstream-agent-tool-loop-secret-store-redaction-missing");
  }

  if (cancellationPropagation.target !== DOWNSTREAM_AGENT_CANCELLATION_TARGET) {
    reasons.push("downstream-agent-tool-loop-cancellation-target-mismatch");
  }
  for (const [field, reason] of [
    ["spawnedProxyTransport", "downstream-agent-tool-loop-cancellation-proxy-missing"],
    ["downstreamMcpTransportProven", "downstream-agent-tool-loop-cancellation-downstream-mcp-missing"],
    ["operationPermissionExecutionProven", "downstream-agent-tool-loop-cancellation-operation-permission-missing"],
    ["gatewayRegistryForwardProven", "downstream-agent-tool-loop-cancellation-registry-forward-missing"],
    ["actualStdioUpstreamProven", "downstream-agent-tool-loop-cancellation-stdio-upstream-missing"],
    ["upstreamCancellationObserved", "downstream-agent-tool-loop-upstream-cancellation-not-observed"],
    ["cancelledRequestIdCorrelated", "downstream-agent-tool-loop-cancelled-request-not-correlated"],
    ["sideEffectAbsentAfterOriginalDeadline", "downstream-agent-tool-loop-cancelled-side-effect-present"],
    ["preCancellationCapacityDenied", "downstream-agent-tool-loop-pre-cancellation-capacity-not-proven"],
    ["trafficSlotReleasedWhilePeerActive", "downstream-agent-tool-loop-traffic-slot-not-released"],
    ["probeAdmittedAfterCancellation", "downstream-agent-tool-loop-post-cancellation-probe-not-admitted"],
    ["peerUnaffected", "downstream-agent-tool-loop-cancellation-affected-peer"]
  ]) {
    if (cancellationPropagation[field] !== true) reasons.push(reason);
  }
  if (Number(cancellationPropagation.cancelledRequestResponseCount ?? -1) !== 0) {
    reasons.push("downstream-agent-tool-loop-cancelled-request-produced-response");
  }
  if (Number(cancellationPropagation.trafficPolicyMaxConcurrent || 0) !== 2) {
    reasons.push("downstream-agent-tool-loop-cancellation-concurrency-policy-mismatch");
  }
  if (Number(cancellationPropagation.finalCounter ?? -1) !== 0 ||
    Number(cancellationPropagation.delayedIncrementStartedCount || 0) !== 1 ||
    Number(cancellationPropagation.delayedIncrementCompletedCount ?? -1) !== 0 ||
    Number(cancellationPropagation.delayedIncrementCancelledCount || 0) !== 1) {
    reasons.push("downstream-agent-tool-loop-cancelled-increment-evidence-invalid");
  }
  if (Number(cancellationPropagation.peerStartedCount || 0) !== 1 ||
    Number(cancellationPropagation.peerCompletedCount || 0) !== 1) {
    reasons.push("downstream-agent-tool-loop-peer-completion-evidence-invalid");
  }

  for (const target of DOWNSTREAM_AGENT_CLIENT_TARGETS) {
    const item = targetRuns.find((run) => asRecord(run).target === target) || {};
    if (item.status !== "passed") {
      reasons.push(`downstream-agent-tool-loop-target-not-passed:${target}`);
    }
    if (item.realProxyTransport !== true) {
      reasons.push(`downstream-agent-tool-loop-not-real-proxy:${target}`);
    }
    if (item.protocol !== "mcp-stdio-jsonl-json-rpc") {
      reasons.push(`downstream-agent-tool-loop-transport-mismatch:${target}`);
    }
    if (item.initialized !== true) {
      reasons.push(`downstream-agent-tool-loop-initialize-failed:${target}`);
    }
    if (item.initializedNotificationSent !== true) {
      reasons.push(`downstream-agent-tool-loop-initialized-notification-missing:${target}`);
    }
    if (Number(item.unexpectedNotificationResponses ?? -1) !== 0) {
      reasons.push(`downstream-agent-tool-loop-notification-response-invalid:${target}`);
    }
    const clientProtocolProfile = asRecord(item.clientProtocolProfile);
    if (clientProtocolProfile.target !== target || clientProtocolProfile.framing !== "jsonl") {
      reasons.push(`downstream-agent-tool-loop-client-profile-mismatch:${target}`);
    }
    if (String(clientProtocolProfile.source || "") !== "neutral-protocol-peer") {
      reasons.push(`downstream-agent-tool-loop-client-profile-source-invalid:${target}`);
    }
    if (!includesEvery(item.completedTurnIds, DOWNSTREAM_AGENT_CORE_TURN_IDS)) {
      reasons.push(`downstream-agent-tool-loop-core-turns-not-completed:${target}`);
    }
    if (Number(item.failedTurnCount ?? 1) !== 0) {
      reasons.push(`downstream-agent-tool-loop-failed-turns:${target}`);
    }
    if (item.readOnlyToolVisible !== true) {
      reasons.push(`downstream-agent-tool-loop-readonly-tool-hidden:${target}`);
    }
    if (item.identityToolVisible !== true) {
      reasons.push(`downstream-agent-tool-loop-identity-tool-hidden:${target}`);
    }
    if (item.destructiveToolHidden !== true) {
      reasons.push(`downstream-agent-tool-loop-destructive-tool-visible:${target}`);
    }
    if (item.readOnlyCallOk !== true) {
      reasons.push(`downstream-agent-tool-loop-readonly-call-not-ok:${target}`);
    }
    if (item.identityCallOk !== true) {
      reasons.push(`downstream-agent-tool-loop-identity-call-not-ok:${target}`);
    }
    if (item.deniedDestructiveRejected !== true) {
      reasons.push(`downstream-agent-tool-loop-denied-destructive-not-rejected:${target}`);
    }
    const credentialProof = asRecord(item.credentialProof);
    if (credentialProof.tokenProofMatchesIssuedCredential !== true) {
      reasons.push(`downstream-agent-tool-loop-credential-proof-missing:${target}`);
    }
    if (credentialProof.rawCredentialRedacted !== true) {
      reasons.push(`downstream-agent-tool-loop-credential-redaction-missing:${target}`);
    }
    if (item.proxyExitOk !== true) {
      reasons.push(`downstream-agent-tool-loop-proxy-exit-not-ok:${target}`);
    }
    if (target === DOWNSTREAM_AGENT_CANCELLATION_TARGET) {
      const targetCancellation = asRecord(item.cancellationPropagation);
      if (targetCancellation.target !== DOWNSTREAM_AGENT_CANCELLATION_TARGET ||
        targetCancellation.upstreamCancellationObserved !== true ||
        Number(targetCancellation.cancelledRequestResponseCount ?? -1) !== 0) {
        reasons.push(`downstream-agent-tool-loop-target-cancellation-evidence-missing:${target}`);
      }
    }
  }

  const releaseReady = reasons.length === 0;
  return {
    sourceOfTruth: DOWNSTREAM_AGENT_TOOL_LOOP_READINESS_SOURCE,
    report: DOWNSTREAM_AGENT_TOOL_LOOP_REPORT_PATH,
    releaseReady,
    liveStatus: releaseReady ? "passed" : "failed",
    reasons,
    targets: [...DOWNSTREAM_AGENT_CLIENT_TARGETS],
    coreTurnIds: [...DOWNSTREAM_AGENT_CORE_TURN_IDS]
  };
}

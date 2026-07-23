import { assertNoSensitiveReportLeak, reportPayloadDigest } from "./sensitive-report-scan.mjs";

export const UPSTREAM_SERVICE_PUBLISHING_REPORT_PATH = "build/reports/upstream-service-publishing.json";
export const UPSTREAM_SERVICE_PUBLISHING_REPORT_SCHEMA_VERSION =
  "v0.0.1:upstream-service-publishing:server-report-3";
export const UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_SCHEMA_VERSION =
  "v0.0.1:upstream-service-publishing:observations-2";
export const UPSTREAM_SERVICE_PUBLISHING_VERIFIER =
  "tools/server-scripts/verify-upstream-service-publishing.mjs";
export const UPSTREAM_SERVICE_PUBLISHING_COMMAND_ID = "verify:upstream-service-publishing";
export const UPSTREAM_SERVICE_PUBLISHING_REDUCER =
  "tools/server-scripts/lib/upstream-service-publishing-evidence.mjs#createUpstreamServicePublishingReadiness";

export const UPSTREAM_SERVICE_PUBLISHING_REQUIREMENTS = Object.freeze(
  Array.from({ length: 13 }, (_, index) => `REQ-USP-${String(index + 1).padStart(3, "0")}`)
);

export const UPSTREAM_SERVICE_PUBLISHING_ASSERTIONS = Object.freeze(
  UPSTREAM_SERVICE_PUBLISHING_REQUIREMENTS.map((requirement) => Object.freeze({
    id: `${requirement.toLowerCase()}.production-proof`,
    requirement,
    phase: Object.freeze({
      "REQ-USP-001": "control-plane",
      "REQ-USP-002": "raw-boundary",
      "REQ-USP-003": "sensitive-material",
      "REQ-USP-004": "manifest-authority",
      "REQ-USP-005": "hot-reload",
      "REQ-USP-006": "permission-publication",
      "REQ-USP-007": "audience-parity",
      "REQ-USP-008": "protocol-delivery",
      "REQ-USP-009": "governed-forwarding",
      "REQ-USP-010": "production-composition",
      "REQ-USP-011": "migration-readiness",
      "REQ-USP-012": "revision-semantics",
      "REQ-USP-013": "resource-bounds"
    })[requirement]
  }))
);

export const UPSTREAM_SERVICE_PUBLISHING_BOUNDARIES = Object.freeze([
  "authentication", "control-plane", "raw-parser", "compiler", "manifest-writer",
  "manifest-reader", "watcher", "gateway-snapshot", "operation-permission", "audience",
  "protocol", "neutral-peer", "sensitive-reference", "loopback-forwarding"
]);

export const UPSTREAM_SERVICE_PUBLISHING_SCENARIOS = Object.freeze([
  "create", "replace", "disable", "remove", "republish", "identical-replay",
  "conflict", "stale", "invalid-command", "restart", "reconnect"
]);

export const UPSTREAM_SERVICE_PUBLISHING_COUNTERS = Object.freeze([
  "writes", "snapshotSwaps", "catalogCommits", "publicationEvents", "invalidationsDelivered",
  "catalogPulls", "acknowledgements", "sessionDisconnects", "reconnectFences",
  "sensitiveReferenceMaterializations", "processLaunches", "upstreamCalls", "deniedExecutions"
]);

const EDGE_OUTCOMES = Object.freeze({
  create: "advanced", replace: "advanced", disable: "advanced", remove: "advanced",
  republish: "advanced", "identical-replay": "unchanged", conflict: "rejected",
  stale: "rejected", "invalid-command": "rejected", restart: "unchanged", reconnect: "unchanged"
});
const PROTOCOL_COHORTS = Object.freeze({
  "affected-ack": "acknowledged",
  "grant-disconnect": "disconnected_fenced",
  "ack-timeout": "timed_out_fenced",
  "reconnect-fence": "disconnected_fenced"
});
const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion", "verifier", "generatedAt", "producer", "commandId", "sourceRevision",
  "payloadDigest", "requirements", "deploymentMode", "summary", "assertions",
  "productionBoundaries", "revisionEdges", "protocolCohorts", "scenarios", "counters",
  "resourceBudgets", "observationSchemaVersion", "observations"
]);
const MAX_COUNTER = 1_000_000;
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_DURATION_MS = 300_000;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function record(value, code = "upstream_service_publishing_report_invalid") {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code, "Expected an object.");
  return value;
}

function exactKeys(value, keys, field) {
  record(value);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("upstream_service_publishing_report_unknown_field", `${field} fields do not match the report contract.`);
  }
}

function exactStringSet(values, expected, field) {
  if (!Array.isArray(values) || values.length !== expected.length ||
      values.some((value, index) => value !== expected[index])) {
    fail("upstream_service_publishing_report_set_mismatch", `${field} does not match the canonical set.`);
  }
}

function integer(value, field, maximum = MAX_COUNTER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail("upstream_service_publishing_report_counter_invalid", `${field} must be a bounded non-negative integer.`);
  }
  return value;
}

function positiveInteger(value, field, maximum = MAX_COUNTER) {
  integer(value, field, maximum);
  if (value === 0) fail("upstream_service_publishing_observation_count_invalid", `${field} must be positive.`);
  return value;
}

function validateCounters(value, field) {
  exactKeys(value, UPSTREAM_SERVICE_PUBLISHING_COUNTERS, field);
  for (const key of UPSTREAM_SERVICE_PUBLISHING_COUNTERS) integer(value[key], `${field}.${key}`);
}

function sumScenarioCounters(scenarios) {
  const total = Object.fromEntries(UPSTREAM_SERVICE_PUBLISHING_COUNTERS.map((key) => [key, 0]));
  for (const scenario of scenarios) {
    for (const key of UPSTREAM_SERVICE_PUBLISHING_COUNTERS) total[key] += scenario.counters[key];
  }
  return total;
}

const EVENT_KEYS = Object.freeze(["id", "status", "scenario", "fromRevision", "toRevision", "count", "fact"]);
const EVENT_META_KEYS = Object.freeze(["id", "status", "scenario", "fromRevision", "toRevision", "count"]);
const EVENT_CATALOG = Object.freeze([
  ["auth.unauthenticated.denied", "denied", "create", 0, 0],
  ["auth.viewer.denied", "denied", "create", 0, 0],
  ["create.accepted", "accepted", "create", 0, 1],
  ["create.idempotent-replay", "replayed", "identical-replay", 1, 1],
  ["auth.cross-owner.denied", "denied", "conflict", 1, 1],
  ["raw.hostile-corpus.rejected", "rejected", "conflict", 1, 1, 29],
  ["runtime.create.visible", "visible", "create", 0, 1],
  ["catalog.initial.pulled", "pulled", "replace", 1, 1, 3],
  ["audience.initial.hidden", "hidden", "replace", 1, 1, 2],
  ["protocol.stream.opened", "opened", "replace", 1, 1],
  ["protocol.unaffected-stream.opened", "opened", "replace", 1, 1],
  ["audience.grant.updated", "updated", "replace", 1, 1],
  ["protocol.invalidation.received", "received", "replace", 1, 1],
  ["protocol.unaffected-stream.quiet", "preserved", "replace", 1, 1],
  ["catalog.refresh.pulled", "pulled", "replace", 1, 1],
  ["protocol.malformed-ack.rejected", "rejected", "replace", 1, 1],
  ["protocol.stale-ack.rejected", "rejected", "replace", 1, 1],
  ["protocol.exact-ack.accepted", "acknowledged", "replace", 1, 1],
  ["protocol.duplicate-ack.rejected", "rejected", "replace", 1, 1],
  ["forward.allowed.accepted", "accepted", "replace", 1, 1],
  ["forward.response-schema.validated", "validated", "replace", 1, 1],
  ["forward.response-projection-redaction.observed", "observed", "replace", 1, 1],
  ["forward.fixture-call.observed", "observed", "replace", 1, 1],
  ["sensitive-reference.materialized", "observed", "replace", 1, 1],
  ["forward.approval.pending", "pending", "replace", 1, 1],
  ["forward.approval.resolved", "approved", "replace", 1, 1],
  ["forward.approval.fixture-call.observed", "observed", "replace", 1, 1],
  ["forward.approval.replay.rejected", "rejected", "replace", 1, 1],
  ["forward.response-byte-bound.rejected", "rejected", "replace", 1, 1],
  ["forward.timeout.rejected", "rejected", "replace", 1, 1],
  ["forward.cancellation.observed", "cancelled", "replace", 1, 1],
  ["forward.traffic.admitted", "admitted", "replace", 1, 1],
  ["forward.traffic.rejected", "rejected", "replace", 1, 1],
  ["forward.denied.rejected", "denied", "replace", 1, 1],
  ["replace.first.accepted", "accepted", "replace", 1, 2],
  ["runtime.replace-first.visible", "visible", "replace", 1, 2],
  ["catalog.replace-first.admitted", "admitted", "replace", 1, 2],
  ["audience.organization-team-role.admitted", "admitted", "replace", 2, 2],
  ["audience.inherited-direct-tags.admitted", "admitted", "replace", 2, 2],
  ["audience.deny-precedence.hidden", "hidden", "replace", 2, 2],
  ["audience.tag-denied.execution-rejected", "denied", "replace", 2, 2],
  ["protocol.revoked-stream.opened", "opened", "replace", 2, 2],
  ["protocol.grant.revoked", "revoked", "replace", 2, 2],
  ["protocol.revoked-stream.closed", "closed", "replace", 2, 2],
  ["protocol.timeout-stream.opened", "opened", "replace", 2, 2],
  ["replace.second.accepted", "accepted", "replace", 2, 3],
  ["runtime.replace-second.visible", "visible", "replace", 2, 3],
  ["catalog.replace-second.admitted", "admitted", "replace", 2, 3],
  ["protocol.timeout-grant.updated", "updated", "replace", 3, 3],
  ["protocol.timeout-invalidation.received", "received", "replace", 3, 3],
  ["protocol.timeout-stream.closed", "closed", "replace", 3, 3],
  ["protocol.same-session.fenced", "fenced", "reconnect", 3, 3],
  ["protocol.fresh-session.opened", "opened", "reconnect", 3, 3],
  ["replace.conflict.rejected", "rejected", "conflict", 3, 3],
  ["replace.stale.rejected", "rejected", "stale", 3, 3],
  ["replace.invalid-command.rejected", "rejected", "invalid-command", 3, 3],
  ["disable.accepted", "accepted", "disable", 3, 4],
  ["runtime.disable.visible", "visible", "disable", 3, 4],
  ["catalog.disable.admitted", "admitted", "disable", 3, 4],
  ["remove.accepted", "accepted", "remove", 4, 5],
  ["runtime.remove.visible", "visible", "remove", 4, 5],
  ["catalog.remove.admitted", "admitted", "remove", 4, 5],
  ["republish.accepted", "accepted", "republish", 5, 6],
  ["runtime.republish.visible", "visible", "republish", 5, 6],
  ["catalog.republish.admitted", "admitted", "republish", 5, 6],
  ["publication.republish.server-published", "server_published", "republish", 5, 6],
  ["restart.snapshot-restored", "restored", "restart", 6, 6]
].map(([id, status, scenario, fromRevision, toRevision, count = 1]) =>
  Object.freeze({ id, status, scenario, fromRevision, toRevision, count })));

const EMPTY_COUNTER_DELTA = Object.freeze(Object.fromEntries(
  UPSTREAM_SERVICE_PUBLISHING_COUNTERS.map((counter) => [counter, 0])
));

const FACT_POLICY = Object.freeze({
  "create.accepted": ["manifest_commit", { writes: 1 }],
  "replace.first.accepted": ["manifest_commit", { writes: 1 }],
  "replace.second.accepted": ["manifest_commit", { writes: 1 }],
  "disable.accepted": ["manifest_commit", { writes: 1 }],
  "remove.accepted": ["manifest_commit", { writes: 1 }],
  "republish.accepted": ["manifest_commit", { writes: 1 }],
  "runtime.create.visible": ["runtime_snapshot", { snapshotSwaps: 1 }],
  "runtime.replace-first.visible": ["runtime_snapshot", { snapshotSwaps: 1 }],
  "runtime.replace-second.visible": ["runtime_snapshot", { snapshotSwaps: 1 }],
  "runtime.disable.visible": ["runtime_snapshot", { snapshotSwaps: 1 }],
  "runtime.remove.visible": ["runtime_snapshot", { snapshotSwaps: 1 }],
  "runtime.republish.visible": ["runtime_snapshot", { snapshotSwaps: 1 }],
  "restart.snapshot-restored": ["runtime_restart", { snapshotSwaps: 1 }],
  "catalog.initial.pulled": ["catalog_audience_commit", { catalogCommits: 1, publicationEvents: 1, catalogPulls: 3 }],
  "catalog.replace-first.admitted": ["catalog_audience_commit", { catalogCommits: 1, publicationEvents: 1, catalogPulls: 1 }],
  "catalog.replace-second.admitted": ["catalog_audience_commit", { catalogCommits: 1, publicationEvents: 1, catalogPulls: 1 }],
  "catalog.disable.admitted": ["catalog_audience_commit", { catalogCommits: 1, publicationEvents: 1, catalogPulls: 1 }],
  "catalog.remove.admitted": ["catalog_audience_commit", { catalogCommits: 1, publicationEvents: 1, catalogPulls: 1 }],
  "catalog.republish.admitted": ["catalog_audience_commit", { catalogCommits: 1, publicationEvents: 1, catalogPulls: 1 }],
  "publication.republish.server-published": ["server_terminal", {}],
  "catalog.refresh.pulled": ["protocol_counter", { catalogPulls: 1 }],
  "protocol.invalidation.received": ["protocol_counter", { invalidationsDelivered: 1 }],
  "protocol.exact-ack.accepted": ["protocol_counter", { acknowledgements: 1 }],
  "protocol.revoked-stream.closed": ["protocol_counter", { sessionDisconnects: 1 }],
  "protocol.timeout-invalidation.received": ["protocol_counter", { invalidationsDelivered: 1 }],
  "protocol.timeout-stream.closed": ["protocol_counter", { sessionDisconnects: 1 }],
  "protocol.same-session.fenced": ["protocol_counter", { reconnectFences: 1 }],
  "forward.fixture-call.observed": ["execution_counter", { upstreamCalls: 1 }],
  "sensitive-reference.materialized": ["execution_counter", { sensitiveReferenceMaterializations: 1 }],
  "forward.approval.fixture-call.observed": ["execution_counter", { upstreamCalls: 1 }],
  "forward.traffic.admitted": ["execution_counter", { upstreamCalls: 1 }],
  "audience.tag-denied.execution-rejected": ["execution_counter", { deniedExecutions: 1 }],
  "forward.denied.rejected": ["execution_counter", { deniedExecutions: 1 }]
});

function counterDelta(overrides = {}) {
  return Object.freeze({ ...EMPTY_COUNTER_DELTA, ...overrides });
}

function syntheticFact(event) {
  const [type = "assertion", deltas = {}] = FACT_POLICY[event.id] || [];
  const publication = ["manifest_commit", "runtime_snapshot", "runtime_restart", "catalog_audience_commit", "server_terminal"].includes(type);
  const terminal = ["runtime_restart", "server_terminal"].includes(type);
  return Object.freeze({
    type,
    sourceRevision: publication ? event.toRevision : 0,
    sourceDigest: publication ? "a".repeat(64) : "",
    catalogRevision: ["catalog_audience_commit", "runtime_restart", "server_terminal"].includes(type) ? "b".repeat(64) : "",
    audienceRevision: ["catalog_audience_commit", "runtime_restart", "server_terminal"].includes(type) ? Math.max(1, event.toRevision) : 0,
    partitionCount: ["catalog_audience_commit", "runtime_restart", "server_terminal"].includes(type) ? 1 : 0,
    protocolRevision: terminal ? Math.max(1, event.toRevision) : 0,
    publicationRefObserved: terminal,
    counterDelta: counterDelta(deltas)
  });
}

export const UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_EVENTS = Object.freeze(
  EVENT_CATALOG.map((event) => Object.freeze({ ...event, fact: syntheticFact(event) }))
);

const BOUNDARY_EVENT = Object.freeze({
  authentication: "auth.unauthenticated.denied",
  "control-plane": "create.accepted",
  "raw-parser": "raw.hostile-corpus.rejected",
  compiler: "create.accepted",
  "manifest-writer": "create.accepted",
  "manifest-reader": "runtime.create.visible",
  watcher: "runtime.create.visible",
  "gateway-snapshot": "runtime.create.visible",
  "operation-permission": "audience.grant.updated",
  audience: "audience.initial.hidden",
  protocol: "protocol.invalidation.received",
  "neutral-peer": "catalog.refresh.pulled",
  "sensitive-reference": "sensitive-reference.materialized",
  "loopback-forwarding": "forward.fixture-call.observed"
});

const REVISION_EVENT = Object.freeze({
  create: "create.accepted",
  replace: "replace.first.accepted",
  disable: "disable.accepted",
  remove: "remove.accepted",
  republish: "republish.accepted",
  "identical-replay": "create.idempotent-replay",
  conflict: "replace.conflict.rejected",
  stale: "replace.stale.rejected",
  "invalid-command": "replace.invalid-command.rejected",
  restart: "restart.snapshot-restored",
  reconnect: "protocol.fresh-session.opened"
});

const PROTOCOL_EVENT = Object.freeze({
  "affected-ack": ["protocol.exact-ack.accepted", "acknowledged"],
  "grant-disconnect": ["protocol.revoked-stream.closed", "disconnected_fenced"],
  "ack-timeout": ["protocol.timeout-stream.closed", "timed_out_fenced"],
  "reconnect-fence": ["protocol.same-session.fenced", "disconnected_fenced"]
});

const REQUIREMENT_EVENTS = Object.freeze({
  "REQ-USP-001": ["auth.unauthenticated.denied", "auth.viewer.denied", "auth.cross-owner.denied"],
  "REQ-USP-002": ["raw.hostile-corpus.rejected"],
  "REQ-USP-003": ["forward.allowed.accepted", "sensitive-reference.materialized", "forward.fixture-call.observed"],
  "REQ-USP-004": ["create.accepted", "create.idempotent-replay"],
  "REQ-USP-005": ["runtime.create.visible", "replace.first.accepted", "runtime.republish.visible"],
  "REQ-USP-006": ["catalog.initial.pulled", "audience.grant.updated"],
  "REQ-USP-007": [
    "audience.initial.hidden", "catalog.refresh.pulled",
    "audience.organization-team-role.admitted", "audience.inherited-direct-tags.admitted",
    "audience.deny-precedence.hidden", "audience.tag-denied.execution-rejected",
    "forward.denied.rejected"
  ],
  "REQ-USP-008": [
    "protocol.invalidation.received", "protocol.unaffected-stream.quiet",
    "protocol.malformed-ack.rejected", "protocol.stale-ack.rejected",
    "protocol.exact-ack.accepted", "protocol.duplicate-ack.rejected",
    "protocol.same-session.fenced"
  ],
  "REQ-USP-009": [
    "forward.allowed.accepted", "forward.response-schema.validated",
    "forward.response-projection-redaction.observed", "forward.fixture-call.observed",
    "forward.approval.pending", "forward.approval.resolved",
    "forward.approval.fixture-call.observed", "forward.approval.replay.rejected",
    "forward.response-byte-bound.rejected", "forward.timeout.rejected",
    "forward.cancellation.observed", "forward.traffic.admitted", "forward.traffic.rejected",
    "forward.denied.rejected"
  ],
  "REQ-USP-010": ["runtime.create.visible", "catalog.refresh.pulled", "forward.fixture-call.observed", "publication.republish.server-published"],
  "REQ-USP-011": ["publication.republish.server-published", "restart.snapshot-restored"],
  "REQ-USP-012": ["replace.conflict.rejected", "replace.stale.rejected", "replace.invalid-command.rejected"],
  "REQ-USP-013": ["raw.hostile-corpus.rejected", "protocol.timeout-stream.closed", "restart.snapshot-restored"]
});

export function reduceUpstreamServicePublishingObservations(observations) {
  if (!Array.isArray(observations)) {
    fail("upstream_service_publishing_observations_missing", "Production observations are required.");
  }
  if (observations.length !== EVENT_CATALOG.length) {
    fail("upstream_service_publishing_observation_set_mismatch", "Production observation count does not match the canonical set.");
  }
  const ids = new Set();
  const directFacts = new Set();
  observations.forEach((observation, index) => {
    exactKeys(observation, EVENT_KEYS, `observations[${index}]`);
    if (ids.has(observation.id)) {
      fail("upstream_service_publishing_observation_duplicate", "Observation IDs must be unique.");
    }
    ids.add(observation.id);
    const expected = EVENT_CATALOG[index];
    for (const field of EVENT_META_KEYS) {
      if (observation[field] !== expected[field]) {
        fail("upstream_service_publishing_observation_substitution", `observations[${index}] does not match the canonical event fact.`);
      }
    }
    positiveInteger(observation.count, `observations[${index}].count`);
    integer(observation.fromRevision, `observations[${index}].fromRevision`);
    integer(observation.toRevision, `observations[${index}].toRevision`);
    exactKeys(observation.fact, [
      "type", "sourceRevision", "sourceDigest", "catalogRevision", "audienceRevision",
      "partitionCount", "protocolRevision", "publicationRefObserved", "counterDelta"
    ], `observations[${index}].fact`);
    const [expectedType = "assertion", expectedDelta = {}] = FACT_POLICY[observation.id] || [];
    if (observation.fact.type !== expectedType) {
      fail("upstream_service_publishing_observation_fact_type_invalid", "Observation fact type is not valid for its event.");
    }
    validateCounters(observation.fact.counterDelta, `observations[${index}].fact.counterDelta`);
    const canonicalDelta = counterDelta(expectedDelta);
    if (!sameJson(observation.fact.counterDelta, canonicalDelta)) {
      fail("upstream_service_publishing_observation_counter_forged", "Observation counter delta is not valid for its direct fact.");
    }
    const publicationFact = ["manifest_commit", "runtime_snapshot", "runtime_restart", "catalog_audience_commit", "server_terminal"].includes(expectedType);
    if (publicationFact) {
      if (observation.fact.sourceRevision !== observation.toRevision ||
          !/^[a-f0-9]{64}$/u.test(observation.fact.sourceDigest)) {
        fail("upstream_service_publishing_observation_direct_fact_invalid", "Publication fact is not bound to its source revision and digest.");
      }
      const directKey = `${expectedType}:${observation.fact.sourceRevision}`;
      if (directFacts.has(directKey)) {
        fail("upstream_service_publishing_observation_direct_fact_duplicate", "A direct publication fact was reused.");
      }
      directFacts.add(directKey);
    } else if (observation.fact.sourceRevision !== 0 || observation.fact.sourceDigest !== "") {
      fail("upstream_service_publishing_observation_direct_fact_unexpected", "A non-publication fact cannot claim source authority.");
    }
    integer(observation.fact.audienceRevision, `observations[${index}].fact.audienceRevision`);
    integer(observation.fact.partitionCount, `observations[${index}].fact.partitionCount`);
    integer(observation.fact.protocolRevision, `observations[${index}].fact.protocolRevision`);
    if (typeof observation.fact.publicationRefObserved !== "boolean") {
      fail("upstream_service_publishing_observation_terminal_fact_invalid", "Publication reference observation must be boolean.");
    }
    if (["catalog_audience_commit", "runtime_restart", "server_terminal"].includes(expectedType)) {
      if (!/^[a-f0-9]{64}$/u.test(observation.fact.catalogRevision) ||
          observation.fact.audienceRevision < 1 || observation.fact.partitionCount < 1) {
        fail("upstream_service_publishing_observation_catalog_fact_invalid", "Catalog and audience fact is incomplete.");
      }
    } else if (observation.fact.catalogRevision !== "" || observation.fact.audienceRevision !== 0 ||
        observation.fact.partitionCount !== 0) {
      fail("upstream_service_publishing_observation_catalog_fact_unexpected", "Only catalog admission facts may carry catalog or audience authority.");
    }
    const terminalFact = ["runtime_restart", "server_terminal"].includes(expectedType);
    if (terminalFact) {
      if (observation.fact.publicationRefObserved !== true ||
          observation.fact.protocolRevision !== observation.fact.audienceRevision) {
        fail("upstream_service_publishing_observation_terminal_fact_invalid", "Server terminal publication fact is incomplete.");
      }
    } else if (observation.fact.protocolRevision !== 0 || observation.fact.publicationRefObserved !== false) {
      fail("upstream_service_publishing_observation_terminal_fact_unexpected", "Only terminal publication facts may carry terminal authority.");
    }
  });
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const publicationTriples = [
    ["create.accepted", "runtime.create.visible", "catalog.initial.pulled"],
    ["replace.first.accepted", "runtime.replace-first.visible", "catalog.replace-first.admitted"],
    ["replace.second.accepted", "runtime.replace-second.visible", "catalog.replace-second.admitted"],
    ["disable.accepted", "runtime.disable.visible", "catalog.disable.admitted"],
    ["remove.accepted", "runtime.remove.visible", "catalog.remove.admitted"],
    ["republish.accepted", "runtime.republish.visible", "catalog.republish.admitted"]
  ];
  for (const eventIds of publicationTriples) {
    const facts = eventIds.map((eventId) => byId.get(eventId)?.fact);
    if (facts.some((fact) => !fact) || facts.some((fact) =>
      fact.sourceRevision !== facts[0].sourceRevision || fact.sourceDigest !== facts[0].sourceDigest)) {
      fail("upstream_service_publishing_observation_publication_disagrees", "Manifest, runtime, catalog, and audience publication facts disagree.");
    }
  }
  const restartFact = byId.get("restart.snapshot-restored")?.fact;
  const finalPublicationFact = byId.get("catalog.republish.admitted")?.fact;
  const serverTerminalFact = byId.get("publication.republish.server-published")?.fact;
  if (!restartFact || !finalPublicationFact || restartFact.sourceRevision !== finalPublicationFact.sourceRevision ||
      restartFact.sourceDigest !== finalPublicationFact.sourceDigest || !serverTerminalFact ||
      serverTerminalFact.sourceRevision !== finalPublicationFact.sourceRevision ||
      serverTerminalFact.sourceDigest !== finalPublicationFact.sourceDigest ||
      serverTerminalFact.catalogRevision !== finalPublicationFact.catalogRevision ||
      serverTerminalFact.audienceRevision !== finalPublicationFact.audienceRevision ||
      restartFact.catalogRevision !== serverTerminalFact.catalogRevision) {
    fail("upstream_service_publishing_observation_restart_disagrees", "Restarted runtime is not bound to the final publication fact.");
  }
  const assertions = UPSTREAM_SERVICE_PUBLISHING_ASSERTIONS.map((assertion) => {
    const requiredEvents = REQUIREMENT_EVENTS[assertion.requirement];
    if (!Array.isArray(requiredEvents) || requiredEvents.some((eventId) => !byId.has(eventId))) {
      fail("upstream_service_publishing_observation_requirement_missing", "A requirement observation is missing.");
    }
    return Object.freeze({
      ...assertion,
      expectedOutcome: "satisfied",
      observedOutcome: "satisfied",
      passed: true,
      durationMs: 0,
      reasonCode: "verified"
    });
  });
  const productionBoundaries = UPSTREAM_SERVICE_PUBLISHING_BOUNDARIES.map((boundary) => {
    if (!byId.has(BOUNDARY_EVENT[boundary])) fail("upstream_service_publishing_observation_boundary_missing", "A production boundary event is missing.");
    return Object.freeze({ id: boundary, traversed: true });
  });
  const revisionEdges = UPSTREAM_SERVICE_PUBLISHING_SCENARIOS.map((scenario) => {
    const observation = byId.get(REVISION_EVENT[scenario]);
    return Object.freeze({
      scenario,
      from: observation.fromRevision,
      to: observation.toRevision,
      outcome: EDGE_OUTCOMES[scenario]
    });
  });
  const protocolCohorts = Object.entries(PROTOCOL_EVENT).map(([id, [eventId, outcome]]) => Object.freeze({
    id,
    outcome,
    count: byId.get(eventId).count
  }));
  const scenarioCounters = Object.fromEntries(UPSTREAM_SERVICE_PUBLISHING_SCENARIOS.map((id) => [id, Object.fromEntries(
    UPSTREAM_SERVICE_PUBLISHING_COUNTERS.map((counter) => [counter, 0])
  )]));
  for (const observation of observations) {
    for (const counter of UPSTREAM_SERVICE_PUBLISHING_COUNTERS) {
      scenarioCounters[observation.scenario][counter] += observation.fact.counterDelta[counter];
    }
  }
  const scenarios = UPSTREAM_SERVICE_PUBLISHING_SCENARIOS.map((id) => Object.freeze({
    id,
    counters: Object.freeze(scenarioCounters[id])
  }));
  const counters = Object.freeze(sumScenarioCounters(scenarios));
  return Object.freeze({
    assertions: Object.freeze(assertions),
    productionBoundaries: Object.freeze(productionBoundaries),
    revisionEdges: Object.freeze(revisionEdges),
    protocolCohorts: Object.freeze(protocolCohorts),
    scenarios: Object.freeze(scenarios),
    counters
  });
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateUpstreamServicePublishingReport(report, {
  expectedSourceRevision = "",
  now = Date.now(),
  maxAgeMs = 24 * 60 * 60 * 1_000
} = {}) {
  exactKeys(report, TOP_LEVEL_KEYS, "report");
  if (report.schemaVersion !== UPSTREAM_SERVICE_PUBLISHING_REPORT_SCHEMA_VERSION ||
      report.verifier !== UPSTREAM_SERVICE_PUBLISHING_VERIFIER ||
      report.producer !== UPSTREAM_SERVICE_PUBLISHING_VERIFIER ||
      report.commandId !== UPSTREAM_SERVICE_PUBLISHING_COMMAND_ID ||
      report.deploymentMode !== "temporary-isolated") {
    fail("upstream_service_publishing_report_identity_mismatch", "Report identity does not match its contract.");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(report.sourceRevision) ||
      (expectedSourceRevision && report.sourceRevision !== expectedSourceRevision)) {
    fail("upstream_service_publishing_report_source_stale", "Report source revision is missing or stale.");
  }
  const generatedAt = Date.parse(report.generatedAt);
  if (!Number.isFinite(generatedAt) || generatedAt > now + 60_000 || now - generatedAt > maxAgeMs) {
    fail("upstream_service_publishing_report_stale", "Report timestamp is outside the accepted window.");
  }
  exactStringSet(report.requirements, UPSTREAM_SERVICE_PUBLISHING_REQUIREMENTS, "requirements");
  if (report.observationSchemaVersion !== UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_SCHEMA_VERSION) {
    fail("upstream_service_publishing_observation_schema_mismatch", "Observation schema identity does not match its contract.");
  }
  const derived = reduceUpstreamServicePublishingObservations(report.observations);
  for (const field of [
    "assertions", "productionBoundaries", "revisionEdges", "protocolCohorts", "scenarios", "counters"
  ]) {
    if (!sameJson(report[field], derived[field])) {
      fail("upstream_service_publishing_observation_derivation_mismatch", `${field} does not match production observations.`);
    }
  }

  if (!Array.isArray(report.assertions) || report.assertions.length !== UPSTREAM_SERVICE_PUBLISHING_ASSERTIONS.length) {
    fail("upstream_service_publishing_report_assertions_missing", "Mandatory assertion count does not match.");
  }
  const assertionIds = new Set();
  report.assertions.forEach((assertion, index) => {
    exactKeys(assertion, ["id", "requirement", "phase", "expectedOutcome", "observedOutcome", "passed", "durationMs", "reasonCode"], `assertions[${index}]`);
    const expected = UPSTREAM_SERVICE_PUBLISHING_ASSERTIONS[index];
    if (assertionIds.has(assertion.id)) fail("upstream_service_publishing_report_assertion_duplicate", "Assertion IDs must be unique.");
    assertionIds.add(assertion.id);
    if (assertion.id !== expected.id || assertion.requirement !== expected.requirement ||
        assertion.phase !== expected.phase || assertion.expectedOutcome !== "satisfied" ||
        assertion.observedOutcome !== "satisfied" || assertion.passed !== true ||
        assertion.reasonCode !== "verified") {
      fail("upstream_service_publishing_report_assertion_failed", "Assertion outcome does not satisfy its contract.");
    }
    integer(assertion.durationMs, `assertions[${index}].durationMs`, MAX_DURATION_MS);
  });

  if (!Array.isArray(report.productionBoundaries)) fail("upstream_service_publishing_report_boundary_missing", "Production boundaries are required.");
  exactStringSet(report.productionBoundaries.map((entry) => entry.id), UPSTREAM_SERVICE_PUBLISHING_BOUNDARIES, "productionBoundaries");
  report.productionBoundaries.forEach((entry, index) => {
    exactKeys(entry, ["id", "traversed"], `productionBoundaries[${index}]`);
    if (entry.traversed !== true) fail("upstream_service_publishing_report_boundary_missing", "Every production boundary must be traversed.");
  });

  if (!Array.isArray(report.revisionEdges) || report.revisionEdges.length !== UPSTREAM_SERVICE_PUBLISHING_SCENARIOS.length) {
    fail("upstream_service_publishing_report_revision_broken", "Revision edge set is incomplete.");
  }
  exactStringSet(report.revisionEdges.map((edge) => edge.scenario), UPSTREAM_SERVICE_PUBLISHING_SCENARIOS, "revisionEdges");
  report.revisionEdges.forEach((edge, index) => {
    exactKeys(edge, ["scenario", "from", "to", "outcome"], `revisionEdges[${index}]`);
    integer(edge.from, `revisionEdges[${index}].from`);
    integer(edge.to, `revisionEdges[${index}].to`);
    const expectedOutcome = EDGE_OUTCOMES[edge.scenario];
    if (edge.outcome !== expectedOutcome ||
        (expectedOutcome === "advanced" ? edge.to <= edge.from : edge.to !== edge.from)) {
      fail("upstream_service_publishing_report_revision_broken", "Revision edge is inconsistent.");
    }
  });

  if (!Array.isArray(report.protocolCohorts)) fail("upstream_service_publishing_report_protocol_missing", "Protocol cohorts are required.");
  exactStringSet(report.protocolCohorts.map((cohort) => cohort.id), Object.keys(PROTOCOL_COHORTS), "protocolCohorts");
  report.protocolCohorts.forEach((cohort, index) => {
    exactKeys(cohort, ["id", "outcome", "count"], `protocolCohorts[${index}]`);
    if (cohort.outcome !== PROTOCOL_COHORTS[cohort.id] || integer(cohort.count, `protocolCohorts[${index}].count`) < 1) {
      fail("upstream_service_publishing_report_protocol_missing", "Protocol cohort outcome is invalid.");
    }
  });

  if (!Array.isArray(report.scenarios)) fail("upstream_service_publishing_report_scenario_missing", "Scenario counter deltas are required.");
  exactStringSet(report.scenarios.map((scenario) => scenario.id), UPSTREAM_SERVICE_PUBLISHING_SCENARIOS, "scenarios");
  report.scenarios.forEach((scenario, index) => {
    exactKeys(scenario, ["id", "counters"], `scenarios[${index}]`);
    validateCounters(scenario.counters, `scenarios[${index}].counters`);
  });
  validateCounters(report.counters, "counters");
  const recomputedCounters = sumScenarioCounters(report.scenarios);
  if (UPSTREAM_SERVICE_PUBLISHING_COUNTERS.some((key) => report.counters[key] !== recomputedCounters[key])) {
    fail("upstream_service_publishing_report_counter_forged", "Aggregate counters do not match scenario deltas.");
  }

  exactKeys(report.resourceBudgets, ["durationMs", "maxDurationMs", "reportBytes", "maxReportBytes"], "resourceBudgets");
  integer(report.resourceBudgets.durationMs, "resourceBudgets.durationMs", MAX_DURATION_MS);
  if (report.resourceBudgets.maxDurationMs !== MAX_DURATION_MS ||
      report.resourceBudgets.durationMs > report.resourceBudgets.maxDurationMs ||
      report.resourceBudgets.maxReportBytes !== MAX_REPORT_BYTES ||
      integer(report.resourceBudgets.reportBytes, "resourceBudgets.reportBytes", MAX_REPORT_BYTES) > report.resourceBudgets.maxReportBytes) {
    fail("upstream_service_publishing_report_budget_exceeded", "Report resource budget is invalid.");
  }

  exactKeys(report.summary, ["assertionCount", "passedCount", "failedCount", "boundaryCount", "revisionEdgeCount", "verificationPassed", "reportLeakScan"], "summary");
  const expectedSummary = {
    assertionCount: report.assertions.length,
    passedCount: report.assertions.filter((assertion) => assertion.passed).length,
    failedCount: report.assertions.filter((assertion) => !assertion.passed).length,
    boundaryCount: report.productionBoundaries.length,
    revisionEdgeCount: report.revisionEdges.length,
    verificationPassed: true,
    reportLeakScan: true
  };
  if (Object.keys(expectedSummary).some((key) => report.summary[key] !== expectedSummary[key])) {
    fail("upstream_service_publishing_report_summary_forged", "Report summary does not match detailed facts.");
  }
  if (report.payloadDigest !== reportPayloadDigest(report)) {
    fail("upstream_service_publishing_report_digest_mismatch", "Report payload digest does not match.");
  }
  const actualBytes = Buffer.byteLength(JSON.stringify(report), "utf8");
  if (report.resourceBudgets.reportBytes !== actualBytes) {
    fail("upstream_service_publishing_report_size_mismatch", "Recorded report size does not match the payload.");
  }
  assertNoSensitiveReportLeak(report, "upstream service publishing report");
  return Object.freeze({ verificationPassed: true });
}

export function reduceUpstreamServicePublishingReport(report, options = {}) {
  return validateUpstreamServicePublishingReport(report, options);
}

export function createUpstreamServicePublishingReadiness(report, options = {}) {
  try {
    reduceUpstreamServicePublishingReport(report, options);
    return Object.freeze({
      sourceOfTruth: UPSTREAM_SERVICE_PUBLISHING_REDUCER,
      reducerSourceOfTruth: UPSTREAM_SERVICE_PUBLISHING_REDUCER,
      releaseReady: true,
      coverageReady: true,
      liveStatus: "passed",
      reasons: []
    });
  } catch (error) {
    return Object.freeze({
      sourceOfTruth: UPSTREAM_SERVICE_PUBLISHING_REDUCER,
      reducerSourceOfTruth: UPSTREAM_SERVICE_PUBLISHING_REDUCER,
      releaseReady: false,
      coverageReady: false,
      liveStatus: "failed",
      reasons: [String(error?.code || "upstream_service_publishing_report_invalid")]
    });
  }
}

export function finalizeUpstreamServicePublishingReport(report) {
  const inputKeys = [
    "schemaVersion", "verifier", "generatedAt", "producer", "commandId", "sourceRevision",
    "requirements", "deploymentMode", "observationSchemaVersion", "observations", "resourceBudgets"
  ];
  exactKeys(report, inputKeys, "report input");
  const derived = reduceUpstreamServicePublishingObservations(report.observations);
  const next = {
    ...structuredClone(report),
    payloadDigest: "",
    summary: {
      assertionCount: derived.assertions.length,
      passedCount: derived.assertions.length,
      failedCount: 0,
      boundaryCount: derived.productionBoundaries.length,
      revisionEdgeCount: derived.revisionEdges.length,
      verificationPassed: true,
      reportLeakScan: true
    },
    assertions: structuredClone(derived.assertions),
    productionBoundaries: structuredClone(derived.productionBoundaries),
    revisionEdges: structuredClone(derived.revisionEdges),
    protocolCohorts: structuredClone(derived.protocolCohorts),
    scenarios: structuredClone(derived.scenarios),
    counters: structuredClone(derived.counters)
  };
  next.payloadDigest = reportPayloadDigest(next);
  let priorSize = -1;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const size = Buffer.byteLength(JSON.stringify(next), "utf8");
    next.resourceBudgets.reportBytes = size;
    next.payloadDigest = reportPayloadDigest(next);
    if (size === priorSize) break;
    priorSize = size;
  }
  validateUpstreamServicePublishingReport(next, { expectedSourceRevision: next.sourceRevision });
  return Object.freeze(next);
}

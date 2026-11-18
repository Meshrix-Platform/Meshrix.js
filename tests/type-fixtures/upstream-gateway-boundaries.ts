/**
 * Compile-time boundary fixtures for the upstream gateway registry.
 *
 * This file is typechecked by `tsconfig.tests.json` and is never executed.
 * Negative cases assert that malformed ports and state models fail to
 * compile; positive cases keep the intended shapes anchored.
 */
import { createUpstreamGatewayRegistry } from "#meshrix/agents/upstream-gateway/index";
import type {
  UpstreamGatewayCallOptions,
  UpstreamGatewayManifestRevision,
  UpstreamGatewayMcpToolCacheEntry,
  UpstreamGatewayMcpToolRefreshFlight,
  UpstreamGatewayMetricsState,
  UpstreamGatewayRegistry,
  UpstreamGatewayRegistryOptions,
  UpstreamGatewayResolvedMcpServiceConfig,
  UpstreamGatewayServiceRecord,
  UpstreamGatewayWalRecord
} from "#meshrix/agents/upstream-gateway/index";

declare const schemaPort: UpstreamGatewayRegistryOptions["schemaPort"];

const emptyMetrics: UpstreamGatewayMetricsState = {
  totalForwardCount: 0,
  totalFailureCount: 0,
  byService: {},
  byStatus: {}
};

export function validBoundaryModels() : void {
  const options: UpstreamGatewayRegistryOptions = {
    userDataPath: "<user-data>",
    schemaPort,
    tagStore: null,
    securityPermissions: null,
    mcpSessionManager: null,
    artifactTransitPort: null,
    secretKeyProvider: null,
    publishSkillHubUpdate: null
  };
  const registry: UpstreamGatewayRegistry = createUpstreamGatewayRegistry(options);
  const revision: UpstreamGatewayManifestRevision = registry.getManifestSnapshotRevision();
  const seed: UpstreamGatewayWalRecord = {
    schemaVersion: "v0.0.1:upstream-gateway:runtime-wal-1",
    sequence: 1,
    kind: "seed",
    auditEvents: [],
    metrics: emptyMetrics,
    createdAt: revision.sourceDigest
  };
  const delta: UpstreamGatewayWalRecord = {
    schemaVersion: "v0.0.1:upstream-gateway:runtime-wal-1",
    sequence: seed.sequence + 1,
    kind: "delta",
    auditEvents: [],
    metrics: emptyMetrics,
    createdAt: ""
  };
  const entry: UpstreamGatewayMcpToolCacheEntry = {
    loadedAt: 0,
    tools: [],
    byPublicName: new Map(),
    byUpstreamName: new Map()
  };
  const flight: UpstreamGatewayMcpToolRefreshFlight = {
    serviceId: "svc_fixture",
    promise: Promise.resolve(entry),
    controller: new AbortController(),
    waiters: new Set()
  };
  void [registry, seed, delta, flight];
}

export function malformedBoundaryInputs() : void {
  // @ts-expect-error the schema port must expose validate and assertSchemaBudget
  createUpstreamGatewayRegistry({ schemaPort: { validate: true } });
  // @ts-expect-error the schema port must expose assertSchemaBudget
  createUpstreamGatewayRegistry({ schemaPort: { validate: async () => ({ ok: true }) } });
  // @ts-expect-error userDataPath is a string
  createUpstreamGatewayRegistry({ schemaPort, userDataPath: 42 });
  // @ts-expect-error unknown factory options are rejected instead of absorbed
  createUpstreamGatewayRegistry({ schemaPort, retryCount: 3 });
  // @ts-expect-error the MCP session manager must expose listTools and close
  createUpstreamGatewayRegistry({ schemaPort, mcpSessionManager: { listTools: "nope", close: async () => {} } });
  // @ts-expect-error the protected-sink claim is a function
  createUpstreamGatewayRegistry({ schemaPort, claimProtectedSinkAttempt: "claim" });
  // @ts-expect-error call timeouts are whole numbers or null
  const callOptions: UpstreamGatewayCallOptions = { timeoutMs: "soon" };
  // @ts-expect-error a manifest revision carries a numeric sourceRevision
  const revision: UpstreamGatewayManifestRevision = { sourceRevision: "1", sourceDigest: "" };
  const flight: UpstreamGatewayMcpToolRefreshFlight = {
    // @ts-expect-error the service id is a string
    serviceId: 7,
    // @ts-expect-error the flight promise is always present
    promise: null,
    controller: new AbortController(),
    waiters: new Set()
  };
  // @ts-expect-error resolved MCP configuration requires its session ownership facts
  const config: UpstreamGatewayResolvedMcpServiceConfig = {
    gatewayServiceId: "svc_fixture",
    allowLocalNetwork: false
  };
  // @ts-expect-error a service record requires its durable provenance
  const service: UpstreamGatewayServiceRecord = { serviceId: "svc_fixture" };
  const wal: UpstreamGatewayWalRecord = {
    schemaVersion: "v0.0.1:upstream-gateway:runtime-wal-1",
    // @ts-expect-error the optional protocol version is a string
    protocolVersion: 7,
    sequence: 1,
    kind: "seed",
    auditEvents: [],
    metrics: emptyMetrics,
    createdAt: ""
  };
  void [callOptions, revision, flight, config, service, wal];
}

export function registryOutputIsNotAnAnyBag(registry: UpstreamGatewayRegistry) : void {
  // @ts-expect-error the registry contract does not expose arbitrary members
  registry.someUnknownMethod();
}

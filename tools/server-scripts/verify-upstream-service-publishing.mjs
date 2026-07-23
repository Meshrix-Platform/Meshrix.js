#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import {
  compileUpstreamOperationCapability,
  upstreamOperationCapabilityId
} from "../../packages/agents/src/upstream-gateway/operation-capability.mjs";
import { UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION } from "../../packages/agents/src/upstream-gateway/publishing-application.mjs";
import { createConsoleAuth } from "../../packages/foundation/src/security/auth/console-auth.mjs";
import { initializeLocalSecret } from "../../packages/foundation/src/security/secrets/local-secret-store.mjs";
import { createStorageProvider } from "../../packages/foundation/src/storage/storage-provider.mjs";
import { createTagStoreAdapter } from "../../packages/server-runtime/src/state/tags/tag-store.adapter.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";
import {
  createMcpCatalogProtocolPeer,
  issueNeutralMcpProtocolGrant
} from "./lib/mcp-catalog-protocol-peer.mjs";
import { createUpstreamPublishingHostileCorpus } from "./lib/upstream-publishing-hostile-corpus.mjs";
import { currentSourceTreeDigest } from "./lib/source-tree-digest.mjs";
import {
  UPSTREAM_SERVICE_PUBLISHING_COMMAND_ID,
  UPSTREAM_SERVICE_PUBLISHING_COUNTERS,
  UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_SCHEMA_VERSION,
  UPSTREAM_SERVICE_PUBLISHING_REPORT_PATH,
  UPSTREAM_SERVICE_PUBLISHING_REPORT_SCHEMA_VERSION,
  UPSTREAM_SERVICE_PUBLISHING_REQUIREMENTS,
  UPSTREAM_SERVICE_PUBLISHING_VERIFIER,
  finalizeUpstreamServicePublishingReport
} from "./lib/upstream-service-publishing-evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reportPath = path.join(ROOT, UPSTREAM_SERVICE_PUBLISHING_REPORT_PATH);
const startedAt = Date.now();
const roots = [];
const servers = [];
const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const PUBLISHING_SECRET_REF = "secret://verifier/upstream-publishing";
const PUBLISHING_SECRET_HEADER = "x-upstream-publishing-verifier";
const PUBLISHING_SECRET_VALUE = "synthetic-runtime-material";

const ZERO_COUNTER_DELTA = Object.freeze(Object.fromEntries(
  UPSTREAM_SERVICE_PUBLISHING_COUNTERS.map((counter) => [counter, 0])
));

const DIRECT_COUNTER_FACTS = Object.freeze({
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

function observationFact(type = "assertion", {
  sourceRevision = 0,
  sourceDigest = "",
  catalogRevision = "",
  audienceRevision = 0,
  partitionCount = 0,
  protocolRevision = 0,
  publicationRefObserved = false,
  counterDelta = {}
} = {}) {
  return Object.freeze({
    type,
    sourceRevision,
    sourceDigest,
    catalogRevision,
    audienceRevision,
    partitionCount,
    protocolRevision,
    publicationRefObserved,
    counterDelta: Object.freeze({ ...ZERO_COUNTER_DELTA, ...counterDelta })
  });
}

function cookieHeader(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return values.map((value) => value.split(";")[0]).join("; ");
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  const cookie = cookieHeader(response);
  return {
    approval: { cookie, csrf: payload.csrfToken },
    read: { cookie },
    write: {
      cookie,
      "content-type": "application/json",
      "x-lico-csrf": payload.csrfToken,
      "x-lico-safety-confirm": "true"
    }
  };
}

function startLoopbackFixture() {
  const state = { calls: 0, credentialCalls: 0, approvalCalls: 0, largeCalls: 0, slowCalls: 0 };
  return new Promise((resolve) => {
    const server = http.createServer(async (request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      await new Promise((done) => request.on("end", done));
      if (request.url === "/echo" && request.method === "POST") {
        state.calls += 1;
        if (request.headers[PUBLISHING_SECRET_HEADER] === PUBLISHING_SECRET_VALUE) {
          state.credentialCalls += 1;
        }
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, echo: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
        return;
      }
      if (request.url === "/approval" && request.method === "POST") {
        state.calls += 1;
        state.approvalCalls += 1;
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url === "/large" && request.method === "POST") {
        state.largeCalls += 1;
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ payload: "x".repeat(512) }));
        return;
      }
      if (request.url === "/slow" && request.method === "POST") {
        state.slowCalls += 1;
        setTimeout(() => {
          if (response.destroyed) return;
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ ok: true }));
        }, 300);
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, state, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function descriptor(fixtureUrl, label = "Verifier service", tagPolicy = undefined) {
  const endpoint = new URL(fixtureUrl);
  return {
    serviceProtocol: "http",
    label,
    baseUrl: fixtureUrl,
    allowLocalNetwork: true,
    ...(tagPolicy ? { tagPolicy } : {}),
    references: [{
      type: "credential",
      reference: PUBLISHING_SECRET_REF,
      revision: 1,
      use: "request-auth",
      operationKey: "echo",
      host: endpoint.hostname,
      protocol: endpoint.protocol.replace(/:$/u, ""),
      scopes: ["gateway:write"]
    }],
    operations: [{
      operationKey: "echo",
      method: "POST",
      path: "/echo",
      requiredScopes: ["gateway:write"],
      risk: "safe_write",
      sensitiveBodyFields: ["echo"],
      publicResponseFields: ["ok"],
      responseSchema: {
        type: "object",
        properties: { ok: { type: "boolean" }, echo: { type: "object" } },
        required: ["ok", "echo"],
        additionalProperties: false
      },
      payloadTransport: structuredPayloadTransport()
    }, {
      operationKey: "approval",
      method: "POST",
      path: "/approval",
      requiredScopes: ["gateway:write"],
      risk: "safe_write",
      requiresApproval: true,
      payloadTransport: structuredPayloadTransport()
    }, {
      operationKey: "bounded",
      method: "POST",
      path: "/large",
      requiredScopes: ["gateway:write"],
      risk: "safe_write",
      payloadTransport: structuredPayloadTransport(128)
    }, {
      operationKey: "timeout",
      method: "POST",
      path: "/slow",
      requiredScopes: ["gateway:write"],
      risk: "safe_write",
      timeoutMs: 100,
      payloadTransport: structuredPayloadTransport()
    }]
  };
}

function structuredPayloadTransport(responseMaxBytes = 1024 * 1024) {
  return {
    request: { mode: "structured_json", maxBytes: 1024 * 1024, mediaTypes: ["application/json"] },
    response: { mode: "structured_json", maxBytes: responseMaxBytes, mediaTypes: ["application/json"] }
  };
}

function command(action, {
  serviceId,
  expectedServiceRevision,
  expectedSetRevision,
  idempotencyKey,
  fixtureUrl,
  label,
  tagPolicy,
  includeDescriptor = ["create", "replace"].includes(action)
} = {}) {
  return {
    schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
    action,
    ...(action === "create" ? { serviceKey: "verifier-service" } : { serviceId }),
    expectedServiceRevision,
    expectedSetRevision,
    idempotencyKey,
    ...(includeDescriptor ? { descriptor: descriptor(fixtureUrl, label, tagPolicy) } : {})
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};
  if (text.trim()) payload = JSON.parse(text);
  return { status: response.status, payload };
}

async function publish(baseUrl, session, method, route, body, expectedStatus = 202) {
  const result = await requestJson(`${baseUrl}${route}`, {
    method,
    headers: session.write,
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  assert.equal(result.status, expectedStatus);
  return result.payload;
}

async function waitForRuntimeService(baseUrl, session, serviceId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await requestJson(`${baseUrl}/api/gateway/v1/external-services`, { headers: session.read });
    if (result.payload?.items?.some((item) => item.serviceId === serviceId)) return result.payload;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Published service did not reach the runtime snapshot.");
}

async function waitForPublicationAuthority({ authority, baseUrl, session, serviceId, accepted, presence = "present" }) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const [snapshot, control, runtime] = await Promise.all([
      authority.getCandidateSnapshot(),
      requestJson(`${baseUrl}/api/gateway/v1/services`, { headers: session.read }),
      requestJson(`${baseUrl}/api/gateway/v1/external-services`, { headers: session.read })
    ]);
    const controlService = control.payload?.services?.find((item) => item.serviceId === serviceId) || null;
    const runtimeService = runtime.payload?.items?.find((item) => item.serviceId === serviceId) || null;
    const controlMatches = control.status === 200 && control.payload?.setRevision === accepted.setRevision &&
      (!controlService || (controlService.serviceRevision === accepted.serviceRevision &&
        controlService.manifestDigest === accepted.manifestDigest));
    const runtimeMatches = presence === "absent"
      ? runtimeService === null
      : runtimeService?.serviceRevision === accepted.serviceRevision &&
        runtimeService?.manifestDigest === accepted.manifestDigest &&
        (presence !== "disabled" || runtimeService?.disabled === true);
    if (snapshot?.setRevision === accepted.setRevision && controlMatches && runtimeMatches) {
      return Object.freeze({ sourceRevision: snapshot.setRevision, sourceDigest: snapshot.setDigest });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Published control-plane, manifest authority, and runtime registry facts did not converge.");
}

async function waitForCatalogAdmission(peer, { sourceRevision, sourceDigest, serviceId, expectTool = true }) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const catalog = await peer.pullCatalog();
    const upstreamTool = catalog.tools.find((tool) => tool?._meta?.serviceId === serviceId) || null;
    const toolMatches = expectTool
      ? upstreamTool?._meta?.sourceRevision === sourceRevision && upstreamTool?._meta?.sourceDigest === sourceDigest
      : upstreamTool === null;
    if (catalog.facts?.sourceRevision === sourceRevision && toolMatches &&
        /^[a-f0-9]{64}$/u.test(String(catalog.facts?.catalogRevision || "")) &&
        Number.isSafeInteger(catalog.facts?.audienceRevision) && catalog.facts.audienceRevision > 0 &&
        Array.isArray(catalog.facts?.partitionKeys) && catalog.facts.partitionKeys.length > 0) {
      return Object.freeze({ catalog, upstreamTool });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Operation Permission catalog and audience facts did not converge with the manifest authority.");
}

function manifestCommitFact(authorityFact) {
  return observationFact("manifest_commit", { ...authorityFact, counterDelta: { writes: 1 } });
}

function runtimeSnapshotFact(authorityFact, type = "runtime_snapshot") {
  return observationFact(type, { ...authorityFact, counterDelta: { snapshotSwaps: 1 } });
}

function catalogAdmissionFact(authorityFact, catalog, catalogPulls = 1) {
  return observationFact("catalog_audience_commit", {
    ...authorityFact,
    catalogRevision: catalog.facts.catalogRevision,
    audienceRevision: catalog.facts.audienceRevision,
    partitionCount: catalog.facts.partitionKeys.length,
    counterDelta: { catalogCommits: 1, publicationEvents: 1, catalogPulls }
  });
}

async function waitForServerPublished({ baseUrl, session, serviceId, authorityFact, catalog }) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await requestJson(
      `${baseUrl}/api/gateway/v1/services/${encodeURIComponent(serviceId)}`,
      { headers: session.read }
    );
    const publication = result.payload?.service?.publication;
    const terminal = publication?.terminal;
    if (result.status === 200 && publication?.status === "server_published" &&
        /^urn:lico:upstream-publication:[a-f0-9]{64}$/u.test(String(publication.publicationRef || "")) &&
        terminal?.sourceRevision === authorityFact.sourceRevision &&
        terminal?.sourceDigest === authorityFact.sourceDigest &&
        terminal?.catalogRevision === catalog.facts.catalogRevision &&
        terminal?.audienceRevision === catalog.facts.audienceRevision &&
        terminal?.protocolRevision === terminal?.audienceRevision) {
      return observationFact("server_terminal", {
        ...authorityFact,
        catalogRevision: terminal.catalogRevision,
        audienceRevision: terminal.audienceRevision,
        partitionCount: catalog.facts.partitionKeys.length,
        protocolRevision: terminal.protocolRevision,
        publicationRefObserved: true
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Public upstream publication status did not reach a revision-consistent server terminal state.");
}

async function main() {
  const observations = [];
  const observe = (id, status, scenario, fromRevision, toRevision, count = 1, fact = null) => {
    const [directType = "assertion", counterDelta = {}] = DIRECT_COUNTER_FACTS[id] || [];
    observations.push(Object.freeze({
      id,
      status,
      scenario,
      fromRevision,
      toRevision,
      count,
      fact: fact || observationFact(directType, { counterDelta })
    }));
  };
  const fixture = await startLoopbackFixture();
  servers.push({ close: () => new Promise((resolve) => fixture.server.close(resolve)) });
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-upstream-publishing-"));
  roots.push(userDataPath);
  const manifestAuthority = createStorageProvider({ userDataPath }).getDurableManifestCandidateAuthorityPort();

  const tagStore = createTagStoreAdapter({ userDataPath });
  const auth = createConsoleAuth({ userDataPath, tagManagementStore: tagStore });
  const owner = await auth.ensureInitialOwner();
  const otherPassword = "other-admin-fixture-credential";
  const viewerPassword = "viewer-fixture-credential";
  await auth.createUser({ username: "other.admin", password: otherPassword, roleId: "admin" });
  await auth.createUser({ username: "read.viewer", password: viewerPassword, roleId: "viewer" });
  await auth.close();
  tagStore.close();

  let server = await startHttpServer({
    userDataPath,
    distPath: "",
    host: "127.0.0.1",
    port: 0,
    runtimeOptions: { disableFileLogging: true }
  });
  servers.push(server);
  const ownerSession = await login(server.url, owner.username, owner.password);
  const otherSession = await login(server.url, "other.admin", otherPassword);
  const viewerSession = await login(server.url, "read.viewer", viewerPassword);
  const collection = "/api/gateway/v1/services";
  const create = command("create", {
    expectedServiceRevision: 0,
    expectedSetRevision: 0,
    idempotencyKey: "create-verifier-service",
    fixtureUrl: fixture.url
  });

  assert.equal((await requestJson(`${server.url}${collection}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(create)
  })).status, 401);
  observe("auth.unauthenticated.denied", "denied", "create", 0, 0);
  assert.equal((await requestJson(`${server.url}${collection}`, {
    method: "POST", headers: viewerSession.write, body: JSON.stringify(create)
  })).status, 403);
  observe("auth.viewer.denied", "denied", "create", 0, 0);

  const created = await publish(server.url, ownerSession, "POST", collection, create);
  assert.equal(created.serviceRevision, 1);
  assert.equal(created.setRevision, 1);
  const serviceId = created.serviceId;
  const createAuthority = await waitForPublicationAuthority({
    authority: manifestAuthority,
    baseUrl: server.url,
    session: ownerSession,
    serviceId,
    accepted: created
  });
  observe("create.accepted", "accepted", "create", 0, 1, 1, manifestCommitFact(createAuthority));
  await initializeLocalSecret({
    dataDir: userDataPath,
    target: {
      provider: "verifier",
      family: "http-header",
      authType: "header",
      secretRef: PUBLISHING_SECRET_REF,
      scope: {
        serviceId,
        scopes: ["gateway:write"],
        allowedHosts: [new URL(fixture.url).hostname],
        allowedProtocols: [new URL(fixture.url).protocol.replace(/:$/u, "")]
      }
    },
    payload: {
      headers: { [PUBLISHING_SECRET_HEADER]: PUBLISHING_SECRET_VALUE }
    }
  });
  const replayed = await publish(server.url, ownerSession, "POST", collection, create);
  assert.equal(replayed.replayed, true);
  observe("create.idempotent-replay", "replayed", "identical-replay", 1, 1);
  const crossOwner = command("replace", {
    serviceId,
    expectedServiceRevision: 1,
    expectedSetRevision: 1,
    idempotencyKey: "cross-owner-replace",
    fixtureUrl: fixture.url,
    label: "Cross owner"
  });
  assert.equal((await requestJson(`${server.url}${collection}/${encodeURIComponent(serviceId)}`, {
    method: "PUT", headers: otherSession.write, body: JSON.stringify(crossOwner)
  })).status, 403);
  observe("auth.cross-owner.denied", "denied", "conflict", 1, 1);
  const hostileCorpus = createUpstreamPublishingHostileCorpus(fixture.url);
  for (const { id, raw } of hostileCorpus) {
    await publish(server.url, ownerSession, "POST", collection, raw, id === "byte-limit" ? 413 : 400);
    const rpc = await requestJson(`${server.url}/api/rpc`, {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `publishing-hostile-${id}`,
        method: "external_services.create",
        params: { bodyText: raw }
      })
    });
    assert.equal(rpc.status, 200);
    assert.equal(rpc.payload?.error?.code, 400);
  }
  const projectedRpc = await requestJson(`${server.url}/api/rpc`, {
    method: "POST",
    headers: ownerSession.write,
    body: '{"jsonrpc":"2.0","id":"projected","method":"external_services.create","params":{"action":"create","action":"replace"}}'
  });
  assert.equal(projectedRpc.status, 200);
  assert.equal(projectedRpc.payload?.error?.code, 400);
  const afterHostileCorpus = await requestJson(`${server.url}${collection}`, { headers: ownerSession.read });
  assert.equal(afterHostileCorpus.payload?.setRevision, 1);
  assert.equal(afterHostileCorpus.payload?.services?.length, 1);
  assert.equal(fixture.state.calls, 0);
  observe("raw.hostile-corpus.rejected", "rejected", "conflict", 1, 1, hostileCorpus.length * 2 + 1);
  await waitForRuntimeService(server.url, ownerSession, serviceId);
  observe("runtime.create.visible", "visible", "create", 0, 1, 1, runtimeSnapshotFact(createAuthority));

  const capabilityId = upstreamOperationCapabilityId({ serviceId }, { operationKey: "echo" });
  const approvalCapabilityId = upstreamOperationCapabilityId({ serviceId }, { operationKey: "approval" });
  const boundedCapabilityId = upstreamOperationCapabilityId({ serviceId }, { operationKey: "bounded" });
  const timeoutCapabilityId = upstreamOperationCapabilityId({ serviceId }, { operationKey: "timeout" });
  const executionCapabilities = [capabilityId, approvalCapabilityId, boundedCapabilityId, timeoutCapabilityId];
  const credentialBindingIds = compileUpstreamOperationCapability(
    { serviceId, credentialRefs: [PUBLISHING_SECRET_REF] },
    { operationKey: "echo", protocol: "http", requiredScopes: ["gateway:write"], risk: "safe_write" }
  ).credentialBindingIds;
  const allowedGrant = await issueNeutralMcpProtocolGrant({
    server,
    approvalAuth: ownerSession.approval,
    peerId: "audience-allowed",
    toolsets: ["lico.gateway.read"],
    dynamicCapabilities: executionCapabilities,
    allowedServiceIds: [serviceId],
    allowedSecretBindings: credentialBindingIds,
    maxRisk: "read_only"
  });
  const deniedGrant = await issueNeutralMcpProtocolGrant({
    server,
    approvalAuth: ownerSession.approval,
    peerId: "audience-denied",
    toolsets: ["lico.gateway.read"],
    maxRisk: "read_only"
  });
  const executionGrant = await issueNeutralMcpProtocolGrant({
    server,
    approvalAuth: ownerSession.approval,
    peerId: "execution",
    toolsets: ["lico.gateway.write", "lico.gateway.read"],
    dynamicCapabilities: executionCapabilities,
    allowedServiceIds: [serviceId],
    allowedSecretBindings: credentialBindingIds,
    maxRisk: "safe_write"
  });
  const tagDeniedGrant = await issueNeutralMcpProtocolGrant({
    server,
    approvalAuth: ownerSession.approval,
    peerId: "audience-tag-denied",
    toolsets: ["lico.gateway.write", "lico.gateway.read"],
    dynamicCapabilities: [capabilityId],
    allowedServiceIds: [serviceId],
    allowedSecretBindings: credentialBindingIds,
    maxRisk: "safe_write"
  });
  const trafficGrant = await issueNeutralMcpProtocolGrant({
    server,
    approvalAuth: ownerSession.approval,
    peerId: "traffic",
    toolsets: ["lico.gateway.write", "lico.gateway.read"],
    dynamicCapabilities: [capabilityId],
    allowedServiceIds: [serviceId],
    allowedSecretBindings: credentialBindingIds,
    maxRisk: "safe_write"
  });
  const audienceTagStore = createTagStoreAdapter({ userDataPath });
  audienceTagStore.upsertTag({ tagId: "audience:allow", kind: "custom", label: "Audience allow" });
  audienceTagStore.upsertTag({
    tagId: "audience:inherited",
    kind: "custom",
    label: "Audience inherited",
    parentTagId: "audience:allow"
  });
  audienceTagStore.upsertTag({ tagId: "audience:required", kind: "custom", label: "Audience required" });
  audienceTagStore.upsertTag({ tagId: "audience:deny", kind: "custom", label: "Audience deny" });
  audienceTagStore.upsertProjection({
    tagId: "audience:inherited",
    entityType: "organization",
    entityId: "organization-verifier",
    payload: { kind: "organization" }
  });
  audienceTagStore.upsertProjection({
    tagId: "audience:required",
    entityType: "team",
    entityId: "team-verifier",
    payload: { kind: "team" }
  });
  audienceTagStore.upsertProjection({
    tagId: "audience:deny",
    entityType: "role",
    entityId: "role-denied-verifier",
    payload: { kind: "role" }
  });
  audienceTagStore.close();
  const allowedPeer = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: allowedGrant,
    proxySessionId: "neutral_allowed_session_001"
  });
  const deniedPeer = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: deniedGrant,
    proxySessionId: "neutral_denied_session_001"
  });
  const executionPeer = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: executionGrant,
    proxySessionId: "neutral_execution_session_001"
  });
  const tagDeniedPeer = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: tagDeniedGrant,
    proxySessionId: "neutral_tag_denied_session_001"
  });
  const trafficPeer = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: trafficGrant,
    proxySessionId: "neutral_traffic_session_001"
  });
  const allowedCatalog = await allowedPeer.pullCatalog();
  const deniedCatalog = await deniedPeer.pullCatalog();
  const executionCatalog = await executionPeer.pullCatalog();
  for (const catalog of [allowedCatalog, deniedCatalog, executionCatalog]) {
    assert.equal(catalog.facts.sourceRevision, createAuthority.sourceRevision);
    assert.equal(catalog.facts.catalogRevision, executionCatalog.facts.catalogRevision);
    assert.equal(catalog.facts.audienceRevision, executionCatalog.facts.audienceRevision);
  }
  const initialTool = executionCatalog.tools.find((tool) => tool?._meta?.serviceId === serviceId);
  assert.equal(initialTool?._meta?.sourceDigest, createAuthority.sourceDigest);
  observe("catalog.initial.pulled", "pulled", "replace", 1, 1, 3,
    catalogAdmissionFact(createAuthority, executionCatalog, 3));
  assert.equal(allowedCatalog.tools.some((tool) => tool?._meta?.serviceId === serviceId), false);
  assert.equal(deniedCatalog.tools.some((tool) => tool?._meta?.serviceId === serviceId), false);
  observe("audience.initial.hidden", "hidden", "replace", 1, 1, 2);

  const tagDeniedGrantUpdate = await requestJson(
    `${server.url}/api/operation-permission/v1/grants/${encodeURIComponent(tagDeniedGrant.grantId)}`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({
        scopes: ["gateway:read", "gateway:write"],
        toolsets: ["lico.gateway.read", "lico.gateway.write"],
        maxRisk: "safe_write",
        metadata: {
          maxRisk: "safe_write",
          organizationId: "organization-verifier",
          teamId: "team-verifier",
          roleId: "role-denied-verifier"
        },
        reason: "tag_policy_verification"
      })
    }
  );
  assert.equal(tagDeniedGrantUpdate.status, 200);
  const executionGrantUpdate = await requestJson(
    `${server.url}/api/operation-permission/v1/grants/${encodeURIComponent(executionGrant.grantId)}`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({
        scopes: ["gateway:read", "gateway:write"],
        toolsets: ["lico.gateway.read", "lico.gateway.write"],
        maxRisk: "safe_write",
        metadata: {
          maxRisk: "safe_write",
          organizationId: "organization-verifier",
          teamId: "team-verifier",
          roleId: "role-allowed-verifier"
        },
        reason: "tag_policy_execution_verification"
      })
    }
  );
  assert.equal(executionGrantUpdate.status, 200);
  const trafficGrantUpdate = await requestJson(
    `${server.url}/api/operation-permission/v1/grants/${encodeURIComponent(trafficGrant.grantId)}`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({
        scopes: ["gateway:read", "gateway:write"],
        toolsets: ["lico.gateway.read", "lico.gateway.write"],
        maxRisk: "safe_write",
        rateLimit: { perMinute: 1 },
        metadata: { maxRisk: "safe_write" },
        reason: "traffic_admission_verification"
      })
    }
  );
  assert.equal(trafficGrantUpdate.status, 200);

  const ackStream = await allowedPeer.openInvalidationStream();
  assert.equal(ackStream.ok, true);
  observe("protocol.stream.opened", "opened", "replace", 1, 1);
  const unaffectedStream = await deniedPeer.openInvalidationStream();
  assert.equal(unaffectedStream.ok, true);
  observe("protocol.unaffected-stream.opened", "opened", "replace", 1, 1);
  const allowedGrantUpdate = await requestJson(
    `${server.url}/api/operation-permission/v1/grants/${encodeURIComponent(allowedGrant.grantId)}`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({
        scopes: ["gateway:read", "gateway:write"],
        toolsets: ["lico.gateway.read", "lico.gateway.write"],
        maxRisk: "safe_write",
        metadata: {
          maxRisk: "safe_write",
          organizationId: "organization-verifier",
          teamId: "team-verifier",
          roleId: "role-allowed-verifier"
        },
        reason: "protocol_verification"
      })
    }
  );
  assert.equal(
    allowedGrantUpdate.status,
    200,
    `Grant update failed: ${String(allowedGrantUpdate.payload?.error?.code || "unknown")}`
  );
  observe("audience.grant.updated", "updated", "replace", 1, 1);
  const invalidation = await ackStream.waitForInvalidation();
  observe("protocol.invalidation.received", "received", "replace", 1, 1);
  await assert.rejects(() => unaffectedStream.waitForInvalidation(300));
  observe("protocol.unaffected-stream.quiet", "preserved", "replace", 1, 1);
  const refreshed = await allowedPeer.pullCatalog();
  assert.ok(refreshed.tools.find((tool) => tool?._meta?.serviceId === serviceId));
  observe("catalog.refresh.pulled", "pulled", "replace", 1, 1);
  const malformedAcknowledgement = await allowedPeer.acknowledge({
    ...refreshed.facts,
    audienceRevision: "invalid"
  }, invalidation.params.change.affectedPartitions);
  assert.notEqual(malformedAcknowledgement.payload?.result?.ok, true);
  observe("protocol.malformed-ack.rejected", "rejected", "replace", 1, 1);
  const staleAcknowledgement = await allowedPeer.acknowledge({
    ...refreshed.facts,
    sourceRevision: Math.max(0, refreshed.facts.sourceRevision - 1)
  }, invalidation.params.change.affectedPartitions);
  assert.notEqual(staleAcknowledgement.payload?.result?.ok, true);
  observe("protocol.stale-ack.rejected", "rejected", "replace", 1, 1);
  const acknowledgement = await allowedPeer.acknowledge(
    refreshed.facts,
    invalidation.params.change.affectedPartitions
  );
  assert.equal(acknowledgement.payload?.result?.ok, true);
  observe("protocol.exact-ack.accepted", "acknowledged", "replace", 1, 1);
  const duplicateAcknowledgement = await allowedPeer.acknowledge(
    refreshed.facts,
    invalidation.params.change.affectedPartitions
  );
  assert.notEqual(duplicateAcknowledgement.payload?.result?.ok, true);
  observe("protocol.duplicate-ack.rejected", "rejected", "replace", 1, 1);
  await ackStream.close();
  await unaffectedStream.close();
  const upstreamTool = executionCatalog.tools.find((tool) =>
    tool?._meta?.serviceId === serviceId && tool?._meta?.operationKey === "echo");
  assert.ok(upstreamTool);
  const forwarded = await executionPeer.callTool(upstreamTool.name, { body: { value: "verified" } });
  assert.equal(
    forwarded.status,
    200,
    `Forwarding failed: ${String(forwarded.payload?.error?.data?.code || forwarded.payload?.error?.code || "unknown")}`
  );
  assert.equal(forwarded.payload?.error, undefined);
  observe("forward.allowed.accepted", "accepted", "replace", 1, 1);
  const publicForwardPayload = forwarded.payload?.result?.structuredContent?.payload;
  assert.equal(publicForwardPayload?.response?.json?.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(publicForwardPayload?.response?.json || {}, "echo"), false);
  assert.equal(JSON.stringify(forwarded.payload).includes("verified"), false);
  observe("forward.response-schema.validated", "validated", "replace", 1, 1);
  observe("forward.response-projection-redaction.observed", "observed", "replace", 1, 1);
  assert.equal(fixture.state.calls, 1);
  observe("forward.fixture-call.observed", "observed", "replace", 1, 1);
  assert.equal(fixture.state.credentialCalls, 1);
  observe("sensitive-reference.materialized", "observed", "replace", 1, 1);
  const approvalTool = executionCatalog.tools.find((tool) =>
    tool?._meta?.serviceId === serviceId && tool?._meta?.operationKey === "approval");
  assert.ok(approvalTool);
  const approvalCallsBefore = fixture.state.approvalCalls;
  const pendingApproval = await executionPeer.callTool(approvalTool.name, { body: { value: "approved" } });
  const pendingApprovalPayload = pendingApproval.payload?.result?.structuredContent?.payload;
  assert.equal(pendingApprovalPayload?.status, "pending_approval");
  const pendingOperationId = String(pendingApprovalPayload?.pendingOperation?.pendingOperationId || "");
  assert.ok(pendingOperationId);
  assert.equal(fixture.state.approvalCalls, approvalCallsBefore);
  observe("forward.approval.pending", "pending", "replace", 1, 1);
  const resolvedApproval = await requestJson(
    `${server.url}/api/operation-permission/v1/pending-operations/${encodeURIComponent(pendingOperationId)}/resolve`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({ resolution: "approved", reason: "upstream_publishing_verification" })
    }
  );
  assert.equal(resolvedApproval.status, 200);
  assert.equal(resolvedApproval.payload?.pendingOperation?.status, "completed");
  observe("forward.approval.resolved", "approved", "replace", 1, 1);
  assert.equal(fixture.state.approvalCalls, approvalCallsBefore + 1);
  observe("forward.approval.fixture-call.observed", "observed", "replace", 1, 1);
  const replayedApproval = await requestJson(
    `${server.url}/api/operation-permission/v1/pending-operations/${encodeURIComponent(pendingOperationId)}/resolve`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({ resolution: "approved", reason: "upstream_publishing_replay_verification" })
    }
  );
  assert.notEqual(replayedApproval.status, 200);
  assert.equal(fixture.state.approvalCalls, approvalCallsBefore + 1);
  observe("forward.approval.replay.rejected", "rejected", "replace", 1, 1);
  const boundedTool = executionCatalog.tools.find((tool) =>
    tool?._meta?.serviceId === serviceId && tool?._meta?.operationKey === "bounded");
  assert.ok(boundedTool);
  const boundedCall = await executionPeer.callTool(boundedTool.name, { body: {} });
  assert.ok(boundedCall.payload?.error || boundedCall.payload?.result?.structuredContent?.payload?.ok === false);
  assert.equal(fixture.state.largeCalls, 1);
  assert.equal(JSON.stringify(boundedCall.payload).includes("x".repeat(64)), false);
  observe("forward.response-byte-bound.rejected", "rejected", "replace", 1, 1);
  const timeoutTool = executionCatalog.tools.find((tool) =>
    tool?._meta?.serviceId === serviceId && tool?._meta?.operationKey === "timeout");
  assert.ok(timeoutTool);
  const timeoutCall = await executionPeer.callTool(timeoutTool.name, { body: {} });
  assert.ok(timeoutCall.payload?.error || timeoutCall.payload?.result?.structuredContent?.payload?.ok === false);
  assert.equal(fixture.state.slowCalls, 1);
  observe("forward.timeout.rejected", "rejected", "replace", 1, 1);
  const cancellationController = new AbortController();
  const cancellationRequest = fetch(`${server.url}/api/gateway/v1/forward`, {
    method: "POST",
    headers: ownerSession.write,
    body: JSON.stringify({ serviceId, operationKey: "timeout", body: {} }),
    signal: cancellationController.signal
  });
  setTimeout(() => cancellationController.abort(), 20);
  await assert.rejects(cancellationRequest, (error) => error?.name === "AbortError");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const cancellationAudit = await requestJson(`${server.url}/api/gateway/v1/audit`, { headers: ownerSession.read });
  assert.ok(cancellationAudit.payload?.items?.some((item) =>
    item?.payload?.operationKey === "timeout" && item?.payload?.reasonCode === "upstream_forward_cancelled"));
  observe("forward.cancellation.observed", "cancelled", "replace", 1, 1);
  const trafficCatalog = await trafficPeer.pullCatalog();
  const trafficTool = trafficCatalog.tools.find((tool) =>
    tool?._meta?.serviceId === serviceId && tool?._meta?.operationKey === "echo");
  assert.ok(trafficTool);
  const callsBeforeTraffic = fixture.state.calls;
  const admittedTraffic = await trafficPeer.callTool(trafficTool.name, { body: { value: "traffic" } });
  assert.equal(admittedTraffic.payload?.error, undefined);
  assert.equal(fixture.state.calls, callsBeforeTraffic + 1);
  observe("forward.traffic.admitted", "admitted", "replace", 1, 1);
  const rejectedTraffic = await trafficPeer.callTool(trafficTool.name, { body: { value: "rate-limited" } });
  assert.ok(rejectedTraffic.payload?.error);
  assert.equal(fixture.state.calls, callsBeforeTraffic + 1);
  observe("forward.traffic.rejected", "rejected", "replace", 1, 1);
  const deniedCall = await deniedPeer.callTool(upstreamTool.name, { body: { value: "denied" } });
  assert.ok(deniedCall.status === 403 || deniedCall.payload?.error);
  assert.equal(fixture.state.calls, 3);
  assert.equal(fixture.state.credentialCalls, 2);
  observe("forward.denied.rejected", "denied", "replace", 1, 1);

  const replaceOneCommand = command("replace", {
    serviceId,
    expectedServiceRevision: 1,
    expectedSetRevision: 1,
    idempotencyKey: "replace-verifier-one",
    fixtureUrl: fixture.url,
    label: "Verifier service one",
    tagPolicy: {
      allowTags: ["audience:allow"],
      requiredTags: ["audience:required"],
      denyTags: ["audience:deny"]
    }
  });
  const replacedOne = await publish(
    server.url, ownerSession, "PUT", `${collection}/${encodeURIComponent(serviceId)}`, replaceOneCommand
  );
  assert.equal(replacedOne.serviceRevision, 2);
  const replaceOneAuthority = await waitForPublicationAuthority({
    authority: manifestAuthority,
    baseUrl: server.url,
    session: ownerSession,
    serviceId,
    accepted: replacedOne
  });
  observe("replace.first.accepted", "accepted", "replace", 1, 2, 1, manifestCommitFact(replaceOneAuthority));
  observe("runtime.replace-first.visible", "visible", "replace", 1, 2, 1, runtimeSnapshotFact(replaceOneAuthority));
  const replaceOneCatalog = await waitForCatalogAdmission(executionPeer, {
    ...replaceOneAuthority,
    serviceId
  });
  observe("catalog.replace-first.admitted", "admitted", "replace", 1, 2, 1,
    catalogAdmissionFact(replaceOneAuthority, replaceOneCatalog.catalog));
  const tagAllowedCatalog = await allowedPeer.pullCatalog();
  const tagDeniedCatalog = await tagDeniedPeer.pullCatalog();
  assert.ok(tagAllowedCatalog.tools.some((tool) =>
    tool?._meta?.serviceId === serviceId && tool?._meta?.operationKey === "echo"));
  observe("audience.organization-team-role.admitted", "admitted", "replace", 2, 2);
  observe("audience.inherited-direct-tags.admitted", "admitted", "replace", 2, 2);
  assert.equal(tagDeniedCatalog.tools.some((tool) => tool?._meta?.serviceId === serviceId), false);
  observe("audience.deny-precedence.hidden", "hidden", "replace", 2, 2);
  const callsBeforeTagDeniedExecution = fixture.state.calls;
  const tagDeniedExecution = await tagDeniedPeer.callTool(upstreamTool.name, { body: { value: "tag-denied" } });
  assert.ok(tagDeniedExecution.status === 403 || tagDeniedExecution.payload?.error);
  assert.equal(fixture.state.calls, callsBeforeTagDeniedExecution);
  observe("audience.tag-denied.execution-rejected", "denied", "replace", 2, 2);

  const disconnectStream = await deniedPeer.openInvalidationStream();
  assert.equal(disconnectStream.ok, true);
  observe("protocol.revoked-stream.opened", "opened", "replace", 2, 2);
  const revoked = await requestJson(
    `${server.url}/api/operation-permission/v1/grants/${encodeURIComponent(deniedGrant.grantId)}/revoke`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({ reason: "verification_complete" })
    }
  );
  assert.equal(revoked.status, 200);
  observe("protocol.grant.revoked", "revoked", "replace", 2, 2);
  assert.equal(await Promise.race([
    disconnectStream.waitForClose(),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 5_000))
  ]), "closed");
  observe("protocol.revoked-stream.closed", "closed", "replace", 2, 2);
  await disconnectStream.close();

  const timeoutPeer = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: allowedGrant,
    proxySessionId: "neutral_timeout_session_001"
  });
  const timeoutStream = await timeoutPeer.openInvalidationStream();
  assert.equal(timeoutStream.ok, true);
  observe("protocol.timeout-stream.opened", "opened", "replace", 2, 2);
  const replaceTwoCommand = command("replace", {
    serviceId,
    expectedServiceRevision: 2,
    expectedSetRevision: 2,
    idempotencyKey: "replace-verifier-two",
    fixtureUrl: fixture.url,
    label: "Verifier service two"
  });
  const replacedTwo = await publish(
    server.url, ownerSession, "PUT", `${collection}/${encodeURIComponent(serviceId)}`, replaceTwoCommand
  );
  assert.equal(replacedTwo.serviceRevision, 3);
  const replaceTwoAuthority = await waitForPublicationAuthority({
    authority: manifestAuthority,
    baseUrl: server.url,
    session: ownerSession,
    serviceId,
    accepted: replacedTwo
  });
  observe("replace.second.accepted", "accepted", "replace", 2, 3, 1, manifestCommitFact(replaceTwoAuthority));
  observe("runtime.replace-second.visible", "visible", "replace", 2, 3, 1, runtimeSnapshotFact(replaceTwoAuthority));
  const replaceTwoCatalog = await waitForCatalogAdmission(executionPeer, {
    ...replaceTwoAuthority,
    serviceId
  });
  observe("catalog.replace-second.admitted", "admitted", "replace", 2, 3, 1,
    catalogAdmissionFact(replaceTwoAuthority, replaceTwoCatalog.catalog));
  const timeoutGrantUpdate = await requestJson(
    `${server.url}/api/operation-permission/v1/grants/${encodeURIComponent(allowedGrant.grantId)}`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({
        scopes: ["gateway:read"],
        toolsets: ["lico.gateway.read"],
        maxRisk: "read_only",
        metadata: { maxRisk: "read_only" },
        reason: "protocol_timeout_verification"
      })
    }
  );
  assert.equal(
    timeoutGrantUpdate.status,
    200,
    `Grant update failed: ${String(timeoutGrantUpdate.payload?.error?.code || "unknown")}`
  );
  observe("protocol.timeout-grant.updated", "updated", "replace", 3, 3);
  await timeoutStream.waitForInvalidation();
  observe("protocol.timeout-invalidation.received", "received", "replace", 3, 3);
  assert.equal(await Promise.race([
    timeoutStream.waitForClose(),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 12_000))
  ]), "closed");
  observe("protocol.timeout-stream.closed", "closed", "replace", 3, 3);
  await timeoutStream.close();
  const fencedReconnect = await timeoutPeer.openInvalidationStream();
  assert.equal(fencedReconnect.ok, false);
  assert.equal(fencedReconnect.status, 409);
  observe("protocol.same-session.fenced", "fenced", "reconnect", 3, 3);
  const freshPeer = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: allowedGrant,
    proxySessionId: "neutral_fresh_session_001"
  });
  const freshStream = await freshPeer.openInvalidationStream();
  assert.equal(freshStream.ok, true);
  observe("protocol.fresh-session.opened", "opened", "reconnect", 3, 3);
  await freshStream.close();

  const conflict = command("replace", {
    serviceId,
    expectedServiceRevision: 2,
    expectedSetRevision: 2,
    idempotencyKey: "replace-verifier-one",
    fixtureUrl: fixture.url,
    label: "Conflicting replay"
  });
  await publish(server.url, ownerSession, "PUT", `${collection}/${encodeURIComponent(serviceId)}`, conflict, 409);
  observe("replace.conflict.rejected", "rejected", "conflict", 3, 3);
  const stale = command("replace", {
    serviceId,
    expectedServiceRevision: 1,
    expectedSetRevision: 1,
    idempotencyKey: "stale-replace",
    fixtureUrl: fixture.url,
    label: "Stale"
  });
  await publish(server.url, ownerSession, "PUT", `${collection}/${encodeURIComponent(serviceId)}`, stale, 409);
  observe("replace.stale.rejected", "rejected", "stale", 3, 3);
  const failedCandidate = command("replace", {
    serviceId,
    expectedServiceRevision: 3,
    expectedSetRevision: 3,
    idempotencyKey: "invalid-candidate",
    fixtureUrl: fixture.url,
    label: "Invalid"
  });
  failedCandidate.descriptor.command = "prohibited";
  await publish(server.url, ownerSession, "PUT", `${collection}/${encodeURIComponent(serviceId)}`, failedCandidate, 400);
  observe("replace.invalid-command.rejected", "rejected", "invalid-command", 3, 3);

  const disabled = await publish(server.url, ownerSession, "POST", `${collection}/${encodeURIComponent(serviceId)}/disable`,
    command("disable", { serviceId, expectedServiceRevision: 3, expectedSetRevision: 3, idempotencyKey: "disable-service" }));
  assert.equal(disabled.serviceRevision, 4);
  const disableAuthority = await waitForPublicationAuthority({
    authority: manifestAuthority,
    baseUrl: server.url,
    session: ownerSession,
    serviceId,
    accepted: disabled,
    presence: "disabled"
  });
  observe("disable.accepted", "accepted", "disable", 3, 4, 1, manifestCommitFact(disableAuthority));
  observe("runtime.disable.visible", "visible", "disable", 3, 4, 1, runtimeSnapshotFact(disableAuthority));
  const disableCatalog = await waitForCatalogAdmission(executionPeer, {
    ...disableAuthority,
    serviceId,
    expectTool: false
  });
  observe("catalog.disable.admitted", "admitted", "disable", 3, 4, 1,
    catalogAdmissionFact(disableAuthority, disableCatalog.catalog));
  const removed = await publish(server.url, ownerSession, "DELETE", `${collection}/${encodeURIComponent(serviceId)}`,
    command("remove", { serviceId, expectedServiceRevision: 4, expectedSetRevision: 4, idempotencyKey: "remove-service" }));
  assert.equal(removed.serviceRevision, 5);
  const removeAuthority = await waitForPublicationAuthority({
    authority: manifestAuthority,
    baseUrl: server.url,
    session: ownerSession,
    serviceId,
    accepted: removed,
    presence: "absent"
  });
  observe("remove.accepted", "accepted", "remove", 4, 5, 1, manifestCommitFact(removeAuthority));
  observe("runtime.remove.visible", "visible", "remove", 4, 5, 1, runtimeSnapshotFact(removeAuthority));
  const removeCatalog = await waitForCatalogAdmission(executionPeer, {
    ...removeAuthority,
    serviceId,
    expectTool: false
  });
  observe("catalog.remove.admitted", "admitted", "remove", 4, 5, 1,
    catalogAdmissionFact(removeAuthority, removeCatalog.catalog));
  const republished = await publish(server.url, ownerSession, "POST", `${collection}/${encodeURIComponent(serviceId)}/republish`,
    command("republish", {
      serviceId,
      expectedServiceRevision: 5,
      expectedSetRevision: 5,
      idempotencyKey: "republish-service",
      fixtureUrl: fixture.url,
      includeDescriptor: true
  }));
  assert.equal(republished.serviceRevision, 6);
  const republishAuthority = await waitForPublicationAuthority({
    authority: manifestAuthority,
    baseUrl: server.url,
    session: ownerSession,
    serviceId,
    accepted: republished
  });
  observe("republish.accepted", "accepted", "republish", 5, 6, 1, manifestCommitFact(republishAuthority));
  observe("runtime.republish.visible", "visible", "republish", 5, 6, 1, runtimeSnapshotFact(republishAuthority));
  const republishCatalog = await waitForCatalogAdmission(executionPeer, {
    ...republishAuthority,
    serviceId
  });
  observe("catalog.republish.admitted", "admitted", "republish", 5, 6, 1,
    catalogAdmissionFact(republishAuthority, republishCatalog.catalog));
  const terminalPublicationFact = await waitForServerPublished({
    baseUrl: server.url,
    session: ownerSession,
    serviceId,
    authorityFact: republishAuthority,
    catalog: republishCatalog.catalog
  });
  observe("publication.republish.server-published", "server_published", "republish", 5, 6, 1,
    terminalPublicationFact);

  await server.close();
  servers.splice(servers.indexOf(server), 1);
  server = await startHttpServer({
    userDataPath,
    distPath: "",
    host: "127.0.0.1",
    port: 0,
    runtimeOptions: { disableFileLogging: true }
  });
  servers.push(server);
  const restartedSession = await login(server.url, owner.username, owner.password);
  const afterRestart = await requestJson(`${server.url}${collection}`, { headers: restartedSession.read });
  assert.equal(afterRestart.status, 200);
  assert.equal(afterRestart.payload.setRevision, 6);
  assert.equal(afterRestart.payload.services.some((item) => item.serviceId === serviceId), true);
  const restartAuthority = await waitForPublicationAuthority({
    authority: manifestAuthority,
    baseUrl: server.url,
    session: restartedSession,
    serviceId,
    accepted: republished
  });
  const restartedExecutionPeer = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: executionGrant,
    proxySessionId: "neutral_restart_session_001"
  });
  const restartCatalog = await waitForCatalogAdmission(restartedExecutionPeer, {
    ...restartAuthority,
    serviceId
  });
  const restartedTerminalFact = await waitForServerPublished({
    baseUrl: server.url,
    session: restartedSession,
    serviceId,
    authorityFact: restartAuthority,
    catalog: restartCatalog.catalog
  });
  observe("restart.snapshot-restored", "restored", "restart", 6, 6, 1,
    observationFact("runtime_restart", {
      ...restartAuthority,
      catalogRevision: restartCatalog.catalog.facts.catalogRevision,
      audienceRevision: restartCatalog.catalog.facts.audienceRevision,
      partitionCount: restartCatalog.catalog.facts.partitionKeys.length,
      protocolRevision: restartedTerminalFact.protocolRevision,
      publicationRefObserved: restartedTerminalFact.publicationRefObserved,
      counterDelta: { snapshotSwaps: 1 }
    }));

  const durationMs = Date.now() - startedAt;
  const sourceRevision = currentSourceTreeDigest(ROOT, { exclude: [UPSTREAM_SERVICE_PUBLISHING_REPORT_PATH] });
  const report = finalizeUpstreamServicePublishingReport({
    schemaVersion: UPSTREAM_SERVICE_PUBLISHING_REPORT_SCHEMA_VERSION,
    verifier: UPSTREAM_SERVICE_PUBLISHING_VERIFIER,
    generatedAt: new Date().toISOString(),
    producer: UPSTREAM_SERVICE_PUBLISHING_VERIFIER,
    commandId: UPSTREAM_SERVICE_PUBLISHING_COMMAND_ID,
    sourceRevision,
    requirements: [...UPSTREAM_SERVICE_PUBLISHING_REQUIREMENTS],
    deploymentMode: "temporary-isolated",
    observationSchemaVersion: UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_SCHEMA_VERSION,
    observations,
    resourceBudgets: { durationMs, maxDurationMs: 300_000, reportBytes: 0, maxReportBytes: 512 * 1024 }
  });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("Upstream service publishing server verification passed.");
}

try {
  await main();
} finally {
  await Promise.allSettled(servers.splice(0).reverse().map((server) => server.close()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  restoreCapabilityKernelEnv();
}

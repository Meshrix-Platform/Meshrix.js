#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import {
  compileUpstreamOperationCapability,
  upstreamOperationCapabilityId
} from "../../packages/agents/src/upstream-gateway/operation-capability.ts";
import { UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION } from "../../packages/agents/src/upstream-gateway/publishing-application.ts";
import { createConsoleAuth } from "../../packages/foundation/src/security/auth/console-auth.ts";
import { initializeLocalSecret } from "../../packages/foundation/src/security/secrets/local-secret-store.ts";
import { createStorageProvider } from "../../packages/foundation/src/storage/storage-provider.ts";
import { createTagStoreAdapter } from "../../packages/server-runtime/src/state/tags/tag-store.adapter.ts";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.ts";
import {
  createMcpCatalogProtocolPeer,
  issueNeutralMcpProtocolGrant
} from "./lib/mcp-catalog-protocol-peer.ts";
import { createUpstreamPublishingHostileCorpus } from "./lib/upstream-publishing-hostile-corpus.ts";
import { currentSourceTreeDigest } from "./lib/source-tree-digest.ts";
import { provisionVerifierLocalSecretKey } from "./lib/local-secret-verifier-key.ts";
import {
  UPSTREAM_SERVICE_PUBLISHING_COMMAND_ID,
  UPSTREAM_SERVICE_PUBLISHING_COUNTERS,
  UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_SCHEMA_VERSION,
  UPSTREAM_SERVICE_PUBLISHING_REPORT_PATH,
  UPSTREAM_SERVICE_PUBLISHING_REPORT_SCHEMA_VERSION,
  UPSTREAM_SERVICE_PUBLISHING_REQUIREMENTS,
  UPSTREAM_SERVICE_PUBLISHING_VERIFIER,
  finalizeUpstreamServicePublishingReport
} from "./lib/upstream-service-publishing-evidence.ts";

const ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reportPath: any = path.join(ROOT, UPSTREAM_SERVICE_PUBLISHING_REPORT_PATH);
const startedAt: any = Date.now();
const roots: any[] = [];
const servers: any[] = [];
const restoreCapabilityKernelEnv: any = useIsolatedCapabilityKernelForVerifier();
const localSecretKeyCustody: any = await provisionVerifierLocalSecretKey();
const PUBLISHING_SECRET_REF: any = "secret://verifier/upstream-publishing";
const PUBLISHING_SECRET_HEADER: any = "x-upstream-publishing-verifier";
const PUBLISHING_SECRET_VALUE: any = "synthetic-runtime-material";

const ZERO_COUNTER_DELTA: any = Object.freeze(Object.fromEntries(
  UPSTREAM_SERVICE_PUBLISHING_COUNTERS.map((counter?: any) : any => [counter, 0])
));

const DIRECT_COUNTER_FACTS: Readonly<Record<string, any>> = Object.freeze({
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

function observationFact(type: any = "assertion", {
  sourceRevision = 0,
  sourceDigest = "",
  catalogRevision = "",
  audienceRevision = 0,
  partitionCount = 0,
  protocolRevision = 0,
  publicationRefObserved = false,
  counterDelta = {}
}: Record<string, any> = {}) : any {
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

function cookieHeader(response?: any) : any {
  const values: any = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return values.map((value?: any) : any => value.split(";")[0]).join("; ");
}

async function login(baseUrl?: any, username?: any, password?: any) : Promise<any> {
  const response: any = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const payload: any = await response.json();
  assert.equal(response.status, 200);
  const cookie: any = cookieHeader(response);
  return {
    approval: { cookie, csrf: payload.csrfToken },
    read: { cookie },
    write: {
      cookie,
      "content-type": "application/json",
      "x-meshrix-csrf": payload.csrfToken,
      "x-meshrix-safety-confirm": "true"
    }
  };
}

function startLoopbackFixture() : any {
  const state: Record<string, any> = { calls: 0, credentialCalls: 0, approvalCalls: 0, largeCalls: 0, slowCalls: 0 };
  return new Promise((resolve?: any) : any => {
    const server: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
      const chunks: any[] = [];
      request.on("data", (chunk?: any) : any => chunks.push(chunk));
      await new Promise((done?: any) : any => request.on("end", done));
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
        setTimeout(() : any => {
          if (response.destroyed) return;
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ ok: true }));
        }, 300);
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    });
    server.listen(0, "127.0.0.1", () : any => {
      const address: any = server.address();
      resolve({ server, state, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function descriptor(fixtureUrl?: any, label: any = "Verifier service", tagPolicy: any = undefined) : any {
  const endpoint: any = new URL(fixtureUrl);
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

function structuredPayloadTransport(responseMaxBytes: any = 1024 * 1024) : any {
  return {
    request: { mode: "structured_json", maxBytes: 1024 * 1024, mediaTypes: ["application/json"] },
    response: { mode: "structured_json", maxBytes: responseMaxBytes, mediaTypes: ["application/json"] }
  };
}

function command(action?: any, {
  serviceId,
  expectedServiceRevision,
  expectedSetRevision,
  idempotencyKey,
  fixtureUrl,
  label,
  tagPolicy,
  includeDescriptor = ["create", "replace"].includes(action)
}: Record<string, any> = {}) : any {
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

async function requestJson(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(url, options);
  const text: any = await response.text();
  let payload: Record<string, any> = {};
  if (text.trim()) payload = JSON.parse(text);
  return { status: response.status, payload };
}

async function publish(baseUrl?: any, session?: any, method?: any, route?: any, body?: any, expectedStatus: any = 202) : Promise<any> {
  const result: any = await requestJson(`${baseUrl}${route}`, {
    method,
    headers: session.write,
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  assert.equal(result.status, expectedStatus);
  return result.payload;
}

async function waitForRuntimeService(baseUrl?: any, session?: any, serviceId?: any) : Promise<any> {
  for (let attempt: any = 0; attempt < 80; attempt += 1) {
    const result: any = await requestJson(`${baseUrl}/api/gateway/v1/external-services`, { headers: session.read });
    if (result.payload?.items?.some((item?: any) : any => item.serviceId === serviceId)) return result.payload;
    await new Promise((resolve?: any) : any => setTimeout(resolve, 25));
  }
  throw new Error("Published service did not reach the runtime snapshot.");
}

async function waitForPublicationAuthority({ authority, baseUrl, session, serviceId, accepted, presence = "present" }: Record<string, any>) : Promise<any> {
  for (let attempt: any = 0; attempt < 120; attempt += 1) {
    const [snapshot, control, runtime] = await Promise.all([
      authority.getCandidateSnapshot(),
      requestJson(`${baseUrl}/api/gateway/v1/services`, { headers: session.read }),
      requestJson(`${baseUrl}/api/gateway/v1/external-services`, { headers: session.read })
    ]);
    const controlService: any = control.payload?.services?.find((item?: any) : any => item.serviceId === serviceId) || null;
    const runtimeService: any = runtime.payload?.items?.find((item?: any) : any => item.serviceId === serviceId) || null;
    const controlMatches: any = control.status === 200 && control.payload?.setRevision === accepted.setRevision &&
      (!controlService || (controlService.serviceRevision === accepted.serviceRevision &&
        controlService.manifestDigest === accepted.manifestDigest));
    const runtimeMatches: any = presence === "absent"
      ? runtimeService === null
      : runtimeService?.serviceRevision === accepted.serviceRevision &&
        runtimeService?.manifestDigest === accepted.manifestDigest &&
        (presence !== "disabled" || runtimeService?.disabled === true);
    if (snapshot?.setRevision === accepted.setRevision && controlMatches && runtimeMatches) {
      return Object.freeze({ sourceRevision: snapshot.setRevision, sourceDigest: snapshot.setDigest });
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, 25));
  }
  throw new Error("Published control-plane, manifest authority, and runtime registry facts did not converge.");
}

async function waitForCatalogAdmission(peer: any, { sourceRevision, sourceDigest, serviceId, expectTool = true }: Record<string, any>) : Promise<any> {
  for (let attempt: any = 0; attempt < 120; attempt += 1) {
    const catalog: any = await peer.pullCatalog();
    const upstreamTool: any = catalog.tools.find((tool?: any) : any => tool?._meta?.serviceId === serviceId) || null;
    const toolMatches: any = expectTool
      ? upstreamTool?._meta?.sourceRevision === sourceRevision && upstreamTool?._meta?.sourceDigest === sourceDigest
      : upstreamTool === null;
    if (catalog.facts?.sourceRevision === sourceRevision && toolMatches &&
        /^[a-f0-9]{64}$/u.test(String(catalog.facts?.catalogRevision || "")) &&
        Number.isSafeInteger(catalog.facts?.audienceRevision) && catalog.facts.audienceRevision > 0 &&
        Array.isArray(catalog.facts?.partitionKeys) && catalog.facts.partitionKeys.length > 0) {
      return Object.freeze({ catalog, upstreamTool });
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, 25));
  }
  throw new Error("Operation Permission catalog and audience facts did not converge with the manifest authority.");
}

function manifestCommitFact(authorityFact?: any) : any {
  return observationFact("manifest_commit", { ...authorityFact, counterDelta: { writes: 1 } });
}

function runtimeSnapshotFact(authorityFact?: any, type: any = "runtime_snapshot") : any {
  return observationFact(type, { ...authorityFact, counterDelta: { snapshotSwaps: 1 } });
}

function catalogAdmissionFact(authorityFact?: any, catalog?: any, catalogPulls: any = 1) : any {
  return observationFact("catalog_audience_commit", {
    ...authorityFact,
    catalogRevision: catalog.facts.catalogRevision,
    audienceRevision: catalog.facts.audienceRevision,
    partitionCount: catalog.facts.partitionKeys.length,
    counterDelta: { catalogCommits: 1, publicationEvents: 1, catalogPulls }
  });
}

async function waitForServerPublished({ baseUrl, session, serviceId, authorityFact, catalog }: Record<string, any>) : Promise<any> {
  for (let attempt: any = 0; attempt < 120; attempt += 1) {
    const result: any = await requestJson(
      `${baseUrl}/api/gateway/v1/services/${encodeURIComponent(serviceId)}`,
      { headers: session.read }
    );
    const publication: any = result.payload?.service?.publication;
    const terminal: any = publication?.terminal;
    if (result.status === 200 && publication?.status === "server_published" &&
        /^urn:meshrix:upstream-publication:[a-f0-9]{64}$/u.test(String(publication.publicationRef || "")) &&
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
    await new Promise((resolve?: any) : any => setTimeout(resolve, 25));
  }
  throw new Error("Public upstream publication status did not reach a revision-consistent server terminal state.");
}

async function main() : Promise<any> {
  const observations: any[] = [];
  const observe: any = (id?: any, status?: any, scenario?: any, fromRevision?: any, toRevision?: any, count: any = 1, fact: any = null) : any => {
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
  const fixture: any = await startLoopbackFixture();
  servers.push({ close: () : any => new Promise((resolve?: any) : any => fixture.server.close(resolve)) });
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-publishing-"));
  roots.push(userDataPath);
  const manifestAuthority: any = createStorageProvider({ userDataPath }).getDurableManifestCandidateAuthorityPort();

  const tagStore: any = createTagStoreAdapter({ userDataPath });
  const auth: any = createConsoleAuth({ userDataPath, tagManagementStore: tagStore });
  const owner: any = await auth.ensureInitialOwner();
  const otherPassword: any = "other-admin-fixture-credential";
  const viewerPassword: any = "viewer-fixture-credential";
  await auth.createUser({ username: "other.admin", password: otherPassword, roleId: "admin" });
  await auth.createUser({ username: "read.viewer", password: viewerPassword, roleId: "viewer" });
  await auth.close();
  tagStore.close();

  let server: any = await startHttpServer({
    userDataPath,
    distPath: "",
    host: "127.0.0.1",
    port: 0,
    runtimeOptions: { disableFileLogging: true }
  });
  servers.push(server);
  const ownerSession: any = await login(server.url, owner.username, owner.password);
  const otherSession: any = await login(server.url, "other.admin", otherPassword);
  const viewerSession: any = await login(server.url, "read.viewer", viewerPassword);
  const collection: any = "/api/gateway/v1/services";
  const create: any = command("create", {
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

  const created: any = await publish(server.url, ownerSession, "POST", collection, create);
  assert.equal(created.serviceRevision, 1);
  assert.equal(created.setRevision, 1);
  const serviceId: any = created.serviceId;
  const createAuthority: any = await waitForPublicationAuthority({
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
  const replayed: any = await publish(server.url, ownerSession, "POST", collection, create);
  assert.equal(replayed.replayed, true);
  observe("create.idempotent-replay", "replayed", "identical-replay", 1, 1);
  const crossOwner: any = command("replace", {
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
  const hostileCorpus: any = createUpstreamPublishingHostileCorpus(fixture.url);
  for (const { id, raw } of hostileCorpus) {
    await publish(server.url, ownerSession, "POST", collection, raw, id === "byte-limit" ? 413 : 400);
    const rpc: any = await requestJson(`${server.url}/api/rpc`, {
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
  const projectedRpc: any = await requestJson(`${server.url}/api/rpc`, {
    method: "POST",
    headers: ownerSession.write,
    body: '{"jsonrpc":"2.0","id":"projected","method":"external_services.create","params":{"action":"create","action":"replace"}}'
  });
  assert.equal(projectedRpc.status, 200);
  assert.equal(projectedRpc.payload?.error?.code, 400);
  const afterHostileCorpus: any = await requestJson(`${server.url}${collection}`, { headers: ownerSession.read });
  assert.equal(afterHostileCorpus.payload?.setRevision, 1);
  assert.equal(afterHostileCorpus.payload?.services?.length, 1);
  assert.equal(fixture.state.calls, 0);
  observe("raw.hostile-corpus.rejected", "rejected", "conflict", 1, 1, hostileCorpus.length * 2 + 1);
  await waitForRuntimeService(server.url, ownerSession, serviceId);
  observe("runtime.create.visible", "visible", "create", 0, 1, 1, runtimeSnapshotFact(createAuthority));

  const capabilityId: any = upstreamOperationCapabilityId({ serviceId }, { operationKey: "echo" });
  const approvalCapabilityId: any = upstreamOperationCapabilityId({ serviceId }, { operationKey: "approval" });
  const boundedCapabilityId: any = upstreamOperationCapabilityId({ serviceId }, { operationKey: "bounded" });
  const timeoutCapabilityId: any = upstreamOperationCapabilityId({ serviceId }, { operationKey: "timeout" });
  const executionCapabilities: any[] = [capabilityId, approvalCapabilityId, boundedCapabilityId, timeoutCapabilityId];
  const credentialBindingIds: any = compileUpstreamOperationCapability(
    { serviceId, credentialRefs: [PUBLISHING_SECRET_REF] },
    { operationKey: "echo", protocol: "http", requiredScopes: ["gateway:write"], risk: "safe_write" }
  ).credentialBindingIds;
  const allowedGrant: any = await issueNeutralMcpProtocolGrant({
    server,
    approvalAuth: ownerSession.approval,
    peerId: "audience-allowed",
    toolsets: ["meshrix.gateway.read"],
    dynamicCapabilities: executionCapabilities,
    allowedServiceIds: [serviceId],
    allowedSecretBindings: credentialBindingIds,
    maxRisk: "read_only"
  });
  const deniedGrant: any = await issueNeutralMcpProtocolGrant({
    server,
    approvalAuth: ownerSession.approval,
    peerId: "audience-denied",
    toolsets: ["meshrix.gateway.read"],
    maxRisk: "read_only"
  });
  const executionGrant: any = await issueNeutralMcpProtocolGrant({
    server,
    approvalAuth: ownerSession.approval,
    peerId: "execution",
    toolsets: ["meshrix.gateway.write", "meshrix.gateway.read"],
    dynamicCapabilities: executionCapabilities,
    allowedServiceIds: [serviceId],
    allowedSecretBindings: credentialBindingIds,
    maxRisk: "safe_write"
  });
  const tagDeniedGrant: any = await issueNeutralMcpProtocolGrant({
    server,
    approvalAuth: ownerSession.approval,
    peerId: "audience-tag-denied",
    toolsets: ["meshrix.gateway.write", "meshrix.gateway.read"],
    dynamicCapabilities: [capabilityId],
    allowedServiceIds: [serviceId],
    allowedSecretBindings: credentialBindingIds,
    maxRisk: "safe_write"
  });
  const trafficGrant: any = await issueNeutralMcpProtocolGrant({
    server,
    approvalAuth: ownerSession.approval,
    peerId: "traffic",
    toolsets: ["meshrix.gateway.write", "meshrix.gateway.read"],
    dynamicCapabilities: [capabilityId],
    allowedServiceIds: [serviceId],
    allowedSecretBindings: credentialBindingIds,
    maxRisk: "safe_write"
  });
  const audienceTagStore: any = createTagStoreAdapter({ userDataPath });
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
  const allowedPeer: any = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: allowedGrant,
    proxySessionId: "neutral_allowed_session_001"
  });
  const deniedPeer: any = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: deniedGrant,
    proxySessionId: "neutral_denied_session_001"
  });
  const executionPeer: any = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: executionGrant,
    proxySessionId: "neutral_execution_session_001"
  });
  const tagDeniedPeer: any = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: tagDeniedGrant,
    proxySessionId: "neutral_tag_denied_session_001"
  });
  const trafficPeer: any = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: trafficGrant,
    proxySessionId: "neutral_traffic_session_001"
  });
  const allowedCatalog: any = await allowedPeer.pullCatalog();
  const deniedCatalog: any = await deniedPeer.pullCatalog();
  const executionCatalog: any = await executionPeer.pullCatalog();
  for (const catalog of [allowedCatalog, deniedCatalog, executionCatalog]) {
    assert.equal(catalog.facts.sourceRevision, createAuthority.sourceRevision);
    assert.equal(catalog.facts.catalogRevision, executionCatalog.facts.catalogRevision);
    assert.equal(catalog.facts.audienceRevision, executionCatalog.facts.audienceRevision);
  }
  const initialTool: any = executionCatalog.tools.find((tool?: any) : any => tool?._meta?.serviceId === serviceId);
  assert.equal(initialTool?._meta?.sourceDigest, createAuthority.sourceDigest);
  observe("catalog.initial.pulled", "pulled", "replace", 1, 1, 3,
    catalogAdmissionFact(createAuthority, executionCatalog, 3));
  assert.equal(allowedCatalog.tools.some((tool?: any) : any => tool?._meta?.serviceId === serviceId), false);
  assert.equal(deniedCatalog.tools.some((tool?: any) : any => tool?._meta?.serviceId === serviceId), false);
  observe("audience.initial.hidden", "hidden", "replace", 1, 1, 2);

  const tagDeniedGrantUpdate: any = await requestJson(
    `${server.url}/api/operation-permission/v1/grants/${encodeURIComponent(tagDeniedGrant.grantId)}`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({
        scopes: ["gateway:read", "gateway:write"],
        toolsets: ["meshrix.gateway.read", "meshrix.gateway.write"],
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
  const executionGrantUpdate: any = await requestJson(
    `${server.url}/api/operation-permission/v1/grants/${encodeURIComponent(executionGrant.grantId)}`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({
        scopes: ["gateway:read", "gateway:write"],
        toolsets: ["meshrix.gateway.read", "meshrix.gateway.write"],
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
  const trafficGrantUpdate: any = await requestJson(
    `${server.url}/api/operation-permission/v1/grants/${encodeURIComponent(trafficGrant.grantId)}`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({
        scopes: ["gateway:read", "gateway:write"],
        toolsets: ["meshrix.gateway.read", "meshrix.gateway.write"],
        maxRisk: "safe_write",
        rateLimit: { perMinute: 1 },
        metadata: { maxRisk: "safe_write" },
        reason: "traffic_admission_verification"
      })
    }
  );
  assert.equal(trafficGrantUpdate.status, 200);

  const ackStream: any = await allowedPeer.openInvalidationStream();
  assert.equal(ackStream.ok, true);
  observe("protocol.stream.opened", "opened", "replace", 1, 1);
  const unaffectedStream: any = await deniedPeer.openInvalidationStream();
  assert.equal(unaffectedStream.ok, true);
  observe("protocol.unaffected-stream.opened", "opened", "replace", 1, 1);
  const allowedGrantUpdate: any = await requestJson(
    `${server.url}/api/operation-permission/v1/grants/${encodeURIComponent(allowedGrant.grantId)}`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({
        scopes: ["gateway:read", "gateway:write"],
        toolsets: ["meshrix.gateway.read", "meshrix.gateway.write"],
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
  const invalidation: any = await ackStream.waitForInvalidation();
  observe("protocol.invalidation.received", "received", "replace", 1, 1);
  await assert.rejects(() : any => unaffectedStream.waitForInvalidation(300));
  observe("protocol.unaffected-stream.quiet", "preserved", "replace", 1, 1);
  const refreshed: any = await allowedPeer.pullCatalog();
  assert.ok(refreshed.tools.find((tool?: any) : any => tool?._meta?.serviceId === serviceId));
  observe("catalog.refresh.pulled", "pulled", "replace", 1, 1);
  const malformedAcknowledgement: any = await allowedPeer.acknowledge({
    ...refreshed.facts,
    audienceRevision: "invalid"
  }, invalidation.params.change.affectedPartitions);
  assert.notEqual(malformedAcknowledgement.payload?.result?.ok, true);
  observe("protocol.malformed-ack.rejected", "rejected", "replace", 1, 1);
  const staleAcknowledgement: any = await allowedPeer.acknowledge({
    ...refreshed.facts,
    sourceRevision: Math.max(0, refreshed.facts.sourceRevision - 1)
  }, invalidation.params.change.affectedPartitions);
  assert.notEqual(staleAcknowledgement.payload?.result?.ok, true);
  observe("protocol.stale-ack.rejected", "rejected", "replace", 1, 1);
  const acknowledgement: any = await allowedPeer.acknowledge(
    refreshed.facts,
    invalidation.params.change.affectedPartitions
  );
  assert.equal(acknowledgement.payload?.result?.ok, true);
  observe("protocol.exact-ack.accepted", "acknowledged", "replace", 1, 1);
  const duplicateAcknowledgement: any = await allowedPeer.acknowledge(
    refreshed.facts,
    invalidation.params.change.affectedPartitions
  );
  assert.notEqual(duplicateAcknowledgement.payload?.result?.ok, true);
  observe("protocol.duplicate-ack.rejected", "rejected", "replace", 1, 1);
  await ackStream.close();
  await unaffectedStream.close();
  const upstreamTool: any = executionCatalog.tools.find((tool?: any) : any =>
    tool?._meta?.serviceId === serviceId && tool?._meta?.operationKey === "echo");
  assert.ok(upstreamTool);
  const forwarded: any = await executionPeer.callTool(upstreamTool.name, { body: { value: "verified" } });
  assert.equal(
    forwarded.status,
    200,
    `Forwarding failed: ${String(forwarded.payload?.error?.data?.code || forwarded.payload?.error?.code || "unknown")}`
  );
  assert.equal(forwarded.payload?.error, undefined);
  observe("forward.allowed.accepted", "accepted", "replace", 1, 1);
  const publicForwardPayload: any = forwarded.payload?.result?.structuredContent?.payload;
  assert.equal(publicForwardPayload?.response?.json?.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(publicForwardPayload?.response?.json || {}, "echo"), false);
  assert.equal(JSON.stringify(forwarded.payload).includes("verified"), false);
  observe("forward.response-schema.validated", "validated", "replace", 1, 1);
  observe("forward.response-projection-redaction.observed", "observed", "replace", 1, 1);
  assert.equal(fixture.state.calls, 1);
  observe("forward.fixture-call.observed", "observed", "replace", 1, 1);
  assert.equal(fixture.state.credentialCalls, 1);
  observe("sensitive-reference.materialized", "observed", "replace", 1, 1);
  const approvalTool: any = executionCatalog.tools.find((tool?: any) : any =>
    tool?._meta?.serviceId === serviceId && tool?._meta?.operationKey === "approval");
  assert.ok(approvalTool);
  const approvalCallsBefore: any = fixture.state.approvalCalls;
  const pendingApproval: any = await executionPeer.callTool(approvalTool.name, { body: { value: "approved" } });
  const pendingApprovalPayload: any = pendingApproval.payload?.result?.structuredContent?.payload;
  assert.equal(pendingApprovalPayload?.status, "pending_approval");
  const pendingOperationId: any = String(pendingApprovalPayload?.pendingOperation?.pendingOperationId || "");
  assert.ok(pendingOperationId);
  assert.equal(fixture.state.approvalCalls, approvalCallsBefore);
  observe("forward.approval.pending", "pending", "replace", 1, 1);
  const resolvedApproval: any = await requestJson(
    `${server.url}/api/operation-permission/v1/pending-operations/${encodeURIComponent(pendingOperationId)}/resolve`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({ resolution: "approved", reason: "upstream_publishing_verification" })
    }
  );
  assert.equal(
    resolvedApproval.status,
    200,
    `Pending approval resolution failed: ${String(resolvedApproval.payload?.error?.code || "unknown")}`
  );
  assert.equal(resolvedApproval.payload?.pendingOperation?.status, "completed");
  observe("forward.approval.resolved", "approved", "replace", 1, 1);
  assert.equal(fixture.state.approvalCalls, approvalCallsBefore + 1);
  observe("forward.approval.fixture-call.observed", "observed", "replace", 1, 1);
  const replayedApproval: any = await requestJson(
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
  const boundedTool: any = executionCatalog.tools.find((tool?: any) : any =>
    tool?._meta?.serviceId === serviceId && tool?._meta?.operationKey === "bounded");
  assert.ok(boundedTool);
  const boundedCall: any = await executionPeer.callTool(boundedTool.name, { body: {} });
  assert.ok(boundedCall.payload?.error || boundedCall.payload?.result?.structuredContent?.payload?.ok === false);
  assert.equal(fixture.state.largeCalls, 1);
  assert.equal(JSON.stringify(boundedCall.payload).includes("x".repeat(64)), false);
  observe("forward.response-byte-bound.rejected", "rejected", "replace", 1, 1);
  const timeoutTool: any = executionCatalog.tools.find((tool?: any) : any =>
    tool?._meta?.serviceId === serviceId && tool?._meta?.operationKey === "timeout");
  assert.ok(timeoutTool);
  const timeoutCall: any = await executionPeer.callTool(timeoutTool.name, { body: {} });
  assert.ok(timeoutCall.payload?.error || timeoutCall.payload?.result?.structuredContent?.payload?.ok === false);
  assert.equal(fixture.state.slowCalls, 1);
  observe("forward.timeout.rejected", "rejected", "replace", 1, 1);
  const cancellationController: any = new AbortController();
  const cancellationRequest: any = fetch(`${server.url}/api/gateway/v1/forward`, {
    method: "POST",
    headers: ownerSession.write,
    body: JSON.stringify({ serviceId, operationKey: "timeout", body: {} }),
    signal: cancellationController.signal
  });
  setTimeout(() : any => cancellationController.abort(), 20);
  await assert.rejects(cancellationRequest, (error?: any) : any => error?.name === "AbortError");
  await new Promise((resolve?: any) : any => setTimeout(resolve, 150));
  const cancellationAudit: any = await requestJson(`${server.url}/api/gateway/v1/audit`, { headers: ownerSession.read });
  assert.ok(cancellationAudit.payload?.items?.some((item?: any) : any =>
    item?.payload?.operationKey === "timeout" && item?.payload?.reasonCode === "upstream_forward_cancelled"));
  observe("forward.cancellation.observed", "cancelled", "replace", 1, 1);
  const trafficCatalog: any = await trafficPeer.pullCatalog();
  const trafficTool: any = trafficCatalog.tools.find((tool?: any) : any =>
    tool?._meta?.serviceId === serviceId && tool?._meta?.operationKey === "echo");
  assert.ok(trafficTool);
  const callsBeforeTraffic: any = fixture.state.calls;
  const admittedTraffic: any = await trafficPeer.callTool(trafficTool.name, { body: { value: "traffic" } });
  assert.equal(admittedTraffic.payload?.error, undefined);
  assert.equal(fixture.state.calls, callsBeforeTraffic + 1);
  observe("forward.traffic.admitted", "admitted", "replace", 1, 1);
  const rejectedTraffic: any = await trafficPeer.callTool(trafficTool.name, { body: { value: "rate-limited" } });
  assert.ok(rejectedTraffic.payload?.error);
  assert.equal(fixture.state.calls, callsBeforeTraffic + 1);
  observe("forward.traffic.rejected", "rejected", "replace", 1, 1);
  const deniedCall: any = await deniedPeer.callTool(upstreamTool.name, { body: { value: "denied" } });
  assert.ok(deniedCall.status === 403 || deniedCall.payload?.error);
  assert.equal(fixture.state.calls, 3);
  assert.equal(fixture.state.credentialCalls, 2);
  observe("forward.denied.rejected", "denied", "replace", 1, 1);

  const replaceOneCommand: any = command("replace", {
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
  const replacedOne: any = await publish(
    server.url, ownerSession, "PUT", `${collection}/${encodeURIComponent(serviceId)}`, replaceOneCommand
  );
  assert.equal(replacedOne.serviceRevision, 2);
  const replaceOneAuthority: any = await waitForPublicationAuthority({
    authority: manifestAuthority,
    baseUrl: server.url,
    session: ownerSession,
    serviceId,
    accepted: replacedOne
  });
  observe("replace.first.accepted", "accepted", "replace", 1, 2, 1, manifestCommitFact(replaceOneAuthority));
  observe("runtime.replace-first.visible", "visible", "replace", 1, 2, 1, runtimeSnapshotFact(replaceOneAuthority));
  const replaceOneCatalog: any = await waitForCatalogAdmission(executionPeer, {
    ...replaceOneAuthority,
    serviceId
  });
  observe("catalog.replace-first.admitted", "admitted", "replace", 1, 2, 1,
    catalogAdmissionFact(replaceOneAuthority, replaceOneCatalog.catalog));
  const tagAllowedCatalog: any = await allowedPeer.pullCatalog();
  const tagDeniedCatalog: any = await tagDeniedPeer.pullCatalog();
  assert.ok(tagAllowedCatalog.tools.some((tool?: any) : any =>
    tool?._meta?.serviceId === serviceId && tool?._meta?.operationKey === "echo"));
  observe("audience.organization-team-role.admitted", "admitted", "replace", 2, 2);
  observe("audience.inherited-direct-tags.admitted", "admitted", "replace", 2, 2);
  assert.equal(tagDeniedCatalog.tools.some((tool?: any) : any => tool?._meta?.serviceId === serviceId), false);
  observe("audience.deny-precedence.hidden", "hidden", "replace", 2, 2);
  const callsBeforeTagDeniedExecution: any = fixture.state.calls;
  const tagDeniedExecution: any = await tagDeniedPeer.callTool(upstreamTool.name, { body: { value: "tag-denied" } });
  assert.ok(tagDeniedExecution.status === 403 || tagDeniedExecution.payload?.error);
  assert.equal(fixture.state.calls, callsBeforeTagDeniedExecution);
  observe("audience.tag-denied.execution-rejected", "denied", "replace", 2, 2);

  const disconnectStream: any = await deniedPeer.openInvalidationStream();
  assert.equal(disconnectStream.ok, true);
  observe("protocol.revoked-stream.opened", "opened", "replace", 2, 2);
  const revoked: any = await requestJson(
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
    new Promise((resolve?: any) : any => setTimeout(() : any => resolve("timeout"), 5_000))
  ]), "closed");
  observe("protocol.revoked-stream.closed", "closed", "replace", 2, 2);
  await disconnectStream.close();

  const timeoutPeer: any = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: allowedGrant,
    proxySessionId: "neutral_timeout_session_001"
  });
  const timeoutStream: any = await timeoutPeer.openInvalidationStream();
  assert.equal(timeoutStream.ok, true);
  observe("protocol.timeout-stream.opened", "opened", "replace", 2, 2);
  const replaceTwoCommand: any = command("replace", {
    serviceId,
    expectedServiceRevision: 2,
    expectedSetRevision: 2,
    idempotencyKey: "replace-verifier-two",
    fixtureUrl: fixture.url,
    label: "Verifier service two"
  });
  const replacedTwo: any = await publish(
    server.url, ownerSession, "PUT", `${collection}/${encodeURIComponent(serviceId)}`, replaceTwoCommand
  );
  assert.equal(replacedTwo.serviceRevision, 3);
  const replaceTwoAuthority: any = await waitForPublicationAuthority({
    authority: manifestAuthority,
    baseUrl: server.url,
    session: ownerSession,
    serviceId,
    accepted: replacedTwo
  });
  observe("replace.second.accepted", "accepted", "replace", 2, 3, 1, manifestCommitFact(replaceTwoAuthority));
  observe("runtime.replace-second.visible", "visible", "replace", 2, 3, 1, runtimeSnapshotFact(replaceTwoAuthority));
  const replaceTwoCatalog: any = await waitForCatalogAdmission(executionPeer, {
    ...replaceTwoAuthority,
    serviceId
  });
  observe("catalog.replace-second.admitted", "admitted", "replace", 2, 3, 1,
    catalogAdmissionFact(replaceTwoAuthority, replaceTwoCatalog.catalog));
  const timeoutGrantUpdate: any = await requestJson(
    `${server.url}/api/operation-permission/v1/grants/${encodeURIComponent(allowedGrant.grantId)}`,
    {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify({
        scopes: ["gateway:read"],
        toolsets: ["meshrix.gateway.read"],
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
    new Promise((resolve?: any) : any => setTimeout(() : any => resolve("timeout"), 12_000))
  ]), "closed");
  observe("protocol.timeout-stream.closed", "closed", "replace", 3, 3);
  await timeoutStream.close();
  const fencedReconnect: any = await timeoutPeer.openInvalidationStream();
  assert.equal(fencedReconnect.ok, false);
  assert.equal(fencedReconnect.status, 409);
  observe("protocol.same-session.fenced", "fenced", "reconnect", 3, 3);
  const freshPeer: any = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: allowedGrant,
    proxySessionId: "neutral_fresh_session_001"
  });
  const freshStream: any = await freshPeer.openInvalidationStream();
  assert.equal(freshStream.ok, true);
  observe("protocol.fresh-session.opened", "opened", "reconnect", 3, 3);
  await freshStream.close();

  const conflict: any = command("replace", {
    serviceId,
    expectedServiceRevision: 2,
    expectedSetRevision: 2,
    idempotencyKey: "replace-verifier-one",
    fixtureUrl: fixture.url,
    label: "Conflicting replay"
  });
  await publish(server.url, ownerSession, "PUT", `${collection}/${encodeURIComponent(serviceId)}`, conflict, 409);
  observe("replace.conflict.rejected", "rejected", "conflict", 3, 3);
  const stale: any = command("replace", {
    serviceId,
    expectedServiceRevision: 1,
    expectedSetRevision: 1,
    idempotencyKey: "stale-replace",
    fixtureUrl: fixture.url,
    label: "Stale"
  });
  await publish(server.url, ownerSession, "PUT", `${collection}/${encodeURIComponent(serviceId)}`, stale, 409);
  observe("replace.stale.rejected", "rejected", "stale", 3, 3);
  const failedCandidate: any = command("replace", {
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

  const disabled: any = await publish(server.url, ownerSession, "POST", `${collection}/${encodeURIComponent(serviceId)}/disable`,
    command("disable", { serviceId, expectedServiceRevision: 3, expectedSetRevision: 3, idempotencyKey: "disable-service" }));
  assert.equal(disabled.serviceRevision, 4);
  const disableAuthority: any = await waitForPublicationAuthority({
    authority: manifestAuthority,
    baseUrl: server.url,
    session: ownerSession,
    serviceId,
    accepted: disabled,
    presence: "disabled"
  });
  observe("disable.accepted", "accepted", "disable", 3, 4, 1, manifestCommitFact(disableAuthority));
  observe("runtime.disable.visible", "visible", "disable", 3, 4, 1, runtimeSnapshotFact(disableAuthority));
  const disableCatalog: any = await waitForCatalogAdmission(executionPeer, {
    ...disableAuthority,
    serviceId,
    expectTool: false
  });
  observe("catalog.disable.admitted", "admitted", "disable", 3, 4, 1,
    catalogAdmissionFact(disableAuthority, disableCatalog.catalog));
  const removed: any = await publish(server.url, ownerSession, "DELETE", `${collection}/${encodeURIComponent(serviceId)}`,
    command("remove", { serviceId, expectedServiceRevision: 4, expectedSetRevision: 4, idempotencyKey: "remove-service" }));
  assert.equal(removed.serviceRevision, 5);
  const removeAuthority: any = await waitForPublicationAuthority({
    authority: manifestAuthority,
    baseUrl: server.url,
    session: ownerSession,
    serviceId,
    accepted: removed,
    presence: "absent"
  });
  observe("remove.accepted", "accepted", "remove", 4, 5, 1, manifestCommitFact(removeAuthority));
  observe("runtime.remove.visible", "visible", "remove", 4, 5, 1, runtimeSnapshotFact(removeAuthority));
  const removeCatalog: any = await waitForCatalogAdmission(executionPeer, {
    ...removeAuthority,
    serviceId,
    expectTool: false
  });
  observe("catalog.remove.admitted", "admitted", "remove", 4, 5, 1,
    catalogAdmissionFact(removeAuthority, removeCatalog.catalog));
  const republished: any = await publish(server.url, ownerSession, "POST", `${collection}/${encodeURIComponent(serviceId)}/republish`,
    command("republish", {
      serviceId,
      expectedServiceRevision: 5,
      expectedSetRevision: 5,
      idempotencyKey: "republish-service",
      fixtureUrl: fixture.url,
      includeDescriptor: true
  }));
  assert.equal(republished.serviceRevision, 6);
  const republishAuthority: any = await waitForPublicationAuthority({
    authority: manifestAuthority,
    baseUrl: server.url,
    session: ownerSession,
    serviceId,
    accepted: republished
  });
  observe("republish.accepted", "accepted", "republish", 5, 6, 1, manifestCommitFact(republishAuthority));
  observe("runtime.republish.visible", "visible", "republish", 5, 6, 1, runtimeSnapshotFact(republishAuthority));
  const republishCatalog: any = await waitForCatalogAdmission(executionPeer, {
    ...republishAuthority,
    serviceId
  });
  observe("catalog.republish.admitted", "admitted", "republish", 5, 6, 1,
    catalogAdmissionFact(republishAuthority, republishCatalog.catalog));
  const terminalPublicationFact: any = await waitForServerPublished({
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
  const restartedSession: any = await login(server.url, owner.username, owner.password);
  const afterRestart: any = await requestJson(`${server.url}${collection}`, { headers: restartedSession.read });
  assert.equal(afterRestart.status, 200);
  assert.equal(afterRestart.payload.setRevision, 6);
  assert.equal(afterRestart.payload.services.some((item?: any) : any => item.serviceId === serviceId), true);
  const restartAuthority: any = await waitForPublicationAuthority({
    authority: manifestAuthority,
    baseUrl: server.url,
    session: restartedSession,
    serviceId,
    accepted: republished
  });
  const restartedExecutionPeer: any = createMcpCatalogProtocolPeer({
    baseUrl: server.url,
    grant: executionGrant,
    proxySessionId: "neutral_restart_session_001"
  });
  const restartCatalog: any = await waitForCatalogAdmission(restartedExecutionPeer, {
    ...restartAuthority,
    serviceId
  });
  const restartedTerminalFact: any = await waitForServerPublished({
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

  const durationMs: any = Date.now() - startedAt;
  const sourceRevision: any = currentSourceTreeDigest(ROOT, {
    exclude: [UPSTREAM_SERVICE_PUBLISHING_REPORT_PATH]
  });
  const report: any = finalizeUpstreamServicePublishingReport({
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
  await Promise.allSettled(servers.splice(0).reverse().map((server?: any) : any => server.close()));
  await Promise.allSettled(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
  await localSecretKeyCustody.close();
  restoreCapabilityKernelEnv();
}

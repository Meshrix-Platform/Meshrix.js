import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUpstreamPublishingApplication,
  UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION
} from "../../../packages/agents/src/upstream-gateway/publishing-application.mjs";
import { createServiceManifestStore } from "../../../packages/foundation/src/storage/service-manifest-store.mjs";
import { structuredJsonPayloadTransport } from "../../helpers/upstream-runtime-snapshot.mjs";

const roots = [];

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-publishing-"));
  roots.push(root);
  return root;
}

function command(overrides = {}) {
  return JSON.stringify({
    schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
    action: "create",
    serviceKey: "inventory",
    expectedServiceRevision: 0,
    expectedSetRevision: 0,
    idempotencyKey: "create-inventory",
    descriptor: {
      serviceProtocol: "http",
      label: "Inventory",
      baseUrl: "https://service.invalid:443",
      references: [{
        type: "credential",
        reference: "credential://vault/inventory",
        revision: 1,
        use: "request-auth",
        protocol: "https"
      }],
      operations: [{
        operationKey: "lookup",
        method: "GET",
        path: "/items",
        payloadTransport: structuredJsonPayloadTransport()
      }]
    },
    ...overrides
  });
}

function subject(subjectId = "developer-one", scopes = ["gateway:write", "gateway:maintain"]) {
  return { subjectId, scopes };
}

async function harness() {
  const store = createServiceManifestStore({ storageRoot: await temporaryRoot() });
  const audit = [];
  const commitManifestSet = vi.fn((input) => store.writerPort.commitManifestSet(input));
  const application = createUpstreamPublishingApplication({
    writerPort: { commitManifestSet },
    readerPort: { getSnapshot: store.getCandidateSnapshot },
    auditPort: { append: async (event) => audit.push(event) }
  });
  return { application, audit, commitManifestSet, store };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("upstream publishing application", () => {
  it("rejects missing authentication and scope before a durable write", async () => {
    const { application, commitManifestSet } = await harness();
    await expect(application.execute(command(), null)).rejects.toMatchObject({
      code: "upstream_publishing_authentication_required",
      statusCode: 401
    });
    await expect(application.execute(command(), subject("developer", []))).rejects.toMatchObject({
      code: "upstream_publishing_scope_required",
      statusCode: 403
    });
    expect(commitManifestSet).not.toHaveBeenCalled();
  });

  it("binds an opaque identity to the authenticated owner and persists typed references without defaults", async () => {
    const { application, audit, store } = await harness();
    const result = await application.execute(command(), subject());
    expect(result).toMatchObject({ ok: true, state: "publishing", serviceRevision: 1, setRevision: 1, replayed: false });
    expect(result.serviceId).toMatch(/^svc_[A-Za-z0-9_-]{43}$/u);
    expect(result).not.toHaveProperty("descriptor");
    expect(result).not.toHaveProperty("ownerSubjectId");

    const record = (await store.getCandidateSnapshot()).getService(result.serviceId);
    expect(record.manifest.references).toEqual([expect.objectContaining({
      type: "credential",
      reference: "credential://vault/inventory",
      revision: 1
    })]);
    expect(record.manifest.payload.descriptor).toEqual({
      baseUrl: "https://service.invalid:443",
      label: "Inventory",
      operations: [{
        method: "GET",
        operationKey: "lookup",
        path: "/items",
        payloadTransport: structuredJsonPayloadTransport()
      }],
      serviceProtocol: "http"
    });
    expect(record.manifest.payload.descriptor).not.toHaveProperty("visibility");
    expect(record.manifest.payload.descriptor).not.toHaveProperty("trafficPolicy");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain("developer-one");
    expect(JSON.stringify(audit[0])).not.toContain("service.invalid");
    expect(JSON.stringify(audit[0])).not.toContain("vault/inventory");
  });

  it("projects publishing until the durable terminal snapshot and paired revision facts agree", async () => {
    const store = createServiceManifestStore({ storageRoot: await temporaryRoot() });
    let publicationFacts = null;
    const application = createUpstreamPublishingApplication({
      writerPort: store.writerPort,
      readerPort: { getSnapshot: store.getCandidateSnapshot },
      publishedReaderPort: store.readerPort,
      getPublicationFacts: () => publicationFacts,
      auditPort: { append: async () => {} }
    });
    const created = await application.execute(command(), subject());
    const readerSubject = subject("developer-one", ["gateway:read", "gateway:write", "gateway:maintain"]);
    expect(created.publication).toMatchObject({ status: "publishing", candidateRevision: 1 });
    expect((await application.get(created.serviceId, readerSubject)).service.publication.status).toBe("publishing");

    const candidate = await store.getCandidateSnapshot();
    await store.acknowledgePublished({
      setRevision: candidate.setRevision,
      setDigest: candidate.setDigest
    });
    publicationFacts = Object.freeze({
      ready: true,
      sourceRevision: candidate.setRevision,
      sourceDigest: candidate.setDigest,
      catalogRevision: "catalog-revision",
      audienceRevision: 3,
      protocolRevision: 3
    });
    expect((await application.get(created.serviceId, readerSubject)).service.publication).toMatchObject({
      status: "server_published",
      terminal: {
        sourceRevision: 1,
        sourceDigest: candidate.setDigest,
        catalogRevision: "catalog-revision",
        audienceRevision: 3,
        protocolRevision: 3
      }
    });
  });

  it("rejects non-reference sensitive material before audit or durable write", async () => {
    const { application, audit, commitManifestSet, store } = await harness();
    const invalidReferences = [
      {
        type: "credential",
        reference: "credential://vault/inventory",
        revision: 1,
        use: "request-auth",
        secretValue: "fixture-material"
      },
      {
        type: "certificate",
        reference: "-----BEGIN CERTIFICATE-----fixture",
        revision: 1,
        use: "server-auth"
      },
      {
        type: "private-key",
        reference: "secret://vault/signing-key",
        revision: 1,
        use: "request-signing"
      },
      {
        type: "trust-anchor",
        reference: "trust-anchor://vault/service-root",
        revision: 1,
        use: "server-auth",
        resolvedMaterial: "fixture-material"
      }
    ];

    for (const reference of invalidReferences) {
      const input = JSON.parse(command());
      input.descriptor.references = [reference];
      await expect(application.execute(JSON.stringify(input), subject())).rejects.toMatchObject({
        code: expect.stringMatching(/^storage_manifest_/u)
      });
    }

    const rawMaterialCommands = [
      (() => {
        const input = JSON.parse(command());
        input.descriptor.description = "sk-syntheticmaterial";
        return input;
      })(),
      (() => {
        const input = JSON.parse(command());
        input.descriptor.operations[0].requestSchema = {
          type: "string",
          const: ["eyJsyntheticHeader", "eyJsyntheticPayload", "syntheticSignature"].join(".")
        };
        return input;
      })(),
      (() => {
        const input = JSON.parse(command());
        input.descriptor.references[0].reference = "credential://vault/sk-syntheticmaterial";
        return input;
      })()
    ];
    for (const input of rawMaterialCommands) {
      await expect(application.execute(JSON.stringify(input), subject())).rejects.toMatchObject({
        code: "storage_manifest_sensitive_material"
      });
    }

    expect(commitManifestSet).not.toHaveBeenCalled();
    expect(audit).toEqual([]);
    expect((await store.getCandidateSnapshot()).setRevision).toBe(0);
  });

  it("returns the durable result for identical replay and rejects conflicting reuse", async () => {
    const { application, store } = await harness();
    const first = await application.execute(command(), subject());
    const replay = await application.execute(command(), subject());
    expect(replay).toEqual({ ...first, replayed: true });

    const conflicting = JSON.parse(command());
    conflicting.descriptor.label = "Changed";
    await expect(application.execute(JSON.stringify(conflicting), subject())).rejects.toMatchObject({
      code: "storage_manifest_replay_conflict",
      statusCode: 409
    });
    expect((await store.getCandidateSnapshot()).setRevision).toBe(1);
  });

  it("enforces ownership and expected revisions before replacement", async () => {
    const { application, store } = await harness();
    const created = await application.execute(command(), subject());
    const replace = command({
      action: "replace",
      serviceKey: undefined,
      serviceId: created.serviceId,
      expectedServiceRevision: 1,
      expectedSetRevision: 1,
      idempotencyKey: "replace-inventory"
    });
    await expect(application.execute(replace, subject("developer-two"))).rejects.toMatchObject({
      code: "upstream_publishing_owner_required",
      statusCode: 403
    });

    const stale = JSON.parse(replace);
    stale.expectedServiceRevision = 0;
    await expect(application.execute(JSON.stringify(stale), subject())).rejects.toMatchObject({
      code: "storage_manifest_service_revision_stale",
      statusCode: 409
    });
    expect((await store.getCandidateSnapshot()).setRevision).toBe(1);
  });

  it("persists disable and removal as monotonic reference-free tombstones", async () => {
    const { application, store } = await harness();
    const created = await application.execute(command(), subject());
    const disabled = await application.execute(command({
      action: "disable",
      serviceKey: undefined,
      serviceId: created.serviceId,
      descriptor: undefined,
      expectedServiceRevision: 1,
      expectedSetRevision: 1,
      idempotencyKey: "disable-inventory"
    }), subject());
    expect(disabled).toMatchObject({ state: "disabled", serviceRevision: 2, setRevision: 2 });

    const removed = await application.execute(command({
      action: "remove",
      serviceKey: undefined,
      serviceId: created.serviceId,
      descriptor: undefined,
      expectedServiceRevision: 2,
      expectedSetRevision: 2,
      idempotencyKey: "remove-inventory"
    }), subject());
    expect(removed).toMatchObject({ state: "removed", serviceRevision: 3, setRevision: 3 });
    const tombstone = (await store.getCandidateSnapshot()).getService(created.serviceId).manifest;
    expect(tombstone.references).toEqual([]);
    expect(tombstone.payload).toEqual({ state: "removed" });
  });

  it("rejects duplicate, unknown, implicit protocol, local-process and raw-secret input before persistence", async () => {
    const { application, audit, commitManifestSet } = await harness();
    const cases = [
      command().replace('"action":"create"', '"action":"create","action":"replace"'),
      command({ unsupported: true }),
      command({ descriptor: { label: "Missing protocol" } }),
      command({ descriptor: { serviceProtocol: "mcp", command: "tool" } }),
      command({ descriptor: { serviceProtocol: "http", password: "raw-material" } }),
      command({ descriptor: { serviceProtocol: "http", baseUrl: "file:///local/service", operations: [] } }),
      command({ descriptor: { serviceProtocol: "http", baseUrl: "https://service.invalid:443", permissions: { command: "tool" } } }),
      command({ descriptor: {
        serviceProtocol: "http",
        baseUrl: "https://service.invalid:443",
        operations: [{
          operationKey: "read",
          method: "GET",
          path: "/read",
          shell: "tool",
          payloadTransport: structuredJsonPayloadTransport()
        }]
      } })
    ];
    for (const input of cases) {
      await expect(application.execute(input, subject())).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(commitManifestSet).not.toHaveBeenCalled();
    expect(audit).toEqual([]);
  });

  it("fails closed when redacted audit persistence fails", async () => {
    const store = createServiceManifestStore({ storageRoot: await temporaryRoot() });
    const commitManifestSet = vi.fn((input) => store.writerPort.commitManifestSet(input));
    const application = createUpstreamPublishingApplication({
      writerPort: { commitManifestSet },
      readerPort: { getSnapshot: store.getCandidateSnapshot },
      auditPort: { append: async () => { throw new Error("audit unavailable"); } }
    });
    await expect(application.execute(command(), subject())).rejects.toThrow("audit unavailable");
    expect(commitManifestSet).not.toHaveBeenCalled();
  });

  it("round-trips every publishing field while keeping typed references separate and owner-scoped", async () => {
    const { application } = await harness();
    const descriptor = {
      serviceProtocol: "json-rpc",
      label: "Catalog",
      description: "Explicit fixture",
      baseUrl: "https://service.invalid:443/rpc",
      endpoints: [{ endpointId: "primary", baseUrl: "https://service.invalid:443/rpc", weight: 1 }],
      healthPath: "/health",
      allowLocalNetwork: false,
      visibility: "organization",
      dataClass: "internal",
      tags: ["catalog"],
      references: [{
        type: "certificate",
        reference: "certificate://authority/catalog",
        revision: 2,
        use: "server-auth",
        host: "service.invalid",
        protocol: "https",
        scopes: ["connect"]
      }, {
        type: "credential",
        reference: "credential://vault/catalog",
        revision: 3,
        use: "request-auth"
      }, {
        type: "private-key",
        reference: "private-key://vault/catalog-signing",
        revision: 4,
        use: "request-signing"
      }, {
        type: "trust-anchor",
        reference: "trust-anchor://authority/catalog-root",
        revision: 5,
        use: "server-auth"
      }],
      interfaceSchemas: { request: { type: "object" }, response: { type: "object" } },
      permissions: { requiredScopes: ["catalog:read"] },
      approvalPolicy: { required: true, scope: "catalog:approve" },
      trafficPolicy: { perMinute: 30, burst: 5 },
      audience: {
        organizations: ["org-a"], teams: ["team-a"], roles: ["operator"], directGrants: ["grant-a"]
      },
      tagPolicy: { requiredTags: ["catalog"] },
      circuitBreaker: { enabled: true, failureThreshold: 3 },
      operations: [{
        operationKey: "list", method: "POST", path: "/rpc", requiredScopes: ["catalog:read"],
        jsonRpcMethod: "catalog.list",
        requestSchema: { type: "object" }, responseSchema: { type: "object" },
        payloadTransport: structuredJsonPayloadTransport({ requestMaxBytes: 4096, responseMaxBytes: 4096 })
      }]
    };
    const created = await application.execute(command({ descriptor }), subject());
    const detail = await application.get(created.serviceId, subject("developer-one", ["gateway:read"]));
    expect(detail.service.descriptor).toEqual(Object.fromEntries(
      Object.entries(descriptor).filter(([key]) => key !== "references")
    ));
    expect(detail.service.references).toEqual([...descriptor.references].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    ));
    expect((await application.list(subject("developer-two", ["gateway:read"]))).services).toEqual([]);
    await expect(application.get(created.serviceId, subject("developer-two", ["gateway:read"])))
      .rejects.toMatchObject({ code: "upstream_publishing_owner_required", statusCode: 403 });
  });
});

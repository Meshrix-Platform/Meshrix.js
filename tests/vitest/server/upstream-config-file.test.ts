import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createUpstreamGatewayRegistry,
  createUpstreamManifestObserver,
  createUpstreamPublishingApplication,
  UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION
} from "../../../packages/agents/src/upstream-gateway/index.ts";
import { createUpstreamConfigFileLoader } from "../../../packages/server-runtime/src/composition/upstream-config-file.ts";
import {
  listLocalSecretEntries,
  resolveLocalSecretPayload
} from "../../../packages/foundation/src/security/secrets/local-secret-store.ts";
import { createMemoryLocalSecretKeyProvider } from "../../../packages/foundation/src/security/secrets/local-secret-key-provider.ts";
import { createServiceManifestStore } from "../../../packages/foundation/src/storage/service-manifest-store.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";
import {
  createFinalProtectedSinkAttempt,
  digestFinalProtectedSinkInput
} from "#meshrix/foundation/security/final-protected-sink-permit";

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const MARKER_A = "SYNTHETIC_BEARER_MARKER_0123456789";
const MARKER_B = "SYNTHETIC_BEARER_MARKER_9876543210";
const PRIVATE_PATH_MARKER = "/synthetic/private/key/path";
const authoritySubject = Object.freeze({
  generation: "1",
  subjectId: "config-runtime-test",
  tenantId: "config-runtime-test-tenant",
  type: "test-subject"
});
const authorityContext = Object.freeze({
  approvalRevision: "1",
  grantRevision: "1",
  policyRevision: "1",
  riskRevision: "1",
  workloadGeneration: authoritySubject.generation
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-config-publication-"));
  roots.push(root);
  return root;
}

async function writeConfig(root: string, services: readonly Record<string, unknown>[]): Promise<void> {
  const directory = path.join(root, "upstream-config");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "services.json"), `${JSON.stringify({ services })}\n`);
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as { port: number }).port;
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function harness({
  keyProvider = createMemoryLocalSecretKeyProvider(),
  invalidateObserver = false,
  includePublishedReader = true
}: {
  keyProvider?: ReturnType<typeof createMemoryLocalSecretKeyProvider> | null;
  invalidateObserver?: boolean;
  includePublishedReader?: boolean;
} = {}) {
  const storageRoot = await temporaryRoot();
  const userDataPath = await temporaryRoot();
  const store = createServiceManifestStore({ storageRoot });
  const candidateReaderPort = Object.freeze({ getSnapshot: store.getCandidateSnapshot });
  const registry = createUpstreamGatewayRegistry({
    schemaPort: createGatewaySchemaPort(),
    userDataPath,
    secretKeyProvider: keyProvider
  });
  const runtimeRegistry = new Proxy(registry, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "forward") {
        return (input: Record<string, any> = {}, caller: Record<string, any> = {}, options: Record<string, any> = {}) => {
          const inputDigest = digestFinalProtectedSinkInput(input);
          const finalProtectedSinkPermit = createFinalProtectedSinkAttempt({
            audience: "upstream-structured-http-final-effect",
            subject: authoritySubject,
            operationId: "gateway.forward",
            requestDigest: inputDigest,
            context: authorityContext,
            targetSelector: Object.freeze({ inputDigest, operationKey: input.operationKey, serviceId: input.serviceId }),
            proofRef: "config-loader-test-proof",
            revalidateCurrentAuthority: async () => Object.freeze({
              allowed: true,
              revoked: false,
              subject: authoritySubject,
              context: authorityContext
            })
          });
          return value.call(target, input, caller, { ...options, finalProtectedSinkPermit });
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const observer = createUpstreamManifestObserver({
    readerPort: candidateReaderPort,
    async onSnapshot(snapshot) {
      registry.replaceFromManifestSnapshot(snapshot);
      await store.acknowledgePublished({ setRevision: snapshot.setRevision, setDigest: snapshot.setDigest });
    },
    pollIntervalMs: 60_000
  });
  await observer.start();

  let fault: "none" | "before-commit" | "after-commit" = "none";
  const audit: unknown[] = [];
  const application = createUpstreamPublishingApplication({
    writerPort: {
      async commitManifestSet(input) {
        if (fault === "before-commit") {
          fault = "none";
          throw Object.assign(new Error(`${MARKER_A} ${PRIVATE_PATH_MARKER}`), {
            code: "storage_manifest_set_revision_stale",
            statusCode: 409
          });
        }
        const outcome = await store.writerPort.commitManifestSet(input);
        if (!outcome.replayed && invalidateObserver) observer.invalidate();
        if (fault === "after-commit") {
          fault = "none";
          throw new Error(`${MARKER_A} ${PRIVATE_PATH_MARKER}`);
        }
        return outcome;
      }
    },
    readerPort: candidateReaderPort,
    ...(includePublishedReader ? { publishedReaderPort: Object.freeze({ getSnapshot: store.getSnapshot }) } : {}),
    auditPort: { async append(event) { audit.push(event); } }
  });
  const commands: Array<Record<string, any>> = [];
  const publishingApplication = Object.freeze({
    prepareConfigFileService: (...args: any[]) => application.prepareConfigFileService(...args),
    execute: async (raw: string, ...args: any[]) => {
      commands.push(JSON.parse(raw));
      return application.execute(raw, ...args);
    }
  });

  const value = {
    storageRoot,
    userDataPath,
    store,
    registry: runtimeRegistry,
    observer,
    audit,
    application,
    publishingApplication,
    commands,
    keyProvider,
    setFault(next: "none" | "before-commit" | "after-commit") { fault = next; },
    makeLoader(options: Record<string, unknown> = {}) {
      const loader = createUpstreamConfigFileLoader({
        userDataPath,
        publishingApplication,
        localSecretKeyProvider: keyProvider,
        pollIntervalMs: 60_000,
        ...options
      });
      cleanups.push(() => loader.close());
      return loader;
    },
    async dispose() {
      await observer.close();
      await registry.close();
      keyProvider?.close();
    }
  };
  cleanups.push(() => value.dispose());
  return value;
}

async function currentRecord(store: ReturnType<typeof createServiceManifestStore>) {
  const snapshot = await store.getCandidateSnapshot();
  return { snapshot, record: snapshot.listServices()[0] || null };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("declarative upstream config publication", () => {
  it("publishes a complete credential once and resolves it through the actual gateway runtime", async () => {
    const fixtureRequests: Array<{ authorization: string; method: string }> = [];
    const server = http.createServer((request, response) => {
      fixtureRequests.push({ authorization: String(request.headers.authorization || ""), method: String(request.method || "") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(server);
    cleanups.push(() => closeServer(server));

    const runtime = await harness();
    const loader = runtime.makeLoader();
    const service = {
      name: "fixture-auth-service",
      type: "http",
      url: `http://127.0.0.1:${port}/`,
      auth: { type: "bearer", token: MARKER_A }
    };
    await writeConfig(runtime.userDataPath, [service]);
    await loader.start();

    expect(runtime.commands).toHaveLength(1);
    expect(runtime.commands[0]).toMatchObject({ action: "create", descriptor: { serviceProtocol: "http" } });
    expect(JSON.stringify(runtime.commands)).not.toContain(MARKER_A);
    expect(runtime.audit).toHaveLength(1);
    expect(JSON.stringify(runtime.audit)).not.toContain(MARKER_A);

    const { snapshot, record } = await currentRecord(runtime.store);
    expect(snapshot.setRevision).toBe(1);
    expect(record?.manifest.references).toHaveLength(1);
    const oldReference = record!.manifest.references[0];
    expect(oldReference).toMatchObject({ type: "credential", revision: 1, use: "request-auth" });
    expect(JSON.stringify(record!.manifest)).not.toContain(MARKER_A);

    await runtime.observer.scan();
    expect((await runtime.store.getSnapshot()).getService(record!.serviceId)?.manifest.references).toEqual(record!.manifest.references);
    const publishedRuntimeService = runtime.registry.getService(record!.serviceId);
    expect(publishedRuntimeService.credentialReferenceCount).toBe(1);
    expect(JSON.stringify(publishedRuntimeService)).not.toContain(oldReference.reference);
    const firstCall = await runtime.registry.forward(
      { serviceId: record!.serviceId, operationKey: "default" },
      { subjectId: "config-runtime-test", scopes: ["gateway:write"] }
    );
    expect(firstCall.response.json).toEqual({ ok: true });
    expect(fixtureRequests).toEqual([{ authorization: `Bearer ${MARKER_A}`, method: "POST" }]);

    await loader.scan();
    expect(runtime.commands).toHaveLength(1);
    await writeConfig(runtime.userDataPath, [{ ...service, auth: { type: "bearer", token: MARKER_B } }]);
    await loader.scan();
    expect(runtime.commands).toHaveLength(2);
    expect(JSON.stringify(runtime.commands)).not.toContain(MARKER_B);

    const updatedRecord = (await runtime.store.getCandidateSnapshot()).getService(record!.serviceId)!;
    const newReference = updatedRecord.manifest.references.find((entry) => entry.type === "credential")!;
    expect(newReference.reference).not.toBe(oldReference.reference);
    const preparedPayload = await resolveLocalSecretPayload({
      dataDir: runtime.userDataPath,
      secretRef: newReference.reference,
      expectedRevision: newReference.revision,
      expectedScope: {
        serviceId: record!.serviceId,
        requiredScopes: ["gateway:write"],
        host: "127.0.0.1",
        protocol: "http"
      },
      keyProvider: runtime.keyProvider
    });
    expect(preparedPayload.payload.headers.authorization).toBe(`Bearer ${MARKER_B}`);
    expect((await runtime.store.getSnapshot()).getService(record!.serviceId)?.manifest.references).toEqual(record!.manifest.references);

    const stillPublished = await runtime.registry.forward(
      { serviceId: record!.serviceId, operationKey: "default" },
      { subjectId: "config-runtime-test", scopes: ["gateway:write"] }
    );
    expect(stillPublished.response.json).toEqual({ ok: true });
    expect(fixtureRequests.at(-1)?.authorization).toBe(`Bearer ${MARKER_A}`);

    await runtime.observer.scan();
    const updatedCall = await runtime.registry.forward(
      { serviceId: record!.serviceId, operationKey: "default" },
      { subjectId: "config-runtime-test", scopes: ["gateway:write"] }
    );
    expect(updatedCall.response.json).toEqual({ ok: true });
    expect(fixtureRequests.at(-1)?.authorization).toBe(`Bearer ${MARKER_B}`);
    await loader.scan();

    const entries = await listLocalSecretEntries({ dataDir: runtime.userDataPath });
    expect(entries.find((entry) => entry.secretRef === oldReference.reference)?.status).toBe("revoked");
    expect(entries.find((entry) => entry.secretRef === newReference.reference)?.status).toBe("active");
    expect(loader.lastError).toBeNull();
  });

  it("keeps unauthenticated MCP services and non-sensitive request headers working", async () => {
    const runtime = await harness({ keyProvider: null });
    const loader = runtime.makeLoader();
    await writeConfig(runtime.userDataPath, [{
      name: "fixture-context-service",
      type: "mcp",
      url: "https://fixture.example.invalid:443/mcp",
      headers: { "x-fixture-context": "alpha" }
    }]);
    await loader.start();
    await runtime.observer.scan();

    const { snapshot, record } = await currentRecord(runtime.store);
    expect(snapshot.setRevision).toBe(1);
    expect(record!.manifest.references).toEqual([]);
    expect(record!.manifest.payload.descriptor).toMatchObject({
      serviceProtocol: "mcp",
      mcp: { transport: "http", url: "https://fixture.example.invalid:443/mcp", headers: { "x-fixture-context": "alpha" } }
    });
    expect(runtime.registry.listServices().count).toBe(1);
    expect(loader.lastError).toBeNull();
    await loader.scan();
    expect(runtime.commands).toHaveLength(1);
  });

  it("refuses authenticated publication without usable external custody and keeps diagnostics redacted", async () => {
    const cases = [
      { keyProvider: null, expectedCode: "credential.provider_required" },
      {
        keyProvider: {
          protocolVersion: "fixture",
          custody: "external-file",
          async loadKey() { throw new Error(`${MARKER_A} ${PRIVATE_PATH_MARKER}`); },
          close() {},
          describe() { return { protocolVersion: "fixture", custody: "external-file", configured: true }; }
        } as any,
        expectedCode: "credential.custody_unavailable"
      }
    ];
    for (const entry of cases) {
      const runtime = await harness({ keyProvider: entry.keyProvider });
      const diagnostics: unknown[] = [];
      const loader = runtime.makeLoader({ onError: (error: unknown) => diagnostics.push(error) });
      await writeConfig(runtime.userDataPath, [{
        name: "fixture-auth-service",
        type: "mcp",
        url: "https://fixture.example.invalid:443/mcp",
        auth: { type: "bearer", token: MARKER_A }
      }]);
      await loader.start();
      expect(runtime.commands).toEqual([]);
      expect((await runtime.store.getCandidateSnapshot()).setRevision).toBe(0);
      expect((await runtime.store.getSnapshot()).setRevision).toBe(0);
      expect(loader.lastError).toMatchObject({ code: entry.expectedCode });
      expect(JSON.stringify(loader.lastError)).not.toContain(MARKER_A);
      expect(JSON.stringify(loader.lastError)).not.toContain(PRIVATE_PATH_MARKER);
      expect(JSON.stringify(diagnostics)).not.toContain(MARKER_A);
      expect(JSON.stringify(diagnostics)).not.toContain(PRIVATE_PATH_MARKER);
    }
  });

  it("requires published-snapshot authority before preparing config credentials", async () => {
    const runtime = await harness({ includePublishedReader: false });
    const loader = runtime.makeLoader();
    await writeConfig(runtime.userDataPath, [{
      name: "fixture-auth-service",
      type: "mcp",
      url: "https://fixture.example.invalid:443/mcp",
      auth: { type: "bearer", token: MARKER_A }
    }]);
    await loader.start();

    expect(loader.lastError?.code).toBe("publication.failed");
    expect(runtime.commands).toEqual([]);
    expect((await runtime.store.getCandidateSnapshot()).setRevision).toBe(0);
    expect(await listLocalSecretEntries({ dataDir: runtime.userDataPath })).toEqual([]);
  });

  it("retries the same unchanged config after external custody recovers", async () => {
    const innerProvider = createMemoryLocalSecretKeyProvider();
    let available = false;
    const provider = {
      protocolVersion: innerProvider.protocolVersion,
      custody: "external-file",
      async loadKey() {
        if (!available) throw new Error(`${PRIVATE_PATH_MARKER} ${MARKER_A}`);
        return innerProvider.loadKey();
      },
      close() { innerProvider.close(); },
      describe() { return { protocolVersion: innerProvider.protocolVersion, custody: "external-file", configured: true }; }
    } as any;
    const runtime = await harness({ keyProvider: provider });
    const loader = runtime.makeLoader();
    await writeConfig(runtime.userDataPath, [{
      name: "fixture-auth-service",
      type: "mcp",
      url: "https://fixture.example.invalid:443/mcp",
      auth: { type: "bearer", token: MARKER_A }
    }]);
    await loader.start();
    expect(runtime.commands).toEqual([]);
    expect(loader.lastError?.code).toBe("credential.custody_unavailable");

    available = true;
    await loader.scan();
    expect(runtime.commands).toHaveLength(1);
    expect((await runtime.store.getCandidateSnapshot()).setRevision).toBe(1);
    expect(loader.lastError).toBeNull();
  });

  it("preserves the prior service and credential after a failed durable write, then retries the same file", async () => {
    const runtime = await harness();
    const loader = runtime.makeLoader();
    const original = {
      name: "fixture-auth-service",
      type: "mcp",
      url: "https://fixture.example.invalid:443/mcp",
      auth: { type: "bearer", token: MARKER_A }
    };
    await writeConfig(runtime.userDataPath, [original]);
    await loader.start();
    await runtime.observer.scan();
    const initial = (await runtime.store.getCandidateSnapshot()).listServices()[0];
    const originalReference = initial.manifest.references[0];

    runtime.setFault("before-commit");
    await writeConfig(runtime.userDataPath, [{ ...original, auth: { type: "bearer", token: MARKER_B } }]);
    await loader.scan();
    expect(loader.lastError?.code).toBe("publication.conflict");
    expect(runtime.commands).toHaveLength(2);
    const afterFailure = (await runtime.store.getCandidateSnapshot()).getService(initial.serviceId)!;
    expect(afterFailure.serviceRevision).toBe(1);
    expect(afterFailure.manifest.references).toEqual([originalReference]);
    expect((await runtime.store.getSnapshot()).getService(initial.serviceId)?.manifest.references).toEqual([originalReference]);

    await loader.scan();
    expect(runtime.commands).toHaveLength(3);
    const recovered = (await runtime.store.getCandidateSnapshot()).getService(initial.serviceId)!;
    expect(recovered.serviceRevision).toBe(2);
    expect(recovered.manifest.references[0].reference).not.toBe(originalReference.reference);
    expect(recovered.manifest.references[0].revision).toBe(1);
    expect(loader.lastError).toBeNull();
  });

  it("does not accept a commit response when a concurrent revision replaced the requested service", async () => {
    const runtime = await harness();
    let interleaved = false;
    const application = Object.freeze({
      prepareConfigFileService: (...args: any[]) => runtime.application.prepareConfigFileService(...args),
      execute: async (raw: string, ...args: any[]) => {
        const result = await runtime.publishingApplication.execute(raw, ...args);
        if (interleaved) return result;
        interleaved = true;

        const candidate = await runtime.store.getCandidateSnapshot();
        const current = candidate.listServices()[0];
        const overwrite = {
          schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
          action: "replace",
          serviceId: current.serviceId,
          expectedServiceRevision: current.serviceRevision,
          expectedSetRevision: candidate.setRevision,
          idempotencyKey: "config-file-concurrent-replacement",
          descriptor: { ...current.manifest.payload.descriptor, label: "parallel-writer" }
        };
        await runtime.publishingApplication.execute(JSON.stringify(overwrite), {
          subjectId: "meshrix:config-file",
          scopes: ["gateway:admin", "gateway:maintain", "gateway:write", "gateway:read"]
        });
        return result;
      }
    });
    const loader = runtime.makeLoader({ publishingApplication: application });
    const configured = {
      name: "fixture-auth-service",
      type: "mcp",
      url: "https://fixture.example.invalid:443/mcp",
      auth: { type: "bearer", token: MARKER_A }
    };
    await writeConfig(runtime.userDataPath, [configured]);
    await loader.start();

    const replaced = (await runtime.store.getCandidateSnapshot()).listServices()[0];
    expect(replaced.manifest.payload.descriptor.label).toBe("parallel-writer");
    expect(loader.lastError?.code).toBe("publication.conflict");

    await loader.scan();
    const recovered = (await runtime.store.getCandidateSnapshot()).listServices()[0];
    expect(recovered.manifest.payload.descriptor.label).toBe(configured.name);
    expect(recovered.serviceRevision).toBe(replaced.serviceRevision + 1);
    expect(recovered.manifest.references).toEqual(replaced.manifest.references);
    expect(loader.lastError).toBeNull();
  });

  it("reconciles a committed publication whose response was lost without duplicating or exposing it", async () => {
    const runtime = await harness();
    const loader = runtime.makeLoader();
    await writeConfig(runtime.userDataPath, [{
      name: "fixture-auth-service",
      type: "mcp",
      url: "https://fixture.example.invalid:443/mcp",
      auth: { type: "bearer", token: MARKER_A }
    }]);
    runtime.setFault("after-commit");

    await loader.start();
    const candidate = await runtime.store.getCandidateSnapshot();
    expect(candidate.setRevision).toBe(1);
    expect(candidate.listServices()).toHaveLength(1);
    expect(runtime.commands).toHaveLength(1);
    expect(loader.lastError).toBeNull();
    expect(JSON.stringify(runtime.commands)).not.toContain(MARKER_A);
  });

  it("redacts malformed JSON parser reflection and rejects credential-like custom headers", async () => {
    const runtime = await harness({ keyProvider: null });
    const diagnostics: unknown[] = [];
    const loader = runtime.makeLoader({ onError: (error: unknown) => diagnostics.push(error) });
    const directory = path.join(runtime.userDataPath, "upstream-config");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "services.json"), `{"services":[{"auth":{"token":"${MARKER_A}"}`);
    await loader.start();
    expect(JSON.stringify(loader.lastError)).not.toContain(MARKER_A);
    expect(JSON.stringify(diagnostics)).not.toContain(MARKER_A);
    expect(runtime.commands).toEqual([]);

    await writeConfig(runtime.userDataPath, [{
      name: "fixture-header-service",
      type: "mcp",
      url: "https://fixture.example.invalid:443/mcp",
      headers: { authorization: `Bearer ${MARKER_A}` }
    }]);
    await loader.scan();
    expect(runtime.commands).toEqual([]);
    expect(JSON.stringify(loader.lastError)).not.toContain(MARKER_A);
    expect((await runtime.store.getCandidateSnapshot()).setRevision).toBe(0);

    await fs.writeFile(path.join(directory, "services.json"), JSON.stringify({
      services: [{
        name: "fixture-prototype-header",
        type: "mcp",
        url: "https://fixture.example.invalid:443/mcp",
        headers: JSON.parse('{"__proto__":"synthetic"}')
      }]
    }));
    await loader.scan();
    expect(loader.lastError?.code).toBe("config.invalid");
    expect(runtime.commands).toEqual([]);
    expect((await runtime.store.getCandidateSnapshot()).setRevision).toBe(0);
  });

  it("coalesces concurrent scans and close joins in-flight preparation", async () => {
    const runtime = await harness();
    await writeConfig(runtime.userDataPath, [{
      name: "fixture-auth-service",
      type: "mcp",
      url: "https://fixture.example.invalid:443/mcp",
      auth: { type: "bearer", token: MARKER_A }
    }]);
    const entered = deferred();
    const release = deferred();
    let blocked = false;
    const application = Object.freeze({
      prepareConfigFileService: async (...args: any[]) => {
        if (!blocked) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
        return runtime.application.prepareConfigFileService(...args);
      },
      execute: (...args: any[]) => runtime.publishingApplication.execute(...args)
    });
    const loader = runtime.makeLoader({ publishingApplication: application });
    const first = loader.scan();
    await entered.promise;
    const second = loader.scan();
    expect(second).toBe(first);
    let closed = false;
    const closing = loader.close().then(() => { closed = true; });
    expect(closed).toBe(false);
    release.resolve();
    await Promise.all([first, closing]);
    expect(closed).toBe(true);
    expect(runtime.commands).toEqual([]);
    expect((await runtime.store.getCandidateSnapshot()).setRevision).toBe(0);
  });

  it("lets an already-started durable publication finish while close waits for it", async () => {
    const runtime = await harness();
    await writeConfig(runtime.userDataPath, [{
      name: "fixture-auth-service",
      type: "mcp",
      url: "https://fixture.example.invalid:443/mcp",
      auth: { type: "bearer", token: MARKER_A }
    }]);
    const entered = deferred();
    const release = deferred();
    let blocked = false;
    const application = Object.freeze({
      prepareConfigFileService: (...args: any[]) => runtime.application.prepareConfigFileService(...args),
      execute: async (raw: string, ...args: any[]) => {
        runtime.commands.push(JSON.parse(raw));
        if (!blocked) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
        return runtime.application.execute(raw, ...args);
      }
    });
    const loader = runtime.makeLoader({ publishingApplication: application });
    const starting = loader.start();
    await entered.promise;
    let closed = false;
    const closing = loader.close().then(() => { closed = true; });
    expect(closed).toBe(false);
    release.resolve();
    await Promise.all([starting, closing]);
    expect(closed).toBe(true);
    expect((await runtime.store.getCandidateSnapshot()).setRevision).toBe(1);
    expect(runtime.commands).toHaveLength(1);
  });
});

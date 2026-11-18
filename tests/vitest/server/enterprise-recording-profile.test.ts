import { createServer } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { createMemoryLocalSecretKeyProvider } from "../../../packages/foundation/src/security/secret-store/local-secret-key-provider.ts";
import {
  createEnterpriseRecordingAuthority,
  inspectRecordingStorage,
  normalizeRecordingRuntimeConfig,
  RECORDING_DEFAULT_ROOT_DIR
} from "../../../packages/server-runtime/src/composition/recording-authority.ts";
import {
  createServerCompositionRoot
} from "../../../packages/server-runtime/src/composition/composition-root.ts";
import {
  createDispatchOperationRecorder
} from "../../../packages/server-runtime/src/composition/dispatch-operation-recording.ts";
import {
  executeRecordingGovernanceOperation
} from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/recording-governance-executor.ts";
import {
  createPlatformMcpGateway
} from "../../../packages/server-runtime/src/composition/gateway-composition.ts";
import {
  createGatewaySchemaPort
} from "../../../packages/server-runtime/src/composition/gateway-schema-port.ts";
import {
  installUpstreamRuntimeServices
} from "../../helpers/upstream-runtime-snapshot.ts";
import { modernHttpRequest } from "../gateway/support.ts";
const canned1 = "tools/call";
const canned2 = "tool_grant";
const canned3 = "not-recorded";




const LIFECYCLE_VERSION = "v0.0.1:recording:lifecycle-1";
const POLICY_VERSION = "v0.0.1:recording:policy-1";
const READER = "role.rec.auditor";

const temporaryRoots: Set<string> = new Set();
const closers: Array<() => unknown> = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-enterprise-recording-"));
  temporaryRoots.add(root);
  return root;
}

afterEach(async (): Promise<void> => {
  for (const release of closers.splice(0).reverse()) {
    try {
      await release();
    } catch {
      // Cleanup must not mask the recorded assertion results.
    }
  }
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

const silentLogger: any = Object.freeze({
  debug() : any {},
  info() : any {},
  warn() : any {},
  error() : any {},
  async close() : Promise<void> {}
});

function categorySelection(overrides: Record<string, any> = {}): any {
  return {
    obligation: "optional",
    sinkRef: "recording-sink-local",
    fieldAllow: [],
    fieldRedact: [],
    eventAllow: [],
    readerRoles: [READER],
    configurerRoles: ["owner"],
    retention: {
      maxAgeSeconds: 3_600,
      maxRecords: 128,
      // Only the content category may carry a non-zero content budget.
      maxContentBytes: 0,
      maxIndexBytes: 65_536
    },
    capacity: { maxBufferedRecords: 32, maxRecordBytes: 16_384 },
    ...overrides
  };
}

function publishedPolicy(current: any, categories: Record<string, any>): any {
  return {
    schemaVersion: POLICY_VERSION,
    kind: "recording-policy",
    policyId: current.policyId,
    policyRevision: Number(current.policyRevision) + 1,
    issuedAt: new Date().toISOString(),
    issuerRole: "console",
    configurerRoles: [...current.configurerRoles],
    categories
  };
}

function consoleSession(tenantId = "default", scopes: string[] = ["recording:read", "recording:admin"]): any {
  return {
    user: { userId: "u.test", username: "tester", roleId: "owner", tenantId, scopes },
    scopes
  };
}

async function governedCall(provider: any, operationId: string, input: Record<string, any>, tenantId: string): Promise<any> {
  return executeRecordingGovernanceOperation({
    operationId,
    input,
    context: { recordingGovernanceProvider: provider, authSession: consoleSession(tenantId) }
  });
}

async function composeRoot(userDataPath: string, recording?: Record<string, unknown>, masterKey?: Buffer): Promise<any> {
  const root: any = await createServerCompositionRoot({
    userDataPath,
    runtimeOptions: recording ? { recording } : {},
    runtimeLogger: silentLogger,
    secretKeyProvider: createMemoryLocalSecretKeyProvider(masterKey ? { key: masterKey } : {})
  });
  closers.push(() => root.close());
  return root;
}

async function realUpstreamPeer(): Promise<{ url: string; wire: any[] }> {
  const wire: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    wire.push({ method: body.method, params: body.params });
    const result = body.method === "tools/list"
      ? {
          resultType: "complete",
          tools: [{
            name: "echo",
            inputSchema: {
              type: "object",
              properties: { echoText: { type: "string" } },
              required: ["echoText"]
            }
          }]
        }
      : body.method === "tools/call"
        ? { resultType: "complete", content: [{ type: "text", text: "peer-ok" }] }
        : null;
    if (result === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("recording test peer has no TCP address");
  return { url: `http://127.0.0.1:${address.port}`, wire };
}

async function startRecordedGateway(root: any, peerUrl: string, tenantId: string): Promise<any> {
  const registry = createUpstreamGatewayRegistry({ schemaPort: createGatewaySchemaPort() });
  closers.push(() => registry.close());
  installUpstreamRuntimeServices(registry, [{
    serviceId: "synthetic",
    serviceProtocol: "mcp",
    label: "synthetic",
    allowLocalNetwork: true,
    operations: [{
      operationKey: canned1,
      protocol: "mcp",
      risk: "safe_write",
      requiredScopes: ["gateway:read", "gateway:write"]
    }],
    mcp: { transport: "http", url: `${peerUrl}/mcp`, protocolVersion: "2026-07-28" }
  }]);
  const gateway = createPlatformMcpGateway({
    upstreamGatewayRegistry: registry,
    operationProofSubstrate: root.operationProofSubstrate,
    recordingSink: root.recordingSink,
    runtimeLogger: silentLogger,
    toolSkillManagementProvider: {
      authorizeMcpClientRequest: async () => ({
        ok: true,
        credentialKind: canned2,
        grant: {
          id: "grant-1",
          revision: "grant-1",
          subjectId: "caller",
          tenantId,
          scopes: ["gateway:read", "gateway:write"],
          dynamicCapabilities: ["cap:upstream:synthetic:tools-call-echo"]
        },
        subject: {
          type: "tool-grant",
          subjectId: "caller",
          tenantId,
          grantId: "grant-1",
          scopes: ["gateway:read", "gateway:write"],
          dynamicCapabilities: ["cap:upstream:synthetic:tools-call-echo"]
        }
      }),
      listVisibleTools: () => []
    }
  });
  closers.push(() => gateway.close());
  await gateway.gateway.start();
  return gateway;
}

function recorded(store: any, category: string, operationRef?: string): any[] {
  return store.listRecords({
    category,
    role: READER,
    ...(operationRef ? { operationRef } : {})
  });
}

describe("enterprise recording profile configuration", () => {
  it("normalizes runtimeOptions.recording and rejects malformed configuration", () => {
    const userDataPath = tempRoot();
    const defaults = normalizeRecordingRuntimeConfig(undefined, { userDataPath });
    expect(defaults.rootPath).toBe(path.join(userDataPath, RECORDING_DEFAULT_ROOT_DIR));
    expect(defaults.sinkId).toBe("recording-sink-local");

    const configured = normalizeRecordingRuntimeConfig({
      root: "enterprise-records",
      sinkId: "sink.custom.1",
      budgets: { maxRecordBytes: 8_192 },
      reservationTtlMs: 30_000,
      policy: { policyId: "pol.custom", configurerRoles: ["maintainer"] }
    }, { userDataPath });
    expect(configured.rootPath).toBe(path.join(userDataPath, "enterprise-records"));
    expect(configured.sinkId).toBe("sink.custom.1");
    expect(configured.budgets).toEqual({ maxRecordBytes: 8_192 });
    expect(configured.policy.policyId).toBe("pol.custom");
    expect(configured.policy.configurerRoles).toEqual(["maintainer"]);

    for (const bad of [
      "not-an-object",
      { root: "" },
      { sinkId: " " },
      { budgets: { maxRecordBytes: -1 } },
      { budgets: { unknownBudget: 1 } },
      { unknownKey: true },
      { policy: { configurerRoles: [] } }
    ]) {
      expect(() => normalizeRecordingRuntimeConfig(bad, { userDataPath }), JSON.stringify(bad))
        .toThrow(/recording/i);
    }
  });

  it("recognizes retired recording paths without deleting or gating startup", async () => {
    const userDataPath = tempRoot();
    const retiredDir = path.join(userDataPath, "recorded-history");
    fs.mkdirSync(retiredDir, { recursive: true });
    fs.writeFileSync(path.join(retiredDir, "legacy.sqlite"), "legacy-bytes");
    const flatDb = path.join(userDataPath, RECORDING_DEFAULT_ROOT_DIR, "recording-sink.sqlite");
    fs.mkdirSync(path.dirname(flatDb), { recursive: true });
    fs.writeFileSync(flatDb, "flat-layout-marker");

    const report = inspectRecordingStorage({ userDataPath });
    expect(report.checked).toBe(true);
    expect(report.retiredPaths.map((entry: any) => entry.kind).sort()).toEqual([
      "retired_flat_recording_store",
      "retired_recording_root"
    ]);

    // Startup proceeds: retired markers are reported, never deleted and never
    // retained as a permanent gate.
    const root = await composeRoot(userDataPath);
    expect(root.recordingAuthority.migration.checked).toBe(true);
    expect(root.recordingAuthority.migration.retiredPaths.length).toBe(2);
    expect(fs.existsSync(path.join(retiredDir, "legacy.sqlite"))).toBe(true);
    expect(fs.existsSync(flatDb)).toBe(true);
  });
});

describe("enterprise recording profile composition", () => {
  it("binds one tenant-scoped recording authority across core provider, gateway, dispatch and Console", async () => {
    const userDataPath = tempRoot();
    const root = await composeRoot(userDataPath);

    // One shared producer facade is the recordingSink every consumer receives.
    expect(root.recordingSink).toBeTruthy();
    expect(typeof root.recordingSink.session).toBe("function");
    expect(root.coreProvider.getRecordingSink()).toBe(root.recordingSink);
    expect(root.recordingGovernanceProvider).toBe(
      root.recordingAuthority.recordingGovernanceProvider
    );
    expect(root.recordingAuthority.config.rootPath).toBe(
      path.join(userDataPath, RECORDING_DEFAULT_ROOT_DIR)
    );

    const provider = root.recordingGovernanceProvider;
    const tenantId = "acme";

    // Console: governed read provisions the tenant's genesis policy, then the
    // configurer publishes a revision selecting the histories the enterprise
    // wants recorded — including execution_history required before the effect.
    const read = await governedCall(provider, "recording_governance.policy.get", {}, tenantId);
    expect(read.status).toBe(200);
    expect(read.payload.snapshot.policy.policyRevision).toBe(1);
    expect(read.payload.snapshot.authority.contentAccess).toBe("organization");
    const genesis = read.payload.snapshot.policy;

    const publish = await governedCall(provider, "recording_governance.policy.publish", {
      expectedRevision: 1,
      policy: publishedPolicy(genesis, {
        execution_history: categorySelection({ obligation: "required_before_effect" }),
        governance_history: categorySelection(),
        usage: categorySelection({
          fieldAllow: ["operations.dispatched", "operations.succeeded", "operations.failed"]
        }),
        diagnostics: categorySelection({
          eventAllow: [
            "operation.dispatch.denied",
            "operation.dispatch.failed",
            "operation.dispatch.in_doubt"
          ]
        }),
        content: categorySelection({
          fieldAllow: ["echoText"],
          retention: {
            maxAgeSeconds: 3_600,
            maxRecords: 128,
            maxContentBytes: 262_144,
            maxIndexBytes: 65_536
          }
        })
      })
    }, tenantId);
    expect(publish.status).toBe(200);
    expect(publish.payload.published.policy.policyRevision).toBe(2);

    // Gateway: a real tools/call through the real gateway composition writes
    // the required pre-effect record and the terminal record into the same
    // tenant store the Console governs.
    const peer = await realUpstreamPeer();
    const gateway = await startRecordedGateway(root, peer.url, tenantId);
    const call = async (method: string, params: Record<string, unknown> = {}) =>
      gateway.adapter.handle(modernHttpRequest(method, method, params));
    const listed = await call("tools/list");
    const tool = (listed.body as any).result.tools
      .find((entry: any) => entry._meta?.serviceId === "synthetic");
    expect(tool).toBeDefined();
    const called = await call("tools/call", { name: tool.name, arguments: { echoText: "recorded-value" } });
    expect((called.body as any).result?.resultType).toBe("complete");

    const store = provider.storeFor(tenantId);
    const executions = recorded(store, "execution_history");
    expect(executions.map((record: any) => record.detail.event)).toEqual(["started", "completed"]);
    expect(executions.every((record: any) => record.tenantRef === tenantId)).toBe(true);
    expect(executions.every((record: any) => record.operationRef.startsWith("op.mcp."))).toBe(true);
    const governance = recorded(store, "governance_history");
    expect(governance.length).toBeGreaterThanOrEqual(1);
    expect(governance.every((record: any) => record.tenantRef === tenantId)).toBe(true);

    // Console sees the same revision the producers admitted under.
    const health = await governedCall(provider, "recording_governance.sink.health", {}, tenantId);
    expect(health.status).toBe(200);
    expect(health.payload.health.policyRevision).toBe(2);
    expect(health.payload.health.sink.custody).toBe("enterprise_local");
    expect(health.payload.health.sink.durable).toBe(true);

    // Dispatch runtime: the same facade records an operation dispatch through
    // the shared producer path used by the operation-permission runtime.
    const recorder = createDispatchOperationRecorder({
      recordingSink: root.recordingSink,
      operation: { id: "recording.verify.dispatch", readOnly: true },
      operationInput: { echoText: "dispatch-payload", secret: canned3 },
      transport: "http",
      method: "POST",
      traceContext: { requestId: "req.profile.1" },
      request: {},
      getAuthSession: () => ({ tenantId, user: { subjectId: "subject.7", tenantId } })
    });
    expect(recorder.admitBeforeEffect().ok).toBe(true);
    const settlement = recorder.settle({ status: "ok" });
    expect(settlement?.outcomes?.execution_history?.outcome).toBe("recorded");
    const dispatchRecords = recorded(store, "execution_history", recorder.operationRef);
    expect(dispatchRecords.map((record: any) => record.detail.event)).toEqual(["started", "completed"]);
    const content = recorded(store, "content", recorder.operationRef);
    expect(content.length).toBe(1);
    expect(content[0].detail.fieldNames).toEqual(["echoText"]);
    expect(JSON.stringify(content[0].detail)).not.toContain("dispatch-payload");

    // Tenant isolation: a second tenant's store carries none of acme's records.
    const other = provider.storeFor("tenant-b");
    expect(recorded(other, "execution_history")).toEqual([]);
  }, 30_000);

  it("reopens an existing recording root without resetting the published policy", async () => {
    const userDataPath = tempRoot();
    // One stable master key models the same self-hosted key custody across a
    // restart; each root gets its own provider instance like a fresh process.
    const masterKey = crypto.randomBytes(32);
    const first = await composeRoot(userDataPath, { root: "records", sinkId: "sink.rec.restart" }, masterKey);
    const provider = first.recordingGovernanceProvider;
    expect(provider.recordingRoot).toBe(path.join(userDataPath, "records"));

    const genesis = (await governedCall(provider, "recording_governance.policy.get", {}, "acme"))
      .payload.snapshot.policy;
    const publish = await governedCall(provider, "recording_governance.policy.publish", {
      expectedRevision: 1,
      policy: publishedPolicy(genesis, {
        governance_history: categorySelection()
      })
    }, "acme");
    expect(publish.status).toBe(200);
    await first.close();

    const second = await composeRoot(userDataPath, { root: "records", sinkId: "sink.rec.restart" }, masterKey);
    const reopened = await governedCall(
      second.recordingGovernanceProvider,
      "recording_governance.policy.get",
      {},
      "acme"
    );
    expect(reopened.status).toBe(200);
    expect(reopened.payload.snapshot.policy.policyRevision).toBe(2);
    expect(reopened.payload.snapshot.policy.categories.governance_history).toBeTruthy();
  }, 30_000);

  it("refuses required admission when the tenant store is unavailable while other work continues", async () => {
    const userDataPath = tempRoot();
    const root = await composeRoot(userDataPath);
    const provider = root.recordingGovernanceProvider;

    const genesis = provider.describe({ tenantId: "acme" }).policy;
    const publish = await governedCall(provider, "recording_governance.policy.publish", {
      expectedRevision: 1,
      policy: publishedPolicy(genesis, {
        execution_history: categorySelection({ obligation: "required_before_effect" })
      })
    }, "acme");
    expect(publish.status).toBe(200);

    const recorder = (tenantId: string, requestId: string) => createDispatchOperationRecorder({
      recordingSink: root.recordingSink,
      operation: { id: "recording.verify.admission", readOnly: true },
      operationInput: {},
      transport: "http",
      method: "POST",
      traceContext: { requestId },
      request: {},
      getAuthSession: () => ({ tenantId, user: { subjectId: "subject.x", tenantId } })
    });

    // A tenant with no published policy has no store and nothing required:
    // dispatch proceeds unrecorded rather than fabricating a failure.
    const unprovisioned = recorder("tenant.never", "req.none.1");
    expect(unprovisioned.admitBeforeEffect().ok).toBe(true);
    expect(unprovisioned.settle({ status: "ok" })).not.toBeNull();
    expect(provider.hasStore("tenant.never")).toBe(false);

    // Sever acme's durable database underneath the open store: the cached
    // policy is still readable but the required reservation write fails, so
    // the dispatch surfaces recording_unavailable instead of writing
    // downstream of a recorder that cannot keep its promise.
    provider.storeFor("acme").db.close();
    const blocked = recorder("acme", "req.blocked.1");
    const admission = blocked.admitBeforeEffect();
    expect(admission.ok).toBe(false);
    expect(admission.reasonCode).toBe("recording_unavailable");
    blocked.settle({ status: "failed" });

    // An unaffected tenant's work continues — optional shed never cancels
    // healthy dispatch and the blocked tenant leaves no fabricated records.
    const healthy = recorder("tenant.never", "req.none.2");
    expect(healthy.admitBeforeEffect().ok).toBe(true);
    expect(healthy.settle({ status: "ok" })).not.toBeNull();
  }, 30_000);

  it("keeps mandatory operational state apart: the operation-audit store owns its own location", async () => {
    const userDataPath = tempRoot();
    const root = await composeRoot(userDataPath);
    // Mandatory evidence stays at its separate owner beneath security/ — the
    // recording root holds only tenant-scoped selected-history stores.
    expect(fs.existsSync(path.join(userDataPath, "security", "operation-audit.sqlite"))).toBe(true);
    expect(root.operationAuditStore).toBeTruthy();
    expect(root.operationAuditStore).not.toBe(root.recordingSink);
    const recordingRoot = root.recordingAuthority.config.rootPath;
    const auditDatabase = path.join(userDataPath, "security", "operation-audit.sqlite");
    expect(path.relative(recordingRoot, auditDatabase).startsWith("..")).toBe(true);
    if (fs.existsSync(recordingRoot)) {
      expect(fs.readdirSync(recordingRoot)).not.toContain("operation-audit.sqlite");
    }
    expect(path.basename(recordingRoot)).toBe(RECORDING_DEFAULT_ROOT_DIR);
    expect(path.dirname(recordingRoot)).toBe(userDataPath);
  });
});

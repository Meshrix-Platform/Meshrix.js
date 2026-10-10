import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeRecordingGovernanceOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/recording-governance-executor.ts";
import { createRecordingGovernanceProvider } from "../../../packages/server-runtime/src/composition/console-domain/recording-governance-provider.ts";

const LIFECYCLE_VERSION = "v0.0.1:recording:lifecycle-1";
const POLICY_VERSION = "v0.0.1:recording:policy-1";
const SINK_ID = "recording-sink-local";

const temporaryRoots: Set<string> = new Set();
const providers: any[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-recording-governance-"));
  temporaryRoots.add(root);
  return root;
}

afterEach(async (): Promise<void> => {
  for (const provider of providers.splice(0)) {
    await provider.close().catch(() => {});
  }
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

function makeProvider(options: Record<string, any> = {}): any {
  const provider = createRecordingGovernanceProvider({
    userDataPath: tempRoot(),
    ...options
  });
  providers.push(provider);
  return provider;
}

function categorySelection(overrides: Record<string, any> = {}): any {
  return {
    obligation: "optional",
    sinkRef: SINK_ID,
    fieldAllow: [],
    fieldRedact: [],
    eventAllow: [],
    readerRoles: ["role.rec.auditor"],
    configurerRoles: ["owner"],
    retention: {
      maxAgeSeconds: 3_600,
      maxRecords: 32,
      maxContentBytes: 0,
      maxIndexBytes: 32_768
    },
    capacity: { maxBufferedRecords: 8, maxRecordBytes: 4_096 },
    ...overrides
  };
}

function nextPolicy(current: any, categories: Record<string, any>): any {
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

function executionRecord(recordId: string, operationRef: string, revision: number): any {
  return {
    schemaVersion: LIFECYCLE_VERSION,
    kind: "recording-record",
    recordId,
    tenantRef: "tenant.rec.1",
    operationRef,
    category: "execution_history",
    evidenceClass: "selected_history",
    policyRevision: revision,
    sinkRef: SINK_ID,
    phase: "pre_effect",
    occurredAt: new Date().toISOString(),
    detail: { event: "started", effectClass: "read", durationBucket: "not_applicable" },
    indexBytes: 256,
    contentBytes: 0
  };
}

function session(scopes: string[] = [], tenantId = "default", roleId = "owner"): any {
  return {
    user: { userId: "u.test", username: "tester", roleId, tenantId, scopes },
    scopes
  };
}

function context(provider: any, authSession: any): any {
  return { recordingGovernanceProvider: provider, authSession };
}

describe("recording governance provider", (): any => {
  it("provisions a truthful genesis snapshot per tenant", (): any => {
    const provider = makeProvider();
    const snapshot = provider.describe({ tenantId: "acme" });
    expect(snapshot.tenantId).toBe("acme");
    expect(snapshot.policy.policyRevision).toBe(1);
    expect(Object.keys(snapshot.policy.categories)).toHaveLength(0);
    expect(snapshot.sink.custody).toBe("enterprise_local");
    expect(snapshot.sink.durable).toBe(true);
    expect(snapshot.authority.decryptionAuthority).toBe("organization");
    expect(snapshot.sinkState.available).toBe(true);
    expect(snapshot.pendingObligations).toEqual([]);
  });

  it("publishes a strictly advanced revision and rejects stale CAS", (): any => {
    const provider = makeProvider();
    const current = provider.describe({ tenantId: "t1" }).policy;
    const published = provider.publishPolicy({
      tenantId: "t1",
      expectedRevision: 1,
      configurerRole: "owner",
      policy: nextPolicy(current, { usage: categorySelection({ fieldAllow: ["ops.completed"] }) })
    });
    expect(published.policy.policyRevision).toBe(2);
    expect(published.policy.issuerRole).toBe("owner");
    expect(published.policy.categories.usage.fieldAllow).toEqual(["ops.completed"]);

    expect(() => provider.publishPolicy({
      tenantId: "t1",
      expectedRevision: 1,
      configurerRole: "owner",
      policy: nextPolicy(current, {})
    })).toThrowError(expect.objectContaining({
      code: "recording_policy_revision_conflict",
      currentRevision: 2
    }));
  });

  it("rejects non-advancing, skipped and identity-changing revisions", (): any => {
    const provider = makeProvider();
    const current = provider.describe({ tenantId: "t1" }).policy;
    expect(() => provider.publishPolicy({
      tenantId: "t1",
      expectedRevision: 1,
      configurerRole: "owner",
      policy: { ...nextPolicy(current, {}), policyRevision: 3 }
    })).toThrowError(expect.objectContaining({ code: "recording_policy_revision_invalid" }));
    expect(() => provider.publishPolicy({
      tenantId: "t1",
      expectedRevision: 1,
      configurerRole: "owner",
      policy: { ...nextPolicy(current, {}), policyId: "pol.other" }
    })).toThrowError(expect.objectContaining({ code: "recording_policy_identity_changed" }));
    expect(() => provider.publishPolicy({
      tenantId: "t1",
      expectedRevision: 1,
      configurerRole: "owner",
      policy: { ...nextPolicy(current, {}), schemaVersion: "other" }
    })).toThrowError(expect.objectContaining({ code: "recording_policy_invalid" }));
  });

  it("denies publication from a role outside configurerRoles", (): any => {
    const provider = makeProvider();
    const current = provider.describe({ tenantId: "t1" }).policy;
    expect(() => provider.publishPolicy({
      tenantId: "t1",
      expectedRevision: 1,
      configurerRole: "viewer",
      policy: nextPolicy(current, {})
    })).toThrowError(expect.objectContaining({ code: "recording_policy_change_denied" }));
  });

  it("keeps tenant stores isolated", (): any => {
    const provider = makeProvider();
    const current = provider.describe({ tenantId: "tenant-a" }).policy;
    provider.publishPolicy({
      tenantId: "tenant-a",
      expectedRevision: 1,
      configurerRole: "owner",
      policy: nextPolicy(current, { usage: categorySelection({ fieldAllow: ["ops.completed"] }) })
    });
    const other = provider.describe({ tenantId: "tenant-b" });
    expect(other.policy.policyRevision).toBe(1);
    expect(Object.keys(other.policy.categories)).toHaveLength(0);
  });

  it("keeps disabled-category admitted audits visibly incomplete", (): any => {
    const provider = makeProvider();
    const genesis = provider.describe({ tenantId: "t1" }).policy;
    provider.publishPolicy({
      tenantId: "t1",
      expectedRevision: 1,
      configurerRole: "owner",
      policy: nextPolicy(genesis, {
        execution_history: categorySelection({ obligation: "required_before_effect" })
      })
    });
    const store = provider.storeFor("t1");
    const admission = store.admit({
      tenantRef: "tenant.rec.1",
      operationRef: "op.req.1",
      category: "execution_history",
      phase: "pre_effect"
    });
    expect(admission.decision).toBe("admit");
    store.writeRecord(executionRecord("rec.exec.start", "op.req.1", 2));
    const rev2 = store.getPolicy();
    provider.publishPolicy({
      tenantId: "t1",
      expectedRevision: 2,
      configurerRole: "owner",
      policy: nextPolicy(rev2, {})
    });
    const snapshot = provider.describe({ tenantId: "t1" });
    expect(snapshot.policy.policyRevision).toBe(3);
    expect(snapshot.policy.categories.execution_history).toBeUndefined();
    expect(snapshot.pendingObligations).toEqual([
      expect.objectContaining({
        operationRef: "op.req.1",
        category: "execution_history",
        obligation: "required_before_effect",
        reason: "category_disabled"
      })
    ]);
  });

  it("reports a closed sink as degraded without hiding the failure", (): any => {
    const provider = makeProvider();
    provider.describe({ tenantId: "t1" });
    const store = provider.storeFor("t1");
    store.close();
    const health = provider.sinkHealth({ tenantId: "t1" });
    expect(health.state.available).toBe(false);
    expect(() => provider.describe({ tenantId: "t1" }))
      .toThrowError(expect.objectContaining({ code: "sink_unavailable" }));
  });
});

describe("recording governance executor", (): any => {
  it("returns 503 when the provider is absent", async (): Promise<any> => {
    const out = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.get",
      input: {},
      context: { authSession: session(["recording:read"]) }
    });
    expect(out.status).toBe(503);
    expect(out.payload.code).toBe("recording_governance_unavailable");
  });

  it("reads the policy snapshot for an authorized session", async (): Promise<any> => {
    const provider = makeProvider();
    const out = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.get",
      input: {},
      context: context(provider, session(["recording:read"]))
    });
    expect(out.status).toBe(200);
    expect(out.payload.snapshot.policy.policyRevision).toBe(1);
    expect(out.payload.snapshot.authority.decryptionAuthority).toBe("organization");
    expect(out.payload.snapshot.sink.custody).toBe("enterprise_local");
  });

  it("denies the policy read without recording:read", async (): Promise<any> => {
    const provider = makeProvider();
    const out = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.get",
      input: {},
      context: context(provider, session([]))
    });
    expect(out.status).toBe(403);
    expect(out.payload.code).toBe("recording_read_scope_required");
  });

  it("publishes a revision for an authorized configurer", async (): Promise<any> => {
    const provider = makeProvider();
    const current = provider.describe({ tenantId: "default" }).policy;
    const out = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.publish",
      input: {
        expectedRevision: 1,
        policy: nextPolicy(current, { usage: categorySelection({ fieldAllow: ["ops.completed"] }) })
      },
      context: context(provider, session(["recording:admin"]))
    });
    expect(out.status).toBe(200);
    expect(out.payload.published.policy.policyRevision).toBe(2);
    expect(out.payload.published.policy.issuerRole).toBe("owner");
  });

  it("denies publication without recording:admin and without a configurer role", async (): Promise<any> => {
    const provider = makeProvider();
    const current = provider.describe({ tenantId: "default" }).policy;
    const policy = nextPolicy(current, {});
    const denied = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.publish",
      input: { expectedRevision: 1, policy },
      context: context(provider, session(["recording:read"]))
    });
    expect(denied.status).toBe(403);
    expect(denied.payload.code).toBe("recording_admin_scope_required");

    const roleDenied = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.publish",
      input: { expectedRevision: 1, policy },
      context: context(provider, session(["recording:admin"], "default", "viewer"))
    });
    expect(roleDenied.status).toBe(403);
    expect(roleDenied.payload.code).toBe("recording_policy_change_denied");
  });

  it("rejects cross-tenant selectors and keeps tenant state separate", async (): Promise<any> => {
    const provider = makeProvider();
    const mismatched = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.get",
      input: { tenantId: "tenant-b" },
      context: context(provider, session(["recording:read"], "tenant-a"))
    });
    expect(mismatched.status).toBe(403);
    expect(mismatched.payload.code).toBe("tenant_mismatch");

    const tenantA = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.get",
      input: {},
      context: context(provider, session(["recording:read"], "tenant-a"))
    });
    expect(tenantA.status).toBe(200);
    const current = tenantA.payload.snapshot.policy;
    const published = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.publish",
      input: {
        expectedRevision: 1,
        policy: nextPolicy(current, { usage: categorySelection({ fieldAllow: ["ops.completed"] }) })
      },
      context: context(provider, session(["recording:admin"], "tenant-a"))
    });
    expect(published.status).toBe(200);

    const tenantB = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.get",
      input: {},
      context: context(provider, session(["recording:read"], "tenant-b"))
    });
    expect(tenantB.status).toBe(200);
    expect(tenantB.payload.snapshot.policy.policyRevision).toBe(1);
  });

  it("maps CAS conflicts to 409 with the current revision", async (): Promise<any> => {
    const provider = makeProvider();
    const current = provider.describe({ tenantId: "default" }).policy;
    const policy = nextPolicy(current, {});
    const auth = session(["recording:admin"]);
    const first = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.publish",
      input: { expectedRevision: 1, policy },
      context: context(provider, auth)
    });
    expect(first.status).toBe(200);
    const conflict = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.publish",
      input: { expectedRevision: 1, policy },
      context: context(provider, auth)
    });
    expect(conflict.status).toBe(409);
    expect(conflict.payload.code).toBe("recording_policy_revision_conflict");
    expect(conflict.payload.currentRevision).toBe(2);
  });

  it("maps invalid policies to 400", async (): Promise<any> => {
    const provider = makeProvider();
    const out = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.publish",
      input: { expectedRevision: 1, policy: { kind: "recording-policy" } },
      context: context(provider, session(["recording:admin"]))
    });
    expect(out.status).toBe(400);
    expect(out.payload.code).toBe("recording_policy_invalid");
  });

  it("reports sink health with custody and capacity truth", async (): Promise<any> => {
    const provider = makeProvider();
    const out = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.sink.health",
      input: { integrity: true },
      context: context(provider, session(["recording:read"]))
    });
    expect(out.status).toBe(200);
    expect(out.payload.health.state.available).toBe(true);
    expect(out.payload.health.sink.custody).toBe("enterprise_local");
    expect(out.payload.health.authority.decryptionAuthority).toBe("organization");
    expect(out.payload.health.integrity.intact).toBe(true);
    expect(out.payload.health.policyRevision).toBe(1);
  });

  it("reports a degraded recorder truthfully and fails the policy read", async (): Promise<any> => {
    const provider = makeProvider();
    const auth = session(["recording:read"]);
    await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.get",
      input: {},
      context: context(provider, auth)
    });
    provider.storeFor("default").close();
    const health = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.sink.health",
      input: {},
      context: context(provider, auth)
    });
    expect(health.status).toBe(200);
    expect(health.payload.health.state.available).toBe(false);
    const read = await executeRecordingGovernanceOperation({
      operationId: "recording_governance.policy.get",
      input: {},
      context: context(provider, auth)
    });
    expect(read.status).toBe(503);
    expect(read.payload.code).toBe("sink_unavailable");
  });
});

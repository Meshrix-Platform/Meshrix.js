import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProcessIdentityService } from "../../../packages/foundation/src/security/process-identity/index.mjs";
import {
  PROCESS_IDENTITY_PROTOCOL_VERSION,
  openState,
  readRecord,
  sealJson,
  writeRecord
} from "../../../packages/foundation/src/security/process-identity/process-identity-core.mjs";
import { createPluginOwnerProcessIdentityAuthority } from "../../../packages/server-runtime/src/composition/plugin-owner-process-identity-authority.mjs";
import { createPluginInvocationAuthorizationAuthority } from "../../../packages/server-runtime/src/composition/plugin-invocation-authorization-authority.mjs";

const roots = [];
const generationA = "a".repeat(64);
const generationB = "b".repeat(64);
const identityContext = Object.freeze({
  tenant: "tenant-ref",
  subject: "subject-ref",
  target: "target-ref",
  workspace: "workspace-ref",
  correlation: "correlation-ref"
});
const future = () => new Date(Date.now() + 60_000).toISOString();
const authorizedIdentityContext = Object.freeze({
  subject: "subject-ref", tenant: "tenant-ref", workspace: "workspace-ref", target: "target-ref",
  operation: "fixture.operation", grant: "host-grant", approval: "", risk: "host-risk",
  policyRevision: "host-policy", authorized: true, current: true, revoked: false,
  correlation: "correlation-ref"
});

function lifecycleAuthority(initialState = "active", pluginId = "plugin-a", generation = 1) {
  let state = initialState;
  let currentGeneration = generation;
  return {
    id: "PluginLifecycleStatePort",
    readRecord: async () => ({ state, pluginId, generation: currentGeneration }),
    runExclusive: async (task) => task(),
    setState(next) { state = next; },
    setGeneration(next) { currentGeneration = next; }
  };
}

async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-owner-process-authority-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("Plugin owner process identity authority", () => {
  it("binds every operation to one owner generation and retires only that epoch", async () => {
    const dataDir = await root();
    const service = createProcessIdentityService({ dataDir });
    const invocationAuthorizationAuthority = createPluginInvocationAuthorizationAuthority();
    const host = createPluginOwnerProcessIdentityAuthority({ invocationAuthorizationAuthority });
    host.bind(service);
    const ownerALifecycle = lifecycleAuthority();
    const ownerA = host.forOwner({
      ownerId: "plugin-a", ownerGenerationDigest: generationA, ownerGeneration: 1, lifecycleStatePort: ownerALifecycle
    });
    const ownerB = host.forOwner({
      ownerId: "plugin-b", ownerGenerationDigest: generationB, ownerGeneration: 1, lifecycleStatePort: lifecycleAuthority("active", "plugin-b", 1)
    });
    const authorized = (pluginId) => invocationAuthorizationAuthority.issue({
      pluginId,
      operationId: "fixture.operation",
      targetRef: "target-ref",
      requestRef: "correlation-ref",
      sourceRequestDigest: "d".repeat(64),
      principal: { subjectRef: "subject-ref", tenantRef: "tenant-ref", workspaceRef: "workspace-ref" },
      governance: {
        grantRef: "host-grant", riskDecisionRef: "host-risk", policyRevision: "host-policy",
        authorized: true, current: true, revoked: false
      }
    });
    const first = await ownerA.issueBinding({
      ownerId: "plugin-b",
      targetRef: "target-ref",
      identityContext,
      idempotencyKey: "first",
      deadline: future(),
      invocationOperationId: "fixture.operation",
      invocationAuthorization: await authorized("plugin-a")
    });
    const second = await ownerB.issueBinding({
      targetRef: "target-ref",
      identityContext,
      idempotencyKey: "second",
      deadline: future(),
      invocationOperationId: "fixture.operation",
      invocationAuthorization: await authorized("plugin-b")
    });
    expect(first).toMatchObject({ ok: true, ownerId: "plugin-a", ownerGenerationDigest: generationA });
    expect(second).toMatchObject({ ok: true, ownerId: "plugin-b", ownerGenerationDigest: generationB });
    await expect(ownerB.inspectBinding({
      processIdentityRef: first.processIdentityRef,
      identityContext: authorizedIdentityContext
    })).resolves.toMatchObject({ ok: false, reasonCode: "owner_process_binding_mismatch" });
    const revoked = await ownerA.revokeBinding({ processIdentityRef: first.processIdentityRef, identityContext: authorizedIdentityContext });
    expect(revoked.revocationReceipt).toMatchObject({ ownerId: "plugin-a", ownerGenerationDigest: generationA });
    await expect(ownerA.revokeAllBindings()).resolves.toMatchObject({ ok: true });
    const staleToken = await authorized("plugin-a");
    await expect(ownerA.issueBinding({
      targetRef: "target-ref", identityContext, idempotencyKey: "after-retire", deadline: future(),
      invocationOperationId: "fixture.operation", invocationAuthorization: staleToken
    })).resolves.toMatchObject({ ok: false, reasonCode: "owner_process_binding_generation_retired" });
    await expect(ownerB.inspectBinding({
      processIdentityRef: second.processIdentityRef,
      identityContext: authorizedIdentityContext
    })).resolves.toMatchObject({ ok: true, status: "valid" });
    ownerALifecycle.setGeneration(2);
    await expect(ownerA.issueBinding({
      targetRef: "target-ref", identityContext, idempotencyKey: "stale-generation", deadline: future(),
      invocationOperationId: "fixture.operation", invocationAuthorization: staleToken
    })).resolves.toMatchObject({ ok: false, reasonCode: "owner_process_binding_generation_retired" });
    ownerALifecycle.setState("removal_pending");
    await expect(ownerA.issueBinding({
      targetRef: "target-ref", identityContext, idempotencyKey: "lifecycle-retired", deadline: future(),
      invocationOperationId: "fixture.operation", invocationAuthorization: staleToken
    })).resolves.toMatchObject({ ok: false, reasonCode: "owner_process_binding_generation_retired" });
    host.close();
    service.close();
  });

  it("resets a retired state without importing any retired binding", async () => {
    const dataDir = await root();
    const alias = "retired-state-reset-fixture";
    const sealingKeyBase64 = crypto.randomBytes(32).toString("base64");
    const retiredState = {
      stateVersion: 1,
      protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
      alias,
      clients: [],
      retiredBindings: [{
        processIdentityRef: "retired-binding",
        ownerId: "sample-plugin",
        bindingRef: "binding_legacy",
        targetRef: "target-ref",
        contextDigest: "d".repeat(64),
        idempotencyKeyDigest: "c".repeat(64),
        status: "valid",
        issuedAt: new Date().toISOString(),
        expiresAt: future(),
        revokedAt: "",
        receiptDigest: ""
      }],
      usedNonces: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await writeRecord({ dataDir, alias }, {
      protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
      alias,
      stateRoot: "",
      sealedState: sealJson({ sealingKeyBase64, payload: retiredState }),
      sealingKeyBase64,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const service = createProcessIdentityService({ dataDir, alias });
    await service.describe();
    service.close();
    const persisted = openState(await readRecord({ dataDir, alias }));
    expect(persisted.stateVersion).toBe(2);
    expect(persisted).not.toHaveProperty("retiredBindings");
    expect(persisted.clients).toEqual([]);
    expect(persisted.ownerProcessBindings).toEqual([]);
    expect(persisted.retiredOwnerProcessBindingGenerations).toEqual([]);
    expect(JSON.stringify(persisted)).not.toContain("retired-binding");
  });
});

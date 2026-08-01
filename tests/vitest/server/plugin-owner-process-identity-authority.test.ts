import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProcessIdentityService } from "../../../packages/foundation/src/security/process-identity/index.ts";
import {
  PROCESS_IDENTITY_PROTOCOL_VERSION,
  openState,
  readRecord,
  sealJson,
  writeRecord
} from "../../../packages/foundation/src/security/process-identity/process-identity-core.ts";
import { createPluginOwnerProcessIdentityAuthority } from "../../../packages/server-runtime/src/composition/plugin-owner-process-identity-authority.ts";
import { createPluginInvocationAuthorizationAuthority } from "../../../packages/server-runtime/src/composition/plugin-invocation-authorization-authority.ts";

const roots: any[] = [];
const generationA: any = "a".repeat(64);
const generationB: any = "b".repeat(64);
const identityContext: Readonly<Record<string, any>> = Object.freeze({
  tenant: "tenant-ref",
  subject: "subject-ref",
  target: "target-ref",
  workspace: "workspace-ref",
  correlation: "correlation-ref"
});
const future: any = () : any => new Date(Date.now() + 60_000).toISOString();
const authorizedIdentityContext: Readonly<Record<string, any>> = Object.freeze({
  subject: "subject-ref", tenant: "tenant-ref", workspace: "workspace-ref", target: "target-ref",
  operation: "fixture.operation", grant: "host-grant", approval: "", risk: "host-risk",
  policyRevision: "host-policy", authorized: true, current: true, revoked: false,
  correlation: "correlation-ref"
});

function lifecycleAuthority(initialState: any = "active", pluginId: any = "plugin-a", generation: any = 1) : any {
  let state: any = initialState;
  let currentGeneration: any = generation;
  return {
    id: "PluginLifecycleStatePort",
    readRecord: async () : Promise<any> => ({ state, pluginId, generation: currentGeneration }),
    runExclusive: async (task?: any) : Promise<any> => task(),
    setState(next?: any) : any { state = next; },
    setGeneration(next?: any) : any { currentGeneration = next; }
  };
}

async function root() : Promise<any> {
  const value: any = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-owner-process-authority-"));
  roots.push(value);
  return value;
}

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((entry?: any) : any => fs.rm(entry, { recursive: true, force: true })));
});

describe("Plugin owner process identity authority", () : any => {
  it("binds every operation to one owner generation and retires only that epoch", async () : Promise<any> => {
    const dataDir: any = await root();
    const service: any = createProcessIdentityService({ dataDir });
    const invocationAuthorizationAuthority: any = createPluginInvocationAuthorizationAuthority();
    const host: any = createPluginOwnerProcessIdentityAuthority({ invocationAuthorizationAuthority });
    host.bind(service);
    const ownerALifecycle: any = lifecycleAuthority();
    const ownerA: any = host.forOwner({
      ownerId: "plugin-a", ownerGenerationDigest: generationA, ownerGeneration: 1, lifecycleStatePort: ownerALifecycle
    });
    const ownerB: any = host.forOwner({
      ownerId: "plugin-b", ownerGenerationDigest: generationB, ownerGeneration: 1, lifecycleStatePort: lifecycleAuthority("active", "plugin-b", 1)
    });
    const authorized: any = (pluginId?: any) : any => invocationAuthorizationAuthority.issue({
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
    const first: any = await ownerA.issueBinding({
      ownerId: "plugin-b",
      targetRef: "target-ref",
      identityContext,
      idempotencyKey: "first",
      deadline: future(),
      invocationOperationId: "fixture.operation",
      invocationAuthorization: await authorized("plugin-a")
    });
    const second: any = await ownerB.issueBinding({
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
    const revoked: any = await ownerA.revokeBinding({ processIdentityRef: first.processIdentityRef, identityContext: authorizedIdentityContext });
    expect(revoked.revocationReceipt).toMatchObject({ ownerId: "plugin-a", ownerGenerationDigest: generationA });
    await expect(ownerA.revokeAllBindings()).resolves.toMatchObject({ ok: true });
    const staleToken: any = await authorized("plugin-a");
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

  it("resets a retired state without importing any retired binding", async () : Promise<any> => {
    const dataDir: any = await root();
    const alias: any = "retired-state-reset-fixture";
    const sealingKeyBase64: any = crypto.randomBytes(32).toString("base64");
    const retiredState: Record<string, any> = {
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
    const service: any = createProcessIdentityService({ dataDir, alias });
    await service.describe();
    service.close();
    const persisted: any = openState(await readRecord({ dataDir, alias }));
    expect(persisted.stateVersion).toBe(2);
    expect(persisted).not.toHaveProperty("retiredBindings");
    expect(persisted.clients).toEqual([]);
    expect(persisted.ownerProcessBindings).toEqual([]);
    expect(persisted.retiredOwnerProcessBindingGenerations).toEqual([]);
    expect(JSON.stringify(persisted)).not.toContain("retired-binding");
  });
});

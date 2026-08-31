#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOperationProofSubstrate } from "#meshrix/foundation/proof/proof-substrate/index";
import { createAgentWorkspace } from "../../packages/agents/src/agent-workspace/index.ts";
import {
  CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION,
  createContributionRegistry
} from "../../packages/agents/src/workspace-contribution/index.ts";
import { createWorkspaceAssetRegistry } from "../../packages/agents/src/workspace-asset-registry/index.ts";
import { createWorkspaceGovernanceRegistry } from "../../packages/agents/src/workspace-governance/index.ts";
import { executeConsoleDomainOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executor.ts";
import { buildWorkspaceAssetRegistryInput } from "../../packages/server-runtime/src/composition/console-domain/operation-executors/workspace-asset-governance.ts";

const b64: any = (value?: any) : any => Buffer.from(value).toString("base64");

let passed: any = 0;
let failed: any = 0;

async function test(name?: any, fn?: any) : Promise<any> {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    passed += 1;
    console.log("ok");
  } catch (error: any) {
    failed += 1;
    console.log("FAIL");
    console.log(`      ${error?.stack || error?.message || String(error)}`);
  }
}

function authSession(scopes: any = []) : any {
  return {
    user: {
      userId: "verify-workspace-asset-management",
      username: "verify-workspace-asset-management",
      scopes
    }
  };
}

const allScopes: any[] = [
  "auth:admin",
  "workspace:read",
  "workspace:write",
  "workspace:maintain",
  "storage:read",
  "storage:write",
  "repo:read",
  "repo:write",
  "repo:review"
];

const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-workspace-assets-"));
const contributionRegistries: any = new Map<any, any>();
const operationProviders: Readonly<Record<string, any>> = Object.freeze({
  operationProofSubstrate: createOperationProofSubstrate({ userDataPath }),
  workspaceAssetRegistry: createWorkspaceAssetRegistry({ userDataPath }),
  workspaceGovernanceRegistry: createWorkspaceGovernanceRegistry({ userDataPath }),
  getContributionRegistry(input: Record<string, any> = {}, context: Record<string, any> = {}) : any {
    const workspaceId: any = String(input.workspaceId || context.workspaceId || "").trim();
    if (!workspaceId) {
      throw Object.assign(new TypeError("workspaceId must be explicit in the workspace asset verifier."), {
        code: "workspace_binding_invalid"
      });
    }
    if (!contributionRegistries.has(workspaceId)) {
      contributionRegistries.set(workspaceId, createContributionRegistry({
        workspaceId,
        userDataPath,
        excludedContributionTypes: ["skill"],
        lifecycleDefinition: CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION
      }));
    }
    return contributionRegistries.get(workspaceId);
  }
});

console.log("\n=== Workspace Asset Management ===\n");

try {
  await test("operation proof substrate records idempotent started/completed entries", async () : Promise<any> => {
    const ledger: any = createOperationProofSubstrate({ userDataPath });
    const first: any = await ledger.beginLifecycle({
      operationId: "workspace.file.upload",
      workspaceId: "ws-ledger",
      semantic: "submit",
      targetKind: "workspaceFolder",
      targetRef: { path: "files/a.txt" },
      input: { path: "files/a.txt", content: "secret-free" },
      idempotencyKey: "idem-1",
      warnings: [{ code: "governance_policy_missing" }]
    });
    const replay: any = await ledger.beginLifecycle({
      operationId: "workspace.file.upload",
      workspaceId: "ws-ledger",
      semantic: "submit",
      targetKind: "workspaceFolder",
      targetRef: { path: "files/a.txt" },
      input: { path: "files/a.txt", content: "secret-free" },
      idempotencyKey: "idem-1"
    });
    assert.equal(replay.ledgerEventId, first.ledgerEventId);
    assert.equal(replay.replayed, true);
    const completed: any = await ledger.finishLifecycle({
      entry: first,
      status: "succeeded",
      assetRef: "workspace_asset_test",
      receiptRefs: ["workspace_asset_receipt_test"]
    });
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.assetRef, "workspace_asset_test");
    assert.deepEqual(completed.receiptRefs, ["workspace_asset_receipt_test"]);
  });

  await test("asset registry records asset, revision, projection, receipt, and lineage", async () : Promise<any> => {
    const registry: any = createWorkspaceAssetRegistry({ userDataPath });
    const recorded: any = registry.recordAssetMutation({
      workspaceId: "  ws-registry  ",
      assetKind: "file",
      canonicalState: "canonical",
      displayName: "files/report.md",
      targetKind: "workspaceFolder",
      targetRef: { kind: "workspaceFolder", path: "files/report.md" },
      sourceRef: { kind: "verify" },
      content: { contentHash: "sha256-registry", byteSize: 12, mediaType: "text/markdown" },
      ledgerEventId: "operation_proof_registry",
      downstreamOperationId: "workspace.file.upload",
      receipts: [{ receiptType: "verifyReceipt", receipt: { ok: true } }],
      links: [{ linkedRef: "source://verify", linkType: "derived_from" }]
    });
    assert.ok(recorded.assetRef);
    assert.ok(recorded.revisionRef);
    assert.equal(recorded.canonicalState, "canonical");
    assert.equal(recorded.receiptRefs.length, 1);
    const asset: any = registry.getAsset({ assetRef: recorded.assetRef });
    assert.equal(asset.assetRef, recorded.assetRef);
    assert.equal(asset.workspaceId, "ws-registry");
    assert.equal(asset.revisions.length, 1);
    assert.equal(asset.projections.length, 1);
    assert.equal(asset.receipts.length, 1);
    assert.equal(asset.lineageLinks.length, 1);
  });

  await test("adoption registry projection belongs to the explicit target workspace", async () : Promise<any> => {
    const projection: any = buildWorkspaceAssetRegistryInput({
      operationId: "workspace.contribution.adopt",
      downstreamOperationId: "workspace.contribution.adopt",
      input: {
        workspaceId: "source-workspace",
        targetWorkspaceId: "target-workspace",
        contributionId: "target-bound-contribution"
      },
      target: { kind: "workspaceContribution" },
      downstream: {
        contribution: {
          contributionId: "target-bound-contribution",
          workspaceId: "source-workspace"
        }
      }
    });
    assert.equal(projection.workspaceId, "target-workspace");
    assert.equal(projection.targetRef.sourceWorkspaceId, "source-workspace");
    assert.equal(projection.targetRef.targetWorkspaceId, "target-workspace");
  });

  await test("workspace-bound writes reject implicit attribution before proof, downstream, provider, or registry state", async () : Promise<any> => {
    let proofStarts: any = 0;
    let downstreamWrites: any = 0;
    let policyWrites: any = 0;
    let contributionProviderReads: any = 0;
    const context: any = {
      operationProofSubstrate: {
        async beginLifecycle() : Promise<any> {
          proofStarts += 1;
          throw new Error("must not start");
        }
      },
      workspaceAssetRegistry: operationProviders.workspaceAssetRegistry,
      workspaceGovernanceRegistry: operationProviders.workspaceGovernanceRegistry,
      agentWorkspace: {
        uploadWorkspaceFile() : any {
          downstreamWrites += 1;
          return { ok: true };
        }
      },
      securityPermissions: {
        setWorkspaceAssetPolicy() : any {
          policyWrites += 1;
          return {};
        }
      },
      getContributionRegistry() : any {
        contributionProviderReads += 1;
        throw new Error("contribution provider must not be reached");
      },
      authSession: authSession(allScopes),
      userDataPath
    };
    const missingWorkspaceOperations: any[] = [
      ["workspace.file.upload", { path: "files/missing.txt", content: "x" }],
      ["workspace.asset.submit", { target: { kind: "workspaceFolder", path: "files/missing.txt" } }],
      ["workspace.asset.backfill", { limit: 100 }],
      ["workspace.asset.policy.set", { accessMode: "restricted" }],
      ["workspace.contribution.submit", { title: "missing workspace" }],
      ["workspace.contribution.permission.request", { contributionId: "missing-workspace" }],
      ["workspace.contribution.permission.grant", { contributionId: "missing-workspace" }],
      ["workspace.contribution.scan", { contributionId: "missing-workspace" }],
      ["workspace.contribution.review", { contributionId: "missing-workspace" }],
      ["workspace.contribution.preview", { contributionId: "missing-workspace" }],
      ["workspace.contribution.publish", { contributionId: "missing-workspace" }],
      ["workspace.contribution.adopt", { contributionId: "missing-workspace" }],
      ["workspace.contribution.reject", { contributionId: "missing-workspace" }],
      ["workspace.contribution.request_changes", { contributionId: "missing-workspace" }],
      ["workspace.contribution.revoke", { contributionId: "missing-workspace" }]
    ];
    for (const [operationId, input] of missingWorkspaceOperations) {
      const response: any = await executeConsoleDomainOperation({ operationId, input, context });
      assert.equal(response.status, 400, `${operationId} must reject an implicit workspace`);
      assert.equal(response.payload.error.code, "workspace_binding_invalid");
    }
    for (const input of [
      { workspaceId: "", path: "files/missing.txt", content: "x" },
      { workspaceId: 42, path: "files/missing.txt", content: "x" },
      { workspace: "legacy-workspace", path: "files/missing.txt", content: "x" }
    ]) {
      const response: any = await executeConsoleDomainOperation({
        operationId: "workspace.file.upload",
        input,
        context
      });
      assert.equal(response.status, 400);
      assert.equal(response.payload.error.code, "workspace_binding_invalid");
    }
    assert.equal(proofStarts, 0);
    assert.equal(downstreamWrites, 0);
    assert.equal(policyWrites, 0);
    assert.equal(contributionProviderReads, 0);

    const registry: any = createWorkspaceAssetRegistry({ userDataPath });
    for (const input of [{}, { workspace: "legacy-workspace" }, { workspaceId: "" }, { workspaceId: 42 }]) {
      assert.throws(
        () : any => registry.recordAssetMutation(input),
        (error: any) : any => error?.code === "workspace_binding_invalid"
      );
    }
    assert.equal(registry.listAssets({ workspaceId: "default" }).count, 0);

    const globalRead: any = await executeConsoleDomainOperation({
      operationId: "workspace.asset.list",
      input: {},
      context
    });
    assert.equal(globalRead.status, 200);
  });

  await test("cross-workspace contribution writes reject an implicit target before proof or provider access", async () : Promise<any> => {
    let proofStarts: any = 0;
    let contributionProviderReads: any = 0;
    const context: any = {
      operationProofSubstrate: {
        async beginLifecycle() : Promise<any> {
          proofStarts += 1;
          throw new Error("proof must not start");
        }
      },
      workspaceAssetRegistry: operationProviders.workspaceAssetRegistry,
      workspaceGovernanceRegistry: operationProviders.workspaceGovernanceRegistry,
      getContributionRegistry() : any {
        contributionProviderReads += 1;
        throw new Error("contribution provider must not be reached");
      },
      authSession: authSession(allScopes),
      userDataPath
    };
    for (const operationId of [
      "workspace.contribution.permission.request",
      "workspace.contribution.permission.grant",
      "workspace.contribution.adopt"
    ]) {
      const response: any = await executeConsoleDomainOperation({
        operationId,
        input: { workspaceId: "source-workspace", contributionId: "missing-target" },
        context
      });
      assert.equal(response.status, 400, `${operationId} must reject an implicit target workspace`);
      assert.equal(response.payload.error.code, "workspace_binding_invalid");
      assert.match(response.payload.error.message, /targetWorkspaceId/u);
    }
    assert.equal(proofStarts, 0);
    assert.equal(contributionProviderReads, 0);
  });

  await test("contribution scan and preview execute through managed workspace proof and registry projection", async () : Promise<any> => {
    const workspaceId: any = "contribution-managed-workspace";
    const context: any = {
      ...operationProviders,
      authSession: authSession(allScopes),
      userDataPath
    };
    const submittedForScan: any = await executeConsoleDomainOperation({
      operationId: "workspace.contribution.submit",
      input: {
        workspaceId,
        contributionId: "managed-scan-contribution",
        title: "Managed scan contribution"
      },
      context
    });
    assert.equal(submittedForScan.status, 201, JSON.stringify(submittedForScan.payload, null, 2));
    const packageChecksum: any = submittedForScan.payload.contribution.packageChecksum;
    const scanned: any = await executeConsoleDomainOperation({
      operationId: "workspace.contribution.scan",
      input: {
        workspaceId,
        contributionId: "managed-scan-contribution",
        scanReceipt: {
          runId: "managed-scan-run",
          workloadKind: "contribution_scan",
          status: "succeeded",
          cleanupStatus: "destroyed",
          workloadArtifactDigest: "a".repeat(64),
          inputDigest: packageChecksum,
          packageDigest: packageChecksum
        }
      },
      context
    });
    assert.equal(scanned.status, 200, JSON.stringify(scanned.payload, null, 2));
    assert.equal(scanned.payload.contribution.status, "scanned");
    assert.ok(scanned.payload.workspaceAsset?.ledgerEventId);

    const submittedForPreview: any = await executeConsoleDomainOperation({
      operationId: "workspace.contribution.submit",
      input: {
        workspaceId,
        contributionId: "managed-preview-contribution",
        title: "Managed preview contribution"
      },
      context
    });
    assert.equal(submittedForPreview.status, 201, JSON.stringify(submittedForPreview.payload, null, 2));
    const previewed: any = await executeConsoleDomainOperation({
      operationId: "workspace.contribution.preview",
      input: {
        workspaceId,
        contributionId: "managed-preview-contribution"
      },
      context
    });
    assert.equal(previewed.status, 200, JSON.stringify(previewed.payload, null, 2));
    assert.equal(previewed.payload.contribution.status, "preview");
    assert.ok(previewed.payload.workspaceAsset?.ledgerEventId);
  });

  await test("direct workspace file upload appends workspaceAsset and writes proof/registry state", async () : Promise<any> => {
    const agentWorkspace: any = createAgentWorkspace({ userDataPath });
    const created: any = agentWorkspace.createWorkspace({
      ownerUserId: "verify-workspace-asset-management",
      title: "Unified Asset Workspace"
    });
    const workspaceId: any = created.workspace.workspaceId;
    const response: any = await executeConsoleDomainOperation({
      operationId: "workspace.file.upload",
      input: {
        workspaceId,
        path: "files/direct-upload.txt",
        contentBase64: b64("direct upload\n"),
        overwrite: true,
        idempotencyKey: "direct-upload-1"
      },
      context: {
        ...operationProviders,
        userDataPath,
        agentWorkspace,
        authSession: authSession(allScopes)
      }
    });
    assert.equal(response.status, 201, JSON.stringify(response.payload, null, 2));
    assert.equal(response.payload.ok, true);
    assert.ok(response.payload.file?.relativePath);
    assert.ok(response.payload.workspaceAsset?.assetRef);
    assert.ok(response.payload.workspaceAsset?.revisionRef);
    assert.ok(response.payload.workspaceAsset?.ledgerEventId);
    const registry: any = createWorkspaceAssetRegistry({ userDataPath });
    const asset: any = registry.getAsset({ assetRef: response.payload.workspaceAsset.assetRef });
    assert.equal(asset.assetRef, response.payload.workspaceAsset.assetRef);
    assert.equal(asset.canonicalState, "canonical");
    const ledger: any = createOperationProofSubstrate({ userDataPath });
    const entry: any = await ledger.getReceipt(response.payload.workspaceAsset.ledgerEventId);
    assert.equal(entry.status, "succeeded");
    assert.match(entry.inputDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(Object.hasOwn(entry, "input"), false);
  });

  await test("workspace.asset.submit uses orchestrator envelope and registry projection", async () : Promise<any> => {
    const agentWorkspace: any = createAgentWorkspace({ userDataPath });
    const created: any = agentWorkspace.createWorkspace({
      ownerUserId: "verify-workspace-asset-management",
      title: "Workspace Asset Submit"
    });
    const workspaceId: any = created.workspace.workspaceId;
    const response: any = await executeConsoleDomainOperation({
      operationId: "workspace.asset.submit",
      input: {
        workspaceId,
        target: { kind: "workspaceFolder", path: "files/facade-submit.txt" },
        content: { contentBase64: b64("facade submit\n") },
        overwrite: true,
        idempotencyKey: "facade-submit-1"
      },
      context: {
        ...operationProviders,
        userDataPath,
        agentWorkspace,
        authSession: authSession(allScopes)
      }
    });
    assert.equal(response.status, 201, JSON.stringify(response.payload, null, 2));
    assert.equal(response.payload.ok, true);
    assert.ok(response.payload.assetRef);
    assert.ok(response.payload.workspaceAsset?.assetRef);
    assert.equal(response.payload.routeDecision.downstreamOperationId, "workspace.file.upload");
    const list: any = await executeConsoleDomainOperation({
      operationId: "workspace.asset.list",
      input: { workspaceId, limit: 20 },
      context: { ...operationProviders, userDataPath, agentWorkspace, authSession: authSession(allScopes) }
    });
    assert.equal(list.status, 200);
    assert.ok(list.payload.downstream.items.some((item?: any) : any => item.assetRef === response.payload.assetRef));
  });

  await test("backfill registers existing workspace files without replaying side effects", async () : Promise<any> => {
    const agentWorkspace: any = createAgentWorkspace({ userDataPath });
    const created: any = agentWorkspace.createWorkspace({
      ownerUserId: "verify-workspace-asset-management",
      title: "Backfill Workspace"
    });
    const workspaceId: any = created.workspace.workspaceId;
    await agentWorkspace.uploadWorkspaceFile({
      actorUserId: "verify-workspace-asset-management",
      workspaceId,
      path: "files/backfill.txt",
      contentBase64: b64("backfill\n"),
      overwrite: true
    });
    const response: any = await executeConsoleDomainOperation({
      operationId: "workspace.asset.backfill",
      input: { workspaceId, limit: 100 },
      context: {
        ...operationProviders,
        userDataPath,
        agentWorkspace,
        authSession: authSession(allScopes)
      }
    });
    assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
    assert.equal(response.payload.downstream.ok, true);
    assert.ok(response.payload.downstream.files >= 1);
    assert.ok(response.payload.ledgerEventId);
  });

  await test("ledger unavailable fails closed before downstream side effect", async () : Promise<any> => {
    const blockedPath: any = path.join(userDataPath, "not-a-directory");
    await fs.writeFile(blockedPath, "not a directory", "utf8");
    let sideEffect: any = false;
    const blockedLedgerAgentWorkspace: Record<string, any> = {
      uploadWorkspaceFile() : any {
        sideEffect = true;
        return {
          ok: true,
          file: { relativePath: "files/should-not-write.txt", contentSha256: "nope", sizeBytes: 1 }
        };
      }
    };
    const response: any = await executeConsoleDomainOperation({
      operationId: "workspace.file.upload",
      input: {
        workspaceId: "ws-fail-closed",
        path: "files/should-not-write.txt",
        content: "x"
      },
      context: {
        ...operationProviders,
        operationProofSubstrate: {
          async beginLifecycle() : Promise<any> {
            throw new Error("proof substrate unavailable");
          }
        },
        userDataPath: blockedPath,
        agentWorkspace: blockedLedgerAgentWorkspace,
        authSession: authSession(allScopes)
      }
    });
    assert.equal(response.status, 503);
    assert.equal(sideEffect, false, "downstream adapter must not run when ledger cannot start");
  });
} finally {
  for (const registry of contributionRegistries.values()) {
    await registry?.close?.();
  }
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);

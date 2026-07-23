#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOperationProofSubstrate } from "#lico/foundation/proof/proof-substrate/index";
import { createAgentWorkspace } from "../../packages/agents/src/agent-workspace/index.mjs";
import {
  CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION,
  createContributionRegistry
} from "../../packages/agents/src/workspace-contribution/index.mjs";
import { createWorkspaceAssetRegistry } from "../../packages/agents/src/workspace-asset-registry/index.mjs";
import { createWorkspaceGovernanceRegistry } from "../../packages/agents/src/workspace-governance/index.mjs";
import { executeConsoleDomainOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executor.mjs";

const b64 = (value) => Buffer.from(value).toString("base64");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    passed += 1;
    console.log("ok");
  } catch (error) {
    failed += 1;
    console.log("FAIL");
    console.log(`      ${error?.stack || error?.message || String(error)}`);
  }
}

function authSession(scopes = []) {
  return {
    user: {
      userId: "verify-workspace-asset-management",
      username: "verify-workspace-asset-management",
      scopes
    }
  };
}

const allScopes = [
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

const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-workspace-assets-"));
const contributionRegistries = new Map();
const operationProviders = Object.freeze({
  operationProofSubstrate: createOperationProofSubstrate({ userDataPath }),
  workspaceAssetRegistry: createWorkspaceAssetRegistry({ userDataPath }),
  workspaceGovernanceRegistry: createWorkspaceGovernanceRegistry({ userDataPath }),
  getContributionRegistry(input = {}, context = {}) {
    const workspaceId = String(input.workspaceId || context.workspaceId || "default").trim() || "default";
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
  await test("operation proof substrate records idempotent started/completed entries", async () => {
    const ledger = createOperationProofSubstrate({ userDataPath });
    const first = await ledger.beginLifecycle({
      operationId: "workspace.file.upload",
      workspaceId: "ws-ledger",
      semantic: "submit",
      targetKind: "workspaceFolder",
      targetRef: { path: "files/a.txt" },
      input: { path: "files/a.txt", content: "secret-free" },
      idempotencyKey: "idem-1",
      warnings: [{ code: "governance_policy_missing" }]
    });
    const replay = await ledger.beginLifecycle({
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
    const completed = await ledger.finishLifecycle({
      entry: first,
      status: "succeeded",
      assetRef: "workspace_asset_test",
      receiptRefs: ["workspace_asset_receipt_test"]
    });
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.assetRef, "workspace_asset_test");
    assert.deepEqual(completed.receiptRefs, ["workspace_asset_receipt_test"]);
  });

  await test("asset registry records asset, revision, projection, receipt, and lineage", async () => {
    const registry = createWorkspaceAssetRegistry({ userDataPath });
    const recorded = registry.recordAssetMutation({
      workspaceId: "ws-registry",
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
    const asset = registry.getAsset({ assetRef: recorded.assetRef });
    assert.equal(asset.assetRef, recorded.assetRef);
    assert.equal(asset.revisions.length, 1);
    assert.equal(asset.projections.length, 1);
    assert.equal(asset.receipts.length, 1);
    assert.equal(asset.lineageLinks.length, 1);
  });

  await test("direct workspace file upload appends workspaceAsset and writes proof/registry state", async () => {
    const agentWorkspace = createAgentWorkspace({ userDataPath });
    const created = agentWorkspace.createWorkspace({
      ownerUserId: "verify-workspace-asset-management",
      title: "Unified Asset Workspace"
    });
    const workspaceId = created.workspace.workspaceId;
    const response = await executeConsoleDomainOperation({
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
    const registry = createWorkspaceAssetRegistry({ userDataPath });
    const asset = registry.getAsset({ assetRef: response.payload.workspaceAsset.assetRef });
    assert.equal(asset.assetRef, response.payload.workspaceAsset.assetRef);
    assert.equal(asset.canonicalState, "canonical");
    const ledger = createOperationProofSubstrate({ userDataPath });
    const entry = await ledger.getReceipt(response.payload.workspaceAsset.ledgerEventId);
    assert.equal(entry.status, "succeeded");
    assert.match(entry.inputDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(Object.hasOwn(entry, "input"), false);
  });

  await test("workspace.asset.submit uses orchestrator envelope and registry projection", async () => {
    const agentWorkspace = createAgentWorkspace({ userDataPath });
    const created = agentWorkspace.createWorkspace({
      ownerUserId: "verify-workspace-asset-management",
      title: "Workspace Asset Submit"
    });
    const workspaceId = created.workspace.workspaceId;
    const response = await executeConsoleDomainOperation({
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
    const list = await executeConsoleDomainOperation({
      operationId: "workspace.asset.list",
      input: { workspaceId, limit: 20 },
      context: { ...operationProviders, userDataPath, agentWorkspace, authSession: authSession(allScopes) }
    });
    assert.equal(list.status, 200);
    assert.ok(list.payload.downstream.items.some((item) => item.assetRef === response.payload.assetRef));
  });

  await test("backfill registers existing workspace files without replaying side effects", async () => {
    const agentWorkspace = createAgentWorkspace({ userDataPath });
    const created = agentWorkspace.createWorkspace({
      ownerUserId: "verify-workspace-asset-management",
      title: "Backfill Workspace"
    });
    const workspaceId = created.workspace.workspaceId;
    await agentWorkspace.uploadWorkspaceFile({
      actorUserId: "verify-workspace-asset-management",
      workspaceId,
      path: "files/backfill.txt",
      contentBase64: b64("backfill\n"),
      overwrite: true
    });
    const response = await executeConsoleDomainOperation({
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

  await test("ledger unavailable fails closed before downstream side effect", async () => {
    const blockedPath = path.join(userDataPath, "not-a-directory");
    await fs.writeFile(blockedPath, "not a directory", "utf8");
    let sideEffect = false;
    const blockedLedgerAgentWorkspace = {
      uploadWorkspaceFile() {
        sideEffect = true;
        return {
          ok: true,
          file: { relativePath: "files/should-not-write.txt", contentSha256: "nope", sizeBytes: 1 }
        };
      }
    };
    const response = await executeConsoleDomainOperation({
      operationId: "workspace.file.upload",
      input: {
        workspaceId: "ws-fail-closed",
        path: "files/should-not-write.txt",
        content: "x"
      },
      context: {
        ...operationProviders,
        operationProofSubstrate: {
          async beginLifecycle() {
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
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);

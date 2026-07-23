import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONTROLLED_SANDBOX_FINAL_RECEIPT_ID,
  SANDBOX_CUSTODY_PROMOTION_SCHEMA,
  SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA,
  SANDBOX_DENIAL_REASONS,
  custodyPromotionAuthorizationDigest,
  custodyPromotionSetDigest,
  sandboxDigest
} from "../../../packages/foundation/src/execution-sandbox/index.mjs";
import { createSandboxExecutionBroker } from "../../../packages/server-runtime/src/execution-sandbox/broker.mjs";

const roots = [];
const restrictions = [
  "filesystem",
  "process",
  "network",
  "environment",
  "credentials",
  "resources",
  "output",
  "cleanup",
  "cross-trust-domain"
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function resources() {
  return {
    wallTimeMs: 5000,
    cpuMillis: 1000,
    memoryBytes: 16 * 1024 * 1024,
    processes: 1,
    fileDescriptors: 16,
    diskBytes: 1024 * 1024,
    inodes: 32,
    fileCount: 16,
    outputBytes: 4096,
    logBytes: 4096,
    networkBytes: 1,
    toolCalls: 1
  };
}

function configuration() {
  return {
    enabled: true,
    providerMode: "explicit",
    providerId: "configured-provider",
    profileId: "configured-profile",
    policyRevision: "policy-current",
    allowedProviderClasses: ["registered-container"],
    receiptRequirement: CONTROLLED_SANDBOX_FINAL_RECEIPT_ID
  };
}

function profile(artifactDigests) {
  return {
    id: "configured-profile",
    policyRevision: "policy-current",
    workloads: {
      skill_scan: {
        runtimeKind: "oci",
        image: `scanner@sha256:${sha256("scanner-image")}`,
        command: ["bin/scan"],
        artifactDigests,
        entryPoint: "bin/scan"
      }
    },
    capabilities: {
      filesystem: ["input:read", "output:write"],
      network: [],
      tools: [],
      secretRefs: [],
      clock: false,
      randomness: false,
      subprocesses: 0
    },
    resourceLimits: resources(),
    requiresApproval: true,
    receiptRequirement: CONTROLLED_SANDBOX_FINAL_RECEIPT_ID
  };
}

function request(inputDigest, approvalRef = "approval-ref") {
  return {
    schemaVersion: SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA,
    workloadKind: "skill_scan",
    principal: {
      subjectRef: "subject-ref",
      tenantRef: "tenant-ref",
      workspaceRef: "workspace-ref",
      operationRef: "sample_plugin.scan"
    },
    invocation: { args: [], workingDirectory: "workspace" },
    inputs: [{ handle: "opaque-package", digest: inputDigest, readOnly: true }],
    outputs: {
      schema: "scan-output",
      maxFiles: 1,
      maxBytes: 4096,
      allowedTypes: ["json"]
    },
    capabilities: {
      filesystem: ["input:read", "output:write"],
      network: [],
      tools: [],
      secretRefs: [],
      clock: false,
      randomness: false,
      subprocesses: 0
    },
    resources: resources(),
    governance: {
      grantRef: "grant-ref",
      approvalRef,
      approvalBindingDigest: "b".repeat(64),
      approvalSourceDigest: "c".repeat(64),
      approvalRequestDigest: "",
      approvalExpiresAt: "2099-01-01T00:00:00.000Z",
      authorizationContextDigest: "d".repeat(64),
      riskDecisionRef: "risk-ref",
      policyRevision: "policy-current",
      authorized: true
    },
    idempotencyKey: `configured-${crypto.randomUUID()}`,
    deadlineAt: new Date(Date.now() + 60_000).toISOString()
  };
}

function currentGovernance(approvalRef = "approval-ref") {
  return {
    grantRef: "grant-ref",
    approvalRef,
    approvalBindingDigest: "b".repeat(64),
    approvalSourceDigest: "c".repeat(64),
    approvalRequestDigest: "",
    approvalExpiresAt: "2099-01-01T00:00:00.000Z",
    authorizationContextDigest: "d".repeat(64),
    riskDecisionRef: "risk-ref",
    policyRevision: "policy-current",
    authorized: true,
    current: true,
    revoked: false
  };
}

function providerResolver() {
  const descriptor = {
    id: "configured-provider",
    providerClass: "registered-container",
    healthy: true,
    enforcedRestrictions: restrictions,
    conformanceReceipt: { receiptId: "provider-receipt" }
  };
  const resolution = {
    generation: 1,
    descriptor,
    backend: {
      async run(context) {
        await fs.writeFile(path.join(context.paths.outputRoot, "scan.json"), "{}", "utf8");
        return { status: "succeeded", resourceTotals: {} };
      },
      async cleanup() { return { destroyed: true }; }
    }
  };
  return {
    async resolve() {
      return resolution;
    },
    validate(candidate) { return candidate === resolution; },
    async close() {}
  };
}

async function brokerFor(artifactDigests, resolver = providerResolver()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-configured-workload-"));
  roots.push(root);
  return createSandboxExecutionBroker({
    configuration: configuration(),
    profiles: { "configured-profile": profile(artifactDigests) },
    providerResolver: resolver,
    opaqueArtifactCustody: {
      async promote(_request, sink) { await sink(Buffer.from("opaque-package")); }
    },
    userDataPath: root
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("profile-bound configured sandbox workloads", () => {
  it("binds configured workload identity for immutable non-custody inputs", async () => {
    const workloadArtifactDigest = sha256("trusted-verifier-workload");
    const source = Buffer.from("export default true;\n");
    const sourceDigest = sha256(source);
    const inputDigest = sandboxDigest([{ path: "verifier.mjs", digest: sourceDigest }]);
    const broker = await brokerFor([workloadArtifactDigest]);

    const receipt = await broker.executeConfigured(
      request(inputDigest),
      async (declared) => ({
        digest: declared.digest,
        files: [{ path: "verifier.mjs", digest: sourceDigest, content: source }]
      }),
      { currentGovernance: currentGovernance(), pluginId: "fixture-plugin" }
    );

    expect(receipt).toMatchObject({
      artifactDigest: workloadArtifactDigest,
      inputDigests: [inputDigest],
      cleanupState: "destroyed"
    });
    expect(await broker.disposeOutput(receipt.outputHandle, "rejected", {
      pluginId: "fixture-plugin",
      owningOperationReceiptDigest: sha256("configured-workload-identity-rejection")
    })).toBe(true);
    await broker.close();
  });

  it("binds the configured scanner to the complete opaque promotion tuple", async () => {
    const workloadArtifactDigest = sha256("trusted-scanner-workload");
    const packageDigest = sha256("opaque-package");
    const opaqueFile = {
      path: "package.bundle",
      digest: packageDigest,
      custodyRef: "custody:fixture",
      envelopeDigest: sha256("envelope"),
      promotionSchemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA
    };
    const inputDigest = sandboxDigest([{ path: opaqueFile.path, digest: opaqueFile.digest }]);
    const promotionDigest = custodyPromotionSetDigest({
      files: [{ ...opaqueFile, contentDigest: opaqueFile.digest }]
    });
    const authorizationDigest = custodyPromotionAuthorizationDigest({
      promotionDigest,
      ownerBinding: { subjectRef: "subject-ref", tenantRef: "tenant-ref", workspaceRef: "workspace-ref" },
      governance: currentGovernance()
    });
    const promotionRequests = [];
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-configured-workload-"));
    roots.push(root);
    const broker = createSandboxExecutionBroker({
      configuration: configuration(),
      profiles: { "configured-profile": profile([workloadArtifactDigest]) },
      providerResolver: providerResolver(),
      opaqueArtifactCustody: {
        async promote(promotion, sink) {
          promotionRequests.push(promotion);
          await sink(Buffer.from("opaque-package"));
        }
      },
      userDataPath: root
    });

    const receipt = await broker.executeConfiguredOpaque(
      request(inputDigest),
      [{
        handle: "opaque-package",
        promotionDigest,
        authorizationDigest,
        files: [opaqueFile]
      }],
      { currentGovernance: currentGovernance(), pluginId: "sample-plugin" }
    );

    expect(receipt.status, JSON.stringify({ reasonCode: receipt.reasonCode, failureStage: receipt.failureStage })).toBe("output_quarantined");
    expect(receipt).toMatchObject({
      status: "output_quarantined",
      artifactDigest: workloadArtifactDigest,
      inputDigests: [inputDigest],
      cleanupState: "destroyed"
    });
    expect(promotionRequests).toHaveLength(1);
    expect(promotionRequests[0]).toMatchObject({
      schemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA,
      handle: opaqueFile.custodyRef,
      contentDigest: opaqueFile.digest,
      envelopeDigest: opaqueFile.envelopeDigest,
      subjectRef: "subject-ref",
      tenantRef: "tenant-ref",
      workspaceRef: "workspace-ref",
      authorizationRef: "grant-ref",
      approvalRef: "approval-ref",
      policyRevision: "policy-current",
      sandboxAvailable: true
    });
    expect(await broker.disposeOutput(receipt.outputHandle, "rejected", {
      owningOperationReceiptDigest: sha256("configured-workload-rejection")
    })).toBe(true);
    const substitutedApprovalRef = "approval-ref-substituted";
    const substituted = await broker.executeConfiguredOpaque(
      request(inputDigest, substitutedApprovalRef),
      [{
        handle: "opaque-package",
        promotionDigest,
        authorizationDigest: "0".repeat(64),
        files: [opaqueFile]
      }],
      { currentGovernance: currentGovernance(substitutedApprovalRef), pluginId: "sample-plugin" }
    );
    expect(substituted).toMatchObject({
      status: "failed",
      reasonCode: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED,
      failureStage: "input_staging_failed"
    });
    await broker.close();
  });

  it("denies an ambiguous workload artifact configuration before provider execution", async () => {
    const packageDigest = sha256("opaque-package");
    const inputDigest = sandboxDigest([{ path: "package.bundle", digest: packageDigest }]);
    const broker = await brokerFor([sha256("scanner-one"), sha256("scanner-two")]);

    const receipt = await broker.executeConfiguredOpaque(request(inputDigest), []);

    expect(receipt).toMatchObject({
      status: "denied",
      reasonCode: SANDBOX_DENIAL_REASONS.CONFIGURATION_INVALID
    });
    await broker.close();
  });

  it("records bounded input-staging and backend failure stages", async () => {
    const workloadArtifactDigest = sha256("trusted-scanner-workload");
    const sourceDigest = sha256("expected-input");
    const inputDigest = sandboxDigest([{ path: "package.bundle", digest: sourceDigest }]);
    const stagingBroker = await brokerFor([workloadArtifactDigest]);

    const stagingReceipt = await stagingBroker.executeConfigured(
      request(inputDigest),
      async () => ({
        files: [{ path: "package.bundle", digest: sourceDigest, content: Buffer.from("different-input") }]
      }),
      { currentGovernance: currentGovernance(), pluginId: "fixture-plugin" }
    );
    expect(stagingReceipt).toMatchObject({
      status: "failed",
      reasonCode: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED,
      failureStage: "input_staging_failed",
      cleanupState: "destroyed"
    });
    await stagingBroker.close();

    const descriptor = {
      id: "configured-provider",
      providerClass: "registered-container",
      healthy: true,
      enforcedRestrictions: restrictions,
      conformanceReceipt: { receiptId: "provider-receipt" }
    };
    const failingResolution = {
      generation: 1,
      descriptor,
      backend: {
        async run() { throw new Error("bounded fixture failure"); },
        async cleanup() { return { destroyed: true }; }
      }
    };
    const failingResolver = {
      async resolve() { return failingResolution; },
      validate(candidate) { return candidate === failingResolution; },
      async close() {}
    };
    const backendBroker = await brokerFor([workloadArtifactDigest], failingResolver);
    const backendReceipt = await backendBroker.executeConfigured(
      request(inputDigest),
      async (declared) => ({
        digest: declared.digest,
        files: [{ path: "package.bundle", digest: sourceDigest, content: Buffer.from("expected-input") }]
      }),
      { currentGovernance: currentGovernance(), pluginId: "fixture-plugin" }
    );
    expect(backendReceipt).toMatchObject({
      status: "failed",
      reasonCode: SANDBOX_DENIAL_REASONS.RUNTIME_FAILED,
      failureStage: "sandbox_backend_failed",
      cleanupState: "destroyed"
    });
    await backendBroker.close();
  });

  it("fails the run when a provider reports a finite resource total above admission", async () => {
    const workloadArtifactDigest = sha256("trusted-resource-bounded-workload");
    const source = Buffer.from("resource-bounded-input", "utf8");
    const sourceDigest = sha256(source);
    const inputDigest = sandboxDigest([{ path: "package.bundle", digest: sourceDigest }]);
    const admitted = resources();
    const descriptor = {
      id: "configured-provider",
      providerClass: "registered-container",
      healthy: true,
      enforcedRestrictions: restrictions,
      conformanceReceipt: { receiptId: "provider-receipt" }
    };
    const resourceResolution = {
      generation: 1,
      descriptor,
      backend: {
        async run() {
          return {
            status: "succeeded",
            resourceTotals: {
              memoryBytes: admitted.memoryBytes + 1,
              wallTimeMs: 1
            }
          };
        },
        async cleanup() { return { destroyed: true }; }
      }
    };
    const resolver = {
      async resolve() { return resourceResolution; },
      validate(candidate) { return candidate === resourceResolution; },
      async close() {}
    };
    const authorizationContextDigest = sha256("resource-budget-authorization-context");
    const executionRequest = request(inputDigest);
    executionRequest.governance.authorizationContextDigest = authorizationContextDigest;
    const governance = {
      ...currentGovernance(),
      authorizationContextDigest
    };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-resource-bounds-"));
    roots.push(root);
    const resourceProfile = {
      ...profile([workloadArtifactDigest]),
      requiresApproval: false
    };
    const broker = createSandboxExecutionBroker({
      configuration: configuration(),
      profiles: { "configured-profile": resourceProfile },
      providerResolver: resolver,
      userDataPath: root
    });

    const receipt = await broker.executeConfigured(
      executionRequest,
      async (declared) => ({
        digest: declared.digest,
        files: [{ path: "package.bundle", digest: sourceDigest, content: source }]
      }),
      { currentGovernance: governance, pluginId: "fixture-plugin" }
    );

    expect(receipt).toMatchObject({
      status: "failed",
      reasonCode: SANDBOX_DENIAL_REASONS.RUNTIME_FAILED,
      failureStage: "resource_budget_exceeded",
      cleanupState: "destroyed",
      outputDisposition: "none",
      resourceTotals: {
        memoryBytes: admitted.memoryBytes + 1,
        wallTimeMs: 1
      }
    });
    await broker.close();
  });

  it("recovers quarantined output and idempotent receipt state after broker restart", async () => {
    const workloadArtifactDigest = sha256("trusted-restart-workload");
    const source = Buffer.from("restart-safe-input", "utf8");
    const sourceDigest = sha256(source);
    const inputDigest = sandboxDigest([{ path: "package.bundle", digest: sourceDigest }]);
    const executionRequest = request(inputDigest, "approval-restart");
    const governance = currentGovernance("approval-restart");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-restart-recovery-"));
    roots.push(root);
    const options = {
      configuration: configuration(),
      profiles: { "configured-profile": profile([workloadArtifactDigest]) },
      userDataPath: root
    };
    const first = createSandboxExecutionBroker({ ...options, providerResolver: providerResolver() });
    const receipt = await first.executeConfigured(
      executionRequest,
      async (declared) => ({
        digest: declared.digest,
        files: [{ path: "package.bundle", digest: sourceDigest, content: source }]
      }),
      { currentGovernance: governance, pluginId: "fixture-plugin" }
    );
    expect(receipt).toMatchObject({
      status: "output_quarantined",
      outputDisposition: "quarantined"
    });
    await first.close();

    const recovered = createSandboxExecutionBroker({ ...options, providerResolver: providerResolver() });
    await expect(recovered.recover()).resolves.toMatchObject({ recovered: true });
    expect(recovered.getReceipt(receipt.runId)).toMatchObject({
      outputHandle: receipt.outputHandle,
      outputDisposition: "quarantined"
    });
    const output = recovered.resolveQuarantinedOutput(receipt.outputHandle, { pluginId: "fixture-plugin" });
    await expect(output.readFile("scan.json")).resolves.toEqual(Buffer.from("{}"));
    const replay = await recovered.executeConfigured(
      executionRequest,
      async () => { throw new Error("idempotent replay must not resolve input"); },
      { currentGovernance: governance, pluginId: "fixture-plugin" }
    );
    expect(replay.runId).toBe(receipt.runId);
    expect(await recovered.disposeOutput(receipt.outputHandle, "committed", {
      pluginId: "fixture-plugin",
      owningOperationReceiptDigest: sha256("restart-owning-operation")
    })).toBe(true);
    expect(recovered.getReceipt(receipt.runId)).toMatchObject({
      status: "succeeded",
      outputDisposition: "committed",
      dispositionState: "complete"
    });
    await recovered.close();
  });
});

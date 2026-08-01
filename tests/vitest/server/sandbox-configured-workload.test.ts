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
} from "../../../packages/foundation/src/execution-sandbox/index.ts";
import { createSandboxExecutionBroker } from "../../../packages/server-runtime/src/execution-sandbox/broker.ts";

const roots: any[] = [];
const restrictions: any[] = [
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

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function resources() : any {
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

function configuration() : any {
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

function profile(artifactDigests?: any) : any {
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

function request(inputDigest?: any, approvalRef: any = "approval-ref") : any {
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

function currentGovernance(approvalRef: any = "approval-ref") : any {
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

function providerResolver() : any {
  const descriptor: Record<string, any> = {
    id: "configured-provider",
    providerClass: "registered-container",
    healthy: true,
    enforcedRestrictions: restrictions,
    conformanceReceipt: { receiptId: "provider-receipt" }
  };
  const resolution: Record<string, any> = {
    generation: 1,
    descriptor,
    backend: {
      async run(context?: any) : Promise<any> {
        await fs.writeFile(path.join(context.paths.outputRoot, "scan.json"), "{}", "utf8");
        return { status: "succeeded", resourceTotals: {} };
      },
      async cleanup() : Promise<any> { return { destroyed: true }; }
    }
  };
  return {
    async resolve() : Promise<any> {
      return resolution;
    },
    validate(candidate?: any) : any { return candidate === resolution; },
    async close() : Promise<any> {}
  };
}

async function brokerFor(artifactDigests?: any, resolver: any = providerResolver()) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-configured-workload-"));
  roots.push(root);
  return createSandboxExecutionBroker({
    configuration: configuration(),
    profiles: { "configured-profile": profile(artifactDigests) },
    providerResolver: resolver,
    opaqueArtifactCustody: {
      async promote(_request?: any, sink?: any) : Promise<any> { await sink(Buffer.from("opaque-package")); }
    },
    userDataPath: root
  });
}

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("profile-bound configured sandbox workloads", () : any => {
  it("binds configured workload identity for immutable non-custody inputs", async () : Promise<any> => {
    const workloadArtifactDigest: any = sha256("trusted-verifier-workload");
    const source: any = Buffer.from("export default true;\n");
    const sourceDigest: any = sha256(source);
    const inputDigest: any = sandboxDigest([{ path: "verifier.ts", digest: sourceDigest }]);
    const broker: any = await brokerFor([workloadArtifactDigest]);

    const receipt: any = await broker.executeConfigured(
      request(inputDigest),
      async (declared?: any) : Promise<any> => ({
        digest: declared.digest,
        files: [{ path: "verifier.ts", digest: sourceDigest, content: source }]
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

  it("binds the configured scanner to the complete opaque promotion tuple", async () : Promise<any> => {
    const workloadArtifactDigest: any = sha256("trusted-scanner-workload");
    const packageDigest: any = sha256("opaque-package");
    const opaqueFile: Record<string, any> = {
      path: "package.bundle",
      digest: packageDigest,
      custodyRef: "custody:fixture",
      envelopeDigest: sha256("envelope"),
      promotionSchemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA
    };
    const inputDigest: any = sandboxDigest([{ path: opaqueFile.path, digest: opaqueFile.digest }]);
    const promotionDigest: any = custodyPromotionSetDigest({
      files: [{ ...opaqueFile, contentDigest: opaqueFile.digest }]
    });
    const authorizationDigest: any = custodyPromotionAuthorizationDigest({
      promotionDigest,
      ownerBinding: { subjectRef: "subject-ref", tenantRef: "tenant-ref", workspaceRef: "workspace-ref" },
      governance: currentGovernance()
    });
    const promotionRequests: any[] = [];
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-configured-workload-"));
    roots.push(root);
    const broker: any = createSandboxExecutionBroker({
      configuration: configuration(),
      profiles: { "configured-profile": profile([workloadArtifactDigest]) },
      providerResolver: providerResolver(),
      opaqueArtifactCustody: {
        async promote(promotion?: any, sink?: any) : Promise<any> {
          promotionRequests.push(promotion);
          await sink(Buffer.from("opaque-package"));
        }
      },
      userDataPath: root
    });

    const receipt: any = await broker.executeConfiguredOpaque(
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
    const substitutedApprovalRef: any = "approval-ref-substituted";
    const substituted: any = await broker.executeConfiguredOpaque(
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

  it("denies an ambiguous workload artifact configuration before provider execution", async () : Promise<any> => {
    const packageDigest: any = sha256("opaque-package");
    const inputDigest: any = sandboxDigest([{ path: "package.bundle", digest: packageDigest }]);
    const broker: any = await brokerFor([sha256("scanner-one"), sha256("scanner-two")]);

    const receipt: any = await broker.executeConfiguredOpaque(request(inputDigest), []);

    expect(receipt).toMatchObject({
      status: "denied",
      reasonCode: SANDBOX_DENIAL_REASONS.CONFIGURATION_INVALID
    });
    await broker.close();
  });

  it("records bounded input-staging and backend failure stages", async () : Promise<any> => {
    const workloadArtifactDigest: any = sha256("trusted-scanner-workload");
    const sourceDigest: any = sha256("expected-input");
    const inputDigest: any = sandboxDigest([{ path: "package.bundle", digest: sourceDigest }]);
    const stagingBroker: any = await brokerFor([workloadArtifactDigest]);

    const stagingReceipt: any = await stagingBroker.executeConfigured(
      request(inputDigest),
      async () : Promise<any> => ({
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

    const descriptor: Record<string, any> = {
      id: "configured-provider",
      providerClass: "registered-container",
      healthy: true,
      enforcedRestrictions: restrictions,
      conformanceReceipt: { receiptId: "provider-receipt" }
    };
    const failingResolution: Record<string, any> = {
      generation: 1,
      descriptor,
      backend: {
        async run() : Promise<any> { throw new Error("bounded fixture failure"); },
        async cleanup() : Promise<any> { return { destroyed: true }; }
      }
    };
    const failingResolver: Record<string, any> = {
      async resolve() : Promise<any> { return failingResolution; },
      validate(candidate?: any) : any { return candidate === failingResolution; },
      async close() : Promise<any> {}
    };
    const backendBroker: any = await brokerFor([workloadArtifactDigest], failingResolver);
    const backendReceipt: any = await backendBroker.executeConfigured(
      request(inputDigest),
      async (declared?: any) : Promise<any> => ({
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

  it("fails the run when a provider reports a finite resource total above admission", async () : Promise<any> => {
    const workloadArtifactDigest: any = sha256("trusted-resource-bounded-workload");
    const source: any = Buffer.from("resource-bounded-input", "utf8");
    const sourceDigest: any = sha256(source);
    const inputDigest: any = sandboxDigest([{ path: "package.bundle", digest: sourceDigest }]);
    const admitted: any = resources();
    const descriptor: Record<string, any> = {
      id: "configured-provider",
      providerClass: "registered-container",
      healthy: true,
      enforcedRestrictions: restrictions,
      conformanceReceipt: { receiptId: "provider-receipt" }
    };
    const resourceResolution: Record<string, any> = {
      generation: 1,
      descriptor,
      backend: {
        async run() : Promise<any> {
          return {
            status: "succeeded",
            resourceTotals: {
              memoryBytes: admitted.memoryBytes + 1,
              wallTimeMs: 1
            }
          };
        },
        async cleanup() : Promise<any> { return { destroyed: true }; }
      }
    };
    const resolver: Record<string, any> = {
      async resolve() : Promise<any> { return resourceResolution; },
      validate(candidate?: any) : any { return candidate === resourceResolution; },
      async close() : Promise<any> {}
    };
    const authorizationContextDigest: any = sha256("resource-budget-authorization-context");
    const executionRequest: any = request(inputDigest);
    executionRequest.governance.authorizationContextDigest = authorizationContextDigest;
    const governance: Record<string, any> = {
      ...currentGovernance(),
      authorizationContextDigest
    };
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-resource-bounds-"));
    roots.push(root);
    const resourceProfile: Record<string, any> = {
      ...profile([workloadArtifactDigest]),
      requiresApproval: false
    };
    const broker: any = createSandboxExecutionBroker({
      configuration: configuration(),
      profiles: { "configured-profile": resourceProfile },
      providerResolver: resolver,
      userDataPath: root
    });

    const receipt: any = await broker.executeConfigured(
      executionRequest,
      async (declared?: any) : Promise<any> => ({
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

  it("recovers quarantined output and idempotent receipt state after broker restart", async () : Promise<any> => {
    const workloadArtifactDigest: any = sha256("trusted-restart-workload");
    const source: any = Buffer.from("restart-safe-input", "utf8");
    const sourceDigest: any = sha256(source);
    const inputDigest: any = sandboxDigest([{ path: "package.bundle", digest: sourceDigest }]);
    const executionRequest: any = request(inputDigest, "approval-restart");
    const governance: any = currentGovernance("approval-restart");
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-restart-recovery-"));
    roots.push(root);
    const options: Record<string, any> = {
      configuration: configuration(),
      profiles: { "configured-profile": profile([workloadArtifactDigest]) },
      userDataPath: root
    };
    const first: any = createSandboxExecutionBroker({ ...options, providerResolver: providerResolver() });
    const receipt: any = await first.executeConfigured(
      executionRequest,
      async (declared?: any) : Promise<any> => ({
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

    const recovered: any = createSandboxExecutionBroker({ ...options, providerResolver: providerResolver() });
    await expect(recovered.recover()).resolves.toMatchObject({ recovered: true });
    expect(recovered.getReceipt(receipt.runId)).toMatchObject({
      outputHandle: receipt.outputHandle,
      outputDisposition: "quarantined"
    });
    const output: any = recovered.resolveQuarantinedOutput(receipt.outputHandle, { pluginId: "fixture-plugin" });
    await expect(output.readFile("scan.json")).resolves.toEqual(Buffer.from("{}"));
    const replay: any = await recovered.executeConfigured(
      executionRequest,
      async () : Promise<any> => { throw new Error("idempotent replay must not resolve input"); },
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

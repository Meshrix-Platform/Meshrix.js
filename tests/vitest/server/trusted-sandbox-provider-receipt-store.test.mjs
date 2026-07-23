import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadTrustedSandboxProviderReceipts,
  writeTrustedSandboxProviderReceipts
} from "../../../packages/server-runtime/src/execution-sandbox/trusted-provider-receipt-store.mjs";
import {
  parseExecutionSandboxOciConformanceArguments,
  runExecutionSandboxOciConformance,
  runExecutionSandboxOciConformanceCli,
  runOciConformancePreflight,
  verifyOciReceiptLifecycle
} from "../../../tools/server-scripts/verify-execution-sandbox-oci-conformance.mjs";

const roots = [];

const noopPreflight = async () => Object.freeze({ present: true, pulled: false });

function passingAdversarialChecks() {
  return {
    cancellationObserved: true,
    cancellationCleanupDestroyed: true,
    cancelledRunIdentityReusable: true,
    timeoutObserved: true,
    timeoutCleanupDestroyed: true,
    pidLimitEnforced: true,
    fileDescriptorLimitEnforced: true,
    memoryLimitEnforced: true,
    cpuLimitEnforced: true,
    outputLimitEnforced: true,
    logLimitEnforced: true,
    subprocessZeroEnforced: true,
    forbiddenNetworkDenied: true,
    forbiddenSecretDenied: true,
    forbiddenToolDenied: true,
    backendCloseReapedActiveRun: true
  };
}

function passingReceiptLifecycleChecks() {
  return {
    freshReceiptAccepted: true,
    staleReceiptRejected: true,
    revokedReceiptRejected: true,
    explicitReceiptRevocationRemovesState: true,
    backendRemovalFailsClosed: true
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("trusted sandbox provider receipt store", () => {
  it("requires an explicit action, absolute state path, and bounded operator values", () => {
    expect(() => parseExecutionSandboxOciConformanceArguments([])).toThrowError(
      expect.objectContaining({ code: "execution_sandbox_oci_action_required" })
    );
    expect(() => parseExecutionSandboxOciConformanceArguments([
      "provision",
      "--user-data-path", "relative-state",
      "--policy-revision", "policy-current",
      "--runtime-profile", "profile-current"
    ])).toThrowError(expect.objectContaining({ code: "execution_sandbox_oci_user_data_path_invalid" }));
    expect(() => parseExecutionSandboxOciConformanceArguments([
      "provision",
      "--user-data-path", path.resolve("runtime-state"),
      "--policy-revision", "x".repeat(129),
      "--runtime-profile", "profile-current"
    ])).toThrowError(expect.objectContaining({ code: "execution_sandbox_oci_policy_revision_invalid" }));
    expect(() => parseExecutionSandboxOciConformanceArguments([
      "revoke",
      "--user-data-path", path.resolve("runtime-state"),
      "--provider-id", "oci.provider.primary",
      "--provider-id", "oci.provider.secondary"
    ])).toThrowError(expect.objectContaining({ code: "execution_sandbox_oci_argument_duplicate" }));
    expect(parseExecutionSandboxOciConformanceArguments([
      "revoke",
      "--user-data-path", path.resolve("runtime-state"),
      "--provider-id", "oci.provider.primary"
    ])).toEqual({
      action: "revoke",
      userDataPath: path.resolve("runtime-state"),
      providerId: "oci.provider.primary"
    });
  });

  it("atomically persists and loads provider-bound receipts from private runtime state", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-provider-receipts-"));
    roots.push(userDataPath);
    const receipt = Object.freeze({ providerId: "provider-one", digest: "a".repeat(64) });

    await expect(writeTrustedSandboxProviderReceipts({
      userDataPath,
      receipts: { "provider-one": receipt }
    })).resolves.toEqual({ receiptCount: 1 });
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({
      "provider-one": receipt
    });
  });

  it("fails closed for missing, malformed, or non-private receipt state", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-provider-receipts-"));
    roots.push(userDataPath);
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({});

    await writeTrustedSandboxProviderReceipts({
      userDataPath,
      receipts: { "provider-one": { digest: "a".repeat(64) } }
    });
    const target = path.join(userDataPath, "execution-sandbox", "trusted-provider-receipts.json");
    await fs.chmod(target, 0o644);
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({});
    await fs.chmod(target, 0o600);
    await fs.writeFile(target, "not-json", "utf8");
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({});
  });

  it("provisions and explicitly revokes a passing OCI receipt through the operator CLI", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-provider-receipts-"));
    roots.push(userDataPath);
    const target = {
      id: "provider-one",
      providerClass: "docker",
      isolationClass: "hardened-oci",
      serviceIdentityRef: "sandbox-provider-service:fixture",
      executableIdentityDigest: "b".repeat(64),
      binary: "/fixed/bin/docker",
      backend: { close: async () => {} }
    };
    const successfulProbe = (sequence) => ({
      execution: { status: "succeeded" },
      result: {
        linuxRuntime: true,
        nonRootIdentity: true,
        immutableInputReadable: true,
        immutableInputWriteDenied: true,
        rootFilesystemWriteDenied: true,
        capabilitiesDropped: true,
        noNewPrivileges: true,
        seccompFilterActive: true,
        deviceNodesRestricted: true,
        networkDenied: true,
        sensitiveEnvironmentAbsent: true,
        containerControlSocketAbsent: true,
        isolationNamespaces: {
          ipc: `ipc:${sequence}`,
          mount: `mount:${sequence}`,
          network: `network:${sequence}`,
          pid: `pid:${sequence}`,
          uts: `uts:${sequence}`
        },
        scratchQuotaBounded: true,
        privateOutputOwned: true
      },
      cleanup: { destroyed: true }
    });
    let probeSequence = 0;

    const result = await runExecutionSandboxOciConformanceCli({
      argv: [
        "provision",
        "--user-data-path", userDataPath,
        "--policy-revision", "policy-current",
        "--runtime-profile", "profile-current"
      ],
      conformanceOptions: {
        writeReport: false,
        targetFactory: async () => target,
        preflightRunner: noopPreflight,
        probeRunner: async () => successfulProbe(probeSequence += 1),
        adversarialRunner: async () => passingAdversarialChecks(),
        receiptLifecycleVerifier: async () => passingReceiptLifecycleChecks(),
        now: () => new Date("2027-01-01T00:00:00.000Z")
      }
    });

    expect(result.receiptState).toBe("provisioned");
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({
      "provider-one": result.report.conformanceReceipt
    });
    expect(result.report.conformanceReceipt.receiptRequirement).not.toBe("receipt-current");

    await expect(runExecutionSandboxOciConformanceCli({
      argv: [
        "revoke",
        "--user-data-path", userDataPath,
        "--provider-id", "provider-one"
      ]
    })).resolves.toEqual({ action: "revoke", receiptState: "revoked" });
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({});
  });

  it("revokes an existing provider receipt when a required probe cannot complete", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-provider-receipts-"));
    roots.push(userDataPath);
    await writeTrustedSandboxProviderReceipts({
      userDataPath,
      receipts: { "provider-one": { providerId: "provider-one", digest: "a".repeat(64) } }
    });
    const target = {
      id: "provider-one",
      providerClass: "docker",
      isolationClass: "hardened-oci",
      serviceIdentityRef: "sandbox-provider-service:fixture",
      executableIdentityDigest: "b".repeat(64),
      binary: "/fixed/bin/docker",
      backend: { close: async () => {} }
    };

    const report = await runExecutionSandboxOciConformance({
      writeReport: false,
      userDataPath,
      targetFactory: async () => target,
      preflightRunner: noopPreflight,
      probeRunner: async () => {
        throw Object.assign(new Error("synthetic probe failure"), { code: "synthetic_probe_failure" });
      },
      adversarialRunner: async () => passingAdversarialChecks(),
      receiptLifecycleVerifier: async () => passingReceiptLifecycleChecks()
    });
    expect(report.productionBackendConformance).toBe(false);
    expect(report.checks.executionSucceeded).toBe(false);
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({});
  });

  it("makes every adversarial and receipt-lifecycle result part of production conformance", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-provider-receipts-"));
    roots.push(userDataPath);
    const target = {
      id: "provider-one",
      providerClass: "docker",
      isolationClass: "hardened-oci",
      serviceIdentityRef: "sandbox-provider-service:fixture",
      executableIdentityDigest: "b".repeat(64),
      binary: "/fixed/bin/docker",
      backend: { close: async () => {} }
    };
    const successfulProbe = (sequence) => ({
      execution: { status: "succeeded" },
      result: {
        linuxRuntime: true,
        nonRootIdentity: true,
        immutableInputReadable: true,
        immutableInputWriteDenied: true,
        rootFilesystemWriteDenied: true,
        capabilitiesDropped: true,
        noNewPrivileges: true,
        seccompFilterActive: true,
        deviceNodesRestricted: true,
        networkDenied: true,
        sensitiveEnvironmentAbsent: true,
        containerControlSocketAbsent: true,
        isolationNamespaces: {
          ipc: `ipc:${sequence}`,
          mount: `mount:${sequence}`,
          network: `network:${sequence}`,
          pid: `pid:${sequence}`,
          uts: `uts:${sequence}`
        },
        scratchQuotaBounded: true,
        privateOutputOwned: true
      },
      cleanup: { destroyed: true }
    });
    let sequence = 0;
    const adversarialChecks = passingAdversarialChecks();
    adversarialChecks.subprocessZeroEnforced = false;

    const report = await runExecutionSandboxOciConformance({
      writeReport: false,
      userDataPath,
      targetFactory: async () => target,
      preflightRunner: noopPreflight,
      probeRunner: async () => successfulProbe(sequence += 1),
      adversarialRunner: async () => adversarialChecks,
      receiptLifecycleVerifier: async () => passingReceiptLifecycleChecks(),
      now: () => new Date("2027-01-01T00:00:00.000Z")
    });

    expect(report.productionBackendConformance).toBe(false);
    expect(report.summary.failedCheckCount).toBe(1);
    expect(report.checks).toMatchObject({
      subprocessZeroEnforced: false,
      timeoutObserved: true,
      staleReceiptRejected: true,
      backendRemovalFailsClosed: true
    });
    expect(report.conformanceReceipt.status).toBe("failed");
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({});
  });

  it("fails closed when the digest-pinned conformance image cannot be provisioned", async () => {
    await expect(runOciConformancePreflight({
      binary: "/fixed/bin/docker",
      id: "provider-one"
    }, {
      waitForEngine: async () => Object.freeze({ ready: true, waitedMs: 0 }),
      ensureImage: () => {
        const error = new Error("The digest-pinned OCI conformance image is unavailable.");
        error.code = "execution_sandbox_oci_pinned_image_missing";
        throw error;
      }
    })).rejects.toMatchObject({ code: "execution_sandbox_oci_pinned_image_missing" });
  });

  it("accepts a fresh receipt and rejects stale, revoked, and removed-provider state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-provider-lifecycle-"));
    roots.push(root);
    const checks = await verifyOciReceiptLifecycle({
      target: {
        id: "provider-one",
        providerClass: "docker",
        isolationClass: "hardened-oci",
        serviceIdentityRef: "sandbox-provider-service:fixture",
        executableIdentityDigest: "b".repeat(64),
        backend: {
          async run() {},
          async cleanup() { return { destroyed: true }; }
        }
      },
      root,
      generatedAt: new Date("2027-01-01T00:00:00.000Z"),
      policyRevision: "policy-current",
      runtimeProfile: "profile-current",
      receiptRequirement: "receipt-current"
    });

    expect(checks).toEqual(passingReceiptLifecycleChecks());
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadTrustedSandboxProviderReceipts,
  writeTrustedSandboxProviderReceipts
} from "../../../packages/server-runtime/src/execution-sandbox/trusted-provider-receipt-store.ts";
import {
  failedOciConformanceCheckIds,
  parseExecutionSandboxOciConformanceArguments,
  runExecutionSandboxOciConformance,
  runExecutionSandboxOciConformanceCli,
  runOciConformancePreflight,
  waitForOciEngineReady,
  verifyOciReceiptLifecycle
} from "../../../tools/server-scripts/verify-execution-sandbox-oci-conformance.ts";

const roots: any[] = [];

const noopPreflight: any = async () : Promise<any> => Object.freeze({ present: true, pulled: false });

function passingAdversarialChecks() : any {
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

function passingReceiptLifecycleChecks() : any {
  return {
    freshReceiptAccepted: true,
    staleReceiptRejected: true,
    revokedReceiptRejected: true,
    explicitReceiptRevocationRemovesState: true,
    backendRemovalFailsClosed: true
  };
}

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("trusted sandbox provider receipt store", () : any => {
  it("requires an explicit action, absolute state path, and bounded operator values", () : any => {
    expect(() : any => parseExecutionSandboxOciConformanceArguments([])).toThrowError(
      expect.objectContaining({ code: "execution_sandbox_oci_action_required" })
    );
    expect(() : any => parseExecutionSandboxOciConformanceArguments([
      "provision",
      "--user-data-path", "relative-state",
      "--policy-revision", "policy-current",
      "--runtime-profile", "profile-current"
    ])).toThrowError(expect.objectContaining({ code: "execution_sandbox_oci_user_data_path_invalid" }));
    expect(() : any => parseExecutionSandboxOciConformanceArguments([
      "provision",
      "--user-data-path", path.resolve("runtime-state"),
      "--policy-revision", "x".repeat(129),
      "--runtime-profile", "profile-current"
    ])).toThrowError(expect.objectContaining({ code: "execution_sandbox_oci_policy_revision_invalid" }));
    expect(() : any => parseExecutionSandboxOciConformanceArguments([
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

  it("atomically persists and loads provider-bound receipts from private runtime state", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-provider-receipts-"));
    roots.push(userDataPath);
    const receipt: Readonly<Record<string, any>> = Object.freeze({ providerId: "provider-one", digest: "a".repeat(64) });

    await expect(writeTrustedSandboxProviderReceipts({
      userDataPath,
      receipts: { "provider-one": receipt }
    })).resolves.toEqual({ receiptCount: 1 });
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({
      "provider-one": receipt
    });
  });

  it("fails closed for missing, malformed, or non-private receipt state", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-provider-receipts-"));
    roots.push(userDataPath);
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({});

    await writeTrustedSandboxProviderReceipts({
      userDataPath,
      receipts: { "provider-one": { digest: "a".repeat(64) } }
    });
    const target: any = path.join(userDataPath, "execution-sandbox", "trusted-provider-receipts.json");
    await fs.chmod(target, 0o644);
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({});
    await fs.chmod(target, 0o600);
    await fs.writeFile(target, "not-json", "utf8");
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({});
  });

  it("provisions and explicitly revokes a passing OCI receipt through the operator CLI", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-provider-receipts-"));
    roots.push(userDataPath);
    const target: Record<string, any> = {
      id: "provider-one",
      providerClass: "docker",
      isolationClass: "hardened-oci",
      serviceIdentityRef: "sandbox-provider-service:fixture",
      executableIdentityDigest: "b".repeat(64),
      binary: "/fixed/bin/docker",
      backend: { close: async () : Promise<any> => {} }
    };
    const successfulProbe: any = (sequence?: any) : any => ({
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
    let probeSequence: any = 0;

    const result: any = await runExecutionSandboxOciConformanceCli({
      argv: [
        "provision",
        "--user-data-path", userDataPath,
        "--policy-revision", "policy-current",
        "--runtime-profile", "profile-current"
      ],
      conformanceOptions: {
        writeReport: false,
        targetFactory: async () : Promise<any> => target,
        preflightRunner: noopPreflight,
        probeRunner: async () : Promise<any> => successfulProbe(probeSequence += 1),
        adversarialRunner: async () : Promise<any> => passingAdversarialChecks(),
        receiptLifecycleVerifier: async () : Promise<any> => passingReceiptLifecycleChecks(),
        now: () : any => new Date("2027-01-01T00:00:00.000Z")
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

  it("revokes an existing provider receipt when a required probe cannot complete", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-provider-receipts-"));
    roots.push(userDataPath);
    await writeTrustedSandboxProviderReceipts({
      userDataPath,
      receipts: { "provider-one": { providerId: "provider-one", digest: "a".repeat(64) } }
    });
    const target: Record<string, any> = {
      id: "provider-one",
      providerClass: "docker",
      isolationClass: "hardened-oci",
      serviceIdentityRef: "sandbox-provider-service:fixture",
      executableIdentityDigest: "b".repeat(64),
      binary: "/fixed/bin/docker",
      backend: { close: async () : Promise<any> => {} }
    };

    const report: any = await runExecutionSandboxOciConformance({
      writeReport: false,
      userDataPath,
      targetFactory: async () : Promise<any> => target,
      preflightRunner: noopPreflight,
      probeRunner: async () : Promise<any> => {
        throw Object.assign(new Error("synthetic probe failure"), {
          code: "sandbox_runtime_failed",
          failureStage: "oci_create_failed",
          failureReason: "oci_runtime_busy",
          exitCode: 125
        });
      },
      adversarialRunner: async () : Promise<any> => passingAdversarialChecks(),
      receiptLifecycleVerifier: async () : Promise<any> => passingReceiptLifecycleChecks()
    });
    expect(report.productionBackendConformance).toBe(false);
    expect(report.checks.executionSucceeded).toBe(false);
    expect(report.probeFailures).toEqual([
      {
        code: "sandbox_runtime_failed",
        failureStage: "oci_create_failed",
        failureReason: "oci_runtime_busy",
        exitCode: 125
      },
      {
        code: "sandbox_runtime_failed",
        failureStage: "oci_create_failed",
        failureReason: "oci_runtime_busy",
        exitCode: 125
      }
    ]);
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({});
  });

  it("makes every adversarial and receipt-lifecycle result part of production conformance", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-provider-receipts-"));
    roots.push(userDataPath);
    const target: Record<string, any> = {
      id: "provider-one",
      providerClass: "docker",
      isolationClass: "hardened-oci",
      serviceIdentityRef: "sandbox-provider-service:fixture",
      executableIdentityDigest: "b".repeat(64),
      binary: "/fixed/bin/docker",
      backend: { close: async () : Promise<any> => {} }
    };
    const successfulProbe: any = (sequence?: any) : any => ({
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
    let sequence: any = 0;
    const adversarialChecks: any = passingAdversarialChecks();
    adversarialChecks.subprocessZeroEnforced = false;

    const report: any = await runExecutionSandboxOciConformance({
      writeReport: false,
      userDataPath,
      targetFactory: async () : Promise<any> => target,
      preflightRunner: noopPreflight,
      probeRunner: async () : Promise<any> => successfulProbe(sequence += 1),
      adversarialRunner: async () : Promise<any> => adversarialChecks,
      receiptLifecycleVerifier: async () : Promise<any> => passingReceiptLifecycleChecks(),
      now: () : any => new Date("2027-01-01T00:00:00.000Z")
    });

    expect(report.productionBackendConformance).toBe(false);
    expect(report.summary.failedCheckCount).toBe(1);
    expect(failedOciConformanceCheckIds(report)).toEqual(["subprocessZeroEnforced"]);
    expect(report.checks).toMatchObject({
      subprocessZeroEnforced: false,
      timeoutObserved: true,
      staleReceiptRejected: true,
      backendRemovalFailsClosed: true
    });
    expect(report.conformanceReceipt.status).toBe("failed");
    expect(loadTrustedSandboxProviderReceipts({ userDataPath })).toEqual({});
  });

  it("runs exactly one concurrent pair of independent OCI probes without retrying it", async () : Promise<any> => {
    const target: Record<string, any> = {
      id: "provider-one",
      providerClass: "docker",
      isolationClass: "hardened-oci",
      serviceIdentityRef: "sandbox-provider-service:fixture",
      executableIdentityDigest: "b".repeat(64),
      binary: "/fixed/bin/docker",
      backend: { close: async () : Promise<any> => {} }
    };
    let active: any = 0;
    let maximumActive: any = 0;
    let sequence: any = 0;
    const successfulProbe: any = (probeSequence?: any) : any => ({
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
          ipc: `ipc:${probeSequence}`,
          mount: `mount:${probeSequence}`,
          network: `network:${probeSequence}`,
          pid: `pid:${probeSequence}`,
          uts: `uts:${probeSequence}`
        },
        scratchQuotaBounded: true,
        privateOutputOwned: true
      },
      cleanup: { destroyed: true }
    });

    const report: any = await runExecutionSandboxOciConformance({
      writeReport: false,
      targetFactory: async () : Promise<any> => target,
      preflightRunner: noopPreflight,
      probeRunner: async () : Promise<any> => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const current: any = sequence += 1;
        await new Promise((resolve?: any) : any => setTimeout(resolve, 5));
        active -= 1;
        return successfulProbe(current);
      },
      adversarialRunner: async () : Promise<any> => passingAdversarialChecks(),
      receiptLifecycleVerifier: async () : Promise<any> => passingReceiptLifecycleChecks()
    });

    expect(report.productionBackendConformance).toBe(true);
    expect(sequence).toBe(2);
    expect(maximumActive).toBe(2);
  });

  it("fails closed when the digest-pinned conformance image cannot be provisioned", async () : Promise<any> => {
    await expect(runOciConformancePreflight({
      binary: "/fixed/bin/docker",
      id: "provider-one"
    }, {
      waitForEngine: async () : Promise<any> => Object.freeze({ ready: true, waitedMs: 0 }),
      ensureImage: () : any => {
        const error: any = new Error("The digest-pinned OCI conformance image is unavailable.");
        error.code = "execution_sandbox_oci_pinned_image_missing";
        throw error;
      }
    })).rejects.toMatchObject({ code: "execution_sandbox_oci_pinned_image_missing" });
  });

  it("uses engine-neutral info JSON when probing OCI readiness", async () : Promise<any> => {
    const calls: any[] = [];
    const result: any = await waitForOciEngineReady("/fixed/bin/podman", {
      commandRunner: (binary?: any, args?: any, options?: any) : any => {
        calls.push({ binary, args, options });
        return { status: 0, stdout: '{"host":{}}' };
      }
    });

    expect(result.ready).toBe(true);
    expect(calls).toEqual([{
      binary: "/fixed/bin/podman",
      args: ["info", "--format", "{{json .}}"],
      options: { allowFailure: true, timeoutMs: 8_000 }
    }]);
  });

  it("accepts a fresh receipt and rejects stale, revoked, and removed-provider state", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-provider-lifecycle-"));
    roots.push(root);
    const checks: any = await verifyOciReceiptLifecycle({
      target: {
        id: "provider-one",
        providerClass: "docker",
        isolationClass: "hardened-oci",
        serviceIdentityRef: "sandbox-provider-service:fixture",
        executableIdentityDigest: "b".repeat(64),
        backend: {
          async run() : Promise<any> {},
          async cleanup() : Promise<any> { return { destroyed: true }; }
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

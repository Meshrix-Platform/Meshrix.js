#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SANDBOX_DENIAL_REASONS,
  SANDBOX_REQUEST_SCHEMA,
  SANDBOX_PROVIDER_CONFORMANCE_SCHEMA,
  CONTROLLED_SANDBOX_FINAL_RECEIPT_ID,
  normalizeSandboxExecutionRequest,
  sandboxApprovalRequestDigest,
  sandboxDigest
} from "@lico/foundation/execution-sandbox/contracts";
import {
  compileSandboxAdmission,
  normalizeSandboxConfiguration
} from "@lico/foundation/execution-sandbox/policy-compiler";
import { createSandboxExecutionBroker } from "@lico/server-runtime/execution-sandbox/broker";
import {
  createSandboxProviderConformanceReceipt,
  createTrustedSandboxProviderResolver
} from "@lico/server-runtime/execution-sandbox/trusted-provider-resolver";
import { runExecutionSandboxOciConformance } from "./verify-execution-sandbox-oci-conformance.mjs";
import { runOpaqueSandboxCustodyVerification } from "./verify-opaque-sandbox-custody.mjs";
import { runExecutionLauncherBoundary } from "../verifiers/execution-launcher-boundary.mjs";
import { createSourceEvidenceContext } from "./lib/source-tree-digest.mjs";

const REPORT_SCHEMA = "v0.0.1:execution-sandbox:acceptance-report-1";
const REPORT_PATH = "build/reports/controlled-execution-sandbox.json";
const VERIFIER = "tools/server-scripts/verify-controlled-execution-sandbox.mjs";
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REQUIRED_RESTRICTIONS = Object.freeze([
  "filesystem",
  "process",
  "network",
  "environment",
  "credentials",
  "resources",
  "output",
  "cleanup",
  "cross-trust-domain"
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function removeVerifierTree(root) {
  async function makeWritable(targetPath) {
    let entries = [];
    try {
      entries = await fs.readdir(targetPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await fs.chmod(targetPath, 0o700).catch(() => {});
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await makeWritable(path.join(targetPath, entry.name));
      }
    }
  }
  await makeWritable(root);
  await fs.rm(root, { recursive: true, force: true });
}

function inputFixture() {
  const content = Buffer.from("controlled sandbox input\n", "utf8");
  const files = [{ path: "input.txt", content, digest: sha256(content) }];
  return Object.freeze({
    handle: "object:fixture-input",
    digest: sandboxDigest(files.map(({ path: filePath, digest }) => ({ path: filePath, digest }))),
    files
  });
}

function requestFixture({
  deadlineAt = new Date(Date.now() + 60_000).toISOString(),
  governance: governanceOverrides = {},
  idempotencyKey = `verification:${crypto.randomUUID()}`
} = {}) {
  const input = inputFixture();
  const draft = {
    schemaVersion: SANDBOX_REQUEST_SCHEMA,
    workloadKind: "verification",
    principal: {
      subjectRef: "subject:verification",
      tenantRef: "tenant:verification",
      workspaceRef: "workspace:verification",
      operationRef: "operation:verification"
    },
    artifact: {
      digest: sha256("controlled-sandbox-artifact"),
      runtimeKind: "fixture",
      entryPoint: "bin/verify"
    },
    invocation: { args: ["--verify"], workingDirectory: "work" },
    inputs: [{ handle: input.handle, digest: input.digest, readOnly: true }],
    outputs: {
      schema: "verification-output",
      maxFiles: 4,
      maxBytes: 16 * 1024,
      allowedTypes: ["txt"]
    },
    capabilities: {
      filesystem: ["input:read", "scratch:write", "output:write"],
      network: [],
      tools: [],
      secretRefs: ["secret:opaque-verification-ref"],
      clock: false,
      randomness: false,
      subprocesses: 0
    },
    resources: {
      wallTimeMs: 5_000,
      cpuMillis: 2_000,
      memoryBytes: 64 * 1024 * 1024,
      processes: 1,
      fileDescriptors: 32,
      diskBytes: 1024 * 1024,
      inodes: 128,
      fileCount: 64,
      outputBytes: 16 * 1024,
      logBytes: 4 * 1024,
      networkBytes: 1,
      toolCalls: 1
    },
    governance: {
      grantRef: "grant:verification",
      approvalRef: "approval:verification",
      approvalBindingDigest: sha256("approval-binding:verification"),
      approvalSourceDigest: sha256("approval-source:verification"),
      approvalRequestDigest: "",
      approvalExpiresAt: "2099-01-01T00:00:00.000Z",
      authorizationContextDigest: sha256("authorization-context:verification"),
      riskDecisionRef: "risk:verification",
      policyRevision: "policy:verification",
      authorized: true,
      current: true,
      revoked: false,
      ...governanceOverrides
    },
    idempotencyKey,
    deadlineAt
  };
  return normalizeSandboxExecutionRequest({
    ...draft,
    governance: {
      ...draft.governance,
      approvalRequestDigest: sandboxApprovalRequestDigest(draft)
    }
  });
}

function profileFixture() {
  const resourceLimits = {};
  for (const field of [
    "wallTimeMs", "cpuMillis", "memoryBytes", "processes", "fileDescriptors",
    "diskBytes", "inodes", "fileCount", "outputBytes", "logBytes", "networkBytes", "toolCalls"
  ]) resourceLimits[field] = Number.MAX_SAFE_INTEGER;
  return Object.freeze({
    id: "verification",
    policyRevision: "policy:verification",
    workloads: {
      verification: {
        runtimeKind: "fixture",
        image: `fixture@sha256:${sha256("fixture-image")}`,
        command: ["bin/verify"],
        artifactDigests: [sha256("controlled-sandbox-artifact")],
        entryPoint: "bin/verify"
      }
    },
    capabilities: {
      filesystem: ["input:read", "scratch:write", "output:write"],
      network: [],
      tools: [],
      secretRefs: ["secret:opaque-verification-ref"],
      clock: false,
      randomness: false,
      subprocesses: 0
    },
    resourceLimits,
    requiresApproval: true,
    receiptRequirement: CONTROLLED_SANDBOX_FINAL_RECEIPT_ID
  });
}

function enabledConfiguration() {
  return Object.freeze({
    enabled: true,
    providerMode: "explicit",
    providerId: "fixture-backend",
    profileId: "verification",
    policyRevision: "policy:verification",
    allowedProviderClasses: ["registered-container"],
    receiptRequirement: CONTROLLED_SANDBOX_FINAL_RECEIPT_ID
  });
}

function createCounters() {
  return { resolver: 0, descriptor: 0, run: 0, cleanup: 0, cancel: 0, persist: 0, audit: 0 };
}

function fakeBackend(counters, behavior = "success") {
  let runStartedResolve;
  const runStarted = new Promise((resolve) => { runStartedResolve = resolve; });
  const serviceIdentityRef = "sandbox-provider-service:fixture";
  const executableIdentityDigest = sha256("fixture-provider-executable");
  return {
    runStarted,
    descriptor() {
      counters.descriptor += 1;
      return {
        id: "fixture-backend",
        providerClass: "registered-container",
        isolationClass: "verification-container",
        production: true,
        healthy: behavior !== "unhealthy",
        enforcedRestrictions: behavior === "unsupported" ? ["filesystem"] : [...REQUIRED_RESTRICTIONS],
        serviceIdentityRef,
        executableIdentityDigest,
        conformanceReceipt: createSandboxProviderConformanceReceipt({
          schemaVersion: SANDBOX_PROVIDER_CONFORMANCE_SCHEMA,
          providerId: "fixture-backend",
          providerClass: "registered-container",
          status: "passed",
          policyRevision: "policy:verification",
          receiptRequirement: CONTROLLED_SANDBOX_FINAL_RECEIPT_ID,
          runtimeProfile: "verification",
          isolationClass: "verification-container",
          serviceIdentityRef,
          executableIdentityDigest,
          checkDigest: sha256("fixture-provider-conformance-checks"),
          generatedAt: "2025-01-01T00:00:00.000Z",
          expiresAt: "2100-01-01T00:00:00.000Z"
        })
      };
    },
    async run(context) {
      counters.run += 1;
      runStartedResolve(context.runId);
      assert.equal((await fs.stat(context.paths.inputRoot)).mode & 0o777, 0o555);
      assert.equal((await fs.stat(path.join(context.paths.inputRoot, "0", "input.txt"))).mode & 0o777, 0o444);
      if (behavior === "wait") {
        await new Promise((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", resolve, { once: true });
        });
      } else {
        await fs.writeFile(path.join(context.paths.outputRoot, "result.txt"), "verified\n", "utf8");
      }
      return {
        status: context.signal.aborted ? "failed" : "succeeded",
        reasonCode: context.signal.aborted ? SANDBOX_DENIAL_REASONS.CANCELLED : "",
        resourceTotals: { wallTimeMs: 1, outputBytes: 9 },
        logSummary: "sensitive-verifier-log-marker"
      };
    },
    async cleanup() {
      counters.cleanup += 1;
      if (behavior === "cleanup-throws") throw new Error("cleanup failed");
      return { destroyed: behavior !== "cleanup-failed" };
    },
    async cancel() {
      counters.cancel += 1;
    }
  };
}

function brokerFixture(options = {}) {
  const { root, backend, counters, now } = options;
  const configuration = Object.hasOwn(options, "configuration")
    ? options.configuration
    : enabledConfiguration();
  const input = inputFixture();
  const providerResolver = createTrustedSandboxProviderResolver({
    configuration,
    adapters: backend ? [{
      id: "fixture-backend",
      providerClass: "registered-container",
      probe: async () => backend.descriptor(),
      createBackend: async () => backend
    }] : [],
    now: now || (() => new Date())
  });
  return createSandboxExecutionBroker({
    configuration,
    profiles: { verification: profileFixture() },
    providerResolver,
    userDataPath: root,
    now,
    persistReceipt: async () => { counters.persist += 1; },
    audit: async () => { counters.audit += 1; }
  });
}

async function executeWithResolver(broker, request, counters) {
  const fixture = inputFixture();
  return broker.execute(request, {
    currentGovernance: request.governance,
    pluginId: "verification-plugin",
    resolveInput: async (input) => {
      counters.resolver += 1;
      assert.equal(input.handle, fixture.handle);
      return fixture;
    }
  });
}

function assertDenied(receipt, reasonCode) {
  assert.equal(receipt.status, "denied");
  assert.equal(receipt.reasonCode, reasonCode);
  assert.equal(receipt.runtimeState, "not_started");
}

function assertZeroExecutionSideEffects(counters) {
  assert.equal(counters.resolver, 0);
  assert.equal(counters.run, 0);
  assert.equal(counters.cleanup, 0);
  assert.equal(counters.cancel, 0);
}

async function denialScenario(root, {
  configuration,
  backendBehavior = "success",
  backendPresent = true,
  expectedReason,
  expectedDescriptorCalls = 0
}) {
  const counters = createCounters();
  const backend = backendPresent ? fakeBackend(counters, backendBehavior) : null;
  const broker = brokerFixture({ root, configuration, backend, counters });
  try {
    const receipt = await executeWithResolver(broker, requestFixture(), counters);
    assertDenied(receipt, expectedReason);
    assertZeroExecutionSideEffects(counters);
    assert.equal(counters.descriptor, expectedDescriptorCalls);
    return true;
  } finally {
    await broker.close();
  }
}

function receiptContainsSensitiveMaterial(receipt) {
  const serialized = JSON.stringify(receipt);
  return serialized.includes("sensitive-verifier-log-marker") ||
    serialized.includes("opaque-verification-ref") ||
    serialized.includes("--verify") ||
    /(?:\/Users\/|\/private\/|[A-Za-z]:\\\\)/u.test(serialized);
}

export async function runControlledExecutionSandboxVerification({
  reportPath = REPORT_PATH,
  writeReport = true,
  verifyProductionBackend = false,
  verifyOpaqueCustody = true
} = {}) {
  assert.deepEqual(normalizeSandboxConfiguration(undefined), { state: "unconfigured" });
  assert.equal(compileSandboxAdmission({ request: requestFixture(), configuration: undefined }).reasonCode, SANDBOX_DENIAL_REASONS.UNCONFIGURED);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-controlled-sandbox-verifier-"));
  const checks = {};
  try {
    checks.unconfiguredDeniedWithoutSideEffects = await denialScenario(path.join(root, "unconfigured"), {
      configuration: undefined,
      expectedReason: SANDBOX_DENIAL_REASONS.UNCONFIGURED
    });
    checks.disabledDeniedWithoutSideEffects = await denialScenario(path.join(root, "disabled"), {
      configuration: { enabled: false },
      expectedReason: SANDBOX_DENIAL_REASONS.DISABLED
    });
    checks.missingBackendDeniedWithoutSideEffects = await denialScenario(path.join(root, "missing"), {
      configuration: enabledConfiguration(),
      backendPresent: false,
      expectedReason: SANDBOX_DENIAL_REASONS.BACKEND_MISSING
    });

    for (const [name, behavior, expectedReason] of [
      ["unhealthyBackendDeniedWithoutSideEffects", "unhealthy", SANDBOX_DENIAL_REASONS.BACKEND_UNHEALTHY],
      ["unsupportedPolicyDeniedWithoutSideEffects", "unsupported", SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED]
    ]) {
      checks[name] = await denialScenario(path.join(root, behavior), {
        configuration: enabledConfiguration(),
        backendBehavior: behavior,
        expectedReason,
        expectedDescriptorCalls: 1
      });
    }

    const successCounters = createCounters();
    const successBackend = fakeBackend(successCounters);
    const successRequest = requestFixture();
    const successAdmission = compileSandboxAdmission({
      request: successRequest,
      configuration: enabledConfiguration(),
      profile: profileFixture(),
      backendDescriptor: successBackend.descriptor(),
      selectedBackendId: "fixture-backend",
      currentGovernance: successRequest.governance
    });
    assert.equal(successAdmission.admitted, true, JSON.stringify(successAdmission));
    const expiredApprovalRequest = requestFixture({
      governance: { approvalExpiresAt: "2020-01-01T00:00:00.000Z" }
    });
    assert.equal(compileSandboxAdmission({
      request: expiredApprovalRequest,
      configuration: enabledConfiguration(),
      profile: profileFixture(),
      backendDescriptor: successBackend.descriptor(),
      selectedBackendId: "fixture-backend",
      currentGovernance: expiredApprovalRequest.governance
    }).reasonCode, SANDBOX_DENIAL_REASONS.APPROVAL_STALE);
    const tamperedApprovalRequest = normalizeSandboxExecutionRequest({
      ...successRequest,
      artifact: { ...successRequest.artifact, digest: sha256("tampered-controlled-sandbox-artifact") }
    });
    assert.equal(compileSandboxAdmission({
      request: tamperedApprovalRequest,
      configuration: enabledConfiguration(),
      profile: profileFixture(),
      backendDescriptor: successBackend.descriptor(),
      selectedBackendId: "fixture-backend",
      currentGovernance: tamperedApprovalRequest.governance
    }).reasonCode, SANDBOX_DENIAL_REASONS.APPROVAL_STALE);
    assert.equal(compileSandboxAdmission({
      request: successRequest,
      configuration: enabledConfiguration(),
      profile: profileFixture(),
      backendDescriptor: successBackend.descriptor(),
      selectedBackendId: "fixture-backend",
      currentGovernance: { ...successRequest.governance, authorized: false }
    }).reasonCode, SANDBOX_DENIAL_REASONS.AUTHORIZATION_MISSING);
    checks.approvalDigestExpiryAndHardDenyEnforced = true;
    const successBroker = brokerFixture({
      root: path.join(root, "success"),
      backend: successBackend,
      counters: successCounters
    });
    try {
      const receipt = await executeWithResolver(successBroker, successRequest, successCounters);
      assert.equal(receipt.status, "output_quarantined", JSON.stringify(receipt));
      assert.equal(receipt.runtimeState, "succeeded");
      assert.equal(receipt.cleanupState, "destroyed");
      assert.equal(successCounters.resolver, 1);
      assert.equal(successCounters.run, 1);
      assert.equal(successCounters.cleanup, 1);
      assert.equal(successCounters.persist, 2);
      assert.equal(receiptContainsSensitiveMaterial(receipt), false);
      assert.equal(await pathExists(path.join(
        root,
        "success",
        "execution-sandbox",
        "runs",
        receipt.runId.replace(":", "-")
      )), false, "A successful receipt must not leave a run directory behind.");
      checks.fakeBackendLifecycleCompleted = true;
      checks.receiptRedacted = true;
      assert.equal(await successBroker.disposeOutput(receipt.outputHandle, "committed", {
        owningOperationReceiptDigest: sha256("verification-owning-operation-receipt")
      }), true);
      const committedReceipt = successBroker.getReceipt(receipt.runId);
      assert.equal(committedReceipt.status, "succeeded");
      assert.equal(committedReceipt.outputDisposition, "committed");
      checks.outputDispositionCompleted = true;
      const reusedApproval = await executeWithResolver(
        successBroker,
        requestFixture(),
        successCounters
      );
      assert.equal(reusedApproval.reasonCode, SANDBOX_DENIAL_REASONS.APPROVAL_REUSED);
      assert.equal(successCounters.run, 1);
      checks.approvalConsumedOnceBeforeLaunch = true;
    } finally {
      await successBroker.close();
    }

    const cancelCounters = createCounters();
    const waitingBackend = fakeBackend(cancelCounters, "wait");
    const cancelBroker = brokerFixture({
      root: path.join(root, "cancel"),
      backend: waitingBackend,
      counters: cancelCounters
    });
    try {
      const pending = executeWithResolver(cancelBroker, requestFixture(), cancelCounters);
      const runId = await waitingBackend.runStarted;
      assert.equal(await cancelBroker.cancel(runId), true);
      const receipt = await pending;
      assert.notEqual(receipt.status, "succeeded");
      assert.equal(receipt.reasonCode, SANDBOX_DENIAL_REASONS.CANCELLED);
      assert.equal(receipt.cleanupState, "destroyed");
      assert.equal(cancelCounters.cancel, 1);
      checks.cancellationTerminatesAndCleans = true;
    } finally {
      await cancelBroker.close();
    }

    const timeoutCounters = createCounters();
    const timeoutBackend = fakeBackend(timeoutCounters, "wait");
    const timeoutBroker = brokerFixture({
      root: path.join(root, "timeout"),
      backend: timeoutBackend,
      counters: timeoutCounters
    });
    try {
      const receipt = await executeWithResolver(timeoutBroker, requestFixture({
        deadlineAt: new Date(Date.now() + 80).toISOString()
      }), timeoutCounters);
      assert.notEqual(receipt.status, "succeeded");
      assert.equal(receipt.reasonCode, SANDBOX_DENIAL_REASONS.TIMED_OUT);
      assert.equal(receipt.cleanupState, "destroyed");
      checks.timeoutTerminatesAndCleans = true;
    } finally {
      await timeoutBroker.close();
    }

    const cleanupCounters = createCounters();
    const cleanupBroker = brokerFixture({
      root: path.join(root, "cleanup-failure"),
      backend: fakeBackend(cleanupCounters, "cleanup-failed"),
      counters: cleanupCounters
    });
    try {
      const receipt = await executeWithResolver(cleanupBroker, requestFixture(), cleanupCounters);
      assert.notEqual(receipt.status, "succeeded");
      assert.equal(receipt.reasonCode, SANDBOX_DENIAL_REASONS.CLEANUP_FAILED);
      assert.equal(receipt.cleanupState, "cleanup_failed");
      checks.cleanupFailureCannotSucceed = true;
    } finally {
      await cleanupBroker.close().catch(() => {});
    }

    checks.noHostFallback = checks.missingBackendDeniedWithoutSideEffects &&
      checks.unhealthyBackendDeniedWithoutSideEffects &&
      checks.unsupportedPolicyDeniedWithoutSideEffects;
    const launcherBoundary = await runExecutionLauncherBoundary({ writeReport });
    checks.launcherBoundaryClosed = launcherBoundary.boundaryClosed === true;
    checks.reportLeakScan = true;

    let productionReport = null;
    if (verifyProductionBackend) {
      productionReport = await runExecutionSandboxOciConformance();
    }
    const custodyReport = verifyOpaqueCustody
      ? await runOpaqueSandboxCustodyVerification({ writeReport })
      : null;
    const contractChecksPassed = Object.values(checks).every(Boolean);
    const productionBackendConformance = productionReport?.productionBackendConformance === true;
    const opaqueCustodyReady = custodyReport?.custodyAcceptanceReady === true;
    const sandboxAcceptanceReady = contractChecksPassed && productionBackendConformance && opaqueCustodyReady;
    const report = {
      schemaVersion: REPORT_SCHEMA,
      verifier: VERIFIER,
      generatedAt: new Date().toISOString(),
      sourceContext: createSourceEvidenceContext(REPO_ROOT, {
        verifier: VERIFIER,
        commandId: "controlled-execution-sandbox"
      }),
      sandboxAcceptanceReady,
      productionBackendConformance,
      opaqueCustodyReady,
      summary: {
        contractChecksPassed,
        productionBackendConformance,
        opaqueCustodyReady,
        sandboxAcceptanceReady,
        reportLeakScan: true
      },
      checks,
      productionConformanceReceipt: productionReport?.conformanceReceipt || null,
      opaqueCustodyReport: custodyReport ? {
        schemaVersion: custodyReport.schemaVersion,
        generatedAt: custodyReport.generatedAt,
        checks: custodyReport.checks
      } : null,
      launcherBoundary,
      blockers: [
        ...(!productionBackendConformance ? ["production_backend_conformance_receipt_missing"] : []),
        ...(!opaqueCustodyReady ? ["opaque_custody_verification_missing"] : []),
        ...(!launcherBoundary.boundaryClosed ? ["execution_launcher_boundary_open"] : [])
      ]
    };
    assert.equal(receiptContainsSensitiveMaterial(report), false);
    if (writeReport) {
      const absoluteReportPath = path.resolve(reportPath);
      await fs.mkdir(path.dirname(absoluteReportPath), { recursive: true });
      await fs.writeFile(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    return report;
  } finally {
    await removeVerifierTree(root);
  }
}

const invokedDirectly = process.argv[1] &&
  path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const keepAlive = setInterval(() => {}, 1_000);
  runControlledExecutionSandboxVerification({ verifyProductionBackend: true }).then((report) => {
    console.log(`[controlled-execution-sandbox] contractChecksPassed=${report.summary.contractChecksPassed}`);
    console.log(`[controlled-execution-sandbox] productionBackendConformance=${report.productionBackendConformance} sandboxAcceptanceReady=${report.sandboxAcceptanceReady}`);
    if (!report.sandboxAcceptanceReady) process.exitCode = 1;
  }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }).finally(() => {
    clearInterval(keepAlive);
  });
}

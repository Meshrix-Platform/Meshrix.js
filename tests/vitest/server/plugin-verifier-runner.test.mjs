import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  SANDBOX_DENIAL_REASONS,
  SANDBOX_RECEIPT_SCHEMA,
  controlledRef,
  sandboxDigest
} from "../../../packages/foundation/src/execution-sandbox/index.mjs";
import {
  createPluginVerifierHooks,
  runPluginVerifierWorkload
} from "../../../packages/foundation/src/module-system/plugin-verifier-runner.mjs";

const temporaryRoots = [];

async function fixtureRoot(source = "export default true;\n") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-verifier-runner-"));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, "verifiers"), { recursive: true });
  await fs.writeFile(path.join(root, "verifiers", "check.mjs"), source, { mode: 0o600 });
  return root;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function artifactResolver(root) {
  return async (source) => pathToFileURL(path.join(root, source));
}

function principal() {
  return {
    subjectRef: "plugin-verifier-subject",
    tenantRef: "plugin-verifier-tenant",
    workspaceRef: "plugin-verifier-workspace",
    operationRef: "plugin.verifier.run"
  };
}

function governance() {
  return {
    grantRef: "plugin-verifier-grant",
    approvalRef: "plugin-verifier-approval",
    riskDecisionRef: "plugin-verifier-risk",
    policyRevision: "policy-current",
    authorized: true,
    current: true,
    revoked: false
  };
}

function receipt(overrides = {}) {
  return {
    schemaVersion: SANDBOX_RECEIPT_SCHEMA,
    runId: "run:0123456789abcdef01234567",
    status: "succeeded",
    reasonCode: "sandbox_succeeded",
    runtimeState: "succeeded",
    cleanupState: "destroyed",
    pluginRef: controlledRef("fixture-plugin", "plugin"),
    resourceTotals: { logBytes: 17 },
    ...overrides
  };
}

function receiptForRequest(request, overrides = {}) {
  return receipt({
    inputDigests: request.inputs.map((input) => input.digest),
    ...overrides
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true
  })));
});

describe("plugin verifier controlled execution boundary", () => {
  it("fails closed without a verified installed-artifact resolver", async () => {
    await expect(runPluginVerifierWorkload(
      { id: "check", workloadKind: "plugin_verifier.check", source: "verifiers/check.mjs" },
      {}
    )).rejects.toMatchObject({ code: "PLUGIN_VERIFIER_ARTIFACT_AUTHORITY_REQUIRED" });
  });

  it("stages the verified source as an immutable input and executes only the configured sandbox workload", async () => {
    const source = "export default 'verified';\n";
    const root = await fixtureRoot(source);
    let observedRequest = null;
    let observedOptions = null;
    const sandboxExecution = {
      async executeConfigured(request, resolveInput, options) {
        observedRequest = request;
        observedOptions = options;
        const resolved = await resolveInput(request.inputs[0]);
        expect(resolved.files).toHaveLength(1);
        expect(resolved.files[0].path).toBe("verifiers/check.mjs");
        expect(resolved.files[0].digest).toBe(sha256(source));
        expect(Buffer.from(resolved.files[0].content).toString("utf8")).toBe(source);
        expect(resolved.digest).toBe(sandboxDigest([{
          path: "verifiers/check.mjs",
          digest: sha256(source)
        }]));
        return receiptForRequest(request);
      }
    };

    const result = await runPluginVerifierWorkload(
      { id: "check", workloadKind: "plugin_verifier.check", source: "verifiers/check.mjs" },
      {
        resolveSource: artifactResolver(root),
        sandboxExecution,
        principal: principal(),
        governance: governance(),
        pluginId: "fixture-plugin"
      }
    );

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      signal: "",
      timedOut: false,
      outputLimitExceeded: false,
      outputBytes: 17,
      reasonCode: "sandbox_succeeded",
      terminalReceiptRef: expect.stringMatching(/^sandbox-receipt:/u)
    });
    expect(observedRequest).toMatchObject({
      workloadKind: "plugin_verifier.check",
      invocation: { args: ["verifiers/check.mjs"], workingDirectory: "workspace" },
      principal: principal(),
      governance: governance()
    });
    expect(observedRequest).not.toHaveProperty("artifact");
    expect(observedOptions).toMatchObject({ pluginId: "fixture-plugin" });
  });

  it("maps sandbox timeouts without returning captured verifier text", async () => {
    const root = await fixtureRoot();
    const sandboxExecution = {
      async executeConfigured(request) {
        return receiptForRequest(request, {
          status: "timed_out",
          reasonCode: SANDBOX_DENIAL_REASONS.TIMED_OUT,
          resourceTotals: { logBytes: 128 },
          stdout: "protected-output",
          stderr: "protected-error"
        });
      }
    };

    const result = await runPluginVerifierWorkload(
      { id: "check", workloadKind: "plugin_verifier.check", source: "verifiers/check.mjs" },
      {
        resolveSource: artifactResolver(root),
        sandboxExecution,
        principal: principal(),
        governance: governance(),
        pluginId: "fixture-plugin",
        maxOutputBytes: 128
      }
    );

    expect(result).toMatchObject({ ok: false, timedOut: true, signal: "SIGKILL", outputBytes: 128 });
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("stderr");
  });

  it("maps the sandbox log budget receipt to the existing bounded-output result", async () => {
    const root = await fixtureRoot();
    const sandboxExecution = {
      async executeConfigured(request) {
        return receiptForRequest(request, {
          status: "failed",
          reasonCode: SANDBOX_DENIAL_REASONS.LOG_BUDGET_EXCEEDED,
          runtimeState: "failed",
          resourceTotals: { logBytes: 64 }
        });
      }
    };

    const result = await runPluginVerifierWorkload(
      { id: "check", workloadKind: "plugin_verifier.check", source: "verifiers/check.mjs" },
      {
        resolveSource: artifactResolver(root),
        sandboxExecution,
        principal: principal(),
        governance: governance(),
        pluginId: "fixture-plugin",
        maxOutputBytes: 64
      }
    );

    expect(result).toMatchObject({
      ok: false,
      outputLimitExceeded: true,
      outputBytes: 64,
      reasonCode: SANDBOX_DENIAL_REASONS.LOG_BUDGET_EXCEEDED
    });
  });

  it("rejects a success claim without completed sandbox cleanup", async () => {
    const root = await fixtureRoot();
    const result = await runPluginVerifierWorkload(
      { id: "check", workloadKind: "plugin_verifier.check", source: "verifiers/check.mjs" },
      {
        resolveSource: artifactResolver(root),
        sandboxExecution: {
          async executeConfigured(request) {
            return receiptForRequest(request, { cleanupState: "cleanup_failed" });
          }
        },
        principal: principal(),
        governance: governance(),
        pluginId: "fixture-plugin"
      }
    );

    expect(result).toMatchObject({
      ok: false,
      reasonCode: "plugin_verifier_receipt_invalid"
    });
  });

  it("propagates cancellation to the canonical sandbox execution call", async () => {
    const root = await fixtureRoot();
    const controller = new AbortController();
    let receivedSignal = null;
    const sandboxExecution = {
      async executeConfigured(request, _resolveInput, options) {
        receivedSignal = options.signal;
        if (options.signal.aborted) {
          return receiptForRequest(request, {
            status: "cancelled",
            reasonCode: SANDBOX_DENIAL_REASONS.CANCELLED,
            resourceTotals: {}
          });
        }
        return new Promise((resolve) => {
          options.signal.addEventListener("abort", () => resolve(receiptForRequest(request, {
            status: "cancelled",
            reasonCode: SANDBOX_DENIAL_REASONS.CANCELLED,
            resourceTotals: {}
          })), { once: true });
        });
      }
    };
    const execution = runPluginVerifierWorkload(
      { id: "check", workloadKind: "plugin_verifier.check", source: "verifiers/check.mjs" },
      {
        resolveSource: artifactResolver(root),
        sandboxExecution,
        principal: principal(),
        governance: governance(),
        pluginId: "fixture-plugin",
        signal: controller.signal
      }
    );
    controller.abort();

    await expect(execution).resolves.toMatchObject({
      ok: false,
      timedOut: false,
      reasonCode: SANDBOX_DENIAL_REASONS.CANCELLED
    });
    expect(receivedSignal).toBe(controller.signal);
  });

  it("keeps existing hook callers but requires execution context at run time", async () => {
    const root = await fixtureRoot();
    const hooks = createPluginVerifierHooks({
      id: "fixture-plugin",
      verifierHooks: [{ id: "check", workloadKind: "plugin_verifier.check", source: "verifiers/check.mjs" }]
    }, { resolveSource: artifactResolver(root) });

    await expect(hooks.check.run()).resolves.toMatchObject({
      ok: false,
      reasonCode: "plugin_verifier_sandbox_configuration_required"
    });
  });
});

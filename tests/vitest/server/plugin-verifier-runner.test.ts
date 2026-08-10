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
} from "../../../packages/foundation/src/execution-sandbox/index.ts";
import {
  createPluginVerifierHooks,
  runPluginVerifierWorkload
} from "../../../packages/foundation/src/module-system/plugin-verifier-runner.ts";

const temporaryRoots: any[] = [];

async function fixtureRoot(source: any = "export default true;\n") : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-verifier-runner-"));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, "verifiers"), { recursive: true });
  await fs.writeFile(path.join(root, "verifiers", "check.mjs"), source, { mode: 0o600 });
  return root;
}

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function artifactResolver(root?: any) : any {
  return async (source?: any) : Promise<any> => pathToFileURL(path.join(root, source));
}

function principal() : any {
  return {
    subjectRef: "plugin-verifier-subject",
    tenantRef: "plugin-verifier-tenant",
    workspaceRef: "plugin-verifier-workspace",
    operationRef: "plugin.verifier.run"
  };
}

function governance() : any {
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

function receipt(overrides: Record<string, any> = {}) : any {
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

function receiptForRequest(request?: any, overrides: Record<string, any> = {}) : any {
  return receipt({
    inputDigests: request.inputs.map((input?: any) : any => input.digest),
    ...overrides
  });
}

afterEach(async () : Promise<any> => {
  await Promise.all(temporaryRoots.splice(0).map((root?: any) : any => fs.rm(root, {
    recursive: true,
    force: true
  })));
});

describe("plugin verifier controlled execution boundary", () : any => {
  it("fails closed without a verified installed-artifact resolver", async () : Promise<any> => {
    await expect(runPluginVerifierWorkload(
      { id: "check", workloadKind: "plugin_verifier.check", source: "verifiers/check.mjs" },
      {}
    )).rejects.toMatchObject({ code: "PLUGIN_VERIFIER_ARTIFACT_AUTHORITY_REQUIRED" });
  });

  it("stages the verified source as an immutable input and executes only the configured sandbox workload", async () : Promise<any> => {
    const source: any = "export default 'verified';\n";
    const root: any = await fixtureRoot(source);
    let observedRequest: any = null;
    let observedOptions: any = null;
    const sandboxExecution: Record<string, any> = {
      async executeConfigured(request?: any, resolveInput?: any, options?: any) : Promise<any> {
        observedRequest = request;
        observedOptions = options;
        const resolved: any = await resolveInput(request.inputs[0]);
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

    const result: any = await runPluginVerifierWorkload(
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

  it("maps sandbox timeouts without returning captured verifier text", async () : Promise<any> => {
    const root: any = await fixtureRoot();
    const sandboxExecution: Record<string, any> = {
      async executeConfigured(request?: any) : Promise<any> {
        return receiptForRequest(request, {
          status: "timed_out",
          reasonCode: SANDBOX_DENIAL_REASONS.TIMED_OUT,
          resourceTotals: { logBytes: 128 },
          stdout: "protected-output",
          stderr: "protected-error"
        });
      }
    };

    const result: any = await runPluginVerifierWorkload(
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

  it("maps the sandbox log budget receipt to the existing bounded-output result", async () : Promise<any> => {
    const root: any = await fixtureRoot();
    const sandboxExecution: Record<string, any> = {
      async executeConfigured(request?: any) : Promise<any> {
        return receiptForRequest(request, {
          status: "failed",
          reasonCode: SANDBOX_DENIAL_REASONS.LOG_BUDGET_EXCEEDED,
          runtimeState: "failed",
          resourceTotals: { logBytes: 64 }
        });
      }
    };

    const result: any = await runPluginVerifierWorkload(
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

  it("rejects a success claim without completed sandbox cleanup", async () : Promise<any> => {
    const root: any = await fixtureRoot();
    const result: any = await runPluginVerifierWorkload(
      { id: "check", workloadKind: "plugin_verifier.check", source: "verifiers/check.mjs" },
      {
        resolveSource: artifactResolver(root),
        sandboxExecution: {
          async executeConfigured(request?: any) : Promise<any> {
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

  it("propagates cancellation to the canonical sandbox execution call", async () : Promise<any> => {
    const root: any = await fixtureRoot();
    const controller: any = new AbortController();
    let receivedSignal: any = null;
    const sandboxExecution: Record<string, any> = {
      async executeConfigured(request?: any, _resolveInput?: any, options?: any) : Promise<any> {
        receivedSignal = options.signal;
        if (options.signal.aborted) {
          return receiptForRequest(request, {
            status: "cancelled",
            reasonCode: SANDBOX_DENIAL_REASONS.CANCELLED,
            resourceTotals: {}
          });
        }
        return new Promise((resolve?: any) : any => {
          options.signal.addEventListener("abort", () : any => resolve(receiptForRequest(request, {
            status: "cancelled",
            reasonCode: SANDBOX_DENIAL_REASONS.CANCELLED,
            resourceTotals: {}
          })), { once: true });
        });
      }
    };
    const execution: any = runPluginVerifierWorkload(
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

  it("keeps existing hook callers but requires execution context at run time", async () : Promise<any> => {
    const root: any = await fixtureRoot();
    const hooks: any = createPluginVerifierHooks({
      id: "fixture-plugin",
      verifierHooks: [{ id: "check", workloadKind: "plugin_verifier.check", source: "verifiers/check.mjs" }]
    }, { resolveSource: artifactResolver(root) });

    await expect(hooks.check.run()).resolves.toMatchObject({
      ok: false,
      reasonCode: "plugin_verifier_sandbox_configuration_required"
    });
  });
});

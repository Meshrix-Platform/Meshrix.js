#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.ts";
import { fingerprint } from "../../packages/agents/src/upstream-gateway/manifest-compiler.ts";
import { createUpstreamGatewayRegistry } from "../../packages/agents/src/upstream-gateway/index.ts";
import { compileUpstreamOperationProjection } from "../../packages/agents/src/upstream-gateway/operation-projection.ts";
import { normalizeService } from "../../packages/agents/src/upstream-gateway/support.ts";
import { createAuthorizationEngine } from "../../packages/foundation/src/security/authorization/authorization-engine.ts";
import { createMemoryLocalSecretKeyProvider } from "../../packages/foundation/src/security/secrets/local-secret-key-provider.ts";
import { initializeLocalSecret } from "../../packages/foundation/src/security/secrets/local-secret-store.ts";
import { createSystemControllerFoundationHandlers } from "../../packages/protocols/http/controllers/system-controller-foundation-handlers.ts";
import { dispatchRegisteredHttpOperation } from "../../packages/server-runtime/src/composition/dispatch-operation-http.ts";
import { executeConsoleDomainOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executor.ts";
import {
  createOperationRouteIndex,
  getRouteIndexRefactorInstrumentation
} from "../../packages/server-runtime/src/routing/operation-route-index.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const verifier: any = "tools/server-scripts/verify-runtime-refactor-convergence.ts";
const REPORT_DIR: any = "build/reports/runtime-refactor-convergence";
const REPORT_RELATIVE_PATH: any = `${REPORT_DIR}/convergence.json`;
const REPORT_SCHEMA_VERSION: any = "v0.0.1:runtime:refactor-convergence-report-1";
const VITEST_RUNNER: any = "./node_modules/vitest/vitest.mjs";
const FOCUSED_SUITES: readonly any[] = Object.freeze([
  "tests/vitest/server/runtime-refactor-workspace-incremental.test.ts",
  "tests/vitest/server/runtime-refactor-authorization-compiler.test.ts",
  "tests/vitest/server/runtime-refactor-routing-mcp-discovery.test.ts",
  "tests/vitest/server/runtime-refactor-governed-evidence.test.ts",
  "tests/vitest/console/use-console-shell-integration.test.ts",
  "tests/vitest/console/console-shell-preference-effects.test.ts",
  "tests/vitest/server/gateway-performance-observation.test.ts"
]);
const SAFE_TOKEN: any = /^[a-z0-9][a-z0-9._:-]{0,79}$/u;
const ALLOWED_PORTABLE_WILDCARD_CONSUMERS: readonly any[] = Object.freeze([
  "tools/server-scripts/lib/mcp-release-portable.ts",
  "tools/server-scripts/verify-mcp-release-portable-assembly.ts"
]);
const LOCK_MANAGER_CONTRACT: any = "packages/foundation/src/concurrency/lock-manager-contract.ts";
const LOCK_MANAGER_BACKEND_GLOB: any = "packages/foundation/src/concurrency";
const CONSOLE_SHELL: any = "apps/console/composables/useServerConsoleShell.ts";
const CONSOLE_SHELL_CONTEXT: any = "apps/console/composables/server-console-shell-context.ts";
const CONSOLE_LEGACY_CONTEXT: any = "apps/console/composables/console-shell-public-context.ts";
const CONSOLE_SHELL_HELPER: any = "tests/vitest/console/console-shell-test-utils.ts";
const BOUNDED_JSONL_OWNER: any = "packages/foundation/src/storage/bounded-jsonl.ts";

function repoPath(relativePath?: any) : any {
  return path.join(repoRoot, relativePath);
}

async function readText(relativePath?: any) : Promise<any> {
  return fs.readFile(repoPath(relativePath), "utf8");
}

async function readTextIfExists(relativePath?: any) : Promise<any> {
  try {
    return await readText(relativePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readJson(relativePath?: any) : Promise<any> {
  return JSON.parse(await readText(relativePath));
}

async function exists(relativePath?: any) : Promise<any> {
  try {
    await fs.stat(repoPath(relativePath));
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function sha256(value: any = "") : any {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeToken(value?: any, fallback: any = "unknown") : any {
  const normalized: any = String(value || "").trim().toLowerCase();
  return SAFE_TOKEN.test(normalized) ? normalized : fallback;
}

function finiteCount(value?: any) : any {
  const number: any = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : -1;
}

async function collectFiles(relativeRoot?: any) : Promise<any> {
  const files: any[] = [];
  const pending: any[] = [relativeRoot];
  while (pending.length > 0) {
    const current: any = pending.pop();
    const entries: any = await fs.readdir(repoPath(current), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath: any = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "build", ".git"].includes(entry.name)) continue;
        pending.push(relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(relativePath);
      }
    }
  }
  return files.sort();
}

function runCommand(command?: any, args: any = [], options: Record<string, any> = {}) : any {
  const result: any = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: "--conditions=source",
      ...(options.env || {})
    }
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

async function runFocusedSuites() : Promise<any> {
  const suites: any[] = [];
  for (const suitePath of FOCUSED_SUITES) {
    const result: any = runCommand(process.execPath, [
      "--conditions=source",
      VITEST_RUNNER,
      "run",
      "--config",
      "vitest.config.ts",
      suitePath
    ]);
    const passed: any = result.status === 0;
    suites.push({
      suite: suitePath,
      passed,
      exitCode: result.status,
      outputBytes: Buffer.byteLength(result.stdout + result.stderr, "utf8")
    });
    assert.ok(passed, `Focused suite failed: ${suitePath}\n${result.stdout}\n${result.stderr}`);
  }
  return suites;
}

function packageJsonFiles(packages: any = []) : any {
  const candidates: any[] = ["package.json"];
  for (const pkg of packages) {
    candidates.push(`${pkg}/package.json`);
  }
  return candidates;
}

async function wildcardImportFindings() : Promise<any> {
  const findings: any[] = [];
  const topLevelPackages: any = (await fs.readdir(repoPath("packages"))).filter((name?: any) : any => !name.startsWith("."));
  const apps: any = (await fs.readdir(repoPath("apps"))).filter((name?: any) : any => !name.startsWith("."));
  const candidates: any = packageJsonFiles([...topLevelPackages.map((name?: any) : any => `packages/${name}`), ...apps.map((name?: any) : any => `apps/${name}`)]);
  candidates.push("packages/protocols/mcp/adapter/gateway-installer/package.json");
  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    const manifest: any = JSON.parse(await readText(candidate));
    for (const [field, mappings] of [["imports", manifest.imports || {}], ["exports", manifest.exports || {}]]) {
      for (const specifier of Object.keys(mappings as Record<string, any>)) {
        if (specifier.includes("*")) {
          findings.push(`${candidate}:${field}-wildcard:${specifier}`);
        }
      }
    }
  }
  return findings;
}

async function lockManagerCycleFindings() : Promise<any> {
  const findings: any[] = [];
  const entries: any = await fs.readdir(repoPath(LOCK_MANAGER_BACKEND_GLOB), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const relativePath: any = `${LOCK_MANAGER_BACKEND_GLOB}/${entry.name}`;
    const source: any = await readText(relativePath);
    if (source.includes('from "./lock-manager.ts"') || source.includes('from "../concurrency/lock-manager.ts"')) {
      findings.push(`${relativePath}:imports-lock-manager-owner`);
    }
  }
  return findings;
}

async function consoleShellFindings() : Promise<any> {
  const findings: any[] = [];
  if (!(await exists(CONSOLE_SHELL))) findings.push("console-shell-owner-missing");
  if (await exists(CONSOLE_LEGACY_CONTEXT)) findings.push("console-legacy-flat-context-present");
  if (!(await exists(CONSOLE_SHELL_HELPER))) findings.push("console-shell-test-utils-missing");
  const consoleSource: any = await readTextIfExists("apps/console/composables/useServerConsoleShell.ts");
  const contextSource: any = await readTextIfExists(CONSOLE_SHELL_CONTEXT);
  const helperSource: any = await readTextIfExists(CONSOLE_SHELL_HELPER);
  if (!(await exists(CONSOLE_SHELL_CONTEXT))) findings.push("console-shell-context-type-missing");
  if (await exists("packages/ui-console/src/server-console-shell-context.ts")) findings.push("console-shell-old-package-context-present");
  if (/\bany\b/u.test(`${consoleSource}\n${contextSource}\n${helperSource}`)) findings.push("console-shell-any-escape-present");
  if (!contextSource.includes("ReturnType<typeof useServerConsoleShell>")) findings.push("console-shell-context-not-inferred");
  return findings;
}

async function conversionOwnerFindings() : Promise<any> {
  const findings: any[] = [];
  for (const root of ["packages/agents/src", "packages/server-runtime/src", "packages/foundation/src"]) {
    const pending: any[] = [root];
    while (pending.length > 0) {
      const current: any = pending.pop();
      const entries: any = await fs.readdir(repoPath(current), { withFileTypes: true });
      for (const entry of entries) {
        const relativePath: any = `${current}/${entry.name}`;
        if (entry.isDirectory()) {
          pending.push(relativePath);
        } else if (entry.isFile() && /(?:conversion|format-conversion|format_conversion)/iu.test(entry.name)) {
          findings.push(relativePath);
        }
      }
    }
  }
  return findings;
}

function structuredUpstreamServiceFixture(rawService: any = {}) : any {
  return {
    ...rawService,
    operations: (rawService.operations || []).map((operation?: any) : any => ({
      ...operation,
      payloadTransport: operation.payloadTransport || {
        request: {
          mode: "structured_json",
          maxBytes: 1024 * 1024,
          mediaTypes: ["application/json"]
        },
        response: {
          mode: "structured_json",
          maxBytes: 1024 * 1024,
          mediaTypes: ["application/json"]
        }
      }
    }))
  };
}

function serviceDescriptor(baseUrl?: any) : any {
  return structuredUpstreamServiceFixture({
    allowLocalNetwork: true,
    baseUrl,
    credentialRefs: ["secret://convergence-fixture/gateway"],
    serviceId: "convergence-safe-write-fixture",
    trafficPolicy: {
      burst: 20,
      maxConcurrent: 4,
      perMinute: 20
    },
    operations: [
      {
        method: "POST",
        operationKey: "http-write",
        path: "/http-write",
        protocol: "http",
        requiredScopes: ["gateway:write"],
        risk: "safe_write"
      }
    ]
  });
}

function installService(registry?: any, baseUrl?: any, revision?: any) : any {
  const rawService: any = serviceDescriptor(baseUrl);
  const normalized: any = normalizeService(rawService, {});
  const service: Readonly<Record<string, any>> = Object.freeze({
    ...normalized,
    manifestDigest: fingerprint(rawService),
    serviceRevision: revision
  });
  return registry.replaceFromManifestSnapshot(Object.freeze({
    setDigest: fingerprint({ revision, rawService }),
    setRevision: revision,
    serviceEntries: Object.freeze([
      Object.freeze(["convergence-safe-write-fixture", service])
    ])
  }), { deferSideEffects: true });
}

function createResponse() : any {
  return {
    chunks: [],
    statusCode: 0,
    ended: false,
    writeHead(statusCode?: any) : any {
      this.statusCode = statusCode;
    },
    write(chunk?: any) : any {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk?: any) : any {
      this.write(chunk);
      this.ended = true;
    },
    json() : any {
      return JSON.parse(Buffer.concat(this.chunks).toString("utf8") || "{}");
    }
  };
}

function proofSubstrate() : any {
  return {
    beginLifecycle: async () : Promise<any> => ({ ledgerEventId: "proof:convergence-fixture" }),
    finishLifecycle: async ({ ledgerEventId }: Record<string, any>) : Promise<any> => ({ ledgerEventId }),
    recordReceipt: async () : Promise<any> => ({ ledgerEventId: "proof:convergence-fixture:receipt" })
  };
}

function authorizationResult({
  allowed = true,
  revoked = false
}: Record<string, any> = {}) : any {
  if (!allowed) {
    return {
      ok: false,
      status: 403,
      reasonCode: revoked
        ? "final_protected_sink_authority_revoked"
        : "final_protected_sink_authority_denied",
      error: "Final protected sink authority denied."
    };
  }
  return {
    ok: true,
    revoked,
    grant: {
      id: "grant-convergence-fixture",
      revision: "31"
    },
    authorizationDecision: {
      allowed: true,
      decisionId: "decision-convergence-fixture",
      reasonCode: "fixture_allow",
      riskRevision: "11"
    },
    governancePolicyRevision: {
      revision: 47
    },
    protectedSinkAuthority: Object.freeze({
      subject: Object.freeze({
        generation: "17",
        subjectId: "convergence-subject",
        tenantId: "convergence-tenant",
        type: "console-user"
      }),
      context: Object.freeze({
        approvalRevision: "23",
        grantRevision: "31",
        policyRevision: "47",
        riskRevision: "11",
        workloadGeneration: "17"
      })
    })
  };
}

async function gatewayCleanRun() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(
    path.join(os.tmpdir(), "meshrix-runtime-refactor-convergence-")
  );
  let sink: any = null;
  let registry: any = null;
  let engine: any = null;
  let secretKeyProvider: any = null;
  let sinkHits: any = 0;
  const sinkRequests: any[] = [];
  try {
    sink = http.createServer(async (request?: any, response?: any) : Promise<any> => {
      sinkHits += 1;
      let body: any = "";
      for await (const chunk of request) {
        body += chunk;
      }
      sinkRequests.push({
        method: request.method,
        url: request.url,
        bodyBytes: Buffer.byteLength(body, "utf8")
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve?: any, reject?: any) : any => {
      sink.once("error", reject);
      sink.listen(0, "127.0.0.1", resolve);
    });
    const sinkAddress: any = sink.address();
    const sinkBaseUrl: any = `http://127.0.0.1:${sinkAddress.port}`;

    engine = createAuthorizationEngine({ compiledFactsCacheLimit: 16 });
    const authorizationEngine: any = engine;
    const authorizeOperation: any = async () : Promise<any> => ({
      ...authorizationResult(),
      session: Object.freeze({
        sessionId: "convergence-session",
        user: Object.freeze({
          generation: "17",
          subjectId: "convergence-subject",
          tenantId: "convergence-tenant",
          type: "console-user",
          roleId: "owner",
          scopes: Object.freeze(["gateway:read", "gateway:write"]),
          userId: "convergence-subject",
          username: "convergence-user"
        })
      })
    });
    const revalidateAuthorization: any = async ({
      phase
    }: Record<string, any> = {}) : Promise<any> => {
      const decision: any = authorizationEngine.evaluate({
        policy: Object.freeze({ revision: "47", grants: Object.freeze([]) }),
        profile: Object.freeze({ revision: "11", permissions: Object.freeze([]) }),
        subject: Object.freeze({ subjectId: "convergence-subject" })
      });
      if (phase === "final-protected-sink") {
        return decision.ok === true
          ? authorizationResult()
          : authorizationResult({ allowed: false });
      }
      return authorizationResult();
    };

    const baseKeyProvider: any = createMemoryLocalSecretKeyProvider();
    secretKeyProvider = Object.freeze({
      protocolVersion: baseKeyProvider.protocolVersion,
      custody: baseKeyProvider.custody,
      loadKey: () : any => baseKeyProvider.loadKey(),
      close: () : any => baseKeyProvider.close(),
      describe: () : any => baseKeyProvider.describe()
    });
    registry = createUpstreamGatewayRegistry({
      secretKeyProvider,
      userDataPath
    });
    installService(registry, sinkBaseUrl, 1);
    const sinkHost: any = new URL(sinkBaseUrl);
    await initializeLocalSecret({
      dataDir: userDataPath,
      keyProvider: secretKeyProvider,
      payload: {
        token: "fixture-bearer-material"
      },
      target: {
        authType: "bearer",
        family: "convergence-fixture",
        provider: "fixture",
        scope: {
          allowedHosts: [sinkHost.hostname],
          allowedProtocols: [sinkHost.protocol.replace(/:$/u, "")],
          scopes: ["gateway:write"],
          serviceId: "convergence-safe-write-fixture"
        },
        secretRef: "secret://convergence-fixture/gateway"
      }
    });
    const projection: any = compileUpstreamOperationProjection(
      registry.captureManifestSnapshotState()
    );
    const projectedOperation: any = projection.operations.find(
      (candidate?: any) : any => candidate._meta?.operationKey === "http-write"
    );
    assert.ok(projectedOperation, "Projected upstream operation is unavailable.");

    const operations: any = SERVER_API_OPERATIONS;
    const routeIndex: any = createOperationRouteIndex(operations);
    const operation: any = operations.find(
      (candidate?: any) : any => candidate.id === "gateway.forward"
    );
    assert.ok(operation, "gateway.forward operation is unavailable.");

    const handlers: any = createSystemControllerFoundationHandlers({
      accessControlContext: (authSession?: any, extra: Record<string, any> = {}) : any => ({
        authSession,
        ...extra
      }),
      agentWorkspace: {},
      authorizationFacadeContext: (authSession?: any, extra: Record<string, any> = {}) : any => ({
        authSession,
        ...extra
      }),
      protocolPayload: (requestBody?: any) : any => JSON.parse(
        Buffer.from(requestBody || Buffer.alloc(0)).toString("utf8") || "{}"
      ),
      runtime: {},
      sendConsoleDomainOperation: async ({
        context,
        input,
        operationId,
        response
      }: Record<string, any>) : Promise<any> => {
        const operationResult: any = await executeConsoleDomainOperation({
          operationId,
          input,
          context: {
            ...context,
            transport: "http",
            upstreamGatewayRegistry: registry
          }
        });
        response.writeHead(operationResult.status || 200, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(operationResult.payload));
      },
      workspaceIdFrom: () : any => ""
    });
    const controllers: any = { system: handlers };

    const dispatchOne: any = async (input: Record<string, any>, authorizationOverride: any = null) : Promise<any> => {
      const response: any = createResponse();
      const requestBody: any = Buffer.from(JSON.stringify(input));
      await dispatchRegisteredHttpOperation({
        operations,
        controllers,
        method: "POST",
        url: new URL(`http://127.0.0.1${operation.http?.path || "/api/gateway/v1/forward"}`),
        request: {
          headers: {},
          method: "POST",
          socket: {
            encrypted: false,
            remoteAddress: "127.0.0.1"
          },
          url: operation.http?.path || "/api/gateway/v1/forward"
        },
        response,
        requestBody,
        authorizeOperation: authorizationOverride || authorizeOperation,
        operationAuditStore: null,
        operationProofSubstrate: proofSubstrate(),
        lockManager: null,
        concurrencyScope: "default",
        logger: {
          debug() : any {},
          error() : any {},
          warn() : any {}
        },
        routeIndex
      });
      return response;
    };

    const requested: any = 8;
    const allowResponses: any[] = [];
    for (let index: any = 0; index < requested; index += 1) {
      allowResponses.push(await dispatchOne({
        body: { message: `convergence-allow-${index}` },
        operationKey: "http-write",
        serviceId: "convergence-safe-write-fixture"
      }));
    }
    const deniedResponse: any = await dispatchOne({
      body: { message: "convergence-denied" },
      operationKey: "http-write",
      serviceId: "convergence-safe-write-fixture"
    }, async () : Promise<any> => authorizationResult({ allowed: false }));

    await new Promise((resolve?: any) : any => {
      sink.close(resolve);
    });
    const failureResponse: any = await dispatchOne({
      body: { message: "convergence-failure" },
      operationKey: "http-write",
      serviceId: "convergence-safe-write-fixture"
    });

    await registry.close();

    const succeeded: any = allowResponses.filter((response?: any) : any =>
      response.statusCode === 200 && response.ended === true
    ).length;
    const stableResponseShape: any = allowResponses.every((response?: any) : any => {
      const payload: any = response.json();
      return (
        response.statusCode === 200 &&
        response.ended === true &&
        payload.ok === true &&
        payload.upstream?.status === 200 &&
        /^upstream_gateway_audit::[a-f0-9]{24}$/u.test(
          String(payload.auditId || "")
        )
      );
    });
    const routeInstrumentation: any = routeIndex.getRefactorInstrumentation();
    const gatewayInstrumentation: any = registry.getRefactorInstrumentation();
    const compilerInstrumentation: any = authorizationEngine.getRefactorInstrumentation();

    return {
      fixture: "gateway-clean-run",
      requested,
      dispatched: requested + 2,
      succeeded,
      sinkHits,
      deniedStatus: deniedResponse.statusCode,
      failureStatus: failureResponse.statusCode,
      stableResponseShape,
      stableCorrelationShape: stableResponseShape,
      requestPathFullStateReads: finiteCount(gatewayInstrumentation.requestPathFullStateReads),
      requestPathFullStateRewrites: finiteCount(gatewayInstrumentation.requestPathFullStateRewrites),
      flushedBatchCount: finiteCount(gatewayInstrumentation.flushedBatchCount),
      flushFailureCount: finiteCount(gatewayInstrumentation.flushFailureCount),
      shedMetricDimensions: finiteCount(gatewayInstrumentation.shedMetricDimensions),
      auditRingLimit: finiteCount(gatewayInstrumentation.auditRingLimit),
      flushBatchSize: finiteCount(gatewayInstrumentation.flushBatchSize),
      metricDimensionLimit: finiteCount(gatewayInstrumentation.metricDimensionLimit),
      targetedCallMapHits: finiteCount(gatewayInstrumentation.targetedCallMapHits),
      serviceDiscoveryCount: finiteCount(gatewayInstrumentation.serviceDiscoveryCount),
      routeIndexSnapshotCount: finiteCount(routeInstrumentation.snapshotBuildCount),
      routeIndexLookupCount: finiteCount(routeInstrumentation.lookupCount),
      compiledSnapshotCount: finiteCount(compilerInstrumentation.compiledSnapshotCount),
      authorizationCacheHits: finiteCount(compilerInstrumentation.cacheHits),
      authorizationCacheEvictions: finiteCount(compilerInstrumentation.cacheEvictions),
      malformedFactDenials: finiteCount(compilerInstrumentation.malformedFactDenials),
      authorizationCacheLimit: finiteCount(compilerInstrumentation.cacheLimit),
      capacityCertified: false,
      sinkRequestSample: sinkRequests.slice(0, 3)
    };
  } finally {
    try {
      if (registry) await registry.close();
    } catch {
      // Best-effort close; the report is assembled from captured counters.
    }
    try {
      if (sink) sink.close();
    } catch {
      // Best-effort sink close.
    }
    try {
      if (secretKeyProvider) await secretKeyProvider.close();
    } catch {
      // Best-effort key provider close.
    }
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

async function staticHygiene() : Promise<any> {
  const findings: any[] = [];
  const wildcardFindings: any = await wildcardImportFindings();
  const lockFindings: any = await lockManagerCycleFindings();
  const consoleFindings: any = await consoleShellFindings();
  const conversionFindings: any = await conversionOwnerFindings();
  if (wildcardFindings.length > 0) findings.push(...wildcardFindings);
  if (lockFindings.length > 0) findings.push(...lockFindings);
  if (consoleFindings.length > 0) findings.push(...consoleFindings);
  if (conversionFindings.length > 0) findings.push(...conversionFindings.map((item?: any) : any => `conversion-owner:${item}`));
  for (const consumer of ALLOWED_PORTABLE_WILDCARD_CONSUMERS) {
    if (!(await exists(consumer))) findings.push(`portable-wildcard-consumer-missing:${consumer}`);
  }
  if (!(await exists(LOCK_MANAGER_CONTRACT))) findings.push("lock-manager-contract-missing");
  if (!(await exists(BOUNDED_JSONL_OWNER))) findings.push("bounded-jsonl-owner-missing");
  return findings;
}

async function main() : Promise<any> {
  const startedAt: any = new Date();
  const phases: Record<string, any> = {};
  try {
    const typecheck: any = runCommand("npm", ["run", "typecheck"]);
    phases.typecheck = { passed: typecheck.status === 0, exitCode: typecheck.status };
    assert.strictEqual(typecheck.status, 0, `typecheck failed:\n${typecheck.stdout}\n${typecheck.stderr}`);

    const build: any = runCommand("npm", ["run", "build"]);
    phases.build = { passed: build.status === 0, exitCode: build.status };
    assert.strictEqual(build.status, 0, `build failed:\n${build.stdout}\n${build.stderr}`);

    const publicBoundary: any = runCommand("npm", ["run", "server:verify:public-boundary"]);
    phases.publicBoundary = { passed: publicBoundary.status === 0, exitCode: publicBoundary.status };
    assert.strictEqual(publicBoundary.status, 0, `public-boundary failed:\n${publicBoundary.stdout}\n${publicBoundary.stderr}`);

    const hygieneFindings: any = await staticHygiene();
    phases.staticHygiene = { passed: hygieneFindings.length === 0, findings: hygieneFindings };
    assert.deepStrictEqual(hygieneFindings, [], `static hygiene findings:\n${hygieneFindings.join("\n")}`);

    const gatewayRun: any = await gatewayCleanRun();
    assert.strictEqual(gatewayRun.sinkHits, gatewayRun.succeeded, "sink hits must equal succeeded forwards");
    assert.strictEqual(gatewayRun.succeeded, gatewayRun.requested, "every requested forward must succeed");
    assert.strictEqual(gatewayRun.requestPathFullStateReads, 0, "request path must perform zero full-state reads");
    assert.strictEqual(gatewayRun.requestPathFullStateRewrites, 0, "request path must perform zero full-state rewrites");
    assert.strictEqual(gatewayRun.flushFailureCount, 0, "bounded flushes must not fail");
    assert.strictEqual(gatewayRun.shedMetricDimensions, 0, "finite metric dimensions must not shed during the clean run");
    assert.ok(
      gatewayRun.flushedBatchCount <= gatewayRun.dispatched + 2,
      "flush count must be bounded by dispatch count plus bounded final drains"
    );
    assert.ok(gatewayRun.metricDimensionLimit > 0, "metric dimension limit must be finite and positive");
    assert.ok(gatewayRun.auditRingLimit > 0, "audit ring limit must be finite and positive");
    assert.ok(gatewayRun.flushBatchSize > 0, "flush batch size must be finite and positive");
    assert.strictEqual(gatewayRun.serviceDiscoveryCount, 0, "targeted forwards must not perform global service discovery");
    assert.strictEqual(gatewayRun.routeIndexSnapshotCount, 1, "one route snapshot must be built for the fixture revision");
    assert.strictEqual(gatewayRun.capacityCertified, false, "clean-run observation must never certify capacity");
    assert.strictEqual(gatewayRun.stableResponseShape, true, "external response shapes must remain stable");
    assert.strictEqual(gatewayRun.deniedStatus, 403, "denied forward must return 403 before the protected sink");
    assert.ok(gatewayRun.failureStatus >= 500, "failed upstream forward must return a server error");
    phases.gatewayCleanRun = gatewayRun;

    const suiteRuns: any = await runFocusedSuites();
    phases.focusedSuites = { passed: suiteRuns.every((suite?: any) : any => suite.passed), suites: suiteRuns };
    assert.ok(suiteRuns.every((suite?: any) : any => suite.passed), "focused runtime-refactor suites must pass");

    const report: Record<string, any> = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      verifier,
      sourceOfTruth: {
        gatewayRuntimeOwner: "packages/agents/src/upstream-gateway/registry-runtime.ts",
        workspaceCheckpointOwner: "packages/agents/src/agent-workspace/agent-workspace-file-state.ts",
        authorizationCompilerOwner: "packages/foundation/src/security/authorization/authorization-engine.ts",
        routeIndexOwner: "packages/server-runtime/src/routing/operation-route-index.ts",
        evidenceLifecycleOwner: "packages/server-runtime/src/composition/dispatch-operation-proof-lifecycle.ts",
        consoleShellOwner: CONSOLE_SHELL,
        boundedJsonlOwner: BOUNDED_JSONL_OWNER,
        testRegistry: "tools/registry/tests.registry.json"
      },
      algorithm: {
        cleanRun: "Register one governed safe-write operation and protected sink in an isolated Gateway fixture, forward a fixed request count, assert requested equals succeeded equals sink hits, zero request-path full-state reads and rewrites, bounded dirty-bucket flushes, finite metric dimensions, map-targeted calls without global discovery, and stable response and correlation shapes.",
        focusedSuites: "Run the runtime-refactor workspace, authorization, routing, evidence, console shell, and performance observation suites under vitest and require each to exit zero.",
        staticHygiene: "Require strict typecheck, build, public-boundary validation, zero wildcard package import maps except documented portable-build consumers, no lock-manager owner imports from backends, the namespaced Console shell contract, and no new format-conversion owner.",
        privacy: "Reject local absolute paths, bearer values, secret tokens, runtime ids, raw payloads, and environment-specific values in every generated artifact."
      },
      phases,
      summary: {
        capacityCertified: false,
        reportLeakScan: true,
        focusedSuiteCount: phases.focusedSuites.suites.length,
        focusedSuitePassCount: phases.focusedSuites.suites.filter((suite?: any) : any => suite.passed).length,
        retainedMemorySampling: "gateway-performance-observation"
      }
    };

    const provenance: Record<string, any> = {
      producer: "meshrix-core-runtime-refactor-convergence",
      commandId: "runtime-refactor-convergence",
      sourceRevision: await computeVerifierSourceRevision(repoRoot, [
        verifier,
        "packages/agents/src/upstream-gateway/registry-runtime.ts",
        "packages/foundation/src/security/authorization/authorization-engine.ts",
        "packages/server-runtime/src/routing/operation-route-index.ts",
        "packages/agents/src/agent-workspace/agent-workspace-file-state.ts",
        "packages/server-runtime/src/composition/dispatch-operation-proof-lifecycle.ts"
      ])
    };
    const finalized: any = finalizeSensitiveReport(report, { provenance });
    assertNoSensitiveReportLeak(finalized, "runtime refactor convergence report");
    assertReportProvenance(finalized, provenance);
    await fs.mkdir(repoPath(REPORT_DIR), { recursive: true });
    await fs.writeFile(
      repoPath(REPORT_RELATIVE_PATH),
      `${JSON.stringify(finalized, null, 2)}\n`,
      "utf8"
    );
    console.log(`[runtime-refactor-convergence] suites=${phases.focusedSuites.suites.length} passed=${phases.focusedSuites.suites.length} report=${REPORT_RELATIVE_PATH}`);
  } catch (error: any) {
    console.error(`[runtime-refactor-convergence] failed: ${String(error?.message || error)}`);
    process.exitCode = 1;
  }
}

await main();

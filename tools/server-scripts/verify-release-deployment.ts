#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION } from "../../packages/contracts/src/upstream-service-publishing.ts";
import {
  FUNCTIONAL_CLAIM,
  RELEASE_DEPLOYMENT_CLAIM,
  RUNTIME_UI_TARGET,
  UBUNTU_RUNNER,
  assertReleaseDeploymentReceipt,
  sha256,
} from "./lib/release-deployment/contract.ts";
import { validateAcceptedCandidateReceipt } from "./lib/platform-acceptance-generation-store.ts";
import { validateReleaseCandidateIdentity } from "./verify-release-candidate-identity.ts";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FIXTURE_PROVIDER = "services/model-gateway/test/fixture-provider.mjs";
const DRIVER_SCRIPT = "tools/server-scripts/release-deployment-driver.ts";
const REDUCER_SCRIPT = "tools/server-scripts/reduce-release-deployment.ts";
const CLEANUP_STATE_SCHEMA = "meshrix.release-deployment.cleanup/2";
const READINESS_BUDGET_MS = 120_000;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const MAX_AUTHORITY_INPUT_BYTES = 4 * 1024 * 1024;
const STATE_KEYS = Object.freeze([
  "backupVolume",
  "codexVolume",
  "containerName",
  "dataVolume",
  "fixtureContainerName",
  "imageName",
  "networkName",
  "resourceId",
  "schemaVersion",
  "tempRoot",
]);

function fail(code: string, detail = code): never {
  throw Object.assign(new Error(detail), { code });
}

function remainingBudget(deadline: number, code: string, cap = Number.POSITIVE_INFINITY): number {
  const remaining = Math.min(cap, deadline - Date.now());
  if (!Number.isFinite(remaining) || remaining < 1) fail(code);
  return Math.max(1, Math.floor(remaining));
}

function boundedAppend(previous: string, chunk: Buffer): string {
  const combined = previous + chunk.toString("utf8");
  return combined.length <= MAX_CHILD_OUTPUT_BYTES
    ? combined
    : combined.slice(combined.length - MAX_CHILD_OUTPUT_BYTES);
}

function spawnBounded(
  executable: string,
  args: string[],
  {
    stdin = "",
    allowFailure = false,
    captureStdout = false,
    captureStderr = false,
    failureCode = "release_deployment_child_failed",
  }: Record<string, any> = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const rejectOnce = (error: any): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const terminateAndReject = (error: any): void => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch { /* The child may already be unavailable. */ }
      rejectOnce(error);
    };
    const resolveOnce = (value: any): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", terminateAndReject);
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      terminateAndReject(Object.assign(new Error("bounded child stdio unavailable"), {
        code: "release_deployment_child_stdio_unavailable",
      }));
      return;
    }
    stdoutStream.on("error", terminateAndReject);
    stderrStream.on("error", terminateAndReject);
    stdoutStream.on("data", (chunk: Buffer) => {
      if (captureStdout) stdout = boundedAppend(stdout, chunk);
    });
    stderrStream.on("data", (chunk: Buffer) => {
      if (captureStderr) stderr = boundedAppend(stderr, chunk);
    });
    if (stdin) {
      const stdinStream = child.stdin;
      if (!stdinStream) {
        terminateAndReject(Object.assign(new Error("bounded child stdin unavailable"), {
          code: "release_deployment_child_stdio_unavailable",
        }));
        return;
      }
      stdinStream.on("error", terminateAndReject);
      stdinStream.end(stdin);
    }
    child.once("close", (code, signal) => {
      if (!allowFailure && code !== 0) {
        rejectOnce(Object.assign(new Error("bounded child command failed"), {
          code: failureCode,
          exitCode: code,
          signal,
        }));
        return;
      }
      resolveOnce({ code, signal, stderr, stdout });
    });
  });
}

export function releaseDriverFailureCode(stderr = ""): string {
  const line = String(stderr).trim().split("\n").at(-1) || "";
  let code = "";
  let diagnosticCode = "";
  try {
    const payload = JSON.parse(line);
    code = String(payload?.code || "");
    diagnosticCode = String(payload?.diagnosticCode || "");
  } catch { /* Use the generic code below. */ }
  if (!/^(?:success|concurrency|cancellation|provider-fault):[a-z][a-z0-9_]*$/u.test(code) &&
      !/^release_driver_[a-z][a-z0-9_]*$/u.test(code)) {
    return "release_deployment_driver_failed";
  }
  if (/^provider_fault_[a-z][a-z0-9_]*$/u.test(diagnosticCode)) {
    return `release_deployment_driver_${diagnosticCode}`;
  }
  return `release_deployment_driver_${code.replace(/[:-]/gu, "_")}`;
}

async function writeJsonAtomic(filePath: string, value: any): Promise<void> {
  const absolute = path.resolve(filePath);
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readBoundedAuthorityFile(filePath: string): Promise<Buffer> {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_AUTHORITY_INPUT_BYTES) {
    fail("release_deployment_authority_input_invalid");
  }
  return fs.readFile(filePath);
}

function validateCleanupState(value: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...STATE_KEYS].sort()) ||
    value.schemaVersion !== CLEANUP_STATE_SCHEMA ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      String(value.resourceId || ""),
    )) {
    fail("release_deployment_cleanup_state_invalid");
  }
  const id = value.resourceId;
  const expected = {
    containerName: `meshrix-release-smoke-${id}`,
    fixtureContainerName: `meshrix-release-fixture-${id}`,
    imageName: `meshrix-release-smoke:${id}`,
    networkName: `meshrix-release-network-${id}`,
    dataVolume: `meshrix-release-data-${id}`,
    backupVolume: `meshrix-release-backup-${id}`,
    codexVolume: `meshrix-release-codex-${id}`,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) fail("release_deployment_cleanup_state_invalid");
  }
  const expectedRoot = path.join(os.tmpdir(), `meshrix-release-deployment-${id}`);
  if (value.tempRoot !== expectedRoot) {
    fail("release_deployment_cleanup_state_invalid");
  }
  return value;
}

async function dockerRemoveExact(state: any, strict: boolean): Promise<void> {
  const run = async (args: string[], allowFailure = false): Promise<any> => spawnBounded("docker", args, {
    allowFailure,
    failureCode: "release_deployment_cleanup_child_failed",
  });
  const ready = await run(["info"], !strict);
  if (ready.code !== 0) {
    if (strict) fail("release_deployment_cleanup_engine_unavailable");
    return;
  }
  for (const container of [state.containerName, state.fixtureContainerName]) {
    if ((await run(["container", "inspect", container], true)).code === 0) {
      await run(["rm", "--force", "--volumes", container]);
    }
  }
  for (const volume of [state.dataVolume, state.backupVolume, state.codexVolume]) {
    if ((await run(["volume", "inspect", volume], true)).code === 0) {
      await run(["volume", "rm", "--force", volume]);
    }
  }
  if ((await run(["image", "inspect", state.imageName], true)).code === 0) {
    await run(["image", "rm", "--force", state.imageName]);
  }
  if ((await run(["network", "inspect", state.networkName], true)).code === 0) {
    await run(["network", "rm", state.networkName]);
  }
}

export async function cleanupReleaseDeployment(
  cleanupStatePath: string,
  { strict = true, removePrivate = true }: Record<string, any> = {},
): Promise<void> {
  const text = await fs.readFile(cleanupStatePath, "utf8").catch(() => "");
  if (!text) return;
  let state: any;
  try { state = validateCleanupState(JSON.parse(text)); } catch (error) { throw error; }
  await dockerRemoveExact(state, strict);
  if (removePrivate) {
    await fs.rm(state.tempRoot, { recursive: true, force: true });
    await fs.rm(cleanupStatePath, { force: true });
  }
}

async function startFixtureContainer(state: any, readinessDeadline: number): Promise<string> {
  const port = 7331;
  const fixtureSource = path.join(REPO_ROOT, "services/model-gateway");
  await spawnBounded("docker", [
    "run", "--detach",
    "--name", state.fixtureContainerName,
    "--network", state.networkName,
    "--mount", `type=bind,source=${fixtureSource},target=/meshrix-fixture,readonly`,
    state.imageName,
    "node", `/meshrix-fixture/${FIXTURE_PROVIDER.slice("services/model-gateway/".length)}`,
    "--port", String(port),
    "--host", "0.0.0.0",
    "--advertise-host", state.fixtureContainerName,
  ], { failureCode: "release_deployment_fixture_start_failed" });
  while (Date.now() < readinessDeadline) {
    const probe = await spawnBounded("docker", [
      "exec", state.fixtureContainerName,
      "node", "--input-type=module", "-e",
      `const response = await fetch("http://127.0.0.1:${port}/health"); if (!response.ok) process.exit(1);`,
    ], { allowFailure: true });
    if (probe.code === 0) return `http://${state.fixtureContainerName}:${port}`;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("release_deployment_fixture_start_failed");
}

async function waitForRuntime(origin: string, readinessDeadline: number): Promise<void> {
  while (Date.now() < readinessDeadline) {
    try {
      const probeBudget = remainingBudget(
        readinessDeadline,
        "release_deployment_runtime_unhealthy",
        2_000,
      );
      const [health, root] = await Promise.all([
        fetch(`${origin}/api/healthz`, { signal: AbortSignal.timeout(probeBudget) }),
        fetch(`${origin}/`, { signal: AbortSignal.timeout(probeBudget) }),
      ]);
      if (health.ok && root.ok) return;
    } catch {
      // The exact run-scoped container is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail("release_deployment_runtime_unhealthy");
}

async function readControlResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { fail("release_deployment_control_response_invalid"); }
}

function createConsoleSession(origin: string, readinessDeadline: number): any {
  const state = { cookie: "", csrf: "" };
  const request = async (
    route: string,
    { method = "GET", body = undefined, safety = false }: Record<string, any> = {},
  ): Promise<any> => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (state.cookie) headers.cookie = state.cookie;
    if (state.csrf) headers["x-meshrix-csrf"] = state.csrf;
    if (safety) headers["x-meshrix-safety-confirm"] = "true";
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${origin}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(remainingBudget(
        readinessDeadline,
        "release_deployment_readiness_budget_exceeded",
        10_000,
      )),
    });
    const cookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean) as string[];
    if (cookies.length > 0) state.cookie = cookies.map((entry) => entry.split(";")[0]).join("; ");
    const payload = await readControlResponse(response);
    if (typeof payload?.csrfToken === "string" && payload.csrfToken) state.csrf = payload.csrfToken;
    return { ok: response.ok, payload, status: response.status };
  };
  return { request, clear: () => { state.cookie = ""; state.csrf = ""; } };
}

function providerHealthFailureCode(payload: any): string {
  const status = Number(payload?.status || payload?.endpoints?.[0]?.status || 0);
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return `release_deployment_provider_unhealthy_status_${status}`;
  }
  const error = String(payload?.error || "").trim();
  if (/^[a-z][a-z0-9_]{0,63}$/u.test(error)) {
    return `release_deployment_provider_unhealthy_${error}`;
  }
  return "release_deployment_provider_unhealthy";
}

async function initializeOwner(imageName: string, dataVolume: string): Promise<string> {
  const ownerPassword = randomBytes(32).toString("base64url");
  const ownerCredential = Buffer.from(JSON.stringify({
    username: "owner",
    password: ownerPassword,
  }), "utf8");
  try {
    await spawnBounded("docker", [
      "run", "--rm", "--interactive",
      "--mount", `source=${dataVolume},target=/app/data`,
      imageName,
      "node", "tools/server-scripts/console-auth.ts",
      "init-owner", "--credential-stdin", "--data-dir", "data",
    ], {
      stdin: ownerCredential,
      failureCode: "release_deployment_owner_initialization_failed",
    });
  } finally {
    ownerCredential.fill(0);
  }
  return ownerPassword;
}

async function configureRuntime(
  origin: string,
  fixtureUrl: string,
  readinessDeadline: number,
  ownerPassword: string,
): Promise<any> {
  const session = createConsoleSession(origin, readinessDeadline);
  const login = await session.request("/api/auth/login", {
    method: "POST",
    body: { username: "owner", password: ownerPassword },
  });
  ownerPassword = "";
  if (!login.ok || login.payload?.ok !== true) fail("release_deployment_login_failed");
  const organization = await session.request("/api/authorization/organization-governance");
  if (!organization.ok) fail("release_deployment_organization_read_failed");
  if (organization.payload?.snapshot?.configured !== true) {
    const imported = await session.request("/api/authorization/organization-governance/import", {
      method: "POST",
      body: { templateKey: "enterprise-group" },
      safety: true,
    });
    if (!imported.ok || !imported.payload?.draft) fail("release_deployment_organization_import_failed");
    const published = await session.request("/api/authorization/organization-governance/publish", {
      method: "POST",
      body: {
        ...imported.payload.draft,
        expectedRevision: Number(organization.payload?.snapshot?.revision || 0),
      },
      safety: true,
    });
    if (!published.ok) fail("release_deployment_organization_publish_failed");
  }

  const transport = {
    request: { mode: "structured_json", maxBytes: 256 * 1024, mediaTypes: ["application/json"] },
    response: { mode: "structured_json", maxBytes: 256 * 1024, mediaTypes: ["application/json"] },
  };
  const command = {
    schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
    action: "create",
    serviceKey: "release-smoke/provider",
    expectedServiceRevision: 0,
    expectedSetRevision: 0,
    idempotencyKey: "release-smoke-provider-v1",
    descriptor: {
      serviceProtocol: "http",
      label: "Deterministic release smoke provider",
      baseUrl: fixtureUrl,
      healthPath: "/health",
      allowLocalNetwork: true,
      references: [],
      operations: [
        {
          operationKey: "openai-chat",
          method: "POST",
          path: "/v1/chat/completions",
          risk: "read_only",
          requiredScopes: ["gateway:read"],
          timeoutMs: 10_000,
          payloadTransport: transport,
        },
        {
          operationKey: "anthropic-messages",
          method: "POST",
          path: "/v1/messages",
          risk: "read_only",
          requiredScopes: ["gateway:read"],
          timeoutMs: 10_000,
          payloadTransport: transport,
        },
      ],
    },
  };
  const accepted = await session.request("/api/gateway/v1/services", {
    method: "POST",
    body: command,
    safety: true,
  });
  const serviceId = String(accepted.payload?.serviceId || "");
  if (accepted.status !== 202 || !/^[A-Za-z0-9_.\/-]{1,160}$/u.test(serviceId)) {
    fail("release_deployment_provider_publish_failed");
  }
  let published = false;
  while (Date.now() < readinessDeadline) {
    const detail = await session.request(`/api/gateway/v1/services/${encodeURIComponent(serviceId)}`);
    const status = detail.payload?.service?.publication?.status || detail.payload?.service?.state;
    if (detail.ok && status === "server_published") { published = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!published) fail("release_deployment_provider_publish_timeout");
  const health = await session.request(`/api/gateway/v1/external-services/${encodeURIComponent(serviceId)}/health`);
  if (!health.ok || health.payload?.ok !== true) fail(providerHealthFailureCode(health.payload));

  const publicPrefix = serviceId.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
  const toolNames = [
    `upstream.${publicPrefix}.openai-chat`,
    `upstream.${publicPrefix}.anthropic-messages`,
  ];
  const scopes = await session.request("/api/operation-permission/v1/api-keys/issuer-scopes");
  const catalog = await session.request("/api/operation-permission/v1/catalog");
  if (!scopes.ok || !catalog.ok) fail("release_deployment_api_key_catalog_failed");
  const selectedTools = (Array.isArray(catalog.payload?.tools) ? catalog.payload.tools : [])
    .filter((tool: any) => toolNames.includes(tool.id));
  if (selectedTools.length !== toolNames.length) fail("release_deployment_projected_tools_missing");
  const scopeIds = [...new Set(selectedTools.flatMap((tool: any) => tool.requiredScopes || tool.scopes || []))];
  const toolsetIds = [...new Set(selectedTools.flatMap((tool: any) => tool.toolsets || []))];
  const issued = await session.request("/api/operation-permission/v1/api-keys", {
    method: "POST",
    safety: true,
    body: {
      workloadDisplayName: "Release deployment smoke",
      organizationNodeId: scopes.payload?.eligibleNodes?.[0]?.nodeId || "",
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      policy: {
        protocol: "mcp",
        serviceIds: [serviceId],
        capabilityIds: [],
        toolsetIds,
        allowedTools: toolNames,
        deniedTools: [],
        scopeIds,
        maximumRisk: "high",
        audience: {
          serverAudience: new URL(origin).host,
          targetIds: ["codex"],
          connectorPackageIds: [],
        },
        resources: {
          mode: "unrestricted",
          workspaceIds: [], dataClassifications: [], egressClasses: [], semanticFamilies: [],
          capabilityDomains: [], capabilityVerbs: [], resourceKinds: [], effectKinds: [],
          secretBindingIds: [], allowedOrigins: [], allowedCidrs: [],
        },
        processIdentity: { mode: "optional" },
        limits: { maxUses: 64, requestsPerWindow: 64, windowSeconds: 3600, maxConcurrentEffects: 4 },
        catalogFingerprint: scopes.payload?.catalogFingerprint || "",
      },
    },
  });
  const credential = String(issued.payload?.apiKey || "");
  if (issued.status !== 201 || credential.length < 16) fail("release_deployment_api_key_issue_failed");
  session.clear();
  return { credential, openAiTool: toolNames[0], anthropicTool: toolNames[1] };
}

async function verifyInputs(sourceCandidatePath: string, functionalReceiptPath: string): Promise<any> {
  const candidateBytes = await readBoundedAuthorityFile(sourceCandidatePath);
  const functionalBytes = await readBoundedAuthorityFile(functionalReceiptPath);
  let candidate: any;
  let functional: any;
  try {
    candidate = JSON.parse(candidateBytes.toString("utf8"));
    functional = JSON.parse(functionalBytes.toString("utf8"));
  } catch {
    fail("release_deployment_authority_input_invalid");
  }
  validateReleaseCandidateIdentity(candidate);
  try {
    const receipt = validateAcceptedCandidateReceipt(functional, {
      candidateDigest: candidate.candidate_digest,
      sourceRevision: candidate.source_revision,
    });
    if (!candidate.supported_profiles.includes(receipt.selectedProfile)) {
      fail("release_deployment_functional_receipt_mismatch");
    }
  } catch {
    fail("release_deployment_functional_receipt_mismatch");
  }
  if (functional.claim !== FUNCTIONAL_CLAIM) fail("release_deployment_functional_receipt_mismatch");
  const head = (await spawnBounded("git", ["rev-parse", "HEAD"], {
    captureStdout: true,
    failureCode: "release_deployment_source_revision_unavailable",
  })).stdout.trim();
  if (head !== candidate.source_revision) fail("release_deployment_source_revision_mismatch");
  return {
    candidate,
    functionalReceiptDigest: sha256(functionalBytes),
  };
}

export async function verifyDeployment({
  sourceCandidatePath,
  functionalReceiptPath,
  outputPath,
  cleanupStatePath,
}: Record<string, string>): Promise<any> {
  const inputs = await verifyInputs(sourceCandidatePath, functionalReceiptPath);
  const resourceId = randomUUID();
  const state = validateCleanupState({
    schemaVersion: CLEANUP_STATE_SCHEMA,
    resourceId,
    imageName: `meshrix-release-smoke:${resourceId}`,
    containerName: `meshrix-release-smoke-${resourceId}`,
    dataVolume: `meshrix-release-data-${resourceId}`,
    backupVolume: `meshrix-release-backup-${resourceId}`,
    codexVolume: `meshrix-release-codex-${resourceId}`,
    fixtureContainerName: `meshrix-release-fixture-${resourceId}`,
    networkName: `meshrix-release-network-${resourceId}`,
    tempRoot: path.join(os.tmpdir(), `meshrix-release-deployment-${resourceId}`),
  });
  await fs.mkdir(state.tempRoot, { recursive: false, mode: 0o700 });
  await writeJsonAtomic(cleanupStatePath, state);
  let complete = false;
  let ownerPassword = "";
  try {
    for (const volume of [state.dataVolume, state.backupVolume, state.codexVolume]) {
      await spawnBounded("docker", ["volume", "create", volume], {
        failureCode: "release_deployment_volume_create_failed",
      });
    }
    await spawnBounded("docker", ["network", "create", state.networkName], {
      failureCode: "release_deployment_network_create_failed",
    });
    await spawnBounded("docker", ["build", "--target", "runtime-ui", "--tag", state.imageName, "."], {
      failureCode: "release_deployment_image_build_failed",
    });
    ownerPassword = await initializeOwner(state.imageName, state.dataVolume);
    const readinessDeadline = Date.now() + READINESS_BUDGET_MS;
    const fixtureUrl = await startFixtureContainer(state, readinessDeadline);
    await spawnBounded("docker", [
      "run", "--detach",
      "--name", state.containerName,
      "--network", state.networkName,
      "--publish", "127.0.0.1::7228",
      "--mount", `source=${state.dataVolume},target=/app/data`,
      "--mount", `source=${state.backupVolume},target=/app/backups`,
      "--mount", `source=${state.codexVolume},target=/codex-home`,
      state.imageName,
    ], { failureCode: "release_deployment_container_start_failed" });
    const portOutput = (await spawnBounded(
      "docker",
      ["port", state.containerName, "7228/tcp"],
      {
        captureStdout: true,
        failureCode: "release_deployment_port_lookup_failed",
      },
    )).stdout.trim();
    const port = Number(/:([0-9]+)$/u.exec(portOutput)?.[1] || 0);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail("release_deployment_port_invalid");
    const origin = `http://127.0.0.1:${port}`;
    await waitForRuntime(origin, readinessDeadline);
    let control = await configureRuntime(
      origin,
      fixtureUrl,
      readinessDeadline,
      ownerPassword,
    );
    ownerPassword = "";
    const aggregatePath = path.join(state.tempRoot, "driver-aggregate.json");
    const driver = await spawnBounded(process.execPath, [
      DRIVER_SCRIPT,
      "--origin", origin,
      "--openai-tool", control.openAiTool,
      "--anthropic-tool", control.anthropicTool,
      "--output", aggregatePath,
    ], {
      stdin: `${control.credential}\n`,
      allowFailure: true,
      captureStderr: true,
    });
    if (driver.code !== 0) fail(releaseDriverFailureCode(driver.stderr));
    control = { credential: "", openAiTool: "", anthropicTool: "" };

    await dockerRemoveExact(state, true);

    const reducer = await spawnBounded(process.execPath, [
      REDUCER_SCRIPT,
      "--input", aggregatePath,
      "--source-revision", inputs.candidate.source_revision,
      "--candidate-digest", inputs.candidate.candidate_digest,
      "--functional-receipt-digest", inputs.functionalReceiptDigest,
      "--cleanup-verified",
      "--output", outputPath,
    ], { allowFailure: true });
    if (reducer.code !== 0) fail("release_deployment_reducer_failed");
    const receipt = JSON.parse(await fs.readFile(outputPath, "utf8"));
    assertReleaseDeploymentReceipt(receipt);
    if (receipt.claim !== RELEASE_DEPLOYMENT_CLAIM || receipt.runtimeUiTarget !== RUNTIME_UI_TARGET ||
      receipt.runner !== UBUNTU_RUNNER) {
      fail("release_deployment_receipt_identity_invalid");
    }
    await fs.rm(state.tempRoot, { recursive: true, force: true });
    await fs.rm(cleanupStatePath, { force: true });
    complete = true;
    return receipt;
  } finally {
    ownerPassword = "";
    if (!complete) await cleanupReleaseDeployment(cleanupStatePath).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-test") {
    const source = await fs.readFile(fileURLToPath(import.meta.url), "utf8");
    const inProcessBootstrap = ["start", "Http", "Server"].join("");
    const retiredServiceCommand = ["--service", "command"].join("-");
    if (source.includes(inProcessBootstrap) || source.includes(retiredServiceCommand)) {
      fail("release_deployment_in_process_shortcut_detected");
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      fixtureProcess: true,
      runtimeUiContainer: true,
      externalDriver: true,
      independentReducer: true,
      runner: UBUNTU_RUNNER,
    })}\n`);
    return;
  }
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--cleanup-only") {
      options["cleanup-only"] = true;
    } else if (name?.startsWith("--") && args[index + 1] && !args[index + 1].startsWith("--")) {
      options[name.slice(2)] = args[++index];
    } else {
      fail("release_deployment_argument_invalid");
    }
  }
  const cleanupStatePath = String(options["cleanup-state"] || "");
  if (!cleanupStatePath) fail("release_deployment_cleanup_state_required");
  if (options["cleanup-only"] === true) {
    await cleanupReleaseDeployment(cleanupStatePath);
    process.stdout.write(`${JSON.stringify({ ok: true, cleanup: true })}\n`);
    return;
  }
  for (const key of ["source-candidate", "functional-receipt", "output"]) {
    if (!options[key]) fail("release_deployment_argument_incomplete");
  }
  const receipt = await verifyDeployment({
    sourceCandidatePath: String(options["source-candidate"]),
    functionalReceiptPath: String(options["functional-receipt"]),
    outputPath: String(options.output),
    cleanupStatePath,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: receipt.status,
    claim: receipt.claim,
    cleanup: receipt.cleanup,
  })}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().catch((error: any) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "release_deployment_failed" })}\n`);
    process.exitCode = 1;
  });
}

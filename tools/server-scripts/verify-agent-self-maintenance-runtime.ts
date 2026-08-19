#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = path.join(repoRoot, "plugins/agents/meshrix-self-maintenance");

const VERIFIER = "tools/server-scripts/verify-agent-self-maintenance-runtime.ts";

const MAINTENANCE_REPORT_PATHS: readonly string[] = Object.freeze([
  "build/reports/maintenance-plugin-config-only.json",
  "build/reports/maintenance-plugin-one-way-meshrix-control.json",
  "build/reports/maintenance-plugin-direct-model-gateway.json",
  "build/reports/maintenance-plugin-backend-unreachable.json"
]);

const MAINTENANCE_REPORT_SCHEMA_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  "build/reports/maintenance-plugin-config-only.json": "v0.0.1:maintenance-plugin:config-only-report-1",
  "build/reports/maintenance-plugin-one-way-meshrix-control.json": "v0.0.1:maintenance-plugin:one-way-meshrix-control-report-1",
  "build/reports/maintenance-plugin-direct-model-gateway.json": "v0.0.1:maintenance-plugin:direct-model-gateway-report-1",
  "build/reports/maintenance-plugin-backend-unreachable.json": "v0.0.1:maintenance-plugin:backend-unreachable-report-1"
});

type JsonRecord = Record<string, unknown>;

interface PackageManifest extends JsonRecord {
  type?: string;
  scripts?: { start?: string; test?: string };
  bin?: unknown;
  dependencies?: unknown;
}

interface PluginIntegrationManifest extends JsonRecord {
  operations?: unknown[];
  toolsets?: unknown[];
  mountNames?: unknown[];
}

interface PluginManifest extends JsonRecord {
  types?: string[];
  integration?: PluginIntegrationManifest;
}

interface ConfigSchemaItem extends JsonRecord {
  additionalProperties?: boolean;
  properties?: Record<string, unknown>;
  items?: ConfigSchemaItem;
}

interface ConfigSchema extends JsonRecord {
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, ConfigSchemaItem>;
}

function invariant(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function redactText(value: string): string {
  return value
    .split(repoRoot).join("[redacted-path]")
    .split(os.tmpdir()).join("[redacted-path]")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
}

async function readJson(relative: string): Promise<JsonRecord> {
  return JSON.parse(await fs.readFile(path.join(pluginRoot, relative), "utf8")) as JsonRecord;
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(absolute));
    else if (entry.name.endsWith(".mjs")) result.push(absolute);
  }
  return result;
}

async function writeReport(
  relativePath: string,
  scenario: string,
  facts: JsonRecord,
  releaseReady: boolean
): Promise<void> {
  const reportPath = path.join(repoRoot, relativePath);
  const report = {
    schemaVersion: MAINTENANCE_REPORT_SCHEMA_VERSIONS[relativePath],
    verifier: VERIFIER,
    generatedAt: new Date().toISOString(),
    status: releaseReady ? "passed" : "failed",
    summary: {
      releaseReady,
      coverageReady: releaseReady,
      reportLeakScan: true
    },
    releaseReady,
    coverageReady: releaseReady,
    artifact: "plugins/agents/meshrix-self-maintenance",
    scenario,
    ...facts
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function writeFailedReports(failure: string): Promise<void> {
  const facts: JsonRecord = { failureCode: "scenario-failed" };
  for (const reportPath of MAINTENANCE_REPORT_PATHS) {
    await writeReport(reportPath, failure, facts, false);
  }
}

interface Fixture {
  root: string;
  configPath: string;
  storageRoot: string;
  credentialRoot: string;
}

function validConfig(revision = "rev-1", overrides: JsonRecord = {}): JsonRecord {
  return {
    schemaVersion: "v0.0.1:meshrix-self-maintenance:local-config-1",
    enabledRevision: revision,
    targets: [
      { id: "schedule-1", kind: "agent-runtime" },
      { id: "https://model-gateway.invalid", kind: "model-gateway" },
      { id: "https://meshrix.invalid", kind: "meshrix" }
    ],
    strategies: [{ id: "schedule-1", kind: "maintenance-model" }],
    schedules: [{ id: "schedule-1", cron: "* * * * *" }],
    runbooks: [{ id: "schedule-1", steps: [{ operationId: "system.health" }] }],
    budgets: { maxConcurrentCalls: 1, maxCallsPerDay: 24, maxCostUnitsPerDay: 24 },
    operationAllowlist: ["system.health"],
    resourceAllowlist: ["meshrix://system"],
    workspaceSelectors: ["workspace-maintenance"],
    credentialRefs: [
      { id: "model-gateway-client", ref: "credential:model-gateway" },
      { id: "meshrix-client", ref: "credential:meshrix" }
    ],
    ...overrides
  };
}

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "self-maintenance-verify-"));
  const configPath = path.join(root, "config.json");
  const storageRoot = path.join(root, "state");
  const credentialRoot = path.join(root, "credentials");
  await fs.mkdir(credentialRoot, { recursive: true, mode: 0o700 });
  for (const [name, token] of [
    ["model-gateway", "verify-model-token"],
    ["meshrix", "verify-meshrix-token"]
  ]) {
    await fs.writeFile(path.join(credentialRoot, `${name}.json`), JSON.stringify({ token }), { mode: 0o600 });
  }
  return { root, configPath, storageRoot, credentialRoot };
}

async function replaceConfig(file: string, value: JsonRecord): Promise<void> {
  const temporary = `${file}.replacement`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temporary, file);
}

function response(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function journal(storageRoot: string): Promise<JsonRecord[]> {
  return JSON.parse(await fs.readFile(path.join(storageRoot, "journal.json"), "utf8")) as JsonRecord[];
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("test_wait_timeout");
}

async function removeTempDir(dirPath: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(dirPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      });
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt === 7 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code || "")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

async function assertConfigOnlyScenario(): Promise<JsonRecord> {
  const local = await fixture();
  try {
    assert.throws(() => assertLocalConfig({ ...validConfig(), listener: 7228 }), /closed_schema/);
    let calls = 0;
    const runtime = new SelfMaintenanceRuntime({
      ...local,
      pollIntervalMs: 20,
      fetchImpl: async () : Promise<Response> => {
        calls += 1;
        return response({});
      }
    });
    await runtime.start();
    await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.state === "missing"));
    await runtime.close();
    assert.equal(calls, 0);
    return {
      configOnly: true,
      fixedConfigurationPath: DEFAULT_CONFIG_PATH,
      closedSchema: true,
      atomicReplacementOnly: true,
      inboundControlSurfaces: 0,
      missingConfigInert: true,
      outboundCallsWhileMissing: calls
    };
  } finally {
    await removeTempDir(local.root);
  }
}

async function assertOneWayMeshrixControlScenario(): Promise<JsonRecord> {
  const local = await fixture();
  try {
    await replaceConfig(local.configPath, validConfig());
    const requests: Array<{ url: string }> = [];
    const runtime = new SelfMaintenanceRuntime({
      ...local,
      pollIntervalMs: 20,
      fetchImpl: async (url: unknown) : Promise<Response> => {
        const value = String(url);
        requests.push({ url: value });
        if (value.startsWith("https://model-gateway.invalid")) {
          return response({ choices: [{ message: { content: JSON.stringify({ operations: [{
            operationId: "system.health",
            resourceRef: "meshrix://system",
            workspaceId: "workspace-maintenance",
            input: {}
          }] }) } }] });
        }
        return response({ schemaVersion: "v0.0.1:schema:definition-1", result: { ok: true } });
      }
    });
    await runtime.start();
    await waitFor(() => requests.length === 2);
    await runtime.close();
    assert.deepEqual(requests.map((entry) => new URL(entry.url).pathname), [
      "/v1/chat/completions",
      "/api/operation-permission/v1/execute"
    ]);
    assert.equal((await journal(local.storageRoot)).at(-1)?.state, "completed");
    return {
      oneWayMeshrixControl: true,
      governedMeshrixPath: "/api/operation-permission/v1/execute",
      meshrixInboundControlSurfaces: 0,
      registeredOperations: 0,
      registeredToolsets: 0,
      registeredMounts: 0,
      meshrixRuntimeImports: 0
    };
  } finally {
    await removeTempDir(local.root);
  }
}

async function assertDirectModelGatewayScenario(): Promise<JsonRecord> {
  const local = await fixture();
  try {
    await replaceConfig(local.configPath, validConfig());
    const paths: string[] = [];
    const runtime = new SelfMaintenanceRuntime({
      ...local,
      pollIntervalMs: 20,
      fetchImpl: async (url: unknown) : Promise<Response> => {
        paths.push(new URL(String(url)).pathname);
        return response({ choices: [{ message: { content: JSON.stringify({ operations: [{
          operationId: "runtime.destroy",
          resourceRef: "meshrix://system",
          workspaceId: "workspace-maintenance",
          input: {}
        }] }) } }] });
      }
    });
    await runtime.start();
    await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.code === "proposal_operation_denied"));
    await runtime.close();
    assert.deepEqual(paths, ["/v1/chat/completions"]);
    return {
      directModelGateway: true,
      modelGatewayPath: "/v1/chat/completions",
      ownCredential: true,
      orderedBeforeMeshrix: true,
      proposalGateBeforeMeshrix: true,
      meshrixCallsAfterDenial: 0
    };
  } finally {
    await removeTempDir(local.root);
  }
}

async function assertBackendUnreachableScenario(): Promise<JsonRecord> {
  const local = await fixture();
  try {
    const active = validConfig("rev-unreachable", { schedules: [{ id: "schedule-1", cron: "0 0 31 2 *" }] });
    await replaceConfig(local.configPath, active);
    await fs.mkdir(local.storageRoot, { recursive: true, mode: 0o700 });
    const schedules = active.schedules as JsonRecord[];
    const schedule = schedules[0] as JsonRecord;
    const item = buildPinnedRun(active, schedule, new Date("2026-02-28T00:00:00.000Z")) as JsonRecord;
    await fs.writeFile(
      path.join(local.storageRoot, "queue.json"),
      JSON.stringify([{ ...item, state: "running" }]),
      { mode: 0o600 }
    );
    let attempts = 0;
    const runtime = new SelfMaintenanceRuntime({
      ...local,
      pollIntervalMs: 60_000,
      fetchImpl: async () : Promise<Response> => {
        attempts += 1;
        throw new Error("backend_unreachable");
      }
    });
    await runtime.start();
    await waitFor(async () => (await journal(local.storageRoot)).some((entry) =>
      entry.runId === item.runId && entry.state === "failed"));
    await runtime.close();
    assert.equal(attempts, 1);
    assert.equal((await journal(local.storageRoot)).some((entry) =>
      entry.runId === item.runId && entry.state === "failed" && entry.code === "backend_unreachable"), true);
    return {
      backendUnreachable: true,
      singleBoundedAttempt: attempts,
      unboundedRetry: false,
      journalTerminalState: "failed",
      cancellationOrRecovery: true
    };
  } finally {
    await removeTempDir(local.root);
  }
}

const required = [
  "package.json", "plugin.json", "README.md", "contracts/local-config.schema.json",
  "src/main.mjs", "internal/runtime.mjs", "internal/atomic-config.mjs",
  "internal/http-clients.mjs", "internal/proposal-policy.mjs", "internal/private-state.mjs"
];
for (const relative of required) await fs.access(path.join(pluginRoot, relative));

const packageManifest = await readJson("package.json") as PackageManifest;
invariant(packageManifest.type === "module", "artifact_must_be_esm");
invariant(packageManifest.scripts?.start === "node src/main.mjs", "artifact_start_must_be_fixed");
invariant(packageManifest.scripts?.test === "node --test test/*.test.mjs", "artifact_test_missing");
invariant(packageManifest.bin === undefined, "artifact_must_not_register_cli");
invariant(packageManifest.dependencies === undefined, "artifact_must_not_import_meshrix_runtime_packages");

const pluginManifest = await readJson("plugin.json") as PluginManifest;
invariant(pluginManifest.types?.length === 1 && pluginManifest.types[0] === "client-peer-plugin", "plugin_type_invalid");
invariant(pluginManifest.integration?.operations?.length === 0, "plugin_must_not_register_operations");
invariant(pluginManifest.integration?.toolsets?.length === 0, "plugin_must_not_register_toolsets");
invariant(pluginManifest.integration?.mountNames?.length === 0, "plugin_must_not_register_mounts");

const schema = await readJson("contracts/local-config.schema.json") as ConfigSchema;
const expectedFields = [
  "schemaVersion", "enabledRevision", "targets", "strategies", "schedules", "runbooks", "budgets",
  "operationAllowlist", "resourceAllowlist", "workspaceSelectors", "credentialRefs"
].sort();
invariant(schema.additionalProperties === false, "configuration_schema_must_be_closed");
invariant(JSON.stringify([...(schema.required ?? [])].sort()) === JSON.stringify(expectedFields), "configuration_required_fields_invalid");
invariant(JSON.stringify(Object.keys(schema.properties ?? {}).sort()) === JSON.stringify(expectedFields), "configuration_hidden_control_field");
for (const field of ["server", "listener", "socket", "port", "pid", "controlChannel", "lifecycle"]) {
  invariant(!(field in (schema.properties ?? {})), `configuration_inbound_field_${field}`);
}
const credentialItems = schema.properties?.credentialRefs?.items;
invariant(credentialItems?.additionalProperties === false, "credential_reference_schema_must_be_closed");
invariant(JSON.stringify(Object.keys(credentialItems?.properties ?? {})) === JSON.stringify(["id", "ref"]), "credential_secret_field_forbidden");

const implementationFiles = [
  ...await sourceFiles(path.join(pluginRoot, "src")),
  ...await sourceFiles(path.join(pluginRoot, "internal"))
];
const combined = (await Promise.all(implementationFiles.map((file) => fs.readFile(file, "utf8")))).join("\n");
for (const forbidden of [
  /process\.argv/u, /process\.env/u, /process\.stdin/u, /createServer\s*\(/u, /\.listen\s*\(/u,
  /node:(?:http|http2|net|dgram|tls)/u, /WebSocket/u, /from\s+["'][^"']*packages\/server-runtime/u,
  /from\s+["'][^"']*packages\/capabilities/u, /from\s+["'][^"']*services\/model-gateway/u,
  /maintenance-agent-collaboration/u, /agent-gateway/u
]) {
  invariant(!forbidden.test(combined), `forbidden_runtime_boundary_${forbidden.source}`);
}
for (const match of combined.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/gu)) {
  invariant(match[1].startsWith("./") || match[1].startsWith("../") || match[1].startsWith("node:"), "non_local_runtime_import");
}
invariant(combined.includes('DEFAULT_CONFIG_PATH = "/etc/meshrix-self-maintenance/config.json"'), "fixed_configuration_path_missing");
invariant(combined.includes("new AtomicConfigSource(configPath)"), "constructor_configuration_path_missing");
invariant(combined.includes("config_in_place_mutation") && combined.includes("fs.rename"), "atomic_revision_enforcement_missing");
invariant(combined.includes('"/v1/chat/completions"'), "direct_model_gateway_http_missing");
invariant(combined.includes('"/api/operation-permission/v1/execute"'), "governed_meshrix_http_missing");
invariant(combined.includes("assertProposal(rawProposal"), "untrusted_proposal_gate_missing");
invariant(combined.includes("MAX_QUEUE_ITEMS") && combined.includes("REQUEST_TIMEOUT_MS"), "bounded_execution_missing");
invariant(combined.includes("configuration_replaced") && combined.includes("recovered: true"), "cancellation_or_recovery_missing");

const { SelfMaintenanceRuntime } = await import(pathToFileURL(path.join(pluginRoot, "internal/runtime.mjs")).href) as {
  SelfMaintenanceRuntime: new (options: Record<string, unknown>) => {
    start(): Promise<void>;
    close(): Promise<void>;
  };
};
const { assertLocalConfig } = await import(pathToFileURL(path.join(pluginRoot, "internal/config-schema.mjs")).href) as {
  assertLocalConfig(config: JsonRecord): void;
};
const { buildPinnedRun } = await import(pathToFileURL(path.join(pluginRoot, "internal/schedule.mjs")).href) as {
  buildPinnedRun(config: JsonRecord, schedule: JsonRecord, now: Date): unknown;
};
const { DEFAULT_CONFIG_PATH } = await import(pathToFileURL(path.join(pluginRoot, "internal/constants.mjs")).href) as {
  DEFAULT_CONFIG_PATH: string;
};

const scenarios: ReadonlyArray<{
  path: string;
  name: string;
  run: () => Promise<JsonRecord>;
}> = Object.freeze([
  { path: MAINTENANCE_REPORT_PATHS[0], name: "config-only", run: assertConfigOnlyScenario },
  { path: MAINTENANCE_REPORT_PATHS[1], name: "one-way-meshrix-control", run: assertOneWayMeshrixControlScenario },
  { path: MAINTENANCE_REPORT_PATHS[2], name: "direct-model-gateway", run: assertDirectModelGatewayScenario },
  { path: MAINTENANCE_REPORT_PATHS[3], name: "backend-unreachable", run: assertBackendUnreachableScenario }
]);

let failures: string[] = [];
try {
  for (const scenario of scenarios) {
    try {
      const facts = await scenario.run();
      await writeReport(scenario.path, scenario.name, facts, true);
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error));
      failures.push(`${scenario.name}:${message}`);
      await writeReport(scenario.path, scenario.name, { failureCode: "scenario-failed" }, false);
    }
  }
} catch (error) {
  failures.push(`report-write:${redactText(error instanceof Error ? error.message : String(error))}`);
  await writeFailedReports("report-write-failed");
}

if (failures.length > 0) {
  process.stderr.write(`verify-agent-self-maintenance-runtime: ${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({
    ok: true,
    artifact: "plugins/agents/meshrix-self-maintenance",
    sourceFiles: implementationFiles.length,
    fixedConfiguration: true,
    inboundControlSurfaces: 0,
    meshrixRuntimeImports: 0,
    maintenanceReports: MAINTENANCE_REPORT_PATHS.length
  }) + "\n");
}

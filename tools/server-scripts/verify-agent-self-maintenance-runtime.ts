import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = path.join(repoRoot, "plugins/agents/meshrix-self-maintenance");

function invariant(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

async function readJson(relative: string) {
  return JSON.parse(await fs.readFile(path.join(pluginRoot, relative), "utf8"));
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

const required = [
  "package.json", "plugin.json", "README.md", "contracts/local-config.schema.json",
  "src/main.mjs", "internal/runtime.mjs", "internal/atomic-config.mjs",
  "internal/http-clients.mjs", "internal/proposal-policy.mjs", "internal/private-state.mjs"
];
for (const relative of required) await fs.access(path.join(pluginRoot, relative));

const packageManifest = await readJson("package.json");
invariant(packageManifest.type === "module", "artifact_must_be_esm");
invariant(packageManifest.scripts?.start === "node src/main.mjs", "artifact_start_must_be_fixed");
invariant(packageManifest.scripts?.test === "node --test test/*.test.mjs", "artifact_test_missing");
invariant(packageManifest.bin === undefined, "artifact_must_not_register_cli");
invariant(packageManifest.dependencies === undefined, "artifact_must_not_import_meshrix_runtime_packages");

const pluginManifest = await readJson("plugin.json");
invariant(pluginManifest.types?.length === 1 && pluginManifest.types[0] === "client-peer-plugin", "plugin_type_invalid");
invariant(pluginManifest.integration?.operations?.length === 0, "plugin_must_not_register_operations");
invariant(pluginManifest.integration?.toolsets?.length === 0, "plugin_must_not_register_toolsets");
invariant(pluginManifest.integration?.mountNames?.length === 0, "plugin_must_not_register_mounts");

const schema = await readJson("contracts/local-config.schema.json");
const expectedFields = [
  "schemaVersion", "enabledRevision", "targets", "strategies", "schedules", "runbooks", "budgets",
  "operationAllowlist", "resourceAllowlist", "workspaceSelectors", "credentialRefs"
].sort();
invariant(schema.additionalProperties === false, "configuration_schema_must_be_closed");
invariant(JSON.stringify([...schema.required].sort()) === JSON.stringify(expectedFields), "configuration_required_fields_invalid");
invariant(JSON.stringify(Object.keys(schema.properties).sort()) === JSON.stringify(expectedFields), "configuration_hidden_control_field");
for (const field of ["server", "listener", "socket", "port", "pid", "controlChannel", "lifecycle"]) {
  invariant(!(field in schema.properties), `configuration_inbound_field_${field}`);
}
invariant(schema.properties.credentialRefs.items.additionalProperties === false, "credential_reference_schema_must_be_closed");
invariant(JSON.stringify(Object.keys(schema.properties.credentialRefs.items.properties)) === JSON.stringify(["id", "ref"]), "credential_secret_field_forbidden");

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

process.stdout.write(JSON.stringify({
  ok: true,
  artifact: "plugins/agents/meshrix-self-maintenance",
  sourceFiles: implementationFiles.length,
  fixedConfiguration: true,
  inboundControlSurfaces: 0,
  meshrixRuntimeImports: 0
}) + "\n");

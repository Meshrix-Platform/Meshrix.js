#!/usr/bin/env node
/**
 * generate-operation-artifacts — Generates HTTP routes, RPC methods, CLI usage,
 * scopes, capability permissions, docs snippets, OpenAPI schemas, and test fixtures
 * from the canonical runtime operation registry.
 *
 * Usage: node tools/generators/generate-operation-artifacts.mjs [--check]
 *
 * --check  : Exit with non-zero if generated files differ from current (CI mode).
 *
 * Generated files:
 *   tools/registry/operations/operations.registry.json
 *   tools/registry/capabilities/capabilities.registry.json
 *   packages/contracts/src/generated/operations.generated.mjs
 *   packages/foundation/src/security/authorization/generated-capabilities.mjs
 *   tools/registry/operations/operations.openapi.generated.json
 *   tools/registry/operations/operations.routes.generated.json
 *
 * @module tools/generators/generate-operation-artifacts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  SERVER_API_OPERATIONS as CORE_SERVER_API_OPERATIONS,
  SERVER_NON_OPERATION_API_CAPABILITIES
} from "../../packages/contracts/src/operations/operation-registry.mjs";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

const REGISTRY_PATH = resolve(ROOT, "tools/registry/operations/operations.registry.json");
const CAPABILITY_REGISTRY_PATH = resolve(ROOT, "tools/registry/capabilities/capabilities.registry.json");

const OUTPUTS = {
  registry: REGISTRY_PATH,
  capabilityRegistry: CAPABILITY_REGISTRY_PATH,
  operations: resolve(ROOT, "packages/contracts/src/generated/operations.generated.mjs"),
  capabilities: resolve(ROOT, "packages/foundation/src/security/authorization/generated-capabilities.mjs"),
  openapi: resolve(ROOT, "tools/registry/operations/operations.openapi.generated.json"),
  routes: resolve(ROOT, "tools/registry/operations/operations.routes.generated.json"),
};

const SOURCE_OPERATION_REGISTRY = "packages/contracts/src/operations/operation-registry.mjs";

// --- Load registries ---

function loadRegistry(path) {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: Cannot load registry: ${path}`);
    console.error(err.message);
    process.exit(1);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function riskOf(operation = {}) {
  const risk = String(operation.risk || operation.safety?.risk || "").trim();
  if (["read_only", "safe_write", "repair_write", "destructive"].includes(risk)) {
    return risk;
  }
  return operation.readOnly === false ? "safe_write" : "read_only";
}

function operationNameOf(operation = {}) {
  return String(operation.id || "operation").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "operation";
}

function auditPolicyOf(operation = {}) {
  if (operation.auditPolicy && typeof operation.auditPolicy === "object") {
    return cloneJson(operation.auditPolicy);
  }
  const audit = operation.audit || {};
  return {
    recordInput: audit.recordInput === true,
    recordOutput: audit.recordOutput === true,
    metadataOnly: audit.metadataOnly === true,
    redaction: audit.redaction || "default"
  };
}

function otelOf(operation = {}) {
  if (operation.otel && typeof operation.otel === "object") {
    return cloneJson(operation.otel);
  }
  return {
    semanticGroup: String(operation.feature || operation.resourceContext?.capabilityDomain || "operation"),
    operationName: operationNameOf(operation)
  };
}

function operationProjection(operation = {}) {
  const projected = cloneJson(operation);
  const risk = riskOf(operation);
  return {
    ...projected,
    description: String(projected.description || projected.label || projected.id || ""),
    readOnly: operation.readOnly === true,
    public: operation.public === true,
    risk,
    requiredScopes: uniqueStrings(operation.requiredScopes),
    resourceContext: projected.resourceContext || {},
    http: projected.http || { method: "POST", path: `/${String(operation.id || "").replace(/\./g, "/")}` },
    rpc: projected.rpc || { method: operation.id },
    otel: otelOf(operation),
    auditPolicy: auditPolicyOf(operation),
    concurrencySafe: operation.concurrencySafe === true
  };
}

function createOperationRegistryProjection(previousRegistry = {}) {
  return {
    "$schema": "../schema/operation.schema.json",
    version: previousRegistry.version || "v1.0.0",
    generatedAt: previousRegistry.generatedAt || "1970-01-01T00:00:00.000Z",
    canonicalSource: false,
    canonicalSourcePath: SOURCE_OPERATION_REGISTRY,
    description: `Generated projection of ${SOURCE_OPERATION_REGISTRY}. Do not edit this file by hand; update the source operation definitions and rerun this generator.`,
    operations: CORE_SERVER_API_OPERATIONS.map(operationProjection)
  };
}

function apiCapabilitiesForOperations(operations = [], nonOperationCapabilities = []) {
  return [
    ...operations.map((operation) => ({
    id: `cap:api:${operation.id}`,
    operationId: operation.id,
    kind: "api",
    risk: riskOf(operation)
    })),
    ...nonOperationCapabilities.map((capability) => ({
      id: `cap:api:${capability.operationId}`,
      operationId: capability.operationId,
      kind: "api",
      risk: riskOf(capability)
    }))
  ];
}

function toolCapabilitiesForOperations(operations = []) {
  const catalog = createToolCatalog({ operations });
  return catalog.tools.map((tool) => ({
    id: `cap:tool:${tool.id}:execute`,
    toolId: tool.id,
    kind: "tool",
    risk: riskOf(tool)
  }));
}

function createCapabilityRegistryProjection(registry = {}, previousCapabilityRegistry = {}) {
  return {
    "$schema": "../schema/capability.schema.json",
    version: previousCapabilityRegistry.version || registry.version || "v1.0.0",
    generatedAt: previousCapabilityRegistry.generatedAt || registry.generatedAt || "1970-01-01T00:00:00.000Z",
    canonicalSource: false,
    canonicalSourcePath: SOURCE_OPERATION_REGISTRY,
    description: `Generated API and Operation Permission tool capability projection of ${SOURCE_OPERATION_REGISTRY}. Do not edit this file by hand.`,
    capabilities: apiCapabilitiesForOperations(registry.operations || [], SERVER_NON_OPERATION_API_CAPABILITIES),
    toolCapabilities: toolCapabilitiesForOperations(registry.operations || []),
    wildcards: previousCapabilityRegistry.wildcards || [
      { id: "cap:*", description: "All capabilities — owner/admin only", requiresRole: "owner" },
      { id: "cap:api:*", description: "All API capabilities — admin override", requiresScope: "auth:admin" },
      { id: "cap:tool:*", description: "All tool capabilities — system grant only", requiresGrant: "system" }
    ],
    policyRules: previousCapabilityRegistry.policyRules || []
  };
}

// --- Generate operations.generated.mjs ---

function generateOperationsModule(registry) {
  const operations = registry.operations || [];
  const hash = _hash(JSON.stringify(registry, null, 2));
  const generatedAt = registry.generatedAt || "1970-01-01T00:00:00.000Z";

  const operationsJson = JSON.stringify(operations, null, 2);

  return `/**
 * OPERATIONS GENERATED — DO NOT EDIT MANUALLY.
 *
 * Generated from: ${SOURCE_OPERATION_REGISTRY}
 * Generator: tools/generators/generate-operation-artifacts.mjs
 * Hash: ${hash}
 * Generated at: ${generatedAt}
 *
 * To modify operations: edit the source operation definitions, then run the generator.
 */
export const GENERATED_OPERATIONS_HASH = "${hash}";
export const SERVER_API_OPERATIONS = ${operationsJson};

export const OPERATION_IDS = Object.freeze(SERVER_API_OPERATIONS.map(op => op.id));
export const OPERATIONS_BY_ID = Object.freeze(
  Object.fromEntries(SERVER_API_OPERATIONS.map(op => [op.id, op]))
);
export const PUBLIC_OPERATION_IDS = Object.freeze(
  SERVER_API_OPERATIONS.filter(op => op.public).map(op => op.id)
);
export const DESTRUCTIVE_OPERATION_IDS = Object.freeze(
  SERVER_API_OPERATIONS.filter(op => op.risk === 'destructive').map(op => op.id)
);

export function getOperationById(id) {
  return OPERATIONS_BY_ID[id] || null;
}

export function listOperationsByFeature(feature) {
  return SERVER_API_OPERATIONS.filter(op => op.feature === feature);
}

export function listOperationsByRisk(risk) {
  return SERVER_API_OPERATIONS.filter(op => op.risk === risk);
}
`;
}

// --- Generate generated-capabilities.mjs ---

function generateCapabilitiesModule(registry, capabilityRegistry) {
  const capabilities = capabilityRegistry?.capabilities || [];
  const toolCapabilities = capabilityRegistry?.toolCapabilities || [];
  const wildcards = capabilityRegistry?.wildcards || [];

  const hash = _hash(JSON.stringify(capabilityRegistry, null, 2));
  const generatedAt = capabilityRegistry.generatedAt || registry.generatedAt || "1970-01-01T00:00:00.000Z";

  const apiCapIds = capabilities.map((c) => `"${c.id}"`).join(",\n  ");
  const toolCapIds = toolCapabilities.map((c) => `"${c.id}"`).join(",\n  ");
  const wildcardIds = wildcards.map((c) => `"${c.id}"`).join(",\n  ");

  const allCaps = [...capabilities, ...toolCapabilities];

  return `/**
 * CAPABILITIES GENERATED — DO NOT EDIT MANUALLY.
 *
 * Generated from: ${SOURCE_OPERATION_REGISTRY}
 * Generator: tools/generators/generate-operation-artifacts.mjs
 * Hash: ${hash}
 * Generated at: ${generatedAt}
 *
 * To modify capabilities: edit source operation definitions or Operation Permission catalog mappings, then run the generator.
 */
export const GENERATED_CAPABILITIES_HASH = "${hash}";

export const KERNEL_API_OPERATION_IDS = Object.freeze([
  ${apiCapIds}
].map(id => id.replace("cap:api:", "")));

export const KERNEL_TOOL_IDS = Object.freeze([
  ${toolCapIds}
].map(id => id.replace("cap:tool:", "").replace(":execute", "")));

export const KERNEL_CAPABILITY_WILDCARDS = Object.freeze([
  ${wildcardIds}
]);

export const KERNEL_API_CAPABILITY_PERMISSIONS = Object.freeze(
  KERNEL_API_OPERATION_IDS.map(id => \`cap:api:\${id}\`)
);

export const KERNEL_TOOL_CAPABILITY_PERMISSIONS = Object.freeze(
  KERNEL_TOOL_IDS.map(id => \`cap:tool:\${id}:execute\`)
);

export const KERNEL_CAPABILITY_PERMISSIONS = Object.freeze([
  ...KERNEL_API_CAPABILITY_PERMISSIONS,
  ...KERNEL_TOOL_CAPABILITY_PERMISSIONS
]);

export function apiCapabilityId(operationId) {
  return \`cap:api:\${String(operationId || "").trim()}\`;
}

export function toolExecuteCapabilityId(toolId) {
  return \`cap:tool:\${String(toolId || "").trim()}:execute\`;
}

export const CAPABILITY_RISK_MAP = Object.freeze(${JSON.stringify(
    Object.fromEntries(allCaps.map((c) => [c.id, c.risk || "read_only"])),
    null,
    2
  )});
`;
}

// --- Generate OpenAPI ---

function openApiResponses(operation = {}) {
  const contract = operation.http?.responseContract;
  if (!contract?.success?.responseSchema) {
    return {
      "200": { description: "Success" },
      "400": { description: "Invalid input" },
      "403": { description: "Forbidden" }
    };
  }
  const responses = {
    [String(contract.success.status || 200)]: {
      description: "Success",
      content: { "application/json": { schema: contract.success.responseSchema } }
    }
  };
  const byStatus = new Map();
  for (const [code, errorContract] of Object.entries(contract.errors || {})) {
    const status = String(errorContract.status || 500);
    const group = byStatus.get(status) || [];
    group.push({ code, contract: errorContract });
    byStatus.set(status, group);
  }
  for (const [status, errors] of byStatus) {
    responses[status] = {
      description: `Protocol errors: ${errors.map((entry) => entry.code).join(", ")}`,
      content: {
        "application/json": { schema: errors[0].contract.responseSchema }
      },
      "x-meshrix-error-codes": Object.fromEntries(errors.map(({ code, contract: errorContract }) => [
        code,
        { retry: errorContract.retry }
      ]))
    };
  }
  return responses;
}

function generateOpenApi(registry) {
  const operations = registry.operations || [];

  const paths = {};
  for (const op of operations) {
    if (!op.http) continue;
    const path = op.http.path || `/${op.id.replace(/\./g, "/")}`;
    const method = String(op.http.method || "POST").toLowerCase();

    if (!paths[path]) paths[path] = {};

    paths[path][method] = {
      operationId: op.id,
      summary: op.description || op.id,
      tags: [op.feature || "general"],
      security: op.public ? [] : [{ bearerAuth: [] }],
      ...(op.http?.headerContract
        ? { "x-meshrix-http-header-contract": op.http.headerContract }
        : {}),
      ...(Array.isArray(op.http?.admissionDimensions)
        ? { "x-meshrix-admission-dimensions": op.http.admissionDimensions }
        : {}),
      requestBody: method !== "get" && op.inputSchema ? {
        required: true,
        content: { "application/json": { schema: op.inputSchema } },
      } : undefined,
      responses: openApiResponses(op),
    };
  }

  return {
    "$comment": `GENERATED - DO NOT EDIT MANUALLY. Source: ${SOURCE_OPERATION_REGISTRY}`,
    openapi: "3.1.0",
    info: {
      title: "Meshrix API",
      version: registry.version || "v1.0.0",
      description: `Generated from ${SOURCE_OPERATION_REGISTRY}`,
    },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
  };
}

// --- Generate routes JSON ---

function generateRoutesJson(registry) {
  const operations = registry.operations || [];
  const routes = [];

  for (const op of operations) {
    if (op.http) {
      routes.push({
        method: String(op.http.method || "POST").toUpperCase(),
        path: op.http.path || `/${op.id.replace(/\./g, "/")}`,
        operationId: op.id,
        feature: op.feature || "",
        risk: op.risk || "read_only",
        public: Boolean(op.public),
      });
    }
    if (op.rpc) {
      routes.push({
        method: "RPC",
        path: op.rpc.method || op.id,
        operationId: op.id,
        feature: op.feature || "",
        risk: op.risk || "read_only",
        public: Boolean(op.public),
      });
    }
  }

  return {
    "$comment": `GENERATED - DO NOT EDIT MANUALLY. Source: ${SOURCE_OPERATION_REGISTRY}`,
    version: registry.version,
    generatedAt: registry.generatedAt || "1970-01-01T00:00:00.000Z",
    routeCount: routes.length,
    routes,
  };
}

// --- Write with header ---

function writeGenerated(path, content) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, content, "utf8");
  console.log(`  Generated: ${path}`);
}

// --- Check mode ---

function checkGenerated(path, content) {
  if (!existsSync(path)) {
    console.error(`  MISSING: ${path}`);
    return false;
  }
  const existing = readFileSync(path, "utf8");
  if (existing !== content) {
    console.error(`  STALE: ${path} (regenerated content differs)`);
    return false;
  }
  console.log(`  OK: ${path}`);
  return true;
}

// --- Main ---

function main() {
  const checkMode = process.argv.includes("--check");
  console.log(`\nOperation Artifact Generator ${checkMode ? "(check mode)" : "(generate mode)"}\n`);

  const previousRegistry = loadRegistry(REGISTRY_PATH);
  const previousCapabilityRegistry = loadRegistry(CAPABILITY_REGISTRY_PATH);
  const registry = createOperationRegistryProjection(previousRegistry);
  const capabilityRegistry = createCapabilityRegistryProjection(registry, previousCapabilityRegistry);

  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    console.error("Registry validation FAILED:");
    for (const err of errors) {
      console.error(`  - [${err.operationId || "?"}] ${err.message}`);
    }
    process.exit(1);
  }
  console.log("Registry validation: OK\n");

  // Generate outputs
  const opsContent = generateOperationsModule(registry);
  const capsContent = generateCapabilitiesModule(registry, capabilityRegistry);
  const openApiContent = JSON.stringify(generateOpenApi(registry), null, 2);
  const routesContent = JSON.stringify(generateRoutesJson(registry), null, 2);

  if (checkMode) {
    console.log("Checking generated files...");
    let allOk = true;
    allOk &= checkGenerated(OUTPUTS.registry, `${JSON.stringify(registry, null, 2)}\n`);
    allOk &= checkGenerated(OUTPUTS.capabilityRegistry, `${JSON.stringify(capabilityRegistry, null, 2)}\n`);
    allOk &= checkGenerated(OUTPUTS.operations, opsContent);
    allOk &= checkGenerated(OUTPUTS.capabilities, capsContent);
    allOk &= checkGenerated(OUTPUTS.openapi, openApiContent);
    allOk &= checkGenerated(OUTPUTS.routes, routesContent);

    if (!allOk) {
      console.error("\nFAILED: Generated files are stale. Run: node tools/generators/generate-operation-artifacts.mjs");
      process.exit(1);
    }
    console.log("\nAll generated files are up to date.");
  } else {
    console.log("Writing generated files...");
    writeGenerated(OUTPUTS.registry, `${JSON.stringify(registry, null, 2)}\n`);
    writeGenerated(OUTPUTS.capabilityRegistry, `${JSON.stringify(capabilityRegistry, null, 2)}\n`);
    writeGenerated(OUTPUTS.operations, opsContent);
    writeGenerated(OUTPUTS.capabilities, capsContent);
    writeGenerated(OUTPUTS.openapi, openApiContent);
    writeGenerated(OUTPUTS.routes, routesContent);
    console.log("\nGeneration complete.");
  }
}

/**
 * Validate the operation registry.
 * @param {object} registry
 * @returns {Array<{operationId: string, message: string}>}
 */
function validateRegistry(registry) {
  const errors = [];
  const ids = new Set();

  for (const op of registry.operations || []) {
    const id = op.id || "";

    if (!id) {
      errors.push({ message: "Operation missing required field: id" });
      continue;
    }

    if (ids.has(id)) {
      errors.push({ operationId: id, message: "Duplicate operation ID" });
    }
    ids.add(id);

    if (!op.risk) {
      errors.push({ operationId: id, message: "Missing required field: risk" });
    }

    if (op.readOnly === undefined || op.readOnly === null) {
      errors.push({ operationId: id, message: "Missing required field: readOnly" });
    }

    if (!op.inputSchema) {
      errors.push({ operationId: id, message: "Missing required field: inputSchema" });
    }

    if (!op.resourceContext) {
      errors.push({ operationId: id, message: "Missing required field: resourceContext" });
    }

    if (!op.otel) {
      errors.push({ operationId: id, message: "Missing required field: otel (OpenTelemetry semantics)" });
    }

    if (!op.auditPolicy) {
      errors.push({ operationId: id, message: "Missing required field: auditPolicy" });
    }

    // Validate HTTP methods
    if (op.http) {
      const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
      const methods = Array.isArray(op.http.method)
        ? op.http.method
        : [op.http.method];
      for (const m of methods) {
        if (!validMethods.includes(String(m).toUpperCase())) {
          errors.push({ operationId: id, message: `Invalid HTTP method: ${m}` });
        }
      }
    }
  }

  return errors;
}

function _hash(input) {
  return `sha256:${crypto.createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16)}`;
}

main();

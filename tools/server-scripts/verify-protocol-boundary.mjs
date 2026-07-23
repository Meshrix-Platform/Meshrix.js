#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { sensitiveReportFindings } from "./lib/sensitive-report-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORT_PATH = path.join(ROOT, "build/reports/protocol-boundary.json");
const VERIFIER = "tools/server-scripts/verify-protocol-boundary.mjs";
const REPORT_SCHEMA_VERSION = "v0.0.1:architecture:protocol-boundary-report-1";
const PROTOCOL_ROOT = path.join(ROOT, "packages/protocols");
const TEXT_EXTENSIONS = new Set([".js", ".json", ".mjs", ".ts", ".tsx"]);
const FORBIDDEN_PATTERNS = Object.freeze([
  {
    id: "server-runtime-package-import",
    pattern: /@lico\/server-runtime/u
  },
  {
    id: "server-runtime-import-alias",
    pattern: /#lico\/server-runtime/u
  },
  {
    id: "server-runtime-source-path",
    pattern: /packages\/server-runtime(?:\/|\b)/u
  },
  {
    id: "settings-runtime-alias",
    pattern: /#lico\/settings/u
  },
  {
    id: "agents-package-import",
    pattern: /@lico\/agents|#lico\/agents/u
  },
  {
    id: "agents-source-path",
    pattern: /packages\/agents(?:\/|\b)/u
  },
  {
    id: "capabilities-package-import",
    pattern: /@lico\/capabilities|#lico\/capabilities/u
  },
  {
    id: "capabilities-source-path",
    pattern: /packages\/capabilities(?:\/|\b)/u
  },
  {
    id: "relative-escape-to-runtime-or-domain",
    pattern: /(?:\.\.\/)+(?:server-runtime|agents|capabilities)(?:\/|\b)/u
  }
]);
const FORBIDDEN_PACKAGE_DEPENDENCIES = Object.freeze([
  "@lico/agents",
  "@lico/capabilities",
  "@lico/server-runtime",
  "@lico/ui-console"
]);
const APPROVED_PROTOCOL_PORTS = Object.freeze([
  "configureMcpNotificationBus",
  "registerConfiguredMcpSseConnection",
  "broadcastConfiguredMcpNotification",
  "toolSkillManagementProvider.authorizeRequest",
  "toolSkillManagementProvider.listVisibleTools"
]);

function toRelative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function assertNoLocalPathLeak(report) {
  const sensitiveFields = [];
  const visit = (value, fieldPath = "report") => {
    if (typeof value === "string") {
      if (sensitiveReportFindings(value).length > 0) sensitiveFields.push(fieldPath);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${fieldPath}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) visit(entry, `${fieldPath}.${key}`);
    }
  };
  visit(report);
  if (sensitiveFields.length > 0) {
    throw new Error(
      `Protocol boundary report contains sensitive fields: ${sensitiveFields.slice(0, 20).join(", ")}`
    );
  }
  const text = JSON.stringify(report);
  if (text.includes(ROOT) || /\/Users\/[^ "'\n]+/u.test(text)) {
    throw new Error("protocol boundary report leaked a local path");
  }
}

async function walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(filePath));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(filePath);
    }
  }
  return files;
}

async function readText(relativePath) {
  return fs.readFile(path.join(ROOT, relativePath), "utf8");
}

function scanForbiddenReferences(filePath, text) {
  const violations = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    for (const forbidden of FORBIDDEN_PATTERNS) {
      if (forbidden.pattern.test(line)) {
        violations.push({
          file: toRelative(filePath),
          line: index + 1,
          rule: forbidden.id
        });
      }
    }
  }
  return violations;
}

async function main() {
  const checks = [];

  async function check(id, fn) {
    try {
      const detail = await fn();
      checks.push({ id, status: "passed", ...(detail ? { detail } : {}) });
    } catch (error) {
      checks.push({
        id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error || "")
      });
    }
  }

  const protocolFiles = await walkFiles(PROTOCOL_ROOT);

  await check("protocol-package-has-no-runtime-dependencies", async () => {
    const violations = [];
    for (const filePath of protocolFiles) {
      violations.push(...scanForbiddenReferences(filePath, await fs.readFile(filePath, "utf8")));
    }
    if (violations.length > 0) {
      throw new Error(`Forbidden protocol runtime references: ${JSON.stringify(violations.slice(0, 20))}`);
    }
    return { scannedFileCount: protocolFiles.length, approvedPorts: APPROVED_PROTOCOL_PORTS };
  });

  await check("protocol-adapters-do-not-depend-on-connector-implementation", async () => {
    const adapterRoot = path.join(PROTOCOL_ROOT, "mcp/adapter");
    const connectorRoot = path.join(adapterRoot, "gateway-installer");
    const violations = [];
    for (const filePath of protocolFiles) {
      if (!filePath.startsWith(adapterRoot) || filePath.startsWith(connectorRoot)) continue;
      const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/u);
      lines.forEach((line, index) => {
        if (/gateway-installer\/lib(?:\/|\b)/u.test(line)) {
          violations.push({ file: toRelative(filePath), line: index + 1 });
        }
      });
    }
    if (violations.length > 0) {
      throw new Error(`Protocol adapter imports connector implementation: ${JSON.stringify(violations.slice(0, 20))}`);
    }
  });

  await check("protocol-package-manifest-forbids-domain-runtime-deps", async () => {
    const packageManifest = JSON.parse(await readText("packages/protocols/package.json"));
    const declared = {
      ...(packageManifest.dependencies || {}),
      ...(packageManifest.optionalDependencies || {}),
      ...(packageManifest.peerDependencies || {}),
      ...(packageManifest.devDependencies || {})
    };
    const forbidden = FORBIDDEN_PACKAGE_DEPENDENCIES.filter((name) => Object.hasOwn(declared, name));
    if (forbidden.length > 0) {
      throw new Error(`Protocol package declares forbidden dependencies: ${forbidden.join(", ")}`);
    }
    const allowed = new Set(["@lico/contracts", "@lico/foundation"]);
    const unexpected = Object.keys(declared).filter((name) => name.startsWith("@lico/") && !allowed.has(name));
    if (unexpected.length > 0) {
      throw new Error(`Protocol package declares unexpected @lico dependencies: ${unexpected.join(", ")}`);
    }
    return { dependencyCount: Object.keys(declared).length };
  });

  await check("mcp-adapter-reaches-authorization-only-through-injected-ports", async () => {
    const transport = await readText("packages/protocols/mcp/adapter/http-mcp-adapter-transport.mjs");
    const tools = await readText("packages/protocols/mcp/adapter/http-mcp-adapter-tools.mjs");
    for (const required of [
      "toolSkillManagementProvider.authorizeRequest",
      "toolSkillManagementProvider?.listVisibleTools",
      "listVisibleTools({ authorization })"
    ]) {
      if (!transport.includes(required) && !tools.includes(required)) {
        throw new Error(`MCP adapter must use injected Operation Permission port: ${required}`);
      }
    }
    if (transport.includes("createOperationPermission") || tools.includes("createOperationPermission")) {
      throw new Error("MCP adapter must not construct Operation Permission internals directly.");
    }
    return { approvedPorts: APPROVED_PROTOCOL_PORTS };
  });

  await check("dependency-rules-have-no-stale-protocol-runtime-exception", async () => {
    const registry = JSON.parse(await readText("tools/registry/dependency-rules.registry.json"));
    const staleException = (registry.exceptions || []).find((exception) =>
      String(exception?.from || "").startsWith("packages/protocols") &&
      String(exception?.to || "").includes("server-runtime")
    );
    if (staleException) {
      throw new Error(`Stale protocol runtime exception remains: ${staleException.id || "unknown"}`);
    }
    const protocolLayer = (registry.layers || []).find((layer) => layer.id === "protocols");
    if (!protocolLayer) {
      throw new Error("Dependency rules registry is missing the protocols layer.");
    }
    const allowed = new Set(protocolLayer.allowedDependsOn || []);
    if (!allowed.has("contracts") || !allowed.has("foundation")) {
      throw new Error("Protocols layer must declare contracts and foundation as allowed dependencies.");
    }
    if (!new Set(protocolLayer.forbiddenDependsOn || []).has("server-runtime")) {
      throw new Error("Protocols layer must forbid server-runtime dependencies.");
    }
  });

  await check("mcp-runtime-state-is-injected-through-port", async () => {
    const replies = await readText("packages/protocols/mcp/adapter/http-mcp-adapter-replies.mjs");
    const transport = await readText("packages/protocols/mcp/adapter/http-mcp-adapter-transport.mjs");
    const bus = await readText("packages/protocols/mcp/adapter/mcp-notification-bus.mjs");
    const serverRoutes = await readText("apps/server/runtime/http-server-routes.mjs");
    const compositionBinding = await readText(
      "packages/server-runtime/src/composition/mcp-notification-bus-binding.mjs"
    );
    if (!replies.includes("broadcastConfiguredMcpNotification")) {
      throw new Error("MCP replies must use the configured notification port.");
    }
    if (!transport.includes("registerConfiguredMcpSseConnection")) {
      throw new Error("MCP transport must use the configured SSE registration port.");
    }
    if (!bus.includes("configureMcpNotificationBus")) {
      throw new Error("MCP notification bus configurator is missing.");
    }
    if (!compositionBinding.includes("configureMcpNotificationBus") ||
        !compositionBinding.includes("registerMcpSseConnection")) {
      throw new Error("Server composition must inject MCP SSE runtime state.");
    }
    if (serverRoutes.includes("configureMcpNotificationBus") ||
        serverRoutes.includes("registerMcpSseConnection")) {
      throw new Error("The HTTP application adapter must not bind MCP runtime state.");
    }
  });

  await check("mcp-identity-provider-is-wired-in-composition", async () => {
    const discovery = await readText("packages/protocols/mcp/adapter/http-mcp-adapter-discovery.mjs");
    const identity = await readText("packages/protocols/mcp/adapter/mcp-identity.mjs");
    const runtimeIdentity = await readText("packages/server-runtime/src/composition/mcp-identity-provider.mjs");
    if (!discovery.includes("./mcp-identity.mjs")) {
      throw new Error("MCP discovery must import identity contract helpers from protocols.");
    }
    if (!identity.includes("buildMcpHandshakePayload") || !identity.includes("signMcpHandshake")) {
      throw new Error("Protocol identity helper must own handshake payload and signature helpers.");
    }
    if (!runtimeIdentity.includes("@lico/protocols/mcp/adapter/mcp-identity")) {
      throw new Error("Runtime composition must reuse the protocol identity contract.");
    }
  });

  await check("http-bootstrap-projection-lives-in-protocols", async () => {
    const apiFacade = await readText("packages/protocols/http/api-facade.mjs");
    const bootstrap = await readText("packages/protocols/http/bootstrap-payload.mjs");
    const discoveryConfig = await readText("packages/server-runtime/src/composition/discovery-config.mjs");
    if (!apiFacade.includes("./bootstrap-payload.mjs")) {
      throw new Error("HTTP api facade must use protocol-local bootstrap projection.");
    }
    if (!bootstrap.includes("buildBootstrapPayload")) {
      throw new Error("Protocol bootstrap projection helper is missing.");
    }
    if (!discoveryConfig.includes("@lico/protocols/http/bootstrap-payload")) {
      throw new Error("Runtime discovery config must reuse protocol bootstrap projection.");
    }
  });

  const failedChecks = checks.filter((checkResult) => checkResult.status !== "passed");
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    verifier: VERIFIER,
    releaseReady: failedChecks.length === 0,
    coverageReady: failedChecks.length === 0,
    summary: {
      releaseReady: failedChecks.length === 0,
      coverageReady: failedChecks.length === 0,
      reportLeakScan: true,
      scannedFileCount: protocolFiles.length,
      checkCount: checks.length,
      failedCheckCount: failedChecks.length
    },
    checks
  };
  assertNoLocalPathLeak(report);
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[protocol-boundary] releaseReady=${report.releaseReady} report=build/reports/protocol-boundary.json`);
  if (!report.releaseReady) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    verifier: VERIFIER,
    releaseReady: false,
    coverageReady: false,
    summary: {
      releaseReady: false,
      coverageReady: false,
      reportLeakScan: true,
      fatal: true
    },
    error: error instanceof Error ? error.message : String(error || "")
  };
  assertNoLocalPathLeak(report);
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(`[protocol-boundary] failed: ${report.error}`);
  process.exitCode = 1;
});

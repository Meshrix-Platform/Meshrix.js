#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { sensitiveReportFindings } from "./lib/sensitive-report-scan.ts";

const ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORT_PATH: any = path.join(ROOT, "build/reports/protocol-boundary.json");
const VERIFIER: any = "tools/server-scripts/verify-protocol-boundary.ts";
const REPORT_SCHEMA_VERSION: any = "v0.0.1:architecture:protocol-boundary-report-1";
const PROTOCOL_ROOT: any = path.join(ROOT, "packages/protocols");
const TEXT_EXTENSIONS: any = new Set<any>([".js", ".json", ".ts", ".ts", ".tsx"]);
const FORBIDDEN_PATTERNS: readonly any[] = Object.freeze([
  {
    id: "server-runtime-package-import",
    pattern: /@meshrix\/server-runtime/u
  },
  {
    id: "server-runtime-import-alias",
    pattern: /#meshrix\/server-runtime/u
  },
  {
    id: "server-runtime-source-path",
    pattern: /packages\/server-runtime(?:\/|\b)/u
  },
  {
    id: "settings-runtime-alias",
    pattern: /#meshrix\/settings/u
  },
  {
    id: "agents-package-import",
    pattern: /@meshrix\/agents|#meshrix\/agents/u
  },
  {
    id: "agents-source-path",
    pattern: /packages\/agents(?:\/|\b)/u
  },
  {
    id: "capabilities-package-import",
    pattern: /@meshrix\/capabilities|#meshrix\/capabilities/u
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
const FORBIDDEN_PACKAGE_DEPENDENCIES: readonly any[] = Object.freeze([
  "@meshrix/agents",
  "@meshrix/capabilities",
  "@meshrix/server-runtime",
  "@meshrix/ui-console"
]);
const APPROVED_PROTOCOL_PORTS: readonly any[] = Object.freeze([
  "configureMcpNotificationBus",
  "registerConfiguredMcpSubscription",
  "broadcastConfiguredMcpNotification",
  "toolSkillManagementProvider.authorizeMcpClientRequest",
  "toolSkillManagementProvider.listVisibleTools"
]);

function toRelative(filePath?: any) : any {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function assertNoLocalPathLeak(report?: any) : any {
  const sensitiveFields: any[] = [];
  const visit: any = (value?: any, fieldPath: any = "report") : any => {
    if (typeof value === "string") {
      if (sensitiveReportFindings(value).length > 0) sensitiveFields.push(fieldPath);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry?: any, index?: any) : any => visit(entry, `${fieldPath}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, entry] of (Object.entries(value) as [string, any][])) visit(entry, `${fieldPath}.${key}`);
    }
  };
  visit(report);
  if (sensitiveFields.length > 0) {
    throw new Error(
      `Protocol boundary report contains sensitive fields: ${sensitiveFields.slice(0, 20).join(", ")}`
    );
  }
  const text: any = JSON.stringify(report);
  if (text.includes(ROOT) || /\/Users\/[^ "'\n]+/u.test(text)) {
    throw new Error("protocol boundary report leaked a local path");
  }
}

async function walkFiles(dir?: any) : Promise<any> {
  const entries: any = await fs.readdir(dir, { withFileTypes: true });
  const files: any[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") {
      continue;
    }
    const filePath: any = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(filePath));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(filePath);
    }
  }
  return files;
}

async function readText(relativePath?: any) : Promise<any> {
  return fs.readFile(path.join(ROOT, relativePath), "utf8");
}

function scanForbiddenReferences(filePath?: any, text?: any) : any {
  const violations: any[] = [];
  const lines: any = text.split(/\r?\n/u);
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

async function main() : Promise<any> {
  const checks: any[] = [];

  async function check(id?: any, fn?: any) : Promise<any> {
    try {
      const detail: any = await fn();
      checks.push({ id, status: "passed", ...(detail ? { detail } : {}) });
    } catch (error: any) {
      checks.push({
        id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error || "")
      });
    }
  }

  const protocolFiles: any = await walkFiles(PROTOCOL_ROOT);

  await check("protocol-package-has-no-runtime-dependencies", async () : Promise<any> => {
    const violations: any[] = [];
    for (const filePath of protocolFiles) {
      violations.push(...scanForbiddenReferences(filePath, await fs.readFile(filePath, "utf8")));
    }
    if (violations.length > 0) {
      throw new Error(`Forbidden protocol runtime references: ${JSON.stringify(violations.slice(0, 20))}`);
    }
    return { scannedFileCount: protocolFiles.length, approvedPorts: APPROVED_PROTOCOL_PORTS };
  });

  await check("protocol-adapters-do-not-depend-on-connector-implementation", async () : Promise<any> => {
    const adapterRoot: any = path.join(PROTOCOL_ROOT, "mcp/adapter");
    const connectorRoot: any = path.join(adapterRoot, "gateway-installer");
    const violations: any[] = [];
    for (const filePath of protocolFiles) {
      if (!filePath.startsWith(adapterRoot) || filePath.startsWith(connectorRoot)) continue;
      const lines: any = (await fs.readFile(filePath, "utf8")).split(/\r?\n/u);
      lines.forEach((line?: any, index?: any) : any => {
        if (/gateway-installer\/lib(?:\/|\b)/u.test(line)) {
          violations.push({ file: toRelative(filePath), line: index + 1 });
        }
      });
    }
    if (violations.length > 0) {
      throw new Error(`Protocol adapter imports connector implementation: ${JSON.stringify(violations.slice(0, 20))}`);
    }
  });

  await check("protocol-package-manifest-forbids-domain-runtime-deps", async () : Promise<any> => {
    const packageManifest: any = JSON.parse(await readText("packages/protocols/package.json"));
    const declared: Record<string, any> = {
      ...(packageManifest.dependencies || {}),
      ...(packageManifest.optionalDependencies || {}),
      ...(packageManifest.peerDependencies || {}),
      ...(packageManifest.devDependencies || {})
    };
    const forbidden: any = FORBIDDEN_PACKAGE_DEPENDENCIES.filter((name?: any) : any => Object.hasOwn(declared, name));
    if (forbidden.length > 0) {
      throw new Error(`Protocol package declares forbidden dependencies: ${forbidden.join(", ")}`);
    }
    const allowed: any = new Set<any>(["@meshrix/contracts", "@meshrix/foundation"]);
    const unexpected: any = Object.keys(declared).filter((name?: any) : any => name.startsWith("@meshrix/") && !allowed.has(name));
    if (unexpected.length > 0) {
      throw new Error(`Protocol package declares unexpected @meshrix dependencies: ${unexpected.join(", ")}`);
    }
    return { dependencyCount: Object.keys(declared).length };
  });

  await check("mcp-adapter-reaches-authorization-only-through-injected-ports", async () : Promise<any> => {
    const transport: any = await readText("packages/protocols/mcp/adapter/http-mcp-adapter-transport.ts");
    const tools: any = await readText("packages/protocols/mcp/adapter/http-mcp-adapter-tools.ts");
    for (const required of [
      "toolSkillManagementProvider.authorizeMcpClientRequest",
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

  await check("dependency-rules-have-no-stale-protocol-runtime-exception", async () : Promise<any> => {
    const registry: any = JSON.parse(await readText("tools/registry/dependency-rules.registry.json"));
    const staleException: any = (registry.exceptions || []).find((exception?: any) : any =>
      String(exception?.from || "").startsWith("packages/protocols") &&
      String(exception?.to || "").includes("server-runtime")
    );
    if (staleException) {
      throw new Error(`Stale protocol runtime exception remains: ${staleException.id || "unknown"}`);
    }
    const protocolLayer: any = (registry.layers || []).find((layer?: any) : any => layer.id === "protocols");
    if (!protocolLayer) {
      throw new Error("Dependency rules registry is missing the protocols layer.");
    }
    const allowed: any = new Set<any>(protocolLayer.allowedDependsOn || []);
    if (!allowed.has("contracts") || !allowed.has("foundation")) {
      throw new Error("Protocols layer must declare contracts and foundation as allowed dependencies.");
    }
    if (!new Set<any>(protocolLayer.forbiddenDependsOn || []).has("server-runtime")) {
      throw new Error("Protocols layer must forbid server-runtime dependencies.");
    }
  });

  await check("mcp-runtime-state-is-injected-through-port", async () : Promise<any> => {
    const replies: any = await readText("packages/protocols/mcp/adapter/http-mcp-adapter-replies.ts");
    const transport: any = await readText("packages/protocols/mcp/adapter/http-mcp-adapter-transport.ts");
    const bus: any = await readText("packages/protocols/mcp/adapter/mcp-notification-bus.ts");
    const serverRoutes: any = await readText("apps/server/runtime/http-server-routes.ts");
    const compositionBinding: any = await readText(
      "packages/server-runtime/src/composition/mcp-notification-bus-binding.ts"
    );
    if (!replies.includes("broadcastConfiguredMcpNotification")) {
      throw new Error("MCP replies must use the configured notification port.");
    }
    if (!transport.includes("registerConfiguredMcpSubscription")) {
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

  await check("mcp-identity-provider-is-wired-in-composition", async () : Promise<any> => {
    const discovery: any = await readText("packages/protocols/mcp/adapter/http-mcp-adapter-discovery.ts");
    const identity: any = await readText("packages/protocols/mcp/adapter/gateway-installer/mcp-identity.ts");
    const runtimeIdentity: any = await readText("packages/server-runtime/src/composition/mcp-identity-provider.ts");
    if (!discovery.includes("./gateway-installer/mcp-identity.ts")) {
      throw new Error("MCP discovery must import identity contract helpers from protocols.");
    }
    if (!identity.includes("buildMcpHandshakePayload") || !identity.includes("signMcpHandshake")) {
      throw new Error("Protocol identity helper must own handshake payload and signature helpers.");
    }
    if (!runtimeIdentity.includes("@meshrix/protocols/mcp/adapter/mcp-identity")) {
      throw new Error("Runtime composition must reuse the protocol identity contract.");
    }
  });

  await check("http-bootstrap-projection-lives-in-protocols", async () : Promise<any> => {
    const apiFacade: any = await readText("packages/protocols/http/api-facade.ts");
    const bootstrap: any = await readText("packages/protocols/http/bootstrap-payload.ts");
    const discoveryConfig: any = await readText("packages/server-runtime/src/composition/discovery-config.ts");
    if (!apiFacade.includes("./bootstrap-payload.ts")) {
      throw new Error("HTTP api facade must use protocol-local bootstrap projection.");
    }
    if (!bootstrap.includes("buildBootstrapPayload")) {
      throw new Error("Protocol bootstrap projection helper is missing.");
    }
    if (!discoveryConfig.includes("@meshrix/protocols/http/bootstrap-payload")) {
      throw new Error("Runtime discovery config must reuse protocol bootstrap projection.");
    }
  });

  const failedChecks: any = checks.filter((checkResult?: any) : any => checkResult.status !== "passed");
  const report: Record<string, any> = {
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

main().catch(async (error?: any) : Promise<any> => {
  const report: Record<string, any> = {
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

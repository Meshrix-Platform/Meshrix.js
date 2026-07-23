#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.mjs";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import {
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME,
  MCP_INTERFACE_VERSION,
  handleLicoMcpHttpRequest
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter.mjs";
import { mcpOutletForTool as resolveMcpOutletForTool } from "../../packages/protocols/mcp/adapter/http-mcp-adapter-tools.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_REPORT_PATH = "build/reports/downstream-mcp-completeness-audit.json";

const MCP_REGISTRY_OPERATION_PREFIXES = Object.freeze([
  "operation_permission.",
  "gateway.",
  "external_services.",
  "workspace.file.",
  "workspace.proposal.",
  "workspace_governance.",
  "agent_workspaces.",
  "agent_sessions.",
  "agent_sync.",
  "authorization.",
  "tag_management."
]);

const INTERNAL_OPERATION_IDS_HIDDEN_FROM_MCP = Object.freeze(new Set([
  "operation_permission.execute",
  "operation_permission.batch",
  "operation_permission.dry_run"
]));

const RISK_RANK = Object.freeze({
  read_only: 0,
  safe_write: 1,
  repair_write: 2,
  destructive: 3
});

function parseArgs(argv) {
  const options = {
    allowOpenGaps: false,
    report: DEFAULT_REPORT_PATH
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-open-gaps") {
      options.allowOpenGaps = true;
      continue;
    }
    if (arg === "--report") {
      options.report = takeValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--report=")) {
      options.report = arg.slice("--report=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function takeValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage:
  node tools/verifiers/downstream-mcp-completeness-audit.mjs
  node tools/verifiers/downstream-mcp-completeness-audit.mjs --allow-open-gaps

Options:
  --allow-open-gaps  Write the report and exit 0 even when downstream MCP gaps exist.
  --report <path>    Report JSON path. Defaults to ${DEFAULT_REPORT_PATH}.`);
}

function repoPath(...parts) {
  return path.join(repoRoot, ...parts);
}

function normalizeRelativePath(value) {
  return String(value || "").replace(/\\/gu, "/").replace(/^\.?\//u, "");
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function riskRank(value = "read_only") {
  return RISK_RANK[String(value || "read_only")] ?? RISK_RANK.read_only;
}

function isMcpRegistryCandidate(operation = {}) {
  const operationId = String(operation.id || "");
  if (!operationId || INTERNAL_OPERATION_IDS_HIDDEN_FROM_MCP.has(operationId)) {
    return false;
  }
  if ((operation.aspects || []).includes("internal")) {
    return false;
  }
  return MCP_REGISTRY_OPERATION_PREFIXES.some((prefix) => operationId.startsWith(prefix));
}

function operationRisk(operation = {}) {
  if (operation.destructive === true) {
    return "destructive";
  }
  if (operation.safety?.risk) {
    return String(operation.safety.risk);
  }
  if (operation.risk) {
    return String(operation.risk);
  }
  return operation.readOnly === false ? "safe_write" : "read_only";
}

function operationTarget(operation = {}) {
  const controller = String(operation.target?.controller || "").trim();
  const method = String(operation.target?.method || "").trim();
  return {
    controller,
    method,
    id: [controller, method].filter(Boolean).join(".")
  };
}

function mcpOutletForTool(tool = {}) {
  return resolveMcpOutletForTool(tool).toolName;
}

function createCapturedHttpResponse() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(chunk = "") {
      if (chunk !== undefined && chunk !== null && chunk !== "") {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      this.ended = true;
    }
  };
}

function capturedJson(response) {
  const text = Buffer.concat(response.chunks || []).toString("utf8").trim();
  return text ? JSON.parse(text) : null;
}

async function callMcpCapabilitiesList({ catalog }) {
  const response = createCapturedHttpResponse();
  const requestBody = Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    id: "downstream-mcp-completeness-audit",
    method: "tools/call",
    params: {
      name: MCP_DISCOVERY_TOOL_NAME,
      arguments: {
        apiVersion: MCP_INTERFACE_VERSION,
        operation: "lico.capabilities.list",
        input: {}
      }
    }
  }));
  const provider = {
    async authorizeRequest() {
      return {
        ok: true,
        status: 200,
        grant: {
          id: "downstream-mcp-completeness-audit-grant",
          label: "audit",
          scopes: [],
          toolsets: [],
          maxRisk: "repair_write",
          metadata: {
            maxRisk: "repair_write"
          }
        }
      };
    },
    listVisibleTools() {
      return catalog.tools.filter((tool) => tool.status === "active");
    },
    visibleGrantSummary() {
      return {
        id: "grant-hidden",
        label: "audit",
        toolsets: [],
        scopes: [],
        maxRisk: "repair_write"
      };
    }
  };
  await handleLicoMcpHttpRequest({
    request: {
      method: "POST",
      headers: {
        "user-agent": "downstream-mcp-completeness-audit"
      },
      socket: { remoteAddress: "127.0.0.1" }
    },
    response,
    requestBody,
    method: "POST",
    url: new URL("http://127.0.0.1/mcp"),
    toolSkillManagementProvider: provider
  });
  const payload = capturedJson(response);
  if (response.statusCode !== 200 || payload?.error) {
    throw new Error(`MCP capabilities call failed with status ${response.statusCode}`);
  }
  const structuredContent = payload?.result?.structuredContent;
  if (!structuredContent || !Array.isArray(structuredContent.operations)) {
    throw new Error("MCP capabilities response did not include structuredContent.operations.");
  }
  return structuredContent;
}

function summarizeOperationProjection({ publicOperation, tool, sourceOperation, toolsetsById }) {
  const sourceTarget = operationTarget(sourceOperation);
  const outlet = publicOperation?._meta?.mcpOutlet || mcpOutletForTool(tool);
  const grantableToolsets = (tool.toolsets || []).filter((toolsetId) => toolsetsById.get(toolsetId)?.grantable !== false);
  return {
    operationId: tool.operationId,
    projectionName: publicOperation?.name || tool.id,
    outlet,
    featureId: sourceOperation?.featureId || sourceOperation?.feature || tool.featureId || "",
    requiredScopes: uniqueStrings(publicOperation?._meta?.requiredScopes || tool.requiredScopes || []),
    operationGroups: uniqueStrings(publicOperation?._meta?.toolsets || tool.toolsets || []),
    grantableOperationGroups: uniqueStrings(grantableToolsets),
    risk: publicOperation?._meta?.risk || tool.risk || operationRisk(sourceOperation),
    approval: {
      requiresApproval: tool.requiresApproval === true,
      approvalScope: tool.approvalScope || "",
      destructive: tool.destructive === true
    },
    executorTarget: {
      ...sourceTarget,
      handlerId: tool.handlerId || ""
    },
    auditPolicy: {
      enabled: tool.auditPolicy?.enabled === true,
      recordInput: tool.auditPolicy?.recordInput !== false,
      recordOutput: tool.auditPolicy?.recordOutput === true
    },
    schema: {
      hasInputSchema: Boolean(publicOperation?.inputSchema || tool.inputSchema),
      publicRequiredCount: Array.isArray(publicOperation?.inputSchema?.required)
        ? publicOperation.inputSchema.required.length
        : 0
    },
    transport: {
      http: sourceOperation?.http
        ? {
            method: String(sourceOperation.http.method || "GET").toUpperCase(),
            path: sourceOperation.http.path || ""
          }
        : null,
      rpc: sourceOperation?.rpc?.method || ""
    }
  };
}

function addFinding(findings, finding) {
  findings.push({
    severity: finding.severity || "critical",
    code: finding.code,
    message: finding.message,
    evidence: finding.evidence || {}
  });
}

function auditCompleteness({ catalog, capabilities }) {
  const findings = [];
  const serverOperationsById = new Map(SERVER_API_OPERATIONS.map((operation) => [operation.id, operation]));
  const catalogOperationTools = catalog.tools.filter((tool) => tool.status === "active" && tool.operationId);
  const catalogToolsById = new Map(catalogOperationTools.map((tool) => [tool.id, tool]));
  const catalogToolsByOperationId = new Map();
  for (const tool of catalogOperationTools) {
    const bucket = catalogToolsByOperationId.get(tool.operationId) || [];
    bucket.push(tool);
    catalogToolsByOperationId.set(tool.operationId, bucket);
  }
  const publicOperationsByName = new Map((capabilities.operations || []).map((operation) => [operation.name, operation]));
  const publicOperationNames = new Set(publicOperationsByName.keys());
  const publicOperationIds = new Set(
    (capabilities.operations || [])
      .map((operation) => String(operation?._meta?.operationId || "").trim())
      .filter(Boolean)
  );
  const toolsetsById = new Map((catalog.toolsets || []).map((toolset) => [toolset.id, toolset]));

  for (const tool of catalogOperationTools) {
    if (!serverOperationsById.has(tool.operationId)) {
      addFinding(findings, {
        code: "catalog_only_tool",
        message: `MCP catalog tool ${tool.id} references registry-missing operation ${tool.operationId}.`,
        evidence: {
          toolId: tool.id,
          operationId: tool.operationId
        }
      });
    }
    if (!publicOperationNames.has(tool.id)) {
      addFinding(findings, {
        code: "catalog_tool_not_discoverable",
        message: `Catalog tool ${tool.id} is active but absent from MCP capabilities.`,
        evidence: {
          toolId: tool.id,
          operationId: tool.operationId
        }
      });
    }
  }

  for (const operation of SERVER_API_OPERATIONS.filter(isMcpRegistryCandidate)) {
    if (!catalogToolsByOperationId.has(operation.id)) {
      addFinding(findings, {
        code: "registry_only_operation",
        message: `MCP candidate operation ${operation.id} is in SERVER_API_OPERATIONS but has no active catalog projection.`,
        evidence: {
          operationId: operation.id,
          feature: operation.feature || "",
          target: operationTarget(operation).id
        }
      });
    }
  }

  for (const hiddenOperationId of INTERNAL_OPERATION_IDS_HIDDEN_FROM_MCP) {
    if (publicOperationIds.has(hiddenOperationId)) {
      addFinding(findings, {
        code: "hidden_operation_exposed",
        message: `Hidden operation ${hiddenOperationId} is exposed through MCP capabilities.`,
        evidence: { operationId: hiddenOperationId }
      });
    }
  }

  const projections = [];
  for (const publicOperation of capabilities.operations || []) {
    const tool = catalogToolsById.get(publicOperation.name);
    if (!tool) {
      addFinding(findings, {
        code: "public_operation_without_catalog_tool",
        message: `MCP operation ${publicOperation.name} has no matching active catalog tool.`,
        evidence: {
          projectionName: publicOperation.name,
          operationId: publicOperation?._meta?.operationId || ""
        }
      });
      continue;
    }
    const sourceOperation = serverOperationsById.get(tool.operationId);
    const projection = summarizeOperationProjection({
      publicOperation,
      tool,
      sourceOperation,
      toolsetsById
    });
    projections.push(projection);

    if (!sourceOperation) {
      continue;
    }
    if (!projection.outlet) {
      addFinding(findings, {
        code: "missing_outlet",
        message: `MCP operation ${projection.projectionName} has no outlet metadata.`,
        evidence: {
          projectionName: projection.projectionName,
          operationId: projection.operationId
        }
      });
    }
    if (projection.outlet !== mcpOutletForTool(tool)) {
      addFinding(findings, {
        code: "operation_outlet_mismatch",
        message: `MCP operation ${projection.projectionName} outlet metadata does not match adapter routing rules.`,
        evidence: {
          projectionName: projection.projectionName,
          operationId: projection.operationId,
          actualOutlet: projection.outlet,
          expectedOutlet: mcpOutletForTool(tool)
        }
      });
    }
    if (!projection.requiredScopes.length) {
      addFinding(findings, {
        code: "missing_required_scopes",
        message: `MCP operation ${projection.projectionName} has no required scope metadata.`,
        evidence: {
          projectionName: projection.projectionName,
          operationId: projection.operationId
        }
      });
    }
    if (!projection.operationGroups.length) {
      addFinding(findings, {
        code: "missing_operation_group",
        message: `MCP operation ${projection.projectionName} has no operation group/toolset.`,
        evidence: {
          projectionName: projection.projectionName,
          operationId: projection.operationId
        }
      });
    }
    if (!projection.grantableOperationGroups.length) {
      addFinding(findings, {
        code: "operation_without_grantable_group",
        message: `MCP operation ${projection.projectionName} has no grantable operation group.`,
        evidence: {
          projectionName: projection.projectionName,
          operationId: projection.operationId,
          operationGroups: projection.operationGroups
        }
      });
    }
    if (!projection.risk || riskRank(projection.risk) === undefined) {
      addFinding(findings, {
        code: "missing_risk",
        message: `MCP operation ${projection.projectionName} has no valid risk metadata.`,
        evidence: {
          projectionName: projection.projectionName,
          operationId: projection.operationId,
          risk: projection.risk
        }
      });
    }
    if (!projection.executorTarget.method && !projection.executorTarget.handlerId) {
      addFinding(findings, {
        code: "missing_executor",
        message: `MCP operation ${projection.projectionName} has no executor target.`,
        evidence: {
          projectionName: projection.projectionName,
          operationId: projection.operationId
        }
      });
    }
    if (projection.auditPolicy.enabled !== true) {
      addFinding(findings, {
        code: "missing_audit_policy",
        message: `MCP operation ${projection.projectionName} has no enabled audit policy.`,
        evidence: {
          projectionName: projection.projectionName,
          operationId: projection.operationId
        }
      });
    }
    if (projection.schema.hasInputSchema !== true) {
      addFinding(findings, {
        code: "missing_schema",
        message: `MCP operation ${projection.projectionName} has no input schema.`,
        evidence: {
          projectionName: projection.projectionName,
          operationId: projection.operationId
        }
      });
    }
  }

  for (const [outlet, summary] of Object.entries(capabilities.outlets || {})) {
    if (outlet !== MCP_DISCOVERY_TOOL_NAME && Number(summary?.operationCount || 0) === 0) {
      addFinding(findings, {
        code: "mcp_outlet_empty",
        message: `Stable MCP outlet ${outlet} has no concrete operations.`,
        evidence: {
          outlet,
          operationCount: Number(summary?.operationCount || 0)
        }
      });
    }
  }

  return {
    projections: projections.sort((left, right) =>
      String(left.outlet).localeCompare(String(right.outlet)) ||
        String(left.projectionName).localeCompare(String(right.projectionName))
    ),
    findings
  };
}

async function writeReport(reportPath, report) {
  const relativeReportPath = normalizeRelativePath(reportPath);
  const absoluteReportPath = repoPath(relativeReportPath);
  await fs.mkdir(path.dirname(absoluteReportPath), { recursive: true });
  const absolutePathPattern = /(?:^|["\s])(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)/u;
  const secretPattern = /(?:bearer\s+[a-z0-9._-]+|x-lico-tool-token|client_secret|private_key|password)/iu;
  const assertSafe = () => {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (absolutePathPattern.test(text)) {
      throw new Error("Downstream MCP completeness audit report contains a local absolute path.");
    }
    if (secretPattern.test(text)) {
      throw new Error("Downstream MCP completeness audit report contains secret-like material.");
    }
    return text;
  };
  report.summary.reportLeakScan = false;
  assertSafe();
  report.summary.reportLeakScan = true;
  const text = assertSafe();
  if (!report.verifier) {
    throw new Error("Downstream MCP completeness audit report is missing its verifier authority.");
  }
  await fs.writeFile(absoluteReportPath, text);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = createToolCatalog({ operations: SERVER_API_OPERATIONS });
  const capabilities = await callMcpCapabilitiesList({ catalog });
  const { projections, findings } = auditCompleteness({ catalog, capabilities });
  const report = {
    schemaVersion: "v0.0.1:mcp:downstream-completeness-audit-1",
    verifier: "tools/verifiers/downstream-mcp-completeness-audit.mjs",
    generatedAt: new Date().toISOString(),
    source: {
      serverOperationRegistry: "packages/contracts/src/operations/operation-registry.mjs",
      toolCatalog: "packages/capabilities/src/operation-permission-core/catalog.mjs",
      mcpAdapter: "packages/protocols/mcp/adapter/http-mcp-adapter.mjs",
      installerDocs: "packages/protocols/mcp/adapter/native-installer/README.md"
    },
    summary: {
      serverOperationCount: SERVER_API_OPERATIONS.length,
      activeCatalogOperationCount: catalog.tools.filter((tool) => tool.status === "active" && tool.operationId).length,
      publicMcpOperationCount: capabilities.operations.length,
      outletCounts: Object.fromEntries(
        Object.entries(capabilities.outlets || {}).map(([outlet, value]) => [outlet, Number(value?.operationCount || 0)])
      ),
      findingCount: findings.length,
      releaseReady: findings.length === 0
    },
    projections,
    findings
  };

  await writeReport(options.report, report);
  console.log(`[downstream-mcp-completeness-audit] report=${normalizeRelativePath(options.report)}`);
  console.log(`[downstream-mcp-completeness-audit] operations=${report.summary.publicMcpOperationCount} findings=${findings.length} releaseReady=${report.summary.releaseReady}`);
  if (findings.length > 0) {
    for (const finding of findings.slice(0, 12)) {
      console.log(`- ${finding.code}: ${finding.evidence.operationId || finding.evidence.projectionName || finding.evidence.outlet || "see report"}`);
    }
  }
  if (findings.length > 0 && !options.allowOpenGaps) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[downstream-mcp-completeness-audit] ${error.message}`);
  process.exit(1);
});

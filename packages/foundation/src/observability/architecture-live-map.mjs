import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProductionHealthReport } from "./report-reader.mjs";

export const ARCHITECTURE_LIVE_MAP_PROTOCOL_VERSION = "v0.0.1:platform:architecture-live-map-1";

const defaultRepoRoot = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

const ARCHITECTURE_NODES = Object.freeze([
  {
    nodeId: "workspace-asset-governance",
    label: "Workspace Asset Governance",
    docRefs: [
      "docs/architecture/ARCHITECTURE.md",
      "docs/functionality/WORKSPACE-ASSETS.md",
      "docs/protocols/PROTOCOLS.md"
    ],
    implementationPaths: [
      "packages/agents/src/workspace-contribution/index.mjs",
      "packages/agents/src/workspace-governance/index.mjs"
    ],
    gateIds: ["workspace-contribution-governance", "workspace-governance"]
  },
  {
    nodeId: "gateway-governance",
    label: "Gateway Governance",
    docRefs: [
      "docs/architecture/ARCHITECTURE.md",
      "docs/functionality/OPERATION-PERMISSION.md",
      "docs/protocols/PROTOCOLS.md"
    ],
    implementationPaths: [
      "packages/capabilities/src/operation-permission-core/index.mjs",
      "packages/protocols/mcp/adapter/http-mcp-adapter.mjs"
    ],
    gateIds: ["gateway-access", "operation-permission", "approval-workflow"]
  },
  {
    nodeId: "version-control",
    label: "Version Governance",
    docRefs: [
      "docs/architecture/ARCHITECTURE.md",
      "docs/protocols/PROTOCOLS.md"
    ],
    implementationPaths: [
      "packages/foundation/src/version-control/README.md",
      "packages/foundation/src/version-control/version-registry.json",
      "packages/foundation/src/version-control/version-registry.schema.json",
      "packages/foundation/src/version-control/version-scan.mjs",
      "tools/server-scripts/verify-version-registry.mjs",
      "tools/server-scripts/verify-version-naming.mjs"
    ],
    gateIds: ["architecture", "version-registry", "version-naming"]
  },
  {
    nodeId: "production-readiness",
    label: "Production Readiness",
    docRefs: [
            "docs/protocols/PROTOCOLS.md"
    ],
    implementationPaths: [
      "tools/server-scripts/production-readiness-gate.mjs",
      "packages/foundation/src/observability/readiness-baseline/report-reader.mjs",
      "packages/foundation/src/observability/readiness-baseline/executive-report.mjs"
    ],
    gateIds: ["architecture", "executive-report", "traffic-control"]
  }
]);

function text(value) {
  return String(value ?? "").trim();
}

async function pathExists(repoRoot, relativePath) {
  try {
    await fs.access(path.join(repoRoot, relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function gateStatus(gatesById, gateIds = []) {
  const statuses = gateIds.map((gateId) => text(gatesById.get(gateId)?.status || "missing"));
  if (statuses.includes("fail") || statuses.includes("timeout") || statuses.includes("blocked")) return "blocked";
  if (statuses.includes("missing")) return "partial";
  if (statuses.every((status) => status === "pass")) return "pass";
  return statuses[0] || "missing";
}

export async function buildArchitectureLiveMap(options = {}) {
  const repoRoot = options.repoRoot || defaultRepoRoot;
  const productionHealth = options.productionHealth || await buildProductionHealthReport({
    repoRoot,
    reportRoot: options.reportRoot
  });
  const gatesById = new Map((productionHealth.gates || []).map((gate) => [gate.id, gate]));
  const nodes = [];
  for (const node of ARCHITECTURE_NODES) {
    const docRefs = await Promise.all(node.docRefs.map(async (docPath) => ({
      path: docPath,
      exists: await pathExists(repoRoot, docPath)
    })));
    const implementationPaths = await Promise.all(node.implementationPaths.map(async (implPath) => ({
      path: implPath,
      exists: await pathExists(repoRoot, implPath)
    })));
    const gates = node.gateIds.map((gateId) => ({
      gateId,
      status: text(gatesById.get(gateId)?.status || "missing"),
      title: text(gatesById.get(gateId)?.title || gateId),
      nextStep: text(gatesById.get(gateId)?.nextStep || "")
    }));
    const missingDocs = docRefs.filter((item) => !item.exists).map((item) => item.path);
    const missingImplementations = implementationPaths.filter((item) => !item.exists).map((item) => item.path);
    const status = missingDocs.length || missingImplementations.length
      ? "partial"
      : gateStatus(gatesById, node.gateIds);
    nodes.push({
      protocolVersion: ARCHITECTURE_LIVE_MAP_PROTOCOL_VERSION,
      nodeId: node.nodeId,
      label: node.label,
      status,
      docRefs,
      implementationPaths,
      gates,
      missingDocs,
      missingImplementations
    });
  }
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: ARCHITECTURE_LIVE_MAP_PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    productionStatus: text(productionHealth.status || "missing"),
    nodes,
    summary: {
      total: nodes.length,
      pass: nodes.filter((node) => node.status === "pass").length,
      partial: nodes.filter((node) => node.status === "partial").length,
      blocked: nodes.filter((node) => node.status === "blocked").length,
      missingDocs: nodes.reduce((sum, node) => sum + node.missingDocs.length, 0),
      missingImplementations: nodes.reduce((sum, node) => sum + node.missingImplementations.length, 0)
    }
  };
}

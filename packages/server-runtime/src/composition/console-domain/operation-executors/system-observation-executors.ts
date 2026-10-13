
import fs from "node:fs";
import path from "node:path";

import {
  buildConsoleState,
  buildRuntimeInfo
} from "@meshrix/protocols/http/api-facade";
import { buildBootstrapPayload } from "@meshrix/protocols/http/bootstrap-payload";
import { buildProductionHealthReport } from "@meshrix/foundation/observability/report-reader";
import { buildArchitectureLiveMap } from "@meshrix/foundation/observability/architecture-live-map";
import {
  actorFrom,
  errorPayload,
  parseBooleanFlag,
  protocolPayload,
  requireDevopsProvider,
  result
} from "./shared.ts";
import {
  browseServerPath,
  normalizePathBrowserExtensions,
  normalizePathBrowserMode
} from "./path-browser.ts";
import { runCheckpointWorkspaceFileRestore } from "./workspace-runtime-helpers.ts";
import {
  executiveReportProviderFor,
  readinessBaselineProviderFor,
  sampleCapabilityPackStoreFor
} from "./registry-services.ts";

function publicCheckpointError(status: number, code: string, message: string): any {
  return result(status, { ok: false, code, error: message });
}

// --- Relay traffic metrics (system.relay_traffic) ------------------------------
//
// The private relay worker exports `GET /admin/metrics` as Prometheus text
// exposition v0.0.4 (`meshrix_relay_*` counters labeled object/tenant/route/
// device/scope). The console reads it through this operation instead of a
// dedicated monitoring stack: env-configured URL + admin bearer token, a small
// parser, and a bounded in-process ring so the panel can draw recent-history
// sparklines without any TSDB.

const RELAY_TRAFFIC_FETCH_TIMEOUT_MS: any = 8_000;
const RELAY_TRAFFIC_HISTORY_INTERVAL_MS: any = 15_000;
const RELAY_TRAFFIC_HISTORY_LIMIT: any = 240;
const RELAY_TRAFFIC_HISTORY_FILE_NAME: any = "relay-traffic-history.json";
// Ingestion bounds: the exposition endpoint is remote input. The body is
// capped while streaming, and the parser only keeps the bounded
// `meshrix_relay_*` projection instead of materializing an arbitrary
// remote-controlled metric set.
const RELAY_TRAFFIC_MAX_BODY_BYTES: any = 262_144;
const RELAY_TRAFFIC_METRIC_PREFIX: any = "meshrix_relay_";
const RELAY_TRAFFIC_MAX_METRICS: any = 64;
const RELAY_TRAFFIC_MAX_SAMPLES: any = 128;
const RELAY_TRAFFIC_MAX_LABELS: any = 16;
const RELAY_TRAFFIC_MAX_NAME_BYTES: any = 128;
const RELAY_TRAFFIC_MAX_VALUE_BYTES: any = 256;
const RELAY_TRAFFIC_MAX_LINE_BYTES: any = 8_192;
const RELAY_TRAFFIC_HISTORY_MAX_BYTES: any = 1_048_576;
const RELAY_TRAFFIC_HISTORY_SUMS_LIMIT: any = 64;

const relayTrafficHistory: Array<{ t: number; sums: Record<string, number> }> = [];
let relayTrafficHistoryAppendedAt: any = 0;
// The file the ring was last loaded from ("" = not loaded yet). Resolution
// is per-call so the "1" shorthand can follow context.userDataPath.
let relayTrafficHistoryLoadedFrom: any = "";
// History durability truth surfaced in every response: "disabled" (no
// persist target), "durable" (last load/write succeeded) or "degraded"
// (a load or write failed; the in-memory ring still serves but restart
// loses history until a later write succeeds).
const relayTrafficPersistence: { state: string; reason: string } = {
  state: "disabled",
  reason: ""
};

function relayTrafficPersistenceSnapshot() : any {
  return { state: relayTrafficPersistence.state, ...(relayTrafficPersistence.reason ? { reason: relayTrafficPersistence.reason } : {}) };
}

/**
 * `MESHRIX_RELAY_TRAFFIC_PERSIST` selects where the history ring survives:
 * unset → the ring stays in-process only (default); a file path → the ring
 * is written there on every append; the literal `"1"` → the default
 * `<userDataPath>/relay-traffic-history.json` when the caller supplies a
 * userDataPath. An unresolvable value honestly means in-memory only.
 */
function relayTrafficPersistPath(context: any) : any {
  const raw: any = String(process.env.MESHRIX_RELAY_TRAFFIC_PERSIST || "").trim();
  if (!raw) {
    return "";
  }
  if (raw === "1") {
    const userDataPath: any = String(context?.userDataPath || "").trim();
    return userDataPath ? path.join(userDataPath, RELAY_TRAFFIC_HISTORY_FILE_NAME) : "";
  }
  return raw;
}

/**
 * Load a previously persisted ring (validated: entries must be
 * `{t:number, sums:Record<string,number>}`; malformed entries and values are
 * dropped, anything unparseable means starting empty). Runs once per
 * resolved file; the restored last-sample time keeps the append interval
 * honest across restarts.
 */
function loadRelayTrafficHistory(filePath: any) : any {
  if (!filePath || relayTrafficHistoryLoadedFrom === filePath) {
    return;
  }
  relayTrafficHistoryLoadedFrom = filePath;
  let parsed: any = null;
  try {
    // A missing file is a clean start, not degradation; an existing file
    // that cannot be stat/read/parse within the byte budget is reported
    // degraded instead of silently dropping to an empty ring.
    const stat: any = fs.statSync(filePath);
    if (stat.size > RELAY_TRAFFIC_HISTORY_MAX_BYTES) {
      throw new Error("persisted history exceeds the byte limit");
    }
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      relayTrafficPersistence.state = "degraded";
      relayTrafficPersistence.reason = "load_failed";
    }
    return;
  }
  if (!Array.isArray(parsed)) {
    relayTrafficPersistence.state = "degraded";
    relayTrafficPersistence.reason = "load_failed";
    return;
  }
  const restored: any = [];
  // Only the tail can ever be kept; validate that window rather than the
  // whole unbounded file.
  for (const entry of parsed.slice(-RELAY_TRAFFIC_HISTORY_LIMIT)) {
    const t: any = Number(entry?.t);
    const sums: any = entry?.sums;
    if (!Number.isFinite(t) || !sums || typeof sums !== "object" || Array.isArray(sums)) {
      continue;
    }
    const cleanSums: Record<string, number> = {};
    for (const [name, value] of Object.entries(sums).slice(0, RELAY_TRAFFIC_HISTORY_SUMS_LIMIT)) {
      const numeric: any = Number(value);
      if (Number.isFinite(numeric)) {
        cleanSums[name] = numeric;
      }
    }
    restored.push({ t, sums: cleanSums });
  }
  if (!restored.length) {
    return;
  }
  relayTrafficHistory.splice(
    0,
    relayTrafficHistory.length,
    ...restored.slice(-RELAY_TRAFFIC_HISTORY_LIMIT)
  );
  relayTrafficHistoryAppendedAt = restored[restored.length - 1].t;
  relayTrafficPersistence.state = "durable";
  relayTrafficPersistence.reason = "";
}

/**
 * Persist the whole ring (≤240 small entries) via a tmp+rename write so a
 * torn file is never observed. A persistence failure must never break the
 * operation — the in-memory ring keeps serving — but it is surfaced through
 * `persistence.state` so the panel can show "degraded" instead of reporting
 * normal while restart would lose history. A later successful write
 * restores "durable".
 */
function persistRelayTrafficHistory(filePath: any) : any {
  if (!filePath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath: any = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(relayTrafficHistory)}\n`, "utf8");
    fs.renameSync(temporaryPath, filePath);
    relayTrafficPersistence.state = "durable";
    relayTrafficPersistence.reason = "";
  } catch {
    relayTrafficPersistence.state = "degraded";
    relayTrafficPersistence.reason = "write_failed";
  }
}

function parseExpositionLabelSet(source: any) : any {
  const labels: Record<string, string> = {};
  let index = 0;
  const text: any = String(source || "");
  while (index < text.length && Object.keys(labels).length < RELAY_TRAFFIC_MAX_LABELS) {
    const nameStart: any = index;
    while (index < text.length && text[index] !== "=") {
      index += 1;
    }
    const name: any = text.slice(nameStart, index).trim();
    index += 1;
    if (text[index] !== "\"") {
      break;
    }
    index += 1;
    let value = "";
    while (index < text.length && text[index] !== "\"") {
      if (text[index] === "\\") {
        index += 1;
        const escaped: any = text[index];
        value += escaped === "n" ? "\n" : escaped;
        index += 1;
      } else {
        value += text[index];
        index += 1;
      }
    }
    index += 1;
    if (name) {
      labels[name] = value.slice(0, RELAY_TRAFFIC_MAX_VALUE_BYTES);
    }
    while (index < text.length && (text[index] === "," || text[index] === " ")) {
      index += 1;
    }
  }
  return labels;
}

/**
 * Bounded v0.0.4 projection: only `meshrix_relay_*` series are kept, and
 * per-metric/series/label/line limits stop an oversized or hostile
 * exposition from expanding unbounded server memory. Truncation is
 * deterministic — extra lines, series and labels are dropped, never
 * partially parsed into misleading values.
 */
function parseRelayMetricsExposition(body: any) : any {
  const metrics: any = new Map<string, any>();
  const metricFor: any = (name: any) : any => {
    let metric: any = metrics.get(name);
    if (!metric) {
      metric = { name, help: "", type: "", samples: [] };
      metrics.set(name, metric);
    }
    return metric;
  };
  for (const rawLine of String(body || "").split("\n")) {
    if (metrics.size >= RELAY_TRAFFIC_MAX_METRICS) {
      break;
    }
    const line: any = rawLine.trim();
    if (!line || line.length > RELAY_TRAFFIC_MAX_LINE_BYTES) {
      continue;
    }
    if (line.startsWith("#")) {
      const helpMatch: any = /^#\s+HELP\s+(\S+)\s*(.*)$/u.exec(line);
      if (helpMatch && helpMatch[1].startsWith(RELAY_TRAFFIC_METRIC_PREFIX)) {
        metricFor(helpMatch[1]).help = helpMatch[2] || "";
      }
      const typeMatch: any = /^#\s+TYPE\s+(\S+)\s*(\S*)/u.exec(line);
      if (typeMatch && typeMatch[1].startsWith(RELAY_TRAFFIC_METRIC_PREFIX)) {
        metricFor(typeMatch[1]).type = typeMatch[2] || "";
      }
      continue;
    }
    const braceIndex: any = line.indexOf("{");
    let name = "";
    let labelsText = "";
    let rest = "";
    if (braceIndex >= 0) {
      const closeIndex: any = line.lastIndexOf("}");
      if (closeIndex < 0) {
        continue;
      }
      name = line.slice(0, braceIndex);
      labelsText = line.slice(braceIndex + 1, closeIndex);
      rest = line.slice(closeIndex + 1).trim();
    } else {
      const spaceIndex: any = line.search(/\s/u);
      name = spaceIndex < 0 ? line : line.slice(0, spaceIndex);
      rest = spaceIndex < 0 ? "" : line.slice(spaceIndex + 1).trim();
    }
    if (!name.startsWith(RELAY_TRAFFIC_METRIC_PREFIX) || name.length > RELAY_TRAFFIC_MAX_NAME_BYTES) {
      continue;
    }
    const value: any = Number(rest.split(/\s+/u)[0]);
    if (!Number.isFinite(value)) {
      continue;
    }
    const metric: any = metricFor(name);
    if (metric.samples.length >= RELAY_TRAFFIC_MAX_SAMPLES) {
      continue;
    }
    metric.samples.push({
      labels: parseExpositionLabelSet(labelsText),
      value
    });
  }
  return [...metrics.values()];
}

function relayMetricSums(metrics: any = []) : any {
  const sums: Record<string, number> = {};
  for (const metric of metrics) {
    sums[metric.name] = (metric.samples || []).reduce(
      (total: any, sample: any) : any => total + Number(sample?.value || 0),
      0
    );
  }
  return sums;
}

function recordRelayTrafficHistory(sums: any = {}, now: any = Date.now(), persistPath: any = "") : any {
  if (now - relayTrafficHistoryAppendedAt < RELAY_TRAFFIC_HISTORY_INTERVAL_MS) {
    return;
  }
  relayTrafficHistory.push({ t: now, sums: { ...sums } });
  relayTrafficHistoryAppendedAt = now;
  if (relayTrafficHistory.length > RELAY_TRAFFIC_HISTORY_LIMIT) {
    relayTrafficHistory.splice(0, relayTrafficHistory.length - RELAY_TRAFFIC_HISTORY_LIMIT);
  }
  persistRelayTrafficHistory(persistPath);
}

/**
 * Read the exposition body under the byte cap. Streaming bodies abort at
 * the limit; mock/text bodies are measured the same way. Over-limit input
 * fails closed with `metrics_response_invalid`, never a partial parse.
 */
async function readExpositionBody(response: any) : Promise<any> {
  const stream: any = response?.body;
  if (stream && typeof stream.getReader === "function") {
    const reader: any = stream.getReader();
    const chunks: any = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk: any = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value || []);
      total += chunk.length;
      if (total > RELAY_TRAFFIC_MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        return null;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const text: any = await response.text();
  if (Buffer.byteLength(String(text || ""), "utf8") > RELAY_TRAFFIC_MAX_BODY_BYTES) {
    return null;
  }
  return String(text || "");
}

async function loadRelayTrafficMetrics(context: any = {}) : Promise<any> {
  const metricsUrl: any = String(process.env.MESHRIX_RELAY_METRICS_URL || "").trim();
  if (!metricsUrl) {
    return result(200, { configured: false });
  }
  const persistPath: any = relayTrafficPersistPath(context);
  if (!persistPath) {
    relayTrafficPersistence.state = "disabled";
    relayTrafficPersistence.reason = "";
  } else if (relayTrafficPersistence.state === "disabled") {
    // First call with a configured target: durable until proven degraded.
    relayTrafficPersistence.state = "durable";
  }
  loadRelayTrafficHistory(persistPath);
  const persistence: any = () : any => relayTrafficPersistenceSnapshot();
  const adminToken: any = String(process.env.MESHRIX_RELAY_ADMIN_TOKEN || "").trim();
  let response: any = null;
  try {
    response = await fetch(metricsUrl, {
      headers: {
        accept: "text/plain",
        ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {})
      },
      signal: AbortSignal.timeout(RELAY_TRAFFIC_FETCH_TIMEOUT_MS)
    });
  } catch {
    return result(200, {
      configured: true,
      error: "relay_unreachable",
      history: [...relayTrafficHistory],
      persistence: persistence()
    });
  }
  if (!response.ok) {
    return result(200, {
      configured: true,
      error: "relay_unreachable",
      status: Number(response.status || 0),
      history: [...relayTrafficHistory],
      persistence: persistence()
    });
  }
  let body: any = null;
  try {
    body = await readExpositionBody(response);
  } catch {
    body = null;
  }
  if (body === null) {
    return result(200, {
      configured: true,
      error: "metrics_response_invalid",
      history: [...relayTrafficHistory],
      persistence: persistence()
    });
  }
  const metrics: any = parseRelayMetricsExposition(body);
  recordRelayTrafficHistory(relayMetricSums(metrics), Date.now(), persistPath);
  return result(200, {
    configured: true,
    fetchedAt: new Date().toISOString(),
    metrics,
    history: [...relayTrafficHistory],
    persistence: persistence()
  });
}

export async function executeSystemObservationOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  const handledOperations: any = new Set<any>([
    "system.background_processes",
    "system.relay_traffic",
    "system.checkpoint_trees.list",
    "system.checkpoint_trees.get",
    "workspace.checkpoint.tree.list",
    "workspace.checkpoint.node.get",
    "workspace.checkpoint.diff",
    "workspace.checkpoint.restore.preview",
    "workspace.checkpoint.restore",
    "workspace.checkpoint.scope.query"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  if (id === "system.background_processes") {
    const { devopsProvider, error } = requireDevopsProvider(context);
    if (error) {
      return error;
    }
    return result(200, await devopsProvider.getBackgroundProcessStatus({ userDataPath: context.userDataPath }));
  }

  if (id === "system.relay_traffic") {
    return loadRelayTrafficMetrics(context);
  }

  const checkpointTreeApi: any = context.checkpointTreeApi;
  if (!checkpointTreeApi) {
    return publicCheckpointError(503, "checkpoint_tree_unavailable", "工作队列 checkpoint 接口暂不可用。");
  }
  if (id === "system.checkpoint_trees.list" || id === "workspace.checkpoint.tree.list") {
    try {
      const trees: any = await checkpointTreeApi.listCheckpointTrees({
        userDataPath: context.userDataPath,
        ownerId: input.ownerId || input["owner-id"] || input.workspaceId || input["workspace-id"] || input.workspaceRef || input["workspace-ref"] || "",
        kind: input.kind || "",
        limit: Number(input.limit || 100)
      });
      return result(200, {
        schemaVersion: "v0.0.1:schema:definition-1",
        count: trees.length,
        items: trees.map((tree?: any) : any => checkpointTreeApi.checkpointTreeSummary(tree))
      });
    } catch {
      return publicCheckpointError(500, "checkpoint_tree_list_failed", "Checkpoint trees could not be listed.");
    }
  }
  if (id === "system.checkpoint_trees.get" || id === "workspace.checkpoint.node.get") {
    const treeId: any = String(input.treeId || input["tree-id"] || input.id || "").trim();
    let tree: any;
    try {
      tree = await checkpointTreeApi.loadCheckpointTree({
        userDataPath: context.userDataPath,
        treeId
      });
    } catch {
      return publicCheckpointError(500, "checkpoint_tree_load_failed", "The checkpoint tree could not be loaded.");
    }
    if (!tree) {
      return publicCheckpointError(404, "checkpoint_tree_not_found", "The checkpoint tree could not be found.");
    }
    return result(200, tree);
  }
  if (id === "workspace.checkpoint.diff") {
    if (typeof checkpointTreeApi.diffCheckpointTree !== "function") {
      return publicCheckpointError(503, "checkpoint_diff_unavailable", "Checkpoint diff is temporarily unavailable.");
    }
    try {
      return result(200, protocolPayload(await checkpointTreeApi.diffCheckpointTree({
        userDataPath: context.userDataPath,
        treeId: input.treeId || input["tree-id"] || input.id || "",
        fromTreeId: input.fromTreeId || input["from-tree-id"] || "",
        toTreeId: input.toTreeId || input["to-tree-id"] || "",
        fromNodeId: input.fromNodeId || input["from-node-id"] || "",
        toNodeId: input.toNodeId || input["to-node-id"] || ""
      })));
    } catch {
      return publicCheckpointError(404, "checkpoint_diff_failed", "Checkpoint diff could not be completed.");
    }
  }
  if (id === "workspace.checkpoint.scope.query") {
    if (typeof checkpointTreeApi.queryCheckpointScope !== "function") {
      return publicCheckpointError(503, "checkpoint_scope_unavailable", "Checkpoint scope is temporarily unavailable.");
    }
    try {
      return result(200, protocolPayload(await checkpointTreeApi.queryCheckpointScope({
        userDataPath: context.userDataPath,
        treeId: input.treeId || input["tree-id"] || input.id || "",
        nodeId: input.nodeId || input["node-id"] || input.checkpointNodeId || ""
      })));
    } catch {
      return publicCheckpointError(404, "checkpoint_scope_query_failed", "Checkpoint scope could not be queried.");
    }
  }
  if (id === "workspace.checkpoint.restore.preview") {
    if (typeof checkpointTreeApi.previewCheckpointRestore !== "function") {
      return publicCheckpointError(503, "checkpoint_restore_preview_unavailable", "Checkpoint restore preview is temporarily unavailable.");
    }
    try {
      const restorePlan: any = await checkpointTreeApi.previewCheckpointRestore({
        userDataPath: context.userDataPath,
        treeId: input.treeId || input["tree-id"] || input.id || "",
        nodeId: input.nodeId || input["node-id"] || input.checkpointNodeId || "",
        mode: input.mode || "",
        reason: input.reason || ""
      });
      const fileRestore: any = await runCheckpointWorkspaceFileRestore({
        plan: restorePlan,
        input,
        context,
        dryRun: true
      });
      if (fileRestore && fileRestore.payload?.ok !== true) {
        return fileRestore;
      }
      return result(200, protocolPayload({
        ...restorePlan,
        actions: fileRestore
          ? [
              ...restorePlan.actions,
              {
                action: "restore_workspace_files",
                workspaceId: fileRestore.payload.workspaceId,
                dryRun: true
              }
            ]
          : restorePlan.actions,
        workspaceFileRestore: fileRestore?.payload
      }));
    } catch {
      return publicCheckpointError(404, "checkpoint_restore_preview_failed", "Checkpoint restore could not be previewed.");
    }
  }
  if (id === "workspace.checkpoint.restore") {
    if (typeof checkpointTreeApi.restoreCheckpointTree !== "function") {
      return publicCheckpointError(503, "checkpoint_restore_unavailable", "Checkpoint restore is temporarily unavailable.");
    }
    try {
      const restorePlan: any = typeof checkpointTreeApi.previewCheckpointRestore === "function"
        ? await checkpointTreeApi.previewCheckpointRestore({
            userDataPath: context.userDataPath,
            treeId: input.treeId || input["tree-id"] || input.id || "",
            nodeId: input.nodeId || input["node-id"] || input.checkpointNodeId || "",
            mode: input.mode || "",
            reason: input.reason || ""
          })
        : null;
      const fileRestore: any = restorePlan
        ? await runCheckpointWorkspaceFileRestore({
            plan: restorePlan,
            input,
            context,
            dryRun: false
          })
        : null;
      if (fileRestore && fileRestore.payload?.ok !== true) {
        return fileRestore;
      }
      const markerRestore: any = await checkpointTreeApi.restoreCheckpointTree({
        userDataPath: context.userDataPath,
        treeId: input.treeId || input["tree-id"] || input.id || "",
        nodeId: input.nodeId || input["node-id"] || input.checkpointNodeId || "",
        actor: actorFrom(context.authSession, input),
        mode: input.mode || "",
        reason: input.reason || ""
      });
      return result(200, protocolPayload({
        ...markerRestore,
        actions: fileRestore
          ? [
              ...markerRestore.actions,
              {
                action: "restore_workspace_files",
                workspaceId: fileRestore.payload.workspaceId,
                dryRun: false
              }
            ]
          : markerRestore.actions,
        workspaceFileRestore: fileRestore?.payload
      }));
    } catch {
      return publicCheckpointError(404, "checkpoint_restore_failed", "Checkpoint restore could not be completed.");
    }
  }

  return null;
}

export async function executeJobObservationOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  if (id !== "jobs.failed_review") {
    return null;
  }
  const jobWorkflowProvider: any = context.jobWorkflowProvider;
  if (!jobWorkflowProvider || typeof jobWorkflowProvider.listJobs !== "function") {
    return result(503, { error: "任务工作流 provider 不可用。" });
  }
  const jobs: any = await jobWorkflowProvider.listJobs({
    limit: Number(input.limit || 50)
  });
  const failed: any = (jobs.items || []).filter((job?: any) : any => job.status === "failed");
  return result(200, {
    ok: true,
    summary: jobs.summary,
    failedCount: failed.length,
    failedJobs: failed.map((job?: any) : any => ({
      id: job.id,
      stage: job.stage || "",
      error: job.error || "",
      createdAt: job.createdAt || "",
      updatedAt: job.updatedAt || ""
    })),
    suggestions:
      failed.length > 0
        ? [
            "查看失败任务的输入来源与索引流程。",
            "确认存储、队列与模型配置是否可用。",
            "需要重跑时由管理员在任务面板或 CLI 明确触发。"
          ]
        : ["最近任务未发现失败项。"]
  });
}

export async function executeSystemCoreOperation({ operationId, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  if (!["system.health", "system.bootstrap"].includes(id)) {
    return null;
  }

  const discoveryState: any = context.discoveryState || {};
  if (id === "system.health") {
    const integrationSnapshot: any =
      context.integrationTaskSupervisorSnapshot &&
      typeof context.integrationTaskSupervisorSnapshot === "object"
        ? context.integrationTaskSupervisorSnapshot
        : {};
    const integrationSummary: any =
      integrationSnapshot.summary &&
      typeof integrationSnapshot.summary === "object"
        ? integrationSnapshot.summary
        : {};
    const integrationStateCounts: any =
      integrationSummary.stateCounts &&
      typeof integrationSummary.stateCounts === "object"
        ? integrationSummary.stateCounts
        : {};
    return result(200, {
      ok: true,
      serverId: discoveryState.serverId,
      mode: discoveryState.mode,
      activeServiceUrl: discoveryState.activeServiceUrl,
      optionalIntegrations: {
        lifecycleState: String(integrationSnapshot.lifecycleState || "unavailable"),
        acceptingTasks: integrationSnapshot.acceptingTasks === true,
        admittedAdapterCount: Number(integrationSummary.admittedAdapterCount || 0),
        readyAdapterCount: Number(integrationStateCounts.ready || 0),
        degradedAdapterCount: Number(integrationStateCounts.degraded || 0),
        inactiveAdapterCount:
          Number(integrationStateCounts.disabled || 0) +
          Number(integrationStateCounts.unconfigured || 0) +
          Number(integrationStateCounts.invalid || 0)
      }
    });
  }

  return result(200, {
    ...buildBootstrapPayload(discoveryState),
    resolvedAt: new Date().toISOString()
  });
}

export async function executeConsoleStateOperation({ operationId, context }: Record<string, any>) : Promise<any> {
  if (operationId === "readiness.baseline.status") {
    const provider: any = readinessBaselineProviderFor(context);
    return result(200, await provider.status());
  }

  if (operationId === "runtime.info") {
    return result(200, await buildRuntimeInfo({
      userDataPath: context.userDataPath,
      distPath: context.distPath,
      runtime: context.runtime,
      moduleManagement: context.moduleManagement,
      discoveryState: context.discoveryState,
      storageProvider: context.storageProvider,
      serverUrl: context.serverUrl,
      securityPermissions: context.securityPermissions,
      request: context.request,
      features: context.features,
      consoleDomainServices: context.consoleDomainServices
    }));
  }

  if (operationId === "system.console_state") {
    return result(200, await buildConsoleState({
      userDataPath: context.userDataPath,
      distPath: context.distPath,
      runtime: context.runtime,
      moduleManagement: context.moduleManagement,
      discoveryState: context.discoveryState,
      jobWorkflowProvider: context.jobWorkflowProvider,
      storageProvider: context.storageProvider,
      clientRegistryService: context.clientRegistryService,
      serverUrl: context.serverUrl,
      securityPermissions: context.securityPermissions,
      request: context.request,
      features: context.features,
      toolSkillManagementProvider: context.toolSkillManagementProvider,
      consoleDomainServices: context.consoleDomainServices
    }));
  }

  return null;
}

export async function executeSystemInterfaceOperation({ operationId, context }: Record<string, any>) : Promise<any> {
  if (operationId !== "system.interfaces") {
    return null;
  }
  if (context.coreProvider && typeof context.coreProvider.buildSystemInterfaces === "function") {
    return result(200, context.coreProvider.buildSystemInterfaces({
      controllers: typeof context.getControllers === "function" ? context.getControllers() : null,
      features: typeof context.getFeatureEntries === "function" ? context.getFeatureEntries() : null
    }));
  }
  const getFeatureEntries: any = typeof context.getFeatureEntries === "function"
    ? context.getFeatureEntries
    : null;
  const getInterfaceCatalog: any = typeof context.getInterfaceCatalog === "function"
    ? context.getInterfaceCatalog
    : () : any => [];
  return result(200, {
    transport: {
      http: "direct",
      rpc: "POST /api/rpc",
      events: "GET /api/events"
    },
    interfaces: getInterfaceCatalog(),
    features: getFeatureEntries ? getFeatureEntries() : null
  });
}

export async function executeRuntimePathBrowseOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  if (operationId !== "runtime.path_browse") {
    return null;
  }
  const mode: any = normalizePathBrowserMode(input.mode);
  return result(200, await browseServerPath({
    requestedPath: input.path || input.currentPath || "",
    mode,
    extensions: normalizePathBrowserExtensions(input.extensions),
    includeHidden: parseBooleanFlag(input.includeHidden ?? input["include-hidden"], false),
    userDataPath: context.userDataPath,
    distPath: context.distPath
  }));
}

export async function executeProductionReadinessOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  const handledOperations: any = new Set<any>([
    "production.health",
    "architecture.live_map",
    "executive_report.list",
    "executive_report.preview",
    "executive_report.generate",
    "sample_capability_pack.list",
    "sample_capability_pack.get",
    "sample_capability_pack.materialize"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  if (id === "production.health") {
    return result(200, await buildProductionHealthReport({
      userDataPath: context.userDataPath
    }));
  }
  if (id === "architecture.live_map") {
    return result(200, await buildArchitectureLiveMap());
  }

  if (id.startsWith("executive_report.")) {
    try {
      const provider: any = executiveReportProviderFor(context);
      if (id === "executive_report.preview") {
        return result(200, await provider.preview(input));
      }
      if (id === "executive_report.list") {
        return result(200, await provider.list(input));
      }
      if (id === "executive_report.generate") {
        return result(200, await provider.generate(input));
      }
    } catch (error: any) {
      return result(400, errorPayload(error, id === "executive_report.generate"
        ? "Executive report generation failed."
        : "Executive report preview failed."));
    }
  }

  if (id.startsWith("sample_capability_pack.")) {
    const store: any = sampleCapabilityPackStoreFor(context);
    if (id === "sample_capability_pack.list") {
      return result(200, store.list());
    }
    if (id === "sample_capability_pack.get") {
      const pack: any = store.get(input.packId || input["pack-id"] || input.id || "");
      if (!pack) {
        return result(404, { ok: false, error: "Sample capability pack not found." });
      }
      return result(200, pack);
    }
    if (id === "sample_capability_pack.materialize") {
      try {
        return result(200, await store.materialize(input));
      } catch (error: any) {
        return result(400, errorPayload(error, "Sample capability pack materialization failed."));
      }
    }
  }

  return null;
}

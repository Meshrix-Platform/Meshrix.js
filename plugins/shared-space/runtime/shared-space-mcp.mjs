export const SHARED_SPACE_MCP_OUTLET = "meshrix.sharedspace";

export const SHARED_SPACE_MCP_OPERATIONS = Object.freeze([
  "meshrix.sharedspace.localDir.connect",
  "meshrix.sharedspace.localDir.list",
  "meshrix.sharedspace.item.list",
  "meshrix.sharedspace.item.stat",
  "meshrix.sharedspace.file.read",
  "meshrix.sharedspace.file.write",
  "meshrix.sharedspace.directory.create",
  "meshrix.sharedspace.item.delete",
  "meshrix.sharedspace.item.move",
  "meshrix.sharedspace.sync.plan",
  "meshrix.sharedspace.sync.apply",
  "meshrix.sharedspace.snapshot.create",
  "meshrix.sharedspace.sandbox.input.seal",
  "meshrix.sharedspace.sandbox.run",
  "meshrix.sharedspace.sandbox.runOpaque",
  "meshrix.sharedspace.sandbox.cancel",
  "meshrix.sharedspace.sandbox.status",
  "meshrix.sharedspace.output.preview",
  "meshrix.sharedspace.output.approve",
  "meshrix.sharedspace.output.commit",
  "meshrix.sharedspace.output.reject"
]);

const SHARED_SPACE_ACTION_BY_OPERATION_SUFFIX = Object.freeze({
  "localDir.connect": "local-dir-connected",
  "localDir.list": "local-dirs-listed",
  "sync.plan": "sync-planned",
  "sync.apply": "sync-applied",
  "directory.create": "directory-created",
  "file.write": "file-written",
  "file.read": "file-read",
  "item.list": "items-listed",
  "item.stat": "item-statted",
  "item.delete": "item-deleted",
  "item.move": "item-moved",
  "snapshot.create": "snapshot-created",
  "sandbox.input.seal": "sandbox-input-sealed",
  "sandbox.run": "sandbox-run-requested",
  "sandbox.runOpaque": "sandbox-opaque-run-requested",
  "sandbox.cancel": "sandbox-run-cancelled",
  "sandbox.status": "sandbox-status-read",
  "output.preview": "output-previewed",
  "output.approve": "output-approved",
  "output.commit": "output-committed",
  "output.reject": "output-rejected"
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function sharedSpaceExchangeReceiptContract() {
  return deepFreeze({
    schemaVersion: "v0.0.1:mcp:sharedspace-exchange-1",
    locations: [
      "structuredContent.exchange",
      "notifications/lico/operation_reply.params.exchange"
    ],
    actions: [...new Set([...Object.values(SHARED_SPACE_ACTION_BY_OPERATION_SUFFIX), "operation"])],
    fields: [
      "schemaVersion",
      "action",
      "outlet",
      "referencePolicy",
      "workspaceRef",
      "mountRef",
      "path",
      "paths",
      "itemCount",
      "checkpointId",
      "syncReceiptId",
      "snapshotHandle",
      "snapshotDigest",
      "runRef",
      "proposalRef",
      "status",
      "outputDigest",
      "nextOperations"
    ]
  });
}

export const SHARED_SPACE_MCP_OUTLET_DESCRIPTOR = deepFreeze({
  toolName: SHARED_SPACE_MCP_OUTLET,
  title: "Meshrix Shared Space",
  description: "Shared Space outlet/router for operations contributed by the enabled Shared Space plugin. Discover concrete operation ids with meshrix.discovery before calling this outlet.",
  architectureCategory: "Shared Space",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false
  },
  exchangeReceipt: sharedSpaceExchangeReceiptContract()
});

function firstString(values = []) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

export function sharedSpaceExchangeReceipt({ operationId = "", input = {}, payload = {} } = {}) {
  const paths = [
    ...(Array.isArray(payload.paths) ? payload.paths : []),
    ...(Array.isArray(payload.items)
      ? payload.items.map((item) => item?.path || item?.relativePath || "")
      : [])
  ].map((value) => String(value || "")).filter(Boolean).slice(0, 100);
  const suffix = Object.keys(SHARED_SPACE_ACTION_BY_OPERATION_SUFFIX)
    .find((candidate) => operationId.endsWith(candidate));
  const action = SHARED_SPACE_ACTION_BY_OPERATION_SUFFIX[suffix] || "operation";
  return {
    schemaVersion: "v0.0.1:mcp:sharedspace-exchange-1",
    action,
    outlet: SHARED_SPACE_MCP_OUTLET,
    referencePolicy: "use-public-workspace-ref",
    workspaceRef: firstString([
      payload.workspace?.workspaceRef,
      payload.workspaceRef,
      input.workspaceRef,
      input.workspaceId
    ]),
    mountRef: firstString([
      payload.mount?.mountRef,
      payload.file?.mountRef,
      payload.item?.mountRef,
      input.mountRef,
      input.mountId
    ]),
    path: firstString([
      payload.file?.relativePath,
      payload.file?.path,
      payload.relativePath,
      payload.path,
      input.path,
      input.filePath,
      input.targetPath,
      paths[0]
    ]),
    paths,
    itemCount: paths.length,
    checkpointId: firstString([payload.checkpoint?.checkpointId, payload.checkpointId]),
    syncReceiptId: firstString([payload.syncReceipt?.syncReceiptId, payload.syncReceiptId]),
    snapshotHandle: firstString([payload.snapshot?.snapshotHandle, payload.snapshotHandle]),
    snapshotDigest: firstString([payload.snapshot?.snapshotDigest, payload.snapshotDigest]),
    runRef: firstString([payload.run?.runRef, payload.runRef, input.runRef]),
    proposalRef: firstString([payload.proposal?.proposalRef, payload.proposalRef, input.proposalRef]),
    status: firstString([payload.proposal?.status, payload.run?.status, payload.status]),
    outputDigest: firstString([payload.proposal?.outputDigest, payload.outputDigest]),
    nextOperations: [...SHARED_SPACE_MCP_OPERATIONS]
  };
}

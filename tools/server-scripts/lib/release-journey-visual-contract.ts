export const RELEASE_JOURNEY_VISUAL_CAPTURE: Readonly<Record<string, any>> = Object.freeze({
  viewport: Object.freeze({ width: 1440, height: 1000 }),
  deviceScaleFactor: 2,
  pixelWidth: 2880,
  pixelHeight: 2000
});

export const RELEASE_JOURNEY_VISUAL_CHECKPOINTS: readonly any[] = Object.freeze([
  ["console-authenticated", "Authenticated Meshrix.js Workbench", "/"],
  ["console-organization-permissions", "Published organization and permission projection", "/admin/organization-governance"],
  ["console-upstream-basic-config", "Upstream service basic configuration", "/admin/publish-upstream-service"],
  ["console-upstream-operation-config", "Upstream operation configuration", "/admin/publish-upstream-service"],
  ["console-upstream-published", "Published upstream service and runtime health", "/admin/publish-upstream-service"],
  ["console-published-tool", "Published operation in the tool catalog", "/admin/tool-list"],
  ["console-api-key-generated", "Issued organization-scoped API Key record", "/admin/api-key-distribution"],
  ["console-downstream-agent-configured", "Downstream agent configured with the pre-issued API Key", "/admin/api-key-distribution"],
  ["console-operation-approval-pending", "Pending Operation Permission approval", "/approval"],
  ["console-operation-approval-completed", "Completed Operation Permission approval", "/approval"],
  ["console-downstream-mcp-call", "Downstream MCP call in the Console audit", "/admin/tool-stats"]
]);

export const RELEASE_JOURNEY_VISUAL_CHECKPOINT_IDS: readonly any[] = Object.freeze(
  RELEASE_JOURNEY_VISUAL_CHECKPOINTS.map(([id]: any[]) : any => id)
);

const PNG_SIGNATURE_HEX: any = "89504e470d0a1a0a";

export function readPngDimensions(sourceBytes?: any) : any {
  const bytes: any = Buffer.isBuffer(sourceBytes)
    ? sourceBytes
    : sourceBytes instanceof Uint8Array
      ? Buffer.from(sourceBytes)
      : null;
  if (
    bytes === null
    || bytes.byteLength < 24
    || bytes.subarray(0, 8).toString("hex") !== PNG_SIGNATURE_HEX
    || bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    return null;
  }
  const width: any = bytes.readUInt32BE(16);
  const height: any = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return Object.freeze({ width, height });
}

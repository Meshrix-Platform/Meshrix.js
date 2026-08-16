export const PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION: any = "v0.0.1:plugin:console-bridge-1";
export const PLUGIN_CONSOLE_ISOLATION_SANDBOX: any = "allow-scripts";
export const PLUGIN_CONSOLE_ISOLATION_MOUNT_EXPORT: any = "mountPluginConsole";
export const PLUGIN_CONSOLE_ISOLATION_MAX_ASSET_BYTES: any = 4 * 1024 * 1024;
export const PLUGIN_CONSOLE_ISOLATION_MAX_REQUEST_BYTES: any = 1 * 1024 * 1024;
export const PLUGIN_CONSOLE_ISOLATION_MAX_RESPONSE_BYTES: any = 8 * 1024 * 1024;
export const PLUGIN_CONSOLE_ISOLATION_MAX_CONCURRENT_CALLS: any = 4;
export const PLUGIN_CONSOLE_ISOLATION_CALL_TIMEOUT_MS: any = 30_000;

const PLUGIN_ID_PATTERN: any = /^[a-z][a-z0-9-]*$/u;
const CONSOLE_ENTRY_ID_PATTERN: any = /^[a-z][a-zA-Z0-9._-]*$/u;
const TOOL_ID_PATTERN: any = /^[a-z][a-zA-Z0-9._-]*$/u;
const DIGEST_PATTERN: any = /^sha256:[a-f0-9]{64}$/u;

function isolationError(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  return error;
}

function uniqueBoundedIds(value?: any, pattern?: any, label?: any) : any {
  if (!Array.isArray(value)) {
    throw isolationError(
      "PLUGIN_CONSOLE_ISOLATION_VERIFICATION_INVALID",
      `${label} must be an array.`
    );
  }
  const output: any[] = [];
  const seen: any = new Set<any>();
  for (const entry of value) {
    const id: any = String(entry || "").trim();
    if (!pattern.test(id) || seen.has(id)) {
      throw isolationError(
        "PLUGIN_CONSOLE_ISOLATION_VERIFICATION_INVALID",
        `${label} contains an invalid identity.`
      );
    }
    seen.add(id);
    output.push(id);
  }
  return Object.freeze(output);
}

export function registerPluginConsoleIsolationVerification({
  pluginId,
  enabled = false,
  consoleEntryIds = [],
  artifactDigest,
  artifactGeneration,
  ownedToolIds = [],
  toolIdsByEntry = {}
}: Record<string, any> = {}) : any {
  const id: any = String(pluginId || "").trim();
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw isolationError(
      "PLUGIN_CONSOLE_ISOLATION_VERIFICATION_REQUIRED",
      "Plugin Console isolation requires a registered plugin identity."
    );
  }
  if (enabled !== true) {
    throw isolationError(
      "PLUGIN_CONSOLE_ISOLATION_VERIFICATION_REQUIRED",
      "Plugin Console isolation requires an enabled verified plugin."
    );
  }
  const digest: any = String(artifactDigest || "").trim().toLowerCase();
  const generation: any = Number(artifactGeneration);
  if (!DIGEST_PATTERN.test(digest) || !Number.isSafeInteger(generation) || generation < 1) {
    throw isolationError(
      "PLUGIN_CONSOLE_ISOLATION_VERIFICATION_REQUIRED",
      "Plugin Console isolation requires a verified artifact identity."
    );
  }
  const entryIds: any = uniqueBoundedIds(consoleEntryIds, CONSOLE_ENTRY_ID_PATTERN, "Plugin console entries");
  if (entryIds.length === 0) {
    throw isolationError(
      "PLUGIN_CONSOLE_ISOLATION_VERIFICATION_INVALID",
      "Plugin Console isolation verification requires declared console entries."
    );
  }
  const owned: any = new Set<any>(uniqueBoundedIds(ownedToolIds, TOOL_ID_PATTERN, "Plugin-owned tools"));
  if (!toolIdsByEntry || typeof toolIdsByEntry !== "object" || Array.isArray(toolIdsByEntry)) {
    throw isolationError(
      "PLUGIN_CONSOLE_ISOLATION_VERIFICATION_INVALID",
      "Plugin Console isolation tool declarations must be an object."
    );
  }
  const tools: Record<string, any> = {};
  for (const entryId of entryIds) {
    const declared: any = Object.hasOwn(toolIdsByEntry, entryId) ? toolIdsByEntry[entryId] : [];
    const toolIds: any = uniqueBoundedIds(declared, TOOL_ID_PATTERN, `Plugin console entry ${entryId} tools`);
    if (toolIds.some((toolId?: any) : any => !owned.has(toolId))) {
      throw isolationError(
        "PLUGIN_CONSOLE_ISOLATION_TOOL_DENIED",
        "Plugin Console isolation tools must be owned by the same plugin."
      );
    }
    tools[entryId] = toolIds;
  }
  return Object.freeze({
    schemaVersion: PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION,
    pluginId: id,
    enabled: true,
    artifactDigest: digest,
    artifactGeneration: generation,
    sandbox: PLUGIN_CONSOLE_ISOLATION_SANDBOX,
    mountExport: PLUGIN_CONSOLE_ISOLATION_MOUNT_EXPORT,
    consoleEntryIds: entryIds,
    toolIdsByEntry: Object.freeze(tools),
    limits: Object.freeze({
      maxAssetBytes: PLUGIN_CONSOLE_ISOLATION_MAX_ASSET_BYTES,
      maxRequestBytes: PLUGIN_CONSOLE_ISOLATION_MAX_REQUEST_BYTES,
      maxResponseBytes: PLUGIN_CONSOLE_ISOLATION_MAX_RESPONSE_BYTES,
      maxConcurrentCalls: PLUGIN_CONSOLE_ISOLATION_MAX_CONCURRENT_CALLS,
      callTimeoutMs: PLUGIN_CONSOLE_ISOLATION_CALL_TIMEOUT_MS
    })
  });
}

export function admitPluginConsoleIsolationVerification(record?: any, expected: Record<string, any> = {}) : any {
  if (!record || record.schemaVersion !== PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION || record.enabled !== true) {
    throw isolationError(
      "PLUGIN_CONSOLE_ISOLATION_VERIFICATION_REQUIRED",
      "Plugin Console isolation verification is unavailable."
    );
  }
  if (expected.pluginId && expected.pluginId !== record.pluginId) {
    throw isolationError(
      "PLUGIN_CONSOLE_ISOLATION_VERIFICATION_REQUIRED",
      "Plugin Console isolation plugin identity does not match."
    );
  }
  if (expected.artifactDigest && expected.artifactDigest !== record.artifactDigest) {
    throw isolationError(
      "PLUGIN_CONSOLE_ISOLATION_VERIFICATION_REQUIRED",
      "Plugin Console isolation artifact digest does not match."
    );
  }
  if (
    expected.artifactGeneration !== undefined &&
    Number(expected.artifactGeneration) !== record.artifactGeneration
  ) {
    throw isolationError(
      "PLUGIN_CONSOLE_ISOLATION_VERIFICATION_REQUIRED",
      "Plugin Console isolation artifact generation does not match."
    );
  }
  return record;
}

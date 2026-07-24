import { isPluginPackageState } from "./plugin-package-state.mjs";

const REASON_PATTERN = /^PLUGIN_PACKAGE_[A-Z0-9_]+$/u;

export function createPluginPackageReceipt({
  pluginId,
  state,
  reasonCode = null,
  packageDigest = null,
  generation = null,
  acquisitionIdempotencyKey = null,
  activationIdempotencyKey = null,
  recordedAt = new Date().toISOString()
} = {}) {
  if (typeof pluginId !== "string" || pluginId.trim().length === 0) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: receipt pluginId is required");
  }
  if (!isPluginPackageState(state)) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: receipt state is invalid");
  }
  if (reasonCode !== null && reasonCode !== undefined) {
    if (typeof reasonCode !== "string" || !REASON_PATTERN.test(reasonCode)) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: receipt reasonCode is invalid");
    }
  }
  if (typeof recordedAt !== "string" || !Number.isFinite(Date.parse(recordedAt))) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: receipt recordedAt is invalid");
  }
  return Object.freeze({
    schemaVersion: "v0.0.1:meshrix:plugin-package-receipt-1",
    pluginId: pluginId.trim(),
    state,
    reasonCode: reasonCode ?? null,
    packageDigest: packageDigest ?? null,
    generation: generation ?? null,
    acquisitionIdempotencyKey: acquisitionIdempotencyKey ?? null,
    activationIdempotencyKey: activationIdempotencyKey ?? null,
    recordedAt
  });
}

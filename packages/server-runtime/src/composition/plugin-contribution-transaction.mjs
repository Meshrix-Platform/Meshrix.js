/**
 * Publishes or discards one immutable contribution generation.
 * Does not interpret plugin payloads; callers supply a prepared snapshot.
 */
export function beginPluginContributionTransaction({
  pluginId,
  generation,
  packageDigest,
  prepareSnapshot,
  publishSnapshot,
  discardSnapshot = null
} = {}) {
  if (typeof pluginId !== "string" || !pluginId.trim()) {
    throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: contribution transaction requires pluginId");
  }
  if (typeof generation !== "string" || !generation.trim()) {
    throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: contribution transaction requires generation");
  }
  if (typeof prepareSnapshot !== "function" || typeof publishSnapshot !== "function") {
    throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: contribution transaction hooks are required");
  }

  let phase = "open";
  let snapshot = null;

  return Object.freeze({
    id: "PluginContributionTransaction",
    pluginId,
    generation,
    packageDigest: packageDigest ?? null,

    async prepare() {
      if (phase !== "open") {
        throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: contribution transaction already prepared");
      }
      snapshot = await prepareSnapshot({ pluginId, generation, packageDigest });
      if (snapshot === null || snapshot === undefined) {
        throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: contribution snapshot is required");
      }
      // Freeze plain objects when possible; callers may pass already-frozen values.
      if (snapshot && typeof snapshot === "object" && !Object.isFrozen(snapshot)) {
        snapshot = Object.freeze(snapshot);
      }
      phase = "prepared";
      return snapshot;
    },

    async commit() {
      if (phase !== "prepared") {
        throw new Error("PLUGIN_PACKAGE_ACTIVATION_FAILED: contribution transaction is not prepared");
      }
      await publishSnapshot({ pluginId, generation, packageDigest, snapshot });
      phase = "committed";
      return Object.freeze({ pluginId, generation, packageDigest, status: "committed" });
    },

    async rollback() {
      if (phase === "committed" || phase === "discarded") {
        throw new Error("PLUGIN_PACKAGE_ROLLBACK_FAILED: contribution transaction is terminal");
      }
      if (typeof discardSnapshot === "function") {
        await discardSnapshot({ pluginId, generation, packageDigest, snapshot });
      }
      snapshot = null;
      phase = "discarded";
      return Object.freeze({ pluginId, generation, packageDigest, status: "discarded" });
    },

    async discard() {
      return this.rollback();
    }
  });
}

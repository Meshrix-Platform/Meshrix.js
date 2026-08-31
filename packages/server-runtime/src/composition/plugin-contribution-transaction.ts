/**
 * Coordinates one reversible contribution publication until its lifecycle
 * generation is durably active. The prepared participant owns the atomic
 * registry swap and restoration of its preceding generation.
 */
export function beginPluginContributionTransaction({
  pluginId,
  generation,
  packageDigest,
  prepareContribution
}: Record<string, any> = {}) : any {
  if (typeof pluginId !== "string" || !pluginId.trim()) {
    throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: contribution transaction requires pluginId");
  }
  if (typeof generation !== "string" || !generation.trim()) {
    throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: contribution transaction requires generation");
  }
  if (typeof prepareContribution !== "function") {
    throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: contribution transaction preparer is required");
  }

  let phase: any = "open";
  let participant: any = null;

  function assertParticipant(value?: any) : any {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.commit !== "function" ||
      typeof value.rollback !== "function"
    ) {
      throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: contribution transaction participant is invalid");
    }
    return value;
  }

  return Object.freeze({
    id: "PluginContributionTransaction",
    pluginId,
    generation,
    packageDigest: packageDigest ?? null,

    async prepare() : Promise<any> {
      if (phase !== "open") {
        throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: contribution transaction already prepared");
      }
      phase = "preparing";
      try {
        participant = assertParticipant(await prepareContribution({ pluginId, generation, packageDigest }));
      } catch (error: any) {
        phase = "prepare-failed";
        throw error;
      }
      phase = "prepared";
      return Object.freeze({ pluginId, generation, packageDigest, status: "prepared" });
    },

    async commit() : Promise<any> {
      if (phase !== "prepared") {
        throw new Error("PLUGIN_PACKAGE_ACTIVATION_FAILED: contribution transaction is not prepared");
      }
      phase = "committing";
      try {
        await participant.commit();
      } catch (error: any) {
        phase = "commit-failed";
        throw error;
      }
      phase = "published";
      return Object.freeze({ pluginId, generation, packageDigest, status: "published" });
    },

    async rollback() : Promise<any> {
      if (phase === "prepare-failed") {
        phase = "rolled-back";
        return Object.freeze({ pluginId, generation, packageDigest, status: "rolled-back" });
      }
      if (!["prepared", "commit-failed", "published"].includes(phase)) {
        throw new Error("PLUGIN_PACKAGE_ROLLBACK_FAILED: contribution transaction cannot roll back from its current phase");
      }
      phase = "rolling-back";
      try {
        await participant.rollback();
      } catch (error: any) {
        phase = "rollback-failed";
        throw new Error("PLUGIN_PACKAGE_ROLLBACK_FAILED: contribution transaction rollback failed", { cause: error });
      }
      participant = null;
      phase = "rolled-back";
      return Object.freeze({ pluginId, generation, packageDigest, status: "rolled-back" });
    },

    async finalize() : Promise<any> {
      if (phase !== "published") {
        throw new Error("PLUGIN_PACKAGE_ACTIVATION_FAILED: contribution transaction is not published");
      }
      participant = null;
      phase = "finalized";
      return Object.freeze({ pluginId, generation, packageDigest, status: "finalized" });
    }
  });
}

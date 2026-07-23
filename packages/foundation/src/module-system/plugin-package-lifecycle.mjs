import { randomUUID } from "node:crypto";

import { assertPluginPackageSource } from "@lico/contracts/plugins/plugin-package-source";
import { assertPluginPackageTransition } from "@lico/contracts/plugins/plugin-package-state";
import { createPluginPackageReceipt } from "@lico/contracts/plugins/plugin-package-receipt";
import { createPluginPackageAcquisitionPort } from "./plugin-package-acquisition-port.mjs";
import { createPluginPackageCustody } from "./plugin-package-custody.mjs";
import { validatePluginPackageArchive } from "./plugin-package-validator.mjs";

function sanitizeError(error) {
  const message = String(error?.message || error || "PLUGIN_PACKAGE_ACTIVATION_FAILED")
    .replace(/(?:\/Users\/|\/home\/|\/opt\/|\/var\/|\/private\/)[^\s"']+/gu, "<redacted-path>")
    .slice(0, 240);
  return message.startsWith("PLUGIN_PACKAGE_")
    ? message
    : `PLUGIN_PACKAGE_ACTIVATION_FAILED: ${message}`;
}

export function createPluginPackageLifecycle({
  custody,
  acquisitionPort = createPluginPackageAcquisitionPort(),
  contributionTransactionFactory = null,
  trustedPublicKeyIds = null,
  coreContractDigest = null,
  now = () => new Date().toISOString()
} = {}) {
  if (!custody || typeof custody.putVerified !== "function") {
    throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: custody store is required");
  }
  const records = new Map();
  const writers = new Map();

  function getRecord(pluginId) {
    if (!records.has(pluginId)) {
      records.set(pluginId, {
        pluginId,
        state: "declared",
        packageDigest: null,
        generation: null,
        acquisitionIdempotencyKey: null,
        activationIdempotencyKey: null,
        lastReceipt: null,
        stagedConfiguration: null
      });
    }
    return records.get(pluginId);
  }

  async function withFence(pluginId, work) {
    const previous = writers.get(pluginId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    writers.set(pluginId, queued);
    await previous.catch(() => {});
    try {
      return await work();
    } finally {
      release();
      if (writers.get(pluginId) === queued) writers.delete(pluginId);
    }
  }

  function transition(record, to, event) {
    assertPluginPackageTransition(record.state, to, event);
    record.state = to;
  }

  function receipt(record, reasonCode = null) {
    const value = createPluginPackageReceipt({
      pluginId: record.pluginId,
      state: record.state,
      reasonCode,
      packageDigest: record.packageDigest,
      generation: record.generation,
      acquisitionIdempotencyKey: record.acquisitionIdempotencyKey,
      activationIdempotencyKey: record.activationIdempotencyKey,
      recordedAt: now()
    });
    record.lastReceipt = value;
    return value;
  }

  return Object.freeze({
    id: "PluginPackageLifecycle",

    getState(pluginId) {
      return getRecord(pluginId).state;
    },

    getHealth(pluginId) {
      const record = getRecord(pluginId);
      return Object.freeze({
        pluginId,
        state: record.state,
        packageDigest: record.packageDigest,
        generation: record.generation,
        ready: record.state === "active"
      });
    },

    getReceipt(pluginId) {
      return getRecord(pluginId).lastReceipt;
    },

    async acquire({ pluginId, source, acquisitionIdempotencyKey, signal } = {}) {
      return withFence(pluginId, async () => {
        const record = getRecord(pluginId);
        if (
          record.acquisitionIdempotencyKey &&
          acquisitionIdempotencyKey &&
          record.acquisitionIdempotencyKey === acquisitionIdempotencyKey &&
          (record.state === "acquired" || record.state === "verified" || record.state === "staged" || record.state === "active")
        ) {
          return receipt(record);
        }
        try {
          assertPluginPackageSource(source);
          if (record.state !== "acquiring") {
            if (!["declared", "failed", "rolled-back", "disabled"].includes(record.state)) {
              throw new Error(`PLUGIN_PACKAGE_STATE_INVALID: cannot acquire from ${record.state}`);
            }
            transition(record, "acquiring", "acquire");
          }
          record.acquisitionIdempotencyKey = acquisitionIdempotencyKey || randomUUID();
          const acquired = await acquisitionPort.acquire(source, {}, signal);
          await custody.putArchive(acquired.archiveDigest, acquired.bytes);
          record.packageDigest = acquired.archiveDigest;
          transition(record, "acquired", "acquire-complete");
          return receipt(record);
        } catch (error) {
          if (record.state !== "failed") {
            try { transition(record, "failed", "acquire-failed"); } catch { record.state = "failed"; }
          }
          return receipt(record, sanitizeError(error).split(":")[0]);
        }
      });
    },

    async verify({ pluginId, expectedPluginId = null } = {}) {
      return withFence(pluginId, async () => {
        const record = getRecord(pluginId);
        try {
          if (record.state !== "acquired" && record.state !== "verified") {
            throw new Error(`PLUGIN_PACKAGE_STATE_INVALID: cannot verify from ${record.state}`);
          }
          if (!record.packageDigest) {
            throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: no acquired package digest");
          }
          const bytes = await custody.getArchive(record.packageDigest);
          const verified = validatePluginPackageArchive({
            bytes,
            expectedPluginId: expectedPluginId || pluginId,
            coreContractDigest,
            trustedPublicKeyIds,
            sourceKind: "bytes",
            now
          });
          await custody.putVerified(verified);
          record.packageDigest = verified.packageDigest;
          if (record.state !== "verified") transition(record, "verified", "verify");
          return receipt(record);
        } catch (error) {
          if (record.state !== "failed") {
            try { transition(record, "failed", "verify-failed"); } catch { record.state = "failed"; }
          }
          return receipt(record, sanitizeError(error).split(":")[0]);
        }
      });
    },

    async stage({ pluginId, configuration = {} } = {}) {
      return withFence(pluginId, async () => {
        const record = getRecord(pluginId);
        try {
          if (record.state !== "verified") {
            throw new Error(`PLUGIN_PACKAGE_STATE_INVALID: cannot stage from ${record.state}`);
          }
          if (!record.packageDigest) {
            throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: verified package missing");
          }
          // Only verified custody records may stage; refuse unverified digests.
          await custody.getVerified(record.packageDigest);
          if (configuration === null || typeof configuration !== "object" || Array.isArray(configuration)) {
            throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: configuration must be an object");
          }
          // Empty configuration remains empty; never fill defaults.
          record.stagedConfiguration = Object.freeze({ ...configuration });
          record.generation = `gen-${digestShort(record.packageDigest)}-${Date.now().toString(36)}`;
          await custody.setActiveGeneration(pluginId, {
            generation: record.generation,
            packageDigest: record.packageDigest,
            state: "staged"
          });
          transition(record, "staged", "stage");
          return receipt(record);
        } catch (error) {
          if (record.state !== "failed") {
            try { transition(record, "failed", "stage-failed"); } catch { record.state = "failed"; }
          }
          return receipt(record, sanitizeError(error).split(":")[0]);
        }
      });
    },

    async activate({ pluginId, activationIdempotencyKey, commitContribution = null } = {}) {
      return withFence(pluginId, async () => {
        const record = getRecord(pluginId);
        if (
          record.activationIdempotencyKey &&
          activationIdempotencyKey &&
          record.activationIdempotencyKey === activationIdempotencyKey &&
          record.state === "active"
        ) {
          return receipt(record);
        }
        let transaction = null;
        try {
          if (record.state !== "staged") {
            throw new Error(`PLUGIN_PACKAGE_STATE_INVALID: cannot activate from ${record.state}`);
          }
          record.activationIdempotencyKey = activationIdempotencyKey || randomUUID();
          const verified = await custody.getVerified(record.packageDigest);
          if (typeof contributionTransactionFactory === "function") {
            transaction = await contributionTransactionFactory({
              pluginId,
              verifiedPackage: verified,
              generation: record.generation,
              configuration: record.stagedConfiguration || {}
            });
            await transaction.prepare();
          }
          if (typeof commitContribution === "function") {
            await commitContribution({
              pluginId,
              verifiedPackage: verified,
              generation: record.generation,
              configuration: record.stagedConfiguration || {}
            });
          }
          if (transaction) await transaction.commit();
          await custody.setActiveGeneration(pluginId, {
            generation: record.generation,
            packageDigest: record.packageDigest,
            state: "active"
          });
          transition(record, "active", "activate");
          return receipt(record);
        } catch (error) {
          if (transaction) {
            try { await transaction.rollback(); } catch { /* bounded */ }
          }
          if (record.state !== "failed") {
            try { transition(record, "failed", "activate-failed"); } catch { record.state = "failed"; }
          }
          return receipt(record, sanitizeError(error).split(":")[0]);
        }
      });
    },

    async rollback({ pluginId } = {}) {
      return withFence(pluginId, async () => {
        const record = getRecord(pluginId);
        if (record.state !== "rolled-back") {
          transition(record, "rolled-back", "rollback");
        }
        record.generation = null;
        record.stagedConfiguration = null;
        await custody.clearActiveGeneration(pluginId);
        return receipt(record);
      });
    },

    async disable({ pluginId } = {}) {
      return withFence(pluginId, async () => {
        const record = getRecord(pluginId);
        transition(record, "disabled", "disable");
        return receipt(record);
      });
    },

    async uninstall({ pluginId } = {}) {
      return withFence(pluginId, async () => {
        const record = getRecord(pluginId);
        transition(record, "removed", "uninstall");
        record.packageDigest = null;
        record.generation = null;
        record.stagedConfiguration = null;
        await custody.clearActiveGeneration(pluginId);
        return receipt(record);
      });
    },

    async remove({ pluginId } = {}) {
      return this.uninstall({ pluginId });
    },

    async recover({ pluginId } = {}) {
      return withFence(pluginId, async () => {
        const record = getRecord(pluginId);
        const active = await custody.getActiveGeneration(pluginId);
        if (!active?.packageDigest) {
          if (record.state === "staged" || record.state === "acquiring") {
            transition(record, "failed", "recover-discard");
            record.generation = null;
            return receipt(record, "PLUGIN_PACKAGE_RECOVERY_FAILED");
          }
          return receipt(record);
        }
        // Restart recovery restores durable generation state without inventing transitions.
        record.packageDigest = active.packageDigest;
        record.generation = active.generation;
        if (active.state === "active" || active.state === "staged") {
          record.state = active.state;
        }
        return receipt(record);
      });
    }
  });
}

function digestShort(digest) {
  return String(digest || "").replace(/^sha256:/u, "").slice(0, 12);
}

export { createPluginPackageCustody, createPluginPackageAcquisitionPort };

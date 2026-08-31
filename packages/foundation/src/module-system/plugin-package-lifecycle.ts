import { randomUUID } from "node:crypto";

import { assertPluginPackageSource } from "@meshrix/contracts/plugins/plugin-package-source";
import { assertPluginPackageTransition } from "@meshrix/contracts/plugins/plugin-package-state";
import { createPluginPackageReceipt } from "@meshrix/contracts/plugins/plugin-package-receipt";
import { createPluginPackageAcquisitionPort } from "./plugin-package-acquisition-port.ts";
import { createPluginPackageCustody } from "./plugin-package-custody.ts";
import { validatePluginPackageArchive } from "./plugin-package-validator.ts";

function sanitizeError(error?: any) : any {
  const message: any = String(error?.message || error || "PLUGIN_PACKAGE_ACTIVATION_FAILED")
    .replace(/(?:\/Users\/|\/home\/|\/opt\/|\/var\/|\/private\/)[^\s"']+/gu, "<redacted-path>")
    .slice(0, 240);
  return message.startsWith("PLUGIN_PACKAGE_")
    ? message
    : `PLUGIN_PACKAGE_ACTIVATION_FAILED: ${message}`;
}

function assertContributionTransaction(transaction?: any) : any {
  if (
    !transaction ||
    typeof transaction !== "object" ||
    typeof transaction.prepare !== "function" ||
    typeof transaction.commit !== "function" ||
    typeof transaction.rollback !== "function" ||
    typeof transaction.finalize !== "function"
  ) {
    throw new Error("PLUGIN_PACKAGE_TRANSACTION_INVALID: activation requires one complete contribution transaction");
  }
  return transaction;
}

export function createPluginPackageLifecycle({
  custody,
  acquisitionPort = createPluginPackageAcquisitionPort(),
  contributionTransactionFactory = null,
  coreContractDigest = null,
  now = () : any => new Date().toISOString()
}: Record<string, any> = {}) : any {
  if (!custody || typeof custody.putVerified !== "function") {
    throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: custody store is required");
  }
  const records: any = new Map<any, any>();
  const writers: any = new Map<any, any>();

  function getRecord(pluginId?: any) : any {
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

  async function withFence(pluginId?: any, work?: any) : Promise<any> {
    const previous: any = writers.get(pluginId) || Promise.resolve();
    let release: any;
    const gate: any = new Promise((resolve?: any) : any => {
      release = resolve;
    });
    const queued: any = previous.then(() : any => gate);
    writers.set(pluginId, queued);
    await previous.catch(() : any => {});
    try {
      return await work();
    } finally {
      release();
      if (writers.get(pluginId) === queued) writers.delete(pluginId);
    }
  }

  function transition(record?: any, to?: any, event?: any) : any {
    assertPluginPackageTransition(record.state, to, event);
    record.state = to;
  }

  function receipt(record?: any, reasonCode: any = null) : any {
    const value: any = createPluginPackageReceipt({
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

    getState(pluginId?: any) : any {
      return getRecord(pluginId).state;
    },

    getHealth(pluginId?: any) : any {
      const record: any = getRecord(pluginId);
      return Object.freeze({
        pluginId,
        state: record.state,
        packageDigest: record.packageDigest,
        generation: record.generation,
        ready: record.state === "active"
      });
    },

    getReceipt(pluginId?: any) : any {
      return getRecord(pluginId).lastReceipt;
    },

    async acquire({ pluginId, source, acquisitionIdempotencyKey, signal }: Record<string, any> = {}) : Promise<any> {
      return withFence(pluginId, async () : Promise<any> => {
        const record: any = getRecord(pluginId);
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
          const acquired: any = await acquisitionPort.acquire(source, {}, signal);
          await custody.putArchive(acquired.archiveDigest, acquired.bytes);
          record.packageDigest = acquired.archiveDigest;
          transition(record, "acquired", "acquire-complete");
          return receipt(record);
        } catch (error: any) {
          if (record.state !== "failed") {
            try { transition(record, "failed", "acquire-failed"); } catch { record.state = "failed"; }
          }
          return receipt(record, sanitizeError(error).split(":")[0]);
        }
      });
    },

    async verify({ pluginId, expectedPluginId = null }: Record<string, any> = {}) : Promise<any> {
      return withFence(pluginId, async () : Promise<any> => {
        const record: any = getRecord(pluginId);
        try {
          if (record.state !== "acquired" && record.state !== "verified") {
            throw new Error(`PLUGIN_PACKAGE_STATE_INVALID: cannot verify from ${record.state}`);
          }
          if (!record.packageDigest) {
            throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: no acquired package digest");
          }
          const bytes: any = await custody.getArchive(record.packageDigest);
          const verified: any = await validatePluginPackageArchive({
            bytes,
            expectedPluginId: expectedPluginId || pluginId,
            coreContractDigest,
            sourceKind: "bytes",
            now
          });
          await custody.putVerified(verified);
          record.packageDigest = verified.packageDigest;
          if (record.state !== "verified") transition(record, "verified", "verify");
          return receipt(record);
        } catch (error: any) {
          if (record.state !== "failed") {
            try { transition(record, "failed", "verify-failed"); } catch { record.state = "failed"; }
          }
          return receipt(record, sanitizeError(error).split(":")[0]);
        }
      });
    },

    async stage({ pluginId, configuration = {} }: Record<string, any> = {}) : Promise<any> {
      return withFence(pluginId, async () : Promise<any> => {
        const record: any = getRecord(pluginId);
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
        } catch (error: any) {
          if (record.state !== "failed") {
            try { transition(record, "failed", "stage-failed"); } catch { record.state = "failed"; }
          }
          return receipt(record, sanitizeError(error).split(":")[0]);
        }
      });
    },

    async activate({ pluginId, activationIdempotencyKey }: Record<string, any> = {}) : Promise<any> {
      return withFence(pluginId, async () : Promise<any> => {
        const record: any = getRecord(pluginId);
        if (
          record.activationIdempotencyKey &&
          activationIdempotencyKey &&
          record.activationIdempotencyKey === activationIdempotencyKey &&
          record.state === "active"
        ) {
          return receipt(record);
        }
        let transaction: any = null;
        try {
          if (record.state !== "staged") {
            throw new Error(`PLUGIN_PACKAGE_STATE_INVALID: cannot activate from ${record.state}`);
          }
          record.activationIdempotencyKey = activationIdempotencyKey || randomUUID();
          const verified: any = await custody.getVerified(record.packageDigest);
          if (typeof contributionTransactionFactory !== "function") {
            throw new Error("PLUGIN_PACKAGE_TRANSACTION_REQUIRED: activation requires a contribution transaction");
          }
          transaction = assertContributionTransaction(await contributionTransactionFactory({
            pluginId,
            verifiedPackage: verified,
            generation: record.generation,
            packageDigest: record.packageDigest,
            configuration: record.stagedConfiguration || {}
          }));
          await transaction.prepare();
          await transaction.commit();
          await custody.setActiveGeneration(pluginId, {
            generation: record.generation,
            packageDigest: record.packageDigest,
            state: "active"
          });
          transition(record, "active", "activate");
          await transaction.finalize();
          return receipt(record);
        } catch (error: any) {
          let rollbackFailed: any = false;
          if (transaction) {
            try {
              await transaction.rollback();
            } catch {
              rollbackFailed = true;
            }
          }
          if (record.generation && record.packageDigest) {
            try {
              await custody.setActiveGeneration(pluginId, {
                generation: record.generation,
                packageDigest: record.packageDigest,
                state: "staged"
              });
            } catch {
              rollbackFailed = true;
            }
          }
          if (record.state !== "failed") {
            try { transition(record, "failed", "activate-failed"); } catch { record.state = "failed"; }
          }
          return receipt(
            record,
            rollbackFailed ? "PLUGIN_PACKAGE_ROLLBACK_FAILED" : sanitizeError(error).split(":")[0]
          );
        }
      });
    },

    async rollback({ pluginId }: Record<string, any> = {}) : Promise<any> {
      return withFence(pluginId, async () : Promise<any> => {
        const record: any = getRecord(pluginId);
        if (record.state !== "rolled-back") {
          transition(record, "rolled-back", "rollback");
        }
        record.generation = null;
        record.stagedConfiguration = null;
        await custody.clearActiveGeneration(pluginId);
        return receipt(record);
      });
    },

    async disable({ pluginId }: Record<string, any> = {}) : Promise<any> {
      return withFence(pluginId, async () : Promise<any> => {
        const record: any = getRecord(pluginId);
        transition(record, "disabled", "disable");
        return receipt(record);
      });
    },

    async uninstall({ pluginId }: Record<string, any> = {}) : Promise<any> {
      return withFence(pluginId, async () : Promise<any> => {
        const record: any = getRecord(pluginId);
        transition(record, "removed", "uninstall");
        record.packageDigest = null;
        record.generation = null;
        record.stagedConfiguration = null;
        await custody.clearActiveGeneration(pluginId);
        return receipt(record);
      });
    },

    async remove({ pluginId }: Record<string, any> = {}) : Promise<any> {
      return this.uninstall({ pluginId });
    },

    async recover({ pluginId }: Record<string, any> = {}) : Promise<any> {
      return withFence(pluginId, async () : Promise<any> => {
        const record: any = getRecord(pluginId);
        const active: any = await custody.getActiveGeneration(pluginId);
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

function digestShort(digest?: any) : any {
  return String(digest || "").replace(/^sha256:/u, "").slice(0, 12);
}

export { createPluginPackageCustody, createPluginPackageAcquisitionPort };

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { writePrivateFileAtomic } from "../../../foundation/src/storage/private-file-atomic.mjs";

const SCHEMA = "meshrix.plugin-controlled-task-authority/1";
const MAX_TASKS = 4096;

function scope(input = {}) {
  const ownerId = String(input.ownerId || "").trim();
  const ownerGenerationDigest = String(input.ownerGenerationDigest || "").trim();
  const ownerGeneration = Number(input.ownerGeneration);
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !/^[a-f0-9]{64}$/u.test(ownerGenerationDigest) ||
      !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1) {
    throw new TypeError("Plugin controlled execution scope is invalid.");
  }
  return Object.freeze({ ownerId, ownerGenerationDigest, ownerGeneration });
}

function taskRef(value) {
  const result = String(value || "").trim();
  return /^owned-task:[a-f0-9]{40}$/u.test(result) ? result : "";
}

function executionTargets(policy = {}) {
  const targets = new Map();
  for (const entry of Array.isArray(policy.targets) ? policy.targets : []) {
    const targetRef = String(entry?.targetRef || "").trim();
    if (!targetRef || targets.has(targetRef) || !entry?.workloadKind || !entry?.invocation || !entry?.outputs ||
        !entry?.capabilities || !entry?.resources) throw new TypeError("Plugin controlled execution policy is invalid.");
    targets.set(targetRef, Object.freeze(JSON.parse(JSON.stringify(entry))));
  }
  return targets;
}

function lifecycleAuthority(input = {}) {
  const port = input.lifecycleStatePort;
  if (port?.id !== "PluginLifecycleStatePort" || typeof port.readRecord !== "function" ||
      typeof port.runExclusive !== "function") {
    throw new TypeError("Plugin controlled execution lifecycle authority is invalid.");
  }
  return port;
}

async function admitActive(port, owner, task) {
  return port.runExclusive(async () => {
    const ledger = await port.readRecord("ledger");
    if (!ledger || ledger.pluginId !== owner.ownerId || ledger.state !== "active" || ledger.generation !== owner.ownerGeneration) {
      const error = new Error("Plugin controlled execution owner generation is not active.");
      error.code = "plugin_controlled_execution_owner_retired";
      throw error;
    }
    return task();
  });
}

function validRecord(record) {
  return record && Object.keys(record).length === 6 && taskRef(record.taskRef) &&
    /^[a-z0-9][a-z0-9-]{0,127}$/u.test(record.ownerId) && /^[a-f0-9]{64}$/u.test(record.ownerGenerationDigest) &&
    Number.isSafeInteger(record.ownerGeneration) && record.ownerGeneration > 0 &&
    typeof record.idempotencyKey === "string" && record.idempotencyKey.length > 0 && record.idempotencyKey.length <= 256 &&
    ["active", "terminal"].includes(record.status);
}

export function createPluginControlledExecutionAuthority({ userDataPath, invocationAuthorizationAuthority = null } = {}) {
  const statePath = path.join(path.resolve(String(userDataPath || "")), "runtime", "plugin-controlled-tasks.json");
  let broker = null;
  let records = null;
  let mutationTail = Promise.resolve();
  let closed = false;

  async function load() {
    if (records) return;
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
      if (parsed?.schemaVersion !== SCHEMA || !Array.isArray(parsed.records) || parsed.records.length > MAX_TASKS ||
          parsed.records.some((record) => !validRecord(record))) throw new Error("invalid");
      records = parsed.records;
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error("Plugin controlled task authority state is invalid.");
      records = [];
    }
  }

  function mutate(task) {
    const current = mutationTail.catch(() => {}).then(async () => {
      await load();
      const result = await task();
      await writePrivateFileAtomic(statePath, `${JSON.stringify({ schemaVersion: SCHEMA, records })}\n`);
      return result;
    });
    mutationTail = current;
    return current;
  }

  async function registerTask(owner, request) {
    const ref = taskRef(request.ownerTaskRef);
    const idempotencyKey = String(request.idempotencyKey || "").trim();
    if (!ref || !idempotencyKey || idempotencyKey.length > 256) throw new TypeError("Plugin controlled task claim is invalid.");
    return mutate(() => {
      const existing = records.find((record) => record.taskRef === ref);
      if (existing && (existing.ownerId !== owner.ownerId || existing.ownerGenerationDigest !== owner.ownerGenerationDigest ||
          existing.idempotencyKey !== idempotencyKey)) throw new Error("Plugin controlled task claim conflicts with an existing owner.");
      if (existing?.status === "terminal") throw new Error("Plugin controlled task is terminal.");
      if (!existing) {
        if (records.length >= MAX_TASKS) {
          const index = records.findIndex((record) => record.status === "terminal");
          if (index < 0) throw new Error("Plugin controlled task authority capacity is exhausted.");
          records.splice(index, 1);
        }
        records.push({ taskRef: ref, ...owner, idempotencyKey, status: "active" });
      }
      return ref;
    });
  }

  async function cancelTask(owner, ref) {
    const normalized = taskRef(ref);
    await mutationTail.catch(() => {});
    await load();
    const record = records.find((entry) => entry.taskRef === normalized);
    if (!record || record.ownerId !== owner.ownerId || record.ownerGenerationDigest !== owner.ownerGenerationDigest) {
      const error = new Error("Plugin controlled task does not belong to this owner generation.");
      error.code = "plugin_controlled_task_owner_mismatch";
      throw error;
    }
    if (record.status === "terminal") return true;
    if (!broker) throw new Error("Plugin controlled execution provider is unavailable.");
    const cancelled = await broker.cancel(record.idempotencyKey, { pluginId: owner.ownerId });
    if (cancelled !== false) {
      await mutate(() => {
        const current = records.find((entry) => entry.taskRef === normalized);
        if (current) current.status = "terminal";
      });
    }
    return cancelled !== false;
  }

  async function markTerminal(owner, ref) {
    await mutate(() => {
      const record = records.find((entry) => entry.taskRef === ref);
      if (record && record.ownerId === owner.ownerId && record.ownerGenerationDigest === owner.ownerGenerationDigest) {
        record.status = "terminal";
      }
    });
  }

  return Object.freeze({
    id: "PluginControlledExecutionAuthority",
    bind(next) {
      if (closed || broker || !next || typeof next.executeConfigured !== "function" || typeof next.cancel !== "function") {
        throw new TypeError("Plugin controlled execution authority cannot be bound.");
      }
      broker = next;
    },
    forOwner(input = {}) {
      const owner = scope(input);
      const targets = executionTargets(input.executionPolicy);
      const lifecycleStatePort = lifecycleAuthority(input);
      if (invocationAuthorizationAuthority?.id !== "PluginInvocationAuthorizationAuthority") {
        throw new TypeError("Plugin invocation authorization authority is unavailable.");
      }
      invocationAuthorizationAuthority.registerOwner({ ...owner, lifecycleStatePort });
      const outputHandles = new Set();
      return Object.freeze({
        id: "ControlledExecutionHostPort",
        ownerGenerationDigest: owner.ownerGenerationDigest,
        ownerGeneration: owner.ownerGeneration,
        async executeTarget(request, inputProvider, options = {}) {
          return admitActive(lifecycleStatePort, owner, async () => {
            if (!broker) throw new Error("Plugin controlled execution provider is unavailable.");
            const target = targets.get(String(request.targetRef || "").trim());
            if (!target) {
              const error = new Error("Plugin controlled execution target is not authorized.");
              error.code = "plugin_controlled_execution_target_denied";
              throw error;
            }
            const claims = await invocationAuthorizationAuthority.verify(request.invocationAuthorization, {
              ...owner,
              audience: "controlled-execution",
              operationId: request.invocationOperationId,
              targetRef: request.targetRef
            });
            await registerTask(owner, request);
            try {
              const result = await broker.executeConfigured({
                schemaVersion: request.schemaVersion,
                workloadKind: target.workloadKind,
                principal: claims.principal,
                invocation: target.invocation,
                inputs: [{ handle: request.ownerTaskRef, digest: request.inputDigest, readOnly: true }],
                outputs: target.outputs,
                capabilities: target.capabilities,
                resources: target.resources,
                governance: claims.governance,
                idempotencyKey: request.idempotencyKey,
                deadlineAt: request.deadlineAt
              }, inputProvider, {
                pluginId: owner.ownerId,
                ownerGenerationDigest: owner.ownerGenerationDigest,
                signal: options.signal,
                currentGovernance: claims.governance
              });
              const outputHandle = String(result?.outputHandle || "").trim();
              if (outputHandle && outputHandle.length <= 512) outputHandles.add(outputHandle);
              return result;
            } finally {
              await markTerminal(owner, request.ownerTaskRef);
            }
          });
        },
        cancelTask: (ref) => cancelTask(owner, ref),
        async verifyNoActiveTasks() {
          await mutationTail.catch(() => {});
          await load();
          const remainingCount = records.filter((record) => record.ownerId === owner.ownerId &&
            record.ownerGenerationDigest === owner.ownerGenerationDigest && record.status === "active").length;
          return Object.freeze({ ok: remainingCount === 0, remainingCount });
        },
        resolveQuarantinedOutput(handle) {
          const normalized = String(handle || "").trim();
          if (!outputHandles.has(normalized)) return null;
          return broker?.resolveQuarantinedOutput(normalized, { pluginId: owner.ownerId });
        },
        async disposeOutput(handle, disposition) {
          const normalized = String(handle || "").trim();
          if (!outputHandles.has(normalized)) return false;
          const disposed = await broker?.disposeOutput(normalized, disposition, {
            pluginId: owner.ownerId,
            owningOperationReceiptDigest: createHash("sha256").update(JSON.stringify({
              ownerId: owner.ownerId,
              ownerGenerationDigest: owner.ownerGenerationDigest,
              outputHandle: normalized,
              disposition: String(disposition || "")
            })).digest("hex")
          });
          if (disposed === true) outputHandles.delete(normalized);
          return disposed === true;
        }
      });
    },
    close() {
      closed = true;
      broker = null;
      records = null;
    }
  });
}

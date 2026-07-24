import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createLocalCustodyKeyBroker } from "../execution-sandbox/custody-key-broker.mjs";

const AUTHORITY_ID = "PluginProtectedRecoveryAuthority";
const PORT_ID = "ProtectedRecoveryPort";
const ALGORITHM = "aes-256-gcm";
const MAX_RECOVERY_MS = 5 * 60 * 1000;
const RECORD_FIELDS = new Set([
  "schemaVersion", "recoveryRef", "purpose", "bindingDigest", "expiresAt",
  "ownerId", "ownerGenerationDigest", "algorithm", "nonce", "ciphertext", "tag", "wrappedKey"
]);

function recoveryError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateBinding(request = {}, { requireValue = false } = {}) {
  const purpose = String(request.purpose || "").trim();
  const bindingDigest = String(request.bindingDigest || "").trim();
  const ownerId = String(request.ownerId || "").trim();
  const ownerGenerationDigest = String(request.ownerGenerationDigest || "").trim();
  if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(purpose) || !/^[a-f0-9]{64}$/u.test(bindingDigest) ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !/^[a-f0-9]{64}$/u.test(ownerGenerationDigest) ||
      (requireValue && (!request.value || typeof request.value !== "object"))) {
    throw recoveryError("protected_recovery_invalid_request", "Protected recovery scope or binding is invalid.");
  }
  return { purpose, bindingDigest, ownerId, ownerGenerationDigest };
}

function validateOwnerScope(request = {}) {
  const ownerId = String(request.ownerId || "").trim();
  const ownerGenerationDigest = String(request.ownerGenerationDigest || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !/^[a-f0-9]{64}$/u.test(ownerGenerationDigest)) {
    throw recoveryError("protected_recovery_invalid_request", "Protected recovery owner scope is invalid.");
  }
  return { ownerId, ownerGenerationDigest };
}

function validateAuthorityScope(request = {}) {
  const scope = validateOwnerScope(request);
  const ownerGeneration = Number(request.ownerGeneration);
  if (!Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1) {
    throw recoveryError("protected_recovery_invalid_request", "Protected recovery owner generation is invalid.");
  }
  return { ...scope, ownerGeneration };
}

function lifecycleAuthority(input = {}) {
  const port = input.lifecycleStatePort;
  if (port?.id !== "PluginLifecycleStatePort" || typeof port.readRecord !== "function" ||
      typeof port.runExclusive !== "function") {
    throw recoveryError("protected_recovery_invalid_request", "Protected recovery lifecycle authority is invalid.");
  }
  return port;
}

async function admitActive(port, scope, task) {
  return port.runExclusive(async () => {
    const ledger = await port.readRecord("ledger");
    if (!ledger || ledger.pluginId !== scope.ownerId || ledger.state !== "active" || ledger.generation !== scope.ownerGeneration) {
      throw recoveryError("protected_recovery_owner_retired", "Protected recovery owner generation is not active.");
    }
    return task();
  });
}

function recordName(recoveryRef) {
  if (!/^recovery_[0-9a-f-]{36}$/u.test(recoveryRef)) {
    throw recoveryError("protected_recovery_invalid_reference", "Protected recovery reference is invalid.");
  }
  return `${crypto.createHash("sha256").update(recoveryRef).digest("hex")}.json`;
}

function aad(record) {
  return Buffer.from(JSON.stringify({
    schemaVersion: record.schemaVersion,
    recoveryRef: record.recoveryRef,
    purpose: record.purpose,
    bindingDigest: record.bindingDigest,
    ownerId: record.ownerId,
    ownerGenerationDigest: record.ownerGenerationDigest,
    expiresAt: record.expiresAt
  }), "utf8");
}

async function atomicWrite(directory, fileName, data) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporary = path.join(directory, `.write-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, path.join(directory, fileName));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function createPluginProtectedRecoveryAuthority({
  userDataPath,
  now = () => new Date(),
  maxRecords = 1024,
  maxBytes = 16 * 1024 * 1024
} = {}) {
  if (!String(userDataPath || "").trim()) throw new TypeError("Protected recovery requires userDataPath.");
  const directory = path.join(path.resolve(userDataPath), "security", "protected-recovery");
  const keyBroker = createLocalCustodyKeyBroker({ userDataPath });
  let closed = false;
  let mutationTail = Promise.resolve();
  const recordLimit = Math.max(1, Math.floor(Number(maxRecords) || 0));
  const byteLimit = Math.max(4096, Math.floor(Number(maxBytes) || 0));

  function ensureOpen() {
    if (closed) throw recoveryError("protected_recovery_closed", "Protected recovery is closed.");
  }

  async function remove(recoveryRef) {
    const target = path.join(directory, recordName(String(recoveryRef || "")));
    try {
      await fs.rm(target);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw recoveryError("protected_recovery_storage_failed", "Protected recovery storage did not complete.");
    }
  }

  function serialize(task) {
    const current = mutationTail.catch(() => {}).then(task);
    mutationTail = current;
    return current;
  }

  async function sweepExpired() {
    let names;
    try {
      names = (await fs.readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
    } catch (error) {
      if (error?.code === "ENOENT") return { records: 0, bytes: 0, removed: 0 };
      throw recoveryError("protected_recovery_storage_failed", "Protected recovery storage did not complete.");
    }
    let records = 0;
    let bytes = 0;
    let removed = 0;
    const nowMs = now().getTime();
    for (const name of names) {
      const target = path.join(directory, name);
      try {
        const serialized = await fs.readFile(target, "utf8");
        const record = JSON.parse(serialized);
        if (!Number.isFinite(Date.parse(record.expiresAt || "")) || Date.parse(record.expiresAt) <= nowMs) {
          await fs.rm(target, { force: true });
          removed += 1;
          continue;
        }
        records += 1;
        bytes += Buffer.byteLength(serialized, "utf8");
      } catch {
        await fs.rm(target, { force: true }).catch(() => {});
        removed += 1;
      }
    }
    return { records, bytes, removed };
  }

  const raw = Object.freeze({
    async seal(request = {}) {
      ensureOpen();
      return serialize(async () => {
        const binding = validateBinding(request, { requireValue: true });
        const nowMs = now().getTime();
        const expiresMs = Date.parse(String(request.expiresAt || ""));
        if (!Number.isFinite(expiresMs) || expiresMs <= nowMs || expiresMs - nowMs > MAX_RECOVERY_MS) {
          throw recoveryError("protected_recovery_expiry_invalid", "Protected recovery expiry is invalid.");
        }
        const usage = await sweepExpired();
        const recoveryRef = `recovery_${crypto.randomUUID()}`;
        const base = {
          schemaVersion: "v0.0.1:meshrix:protected-recovery-1",
          recoveryRef,
          ...binding,
          expiresAt: new Date(expiresMs).toISOString()
        };
        const dataKey = crypto.randomBytes(32);
        try {
          const nonce = crypto.randomBytes(12);
          const cipher = crypto.createCipheriv(ALGORITHM, dataKey, nonce);
          cipher.setAAD(aad(base));
          const ciphertext = Buffer.concat([cipher.update(JSON.stringify(request.value), "utf8"), cipher.final()]);
          const record = {
            ...base,
            algorithm: ALGORITHM,
            nonce: nonce.toString("base64"),
            ciphertext: ciphertext.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            wrappedKey: await keyBroker.wrapKey(dataKey, recoveryRef)
          };
          const serialized = `${JSON.stringify(record)}\n`;
          if (usage.records >= recordLimit || usage.bytes + Buffer.byteLength(serialized, "utf8") > byteLimit) {
            throw recoveryError("protected_recovery_capacity_exceeded", "Protected recovery capacity is full.");
          }
          await atomicWrite(directory, recordName(recoveryRef), serialized);
          return Object.freeze({ recoveryRef });
        } finally {
          dataKey.fill(0);
        }
      });
    },
    async recover(request = {}) {
      ensureOpen();
      const binding = validateBinding(request);
      const recoveryRef = String(request.recoveryRef || "").trim();
      let record;
      try {
        record = JSON.parse(await fs.readFile(path.join(directory, recordName(recoveryRef)), "utf8"));
      } catch {
        throw recoveryError("protected_recovery_unavailable", "Protected recovery reference is unavailable.");
      }
      if (!record || typeof record !== "object" || Array.isArray(record) ||
          Object.keys(record).some((field) => !RECORD_FIELDS.has(field)) ||
          Object.keys(record).length !== RECORD_FIELDS.size || record.recoveryRef !== recoveryRef ||
          record.purpose !== binding.purpose || record.bindingDigest !== binding.bindingDigest ||
          record.ownerId !== binding.ownerId || record.ownerGenerationDigest !== binding.ownerGenerationDigest ||
          record.algorithm !== ALGORITHM) {
        throw recoveryError("protected_recovery_binding_invalid", "Protected recovery binding is invalid.");
      }
      if (Date.parse(record.expiresAt || "") <= now().getTime()) {
        await remove(recoveryRef);
        throw recoveryError("protected_recovery_expired", "Protected recovery reference expired.");
      }
      const dataKey = await keyBroker.unwrapKey(record.wrappedKey, recoveryRef);
      try {
        const decipher = crypto.createDecipheriv(ALGORITHM, dataKey, Buffer.from(record.nonce, "base64"));
        decipher.setAAD(aad(record));
        decipher.setAuthTag(Buffer.from(record.tag, "base64"));
        const value = JSON.parse(Buffer.concat([
          decipher.update(Buffer.from(record.ciphertext, "base64")),
          decipher.final()
        ]).toString("utf8"));
        return Object.freeze({ value });
      } catch {
        throw recoveryError("protected_recovery_authentication_failed", "Protected recovery authentication failed.");
      } finally {
        dataKey.fill(0);
      }
    },
    async delete(request = {}) {
      ensureOpen();
      const owner = validateOwnerScope(request);
      const recoveryRef = String(request.recoveryRef || "").trim();
      return serialize(async () => {
        let record;
        try {
          record = JSON.parse(await fs.readFile(path.join(directory, recordName(recoveryRef)), "utf8"));
        } catch (error) {
          if (error?.code === "ENOENT") return Object.freeze({ deleted: false });
          throw recoveryError("protected_recovery_storage_failed", "Protected recovery storage did not complete.");
        }
        if (record.ownerId !== owner.ownerId || record.ownerGenerationDigest !== owner.ownerGenerationDigest) {
          throw recoveryError("protected_recovery_binding_invalid", "Protected recovery binding is invalid.");
        }
        return Object.freeze({ deleted: await remove(recoveryRef) });
      });
    },
    async sweep() {
      ensureOpen();
      return serialize(async () => Object.freeze(await sweepExpired()));
    },
    async close() {
      if (closed) return Object.freeze({ ok: true, alreadyClosed: true });
      await serialize(() => sweepExpired());
      closed = true;
      await keyBroker.close();
      return Object.freeze({ ok: true, alreadyClosed: false });
    }
  });
  return Object.freeze({
    id: AUTHORITY_ID,
    forOwner({ ownerId, ownerGenerationDigest, ownerGeneration, lifecycleStatePort } = {}) {
      const scope = validateAuthorityScope({ ownerId, ownerGenerationDigest, ownerGeneration });
      const lifecycle = lifecycleAuthority({ lifecycleStatePort });
      const bind = (request = {}) => ({ ...request, ownerId: scope.ownerId, ownerGenerationDigest: scope.ownerGenerationDigest });
      return Object.freeze({
        id: PORT_ID,
        ownerGenerationDigest: scope.ownerGenerationDigest,
        ownerGeneration: scope.ownerGeneration,
        seal: (request) => admitActive(lifecycle, scope, () => raw.seal(bind(request))),
        recover: (request) => admitActive(lifecycle, scope, () => raw.recover(bind(request))),
        delete: (request) => raw.delete(bind(request))
      });
    },
    sweep: () => raw.sweep(),
    close: () => raw.close()
  });
}

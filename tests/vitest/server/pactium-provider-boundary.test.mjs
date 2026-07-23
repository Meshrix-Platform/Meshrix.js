import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  PACTIUM_PROTOCOL,
  PACTIUM_SCHEMA_VERSION,
  createStoragePort
} from "pactium";
import { describe, expect, it } from "vitest";
import { createDataStructureSubstrate } from "#lico/foundation/checkpoint/tree/data-structure-substrate";
import {
  createLicoPactiumRuntime,
  PACTIUM_MANIFEST_FILE
} from "#lico/foundation/checkpoint/tree/pactium-substrate-preflight";
import {
  checkpointTreeId,
  loadCheckpointTree,
  queryCheckpointScope,
  startCheckpointTree
} from "#lico/foundation/checkpoint/tree/checkpoint-tree-projection";
import { createOperationProofSubstrate } from "#lico/foundation/proof/proof-substrate/index";
import { serverToken } from "#lico/client-strings";

const execFileAsync = promisify(execFile);

async function withTempDataDir(testCase) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-pactium-boundary-"));
  try {
    return await testCase(userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function restoreEnvironmentValue(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function descriptorsUnder(directoryPath) {
  const normalizedDirectory = await fs.realpath(directoryPath).catch(() => path.resolve(directoryPath));
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("lsof", ["-Fn", "-p", String(process.pid)], {
        encoding: "utf8"
      });
      return stdout.split("\n")
        .filter((line) => line.startsWith("n"))
        .map((line) => line.slice(1))
        .filter((target) => target.startsWith(`${normalizedDirectory}${path.sep}`))
        .length;
    } catch {
      return null;
    }
  }
  if (process.platform !== "linux") return null;
  let names = null;
  try {
    names = await fs.readdir("/proc/self/fd");
  } catch {
    return null;
  }
  let count = 0;
  for (const name of names) {
    try {
      const target = await fs.readlink(path.join("/proc/self/fd", name));
      if (path.resolve(target).startsWith(`${normalizedDirectory}${path.sep}`)) count += 1;
    } catch {
      // Descriptors can close between directory enumeration and readlink.
    }
  }
  return count;
}

describe("Pactium provider boundary", () => {
  it("uses Pactium behind LicoMesh facades without changing checkpoint ids or data dir", async () => {
    await withTempDataDir(async (userDataPath) => {
      const provider = createDataStructureSubstrate({ userDataPath });
      let proofSubstrate = null;
      try {
      const treeId = checkpointTreeId("workflow", "alpha");
      expect(provider.provider).toBe("pactium");
      expect(provider.providerProtocolVersion).toMatch(/pactium/);
      expect(provider.merkleStateSubstrate.dataDir).toBe(path.resolve(userDataPath));
      expect(treeId).toBe(serverToken("checkpoint_tree", "workflow", "alpha"));

      const started = await startCheckpointTree({
        userDataPath,
        treeId,
        kind: "workflow",
        ownerId: "owner-a",
        rootNodeId: "root",
        rootLabel: "Root"
      });
      expect(started).toMatchObject({ treeId, ownerId: "owner-a" });
      await expect(fs.stat(path.join(userDataPath, PACTIUM_MANIFEST_FILE))).resolves.toBeTruthy();
      const manifest = JSON.parse(await fs.readFile(path.join(userDataPath, PACTIUM_MANIFEST_FILE), "utf8"));
      expect(manifest).toMatchObject({
        protocol: PACTIUM_PROTOCOL,
        schema: PACTIUM_SCHEMA_VERSION,
        latestSchemaOnly: true
      });
      proofSubstrate = createOperationProofSubstrate({ userDataPath });
      expect(proofSubstrate.dataDir).toBe(path.resolve(userDataPath));
      const headBeforeLifecycle = await proofSubstrate.pactiumRuntime.core.readLedgerHead();
      const entry = await proofSubstrate.beginLifecycle({
        operationId: "workspace.test",
        workspaceId: "workspace-a",
        input: {
          privateMarker: "intent-private-marker",
          timeoutMs: Number.MAX_SAFE_INTEGER + 100,
          temperature: 0.25,
          tokenBudget: 123n
        }
      });
      expect(entry.protocol).toBe(PACTIUM_PROTOCOL);
      expect(entry.pactium.intentId).toMatch(/^operation_intent_/);
      expect(entry.inputDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(entry).not.toHaveProperty("input");
      const completed = await proofSubstrate.finishLifecycle({
        entry,
        status: "succeeded",
        output: { privateMarker: "outcome-private-marker" }
      });
      expect(completed.status).toBe("succeeded");
      const head = await proofSubstrate.pactiumRuntime.core.readLedgerHead();
      expect(head.size - headBeforeLifecycle.size).toBe(2);
      for (let index = headBeforeLifecycle.size; index < head.size; index += 1) {
        const serialized = JSON.stringify(
          await proofSubstrate.pactiumRuntime.core.readLedgerLeaf(index)
        );
        expect(serialized).not.toContain("intent-private-marker");
        expect(serialized).not.toContain("outcome-private-marker");
      }
      } finally {
        await proofSubstrate?.close?.();
        await provider.close();
      }
    });
  });

  it("rejects a non-current Pactium manifest before providers can write", async () => {
    await withTempDataDir(async (userDataPath) => {
      await writeJson(path.join(userDataPath, PACTIUM_MANIFEST_FILE), {
        protocol: "not-current",
        schema: "not-current"
      });
      expect(() => createOperationProofSubstrate({ userDataPath })).toThrow(/current Pactium data directory/);
      expect(() => createDataStructureSubstrate({ userDataPath })).toThrow(/current Pactium data directory/);
    });
  });

  it("delegates an empty storage backend to Pactium while preserving configuration precedence", async () => {
    await withTempDataDir(async (userDataPath) => {
      const previousLicoBackend = process.env.LICO_PACTIUM_STORAGE_BACKEND;
      const previousPactiumBackend = process.env.PACTIUM_STORAGE_BACKEND;
      const runtimes = [];

      try {
        delete process.env.LICO_PACTIUM_STORAGE_BACKEND;
        delete process.env.PACTIUM_STORAGE_BACKEND;
        const automaticRuntime = createLicoPactiumRuntime({
          dataDir: path.join(userDataPath, "automatic")
        });
        runtimes.push(automaticRuntime);
        expect(automaticRuntime.storage.storageBackend).toBe("auto");

        process.env.LICO_PACTIUM_STORAGE_BACKEND = "json";
        process.env.PACTIUM_STORAGE_BACKEND = "auto";
        const licoEnvironmentRuntime = createLicoPactiumRuntime({
          dataDir: path.join(userDataPath, "lico-environment")
        });
        runtimes.push(licoEnvironmentRuntime);
        expect(licoEnvironmentRuntime.storage.storageBackend).toBe("json");

        const explicitRuntime = createLicoPactiumRuntime({
          dataDir: path.join(userDataPath, "explicit"),
          storageBackend: "auto"
        });
        runtimes.push(explicitRuntime);
        expect(explicitRuntime.storage.storageBackend).toBe("auto");

        delete process.env.LICO_PACTIUM_STORAGE_BACKEND;
        process.env.PACTIUM_STORAGE_BACKEND = "json";
        const pactiumEnvironmentRuntime = createLicoPactiumRuntime({
          dataDir: path.join(userDataPath, "pactium-environment")
        });
        runtimes.push(pactiumEnvironmentRuntime);
        expect(pactiumEnvironmentRuntime.storage.storageBackend).toBe("json");
      } finally {
        for (const runtime of runtimes) {
          await runtime.close();
        }
        restoreEnvironmentValue("LICO_PACTIUM_STORAGE_BACKEND", previousLicoBackend);
        restoreEnvironmentValue("PACTIUM_STORAGE_BACKEND", previousPactiumBackend);
      }
    });
  });

  it("closes owned persistent storage idempotently while preserving injected storage ownership", async () => {
    await withTempDataDir(async (userDataPath) => {
      const ownedRuntime = createLicoPactiumRuntime({
        dataDir: path.join(userDataPath, "owned"),
        storageBackend: "sqlite"
      });
      await ownedRuntime.storage.initialize();
      await Promise.all([ownedRuntime.close(), ownedRuntime.close()]);
      await expect(ownedRuntime.storage.initialize()).rejects.toMatchObject({
        code: "PACTIUM_STORAGE_CLOSED"
      });

      const externalStorage = createStoragePort({ inMemory: true });
      let externalCloseCalls = 0;
      const observedStorage = {
        ...externalStorage,
        async close() {
          externalCloseCalls += 1;
          await externalStorage.close();
        }
      };
      const externalRuntime = createLicoPactiumRuntime({
        dataDir: path.join(userDataPath, "external"),
        storage: observedStorage
      });
      await externalRuntime.storage.initialize();
      await Promise.all([externalRuntime.close(), externalRuntime.close()]);
      expect(externalCloseCalls).toBe(0);
      await expect(externalStorage.putProtocolObject("scope", "still-open", { ok: true }))
        .resolves.toEqual({ ok: true });
      await externalStorage.close();
    });
  });

  it("releases owned SQLite descriptors after direct checkpoint calls, including failures", async () => {
    await withTempDataDir(async (userDataPath) => {
      const previousBackend = process.env.LICO_PACTIUM_STORAGE_BACKEND;
      process.env.LICO_PACTIUM_STORAGE_BACKEND = "sqlite";
      try {
        const treeId = checkpointTreeId("descriptor", "direct-call");
        await startCheckpointTree({
          userDataPath,
          treeId,
          kind: "descriptor",
          ownerId: "owner-a"
        });
        await expect(loadCheckpointTree({ userDataPath, treeId })).resolves.toMatchObject({ treeId });
        await expect(queryCheckpointScope({
          userDataPath,
          treeId: checkpointTreeId("descriptor", "missing")
        })).rejects.toThrow("checkpoint tree is missing");

        const descriptorCount = await descriptorsUnder(userDataPath);
        if (descriptorCount !== null) expect(descriptorCount).toBe(0);
      } finally {
        restoreEnvironmentValue("LICO_PACTIUM_STORAGE_BACKEND", previousBackend);
      }
    });
  });
});

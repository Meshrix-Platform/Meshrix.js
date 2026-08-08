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
import { createDataStructureSubstrate } from "#meshrix/foundation/checkpoint/tree/data-structure-substrate";
import {
  createMeshrixPactiumRuntime,
  PACTIUM_MANIFEST_FILE
} from "#meshrix/foundation/checkpoint/tree/pactium-substrate-preflight";
import {
  checkpointTreeId,
  loadCheckpointTree,
  queryCheckpointScope,
  startCheckpointTree
} from "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection";
import { createOperationProofSubstrate } from "#meshrix/foundation/proof/proof-substrate/index";
import { serverToken } from "#meshrix/client-strings";

const execFileAsync: any = promisify(execFile);

async function withTempDataDir(testCase?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-pactium-boundary-"));
  try {
    return await testCase(userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

async function writeJson(filePath?: any, value?: any) : Promise<any> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function restoreEnvironmentValue(name?: any, value?: any) : any {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function descriptorsUnder(directoryPath?: any) : Promise<any> {
  const normalizedDirectory: any = await fs.realpath(directoryPath).catch(() : any => path.resolve(directoryPath));
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("lsof", ["-Fn", "-p", String(process.pid)], {
        encoding: "utf8"
      });
      return stdout.split("\n")
        .filter((line?: any) : any => line.startsWith("n"))
        .map((line?: any) : any => line.slice(1))
        .filter((target?: any) : any => target.startsWith(`${normalizedDirectory}${path.sep}`))
        .length;
    } catch {
      return null;
    }
  }
  if (process.platform !== "linux") return null;
  let names: any = null;
  try {
    names = await fs.readdir("/proc/self/fd");
  } catch {
    return null;
  }
  let count: any = 0;
  for (const name of names) {
    try {
      const target: any = await fs.readlink(path.join("/proc/self/fd", name));
      if (path.resolve(target).startsWith(`${normalizedDirectory}${path.sep}`)) count += 1;
    } catch {
      // Descriptors can close between directory enumeration and readlink.
    }
  }
  return count;
}

describe("Pactium provider boundary", () : any => {
  it("uses Pactium behind Meshrix.js facades without changing checkpoint ids or data dir", async () : Promise<any> => {
    await withTempDataDir(async (userDataPath?: any) : Promise<any> => {
      const provider: any = createDataStructureSubstrate({ userDataPath });
      let proofSubstrate: any = null;
      try {
      const treeId: any = checkpointTreeId("workflow", "alpha");
      expect(provider.provider).toBe("pactium");
      expect(provider.providerProtocolVersion).toMatch(/pactium/);
      expect(provider.merkleStateSubstrate.dataDir).toBe(path.resolve(userDataPath));
      expect(treeId).toBe(serverToken("checkpoint_tree", "workflow", "alpha"));

      const started: any = await startCheckpointTree({
        userDataPath,
        treeId,
        kind: "workflow",
        ownerId: "owner-a",
        rootNodeId: "root",
        rootLabel: "Root"
      });
      expect(started).toMatchObject({ treeId, ownerId: "owner-a" });
      await expect(fs.stat(path.join(userDataPath, PACTIUM_MANIFEST_FILE))).resolves.toBeTruthy();
      const manifest: any = JSON.parse(await fs.readFile(path.join(userDataPath, PACTIUM_MANIFEST_FILE), "utf8"));
      expect(manifest).toMatchObject({
        protocol: PACTIUM_PROTOCOL,
        schema: PACTIUM_SCHEMA_VERSION,
        latestSchemaOnly: true
      });
      proofSubstrate = createOperationProofSubstrate({ userDataPath });
      expect(proofSubstrate.dataDir).toBe(path.resolve(userDataPath));
      const headBeforeLifecycle: any = await proofSubstrate.pactiumRuntime.core.readLedgerHead();
      const entry: any = await proofSubstrate.beginLifecycle({
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
      const completed: any = await proofSubstrate.finishLifecycle({
        entry,
        status: "succeeded",
        output: { privateMarker: "outcome-private-marker" }
      });
      expect(completed.status).toBe("succeeded");
      const head: any = await proofSubstrate.pactiumRuntime.core.readLedgerHead();
      expect(head.size - headBeforeLifecycle.size).toBe(2);
      for (let index: any = headBeforeLifecycle.size; index < head.size; index += 1) {
        const serialized: any = JSON.stringify(
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

  it("rejects a non-current Pactium manifest before providers can write", async () : Promise<any> => {
    await withTempDataDir(async (userDataPath?: any) : Promise<any> => {
      await writeJson(path.join(userDataPath, PACTIUM_MANIFEST_FILE), {
        protocol: "not-current",
        schema: "not-current"
      });
      expect(() : any => createOperationProofSubstrate({ userDataPath })).toThrow(/current Pactium data directory/);
      expect(() : any => createDataStructureSubstrate({ userDataPath })).toThrow(/current Pactium data directory/);
    });
  });

  it("delegates an empty storage backend to Pactium while preserving configuration precedence", async () : Promise<any> => {
    await withTempDataDir(async (userDataPath?: any) : Promise<any> => {
      const previousMeshrixBackend: any = process.env.MESHRIX_PACTIUM_STORAGE_BACKEND;
      const previousPactiumBackend: any = process.env.PACTIUM_STORAGE_BACKEND;
      const runtimes: any[] = [];

      try {
        delete process.env.MESHRIX_PACTIUM_STORAGE_BACKEND;
        delete process.env.PACTIUM_STORAGE_BACKEND;
        const automaticRuntime: any = createMeshrixPactiumRuntime({
          dataDir: path.join(userDataPath, "automatic")
        });
        runtimes.push(automaticRuntime);
        expect(automaticRuntime.storage.storageBackend).toBe("auto");

        process.env.MESHRIX_PACTIUM_STORAGE_BACKEND = "json";
        process.env.PACTIUM_STORAGE_BACKEND = "auto";
        const meshrixEnvironmentRuntime: any = createMeshrixPactiumRuntime({
          dataDir: path.join(userDataPath, "meshrix-environment")
        });
        runtimes.push(meshrixEnvironmentRuntime);
        expect(meshrixEnvironmentRuntime.storage.storageBackend).toBe("json");

        const explicitRuntime: any = createMeshrixPactiumRuntime({
          dataDir: path.join(userDataPath, "explicit"),
          storageBackend: "auto"
        });
        runtimes.push(explicitRuntime);
        expect(explicitRuntime.storage.storageBackend).toBe("auto");

        delete process.env.MESHRIX_PACTIUM_STORAGE_BACKEND;
        process.env.PACTIUM_STORAGE_BACKEND = "json";
        const pactiumEnvironmentRuntime: any = createMeshrixPactiumRuntime({
          dataDir: path.join(userDataPath, "pactium-environment")
        });
        runtimes.push(pactiumEnvironmentRuntime);
        expect(pactiumEnvironmentRuntime.storage.storageBackend).toBe("json");
      } finally {
        for (const runtime of runtimes) {
          await runtime.close();
        }
        restoreEnvironmentValue("MESHRIX_PACTIUM_STORAGE_BACKEND", previousMeshrixBackend);
        restoreEnvironmentValue("PACTIUM_STORAGE_BACKEND", previousPactiumBackend);
      }
    });
  });

  it("closes owned persistent storage idempotently while preserving injected storage ownership", async () : Promise<any> => {
    await withTempDataDir(async (userDataPath?: any) : Promise<any> => {
      const ownedRuntime: any = createMeshrixPactiumRuntime({
        dataDir: path.join(userDataPath, "owned"),
        storageBackend: "sqlite"
      });
      await ownedRuntime.storage.initialize();
      await Promise.all([ownedRuntime.close(), ownedRuntime.close()]);
      await expect(ownedRuntime.storage.initialize()).rejects.toMatchObject({
        code: "PACTIUM_STORAGE_CLOSED"
      });

      const externalStorage: any = createStoragePort({ inMemory: true });
      let externalCloseCalls: any = 0;
      const observedStorage: Record<string, any> = {
        ...externalStorage,
        async close() : Promise<any> {
          externalCloseCalls += 1;
          await externalStorage.close();
        }
      };
      const externalRuntime: any = createMeshrixPactiumRuntime({
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

  it("releases owned SQLite descriptors after direct checkpoint calls, including failures", async () : Promise<any> => {
    await withTempDataDir(async (userDataPath?: any) : Promise<any> => {
      const previousBackend: any = process.env.MESHRIX_PACTIUM_STORAGE_BACKEND;
      process.env.MESHRIX_PACTIUM_STORAGE_BACKEND = "sqlite";
      try {
        const treeId: any = checkpointTreeId("descriptor", "direct-call");
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

        const descriptorCount: any = await descriptorsUnder(userDataPath);
        if (descriptorCount !== null) expect(descriptorCount).toBe(0);
      } finally {
        restoreEnvironmentValue("MESHRIX_PACTIUM_STORAGE_BACKEND", previousBackend);
      }
    });
  });
});

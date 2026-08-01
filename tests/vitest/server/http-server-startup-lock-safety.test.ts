import fs from "node:fs/promises";
import http from "node:http";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startHttpServer } from "../../../apps/server/runtime/http-server.ts";
import {
  LockManagerDestroyedError,
  MemoryLockManager
} from "../../../packages/foundation/src/concurrency/lock-manager.ts";

class ListenerStub extends EventEmitter {
  listenError: any;
  listening: any;
  constructor({ listenError = null }: Record<string, any> = {}) {
    super();
    this.listenError = listenError;
    this.listening = false;
  }

  listen(_port?: any, _host?: any, callback?: any) : any {
    if (this.listenError) {
      queueMicrotask(() : any => this.emit("error", this.listenError));
      return this;
    }
    this.listening = true;
    queueMicrotask(callback);
    return this;
  }

  address() : any {
    return this.listening
      ? { address: "127.0.0.1", family: "IPv4", port: 43123 }
      : null;
  }

  close(callback?: any) : any {
    this.listening = false;
    queueMicrotask(() : any => callback?.());
    return this;
  }
}

afterEach(() : any => {
  vi.restoreAllMocks();
});

describe("HTTP startup lock safety", () : any => {
  it("fails before listen when configured secret-key custody is unavailable", async () : Promise<any> => {
    const createServer: any = vi.spyOn(http, "createServer");
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-startup-secret-key-"));
    const previous: any = process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE;
    process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = path.join(userDataPath, "missing-key");
    try {
      await expect(startHttpServer({
        userDataPath,
        distPath: "",
        host: "127.0.0.1",
        port: 0
      })).rejects.toMatchObject({ code: "local_secret_key_unavailable" });
      expect(createServer).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE;
      else process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = previous;
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("fails before listen when production proof signing custody is unavailable", async () : Promise<any> => {
    const createServer: any = vi.spyOn(http, "createServer");
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-startup-proof-signer-"));
    const previousPolicy: any = process.env.MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY;
    const previousSecretFile: any = process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE;
    process.env.MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY = "production";
    delete process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE;
    try {
      await expect(startHttpServer({
        userDataPath,
        distPath: "",
        host: "127.0.0.1",
        port: 0
      })).rejects.toMatchObject({ code: "operation_proof_signer_required" });
      expect(createServer).not.toHaveBeenCalled();
    } finally {
      if (previousPolicy === undefined) delete process.env.MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY;
      else process.env.MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY = previousPolicy;
      if (previousSecretFile === undefined) delete process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE;
      else process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE = previousSecretFile;
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("starts with distinct externally custodied production encryption and proof keys", async () : Promise<any> => {
    vi.spyOn(http, "createServer").mockReturnValue(new ListenerStub());
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-startup-production-custody-"));
    const userDataPath: any = path.join(root, "data");
    const encryptionKeyFile: any = path.join(root, "local-secret-key");
    const proofSignerFile: any = path.join(root, "proof-signer");
    await fs.mkdir(userDataPath);
    await fs.writeFile(encryptionKeyFile, "a".repeat(64), { mode: 0o600 });
    await fs.writeFile(proofSignerFile, "b".repeat(64), { mode: 0o600 });
    const previousKeyFile: any = process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE;
    const previousPolicy: any = process.env.MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY;
    const previousSecretFile: any = process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE;
    process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = encryptionKeyFile;
    process.env.MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY = "production";
    process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE = proofSignerFile;
    let serverHandle: any = null;
    try {
      serverHandle = await startHttpServer({
        userDataPath,
        distPath: "",
        host: "127.0.0.1",
        port: 0
      });
      expect(serverHandle.url).toMatch(/^http:\/\/127\.0\.0\.1:/u);
    } finally {
      await serverHandle?.close?.().catch(() : any => {});
      if (previousKeyFile === undefined) delete process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE;
      else process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = previousKeyFile;
      if (previousPolicy === undefined) delete process.env.MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY;
      else process.env.MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY = previousPolicy;
      if (previousSecretFile === undefined) delete process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE;
      else process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE = previousSecretFile;
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20
      });
    }
  });

  it("fails before listen when production encryption and proof keys share material", async () : Promise<any> => {
    const createServer: any = vi.spyOn(http, "createServer");
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-startup-shared-custody-"));
    const userDataPath: any = path.join(root, "data");
    const encryptionKeyFile: any = path.join(root, "local-secret-key");
    const proofSignerFile: any = path.join(root, "proof-signer");
    await fs.mkdir(userDataPath);
    await fs.writeFile(encryptionKeyFile, "a".repeat(64), { mode: 0o600 });
    await fs.writeFile(proofSignerFile, "a".repeat(64), { mode: 0o600 });
    const previousKeyFile: any = process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE;
    const previousPolicy: any = process.env.MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY;
    const previousSecretFile: any = process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE;
    process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = encryptionKeyFile;
    process.env.MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY = "production";
    process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE = proofSignerFile;
    try {
      await expect(startHttpServer({
        userDataPath,
        distPath: "",
        host: "127.0.0.1",
        port: 0
      })).rejects.toMatchObject({
        code: "production_secret_custody_separation_required"
      });
      expect(createServer).not.toHaveBeenCalled();
    } finally {
      if (previousKeyFile === undefined) delete process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE;
      else process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = previousKeyFile;
      if (previousPolicy === undefined) delete process.env.MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY;
      else process.env.MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY = previousPolicy;
      if (previousSecretFile === undefined) delete process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE;
      else process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE = previousSecretFile;
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20
      });
    }
  });

  it("unwinds an injected lock manager when listen fails after composition", async () : Promise<any> => {
    const listenError: any = Object.assign(new Error("address unavailable"), { code: "EADDRINUSE" });
    vi.spyOn(http, "createServer").mockReturnValue(new ListenerStub({ listenError }));
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-startup-lock-"));
    const manager: any = new MemoryLockManager();

    try {
      await expect(startHttpServer({
        userDataPath,
        distPath: "",
        host: "127.0.0.1",
        port: 43123,
        operationLockManager: manager,
        operationConcurrencyScope: "test-deployment"
      })).rejects.toMatchObject({ code: "EADDRINUSE" });
      await expect(manager.acquire("after-failed-startup"))
        .rejects.toBeInstanceOf(LockManagerDestroyedError);
    } finally {
      manager.destroy();
      await fs.rm(userDataPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20
      });
    }
  });

  it("owns an injected manager and makes successful server close idempotent", async () : Promise<any> => {
    vi.spyOn(http, "createServer").mockReturnValue(new ListenerStub());
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-startup-close-lock-"));
    const manager: any = new MemoryLockManager();
    let serverHandle: any = null;

    try {
      serverHandle = await startHttpServer({
        userDataPath,
        distPath: "",
        host: "127.0.0.1",
        port: 0,
        operationLockManager: manager,
        operationConcurrencyScope: "test-deployment"
      });
      const firstClose: any = serverHandle.close();
      const secondClose: any = serverHandle.close();
      expect(secondClose).toBe(firstClose);
      await firstClose;
      await expect(manager.acquire("after-successful-shutdown"))
        .rejects.toBeInstanceOf(LockManagerDestroyedError);
    } finally {
      await serverHandle?.close?.().catch(() : any => {});
      manager.destroy();
      await fs.rm(userDataPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20
      });
    }
  });
});

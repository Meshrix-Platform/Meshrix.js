import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnHarness: any = vi.hoisted(() : any => {
  class MiniEmitter {
  handlers: any;
    constructor() {
      this.handlers = new Map<any, any>();
    }

    on(event?: any, handler?: any) : any {
      const handlers: any = this.handlers.get(event) || [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    emit(event: any, ...args: any[]) : any {
      for (const handler of this.handlers.get(event) || []) {
        handler(...args);
      }
    }
  }

  const harness: Record<string, any> = {
    calls: [],
    responder: null,
    spawn: null
  };

  harness.spawn = vi.fn((command?: any, args: any = [], options: Record<string, any> = {}) : any => {
    const child: any = new MiniEmitter();
    child.stdout = new MiniEmitter();
    child.stderr = new MiniEmitter();
    child.kill = vi.fn();
    child.stdin = new MiniEmitter();
    child.stdin.end = (input: any = "") : any => {
        const call: Record<string, any> = { command, args, options, input: String(input || "") };
        harness.calls.push(call);
        const result: any = harness.responder?.(call) || { code: 0, stdout: "" };
        queueMicrotask(() : any => {
          if (result.error) {
            child.emit("error", result.error);
            return;
          }
          if (result.stdout) {
            child.stdout.emit("data", Buffer.from(String(result.stdout)));
          }
          if (result.stderr) {
            child.stderr.emit("data", Buffer.from(String(result.stderr)));
          }
          child.emit("close", Number(result.code || 0));
        });
    };
    return child;
  });

  return harness;
});

vi.mock("node:child_process", () : any => ({
  spawn: spawnHarness.spawn
}));

import { apiCapabilityId } from "#meshrix/authorization-engine";
import {
  createCapabilityBindingGuard
} from "../../../packages/foundation/src/security/authorization/capability-binding-guard.ts";
import {
  createCapabilityKey,
  createMemoryCapabilityKeyBindingStore,
  createOpaqueCapabilityKeyProvider,
  createSealedCapabilityKernelStore
} from "../../../packages/foundation/src/security/authorization/opaque-capability-key.ts";

const tempRoots: any[] = [];
const originalDpapiCommand: any = process.env.MESHRIX_WINDOWS_DPAPI_COMMAND;
const originalPath: any = process.env.PATH;
const originalPlatformDescriptor: any = Object.getOwnPropertyDescriptor(process, "platform");

async function makeTempRoot(prefix?: any) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function installFakeCommands(root?: any, commands: any = []) : Promise<any> {
  const binDir: any = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });
  for (const command of commands) {
    const commandPath: any = path.join(binDir, command);
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n");
    await fs.chmod(commandPath, 0o755);
  }
  process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
  return binDir;
}

async function withMockedPlatform(platform?: any, action?: any) : Promise<any> {
  Object.defineProperty(process, "platform", {
    ...originalPlatformDescriptor,
    value: platform
  });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}

function defaultBackendResponder({ command, args }: Record<string, any>) : any {
  if (command === "/usr/bin/security") {
    return args.includes("find-generic-password")
      ? { code: 1, stderr: "The specified item could not be found" }
      : { code: 0, stdout: "" };
  }
  if (command === "keyctl") {
    return args[0] === "search"
      ? { code: 1, stderr: "not found" }
      : { code: 0, stdout: "" };
  }
  if (command === "secret-tool") {
    return args[0] === "lookup"
      ? { code: 1, stderr: "not found" }
      : { code: 0, stdout: "" };
  }
  if (command === "pass") {
    return args[0] === "show"
      ? { code: 1, stderr: "is not in the password store" }
      : { code: 0, stdout: "" };
  }
  if (command === "pwsh-fixture") {
    return { code: 0, stdout: "protected-dpapi-payload" };
  }
  return { code: 0, stdout: "" };
}

function commandHelperResponder({ command, input }: Record<string, any>) : any {
  if (command === "helper-ok") {
    const request: any = JSON.parse(input || "{}");
    if (request.action === "describe") {
      return { code: 0, stdout: JSON.stringify({ provider: "helper", generation: 7 }) };
    }
    if (request.action === "rotateRuntimeLookupKey") {
      return { code: 0, stdout: JSON.stringify({ generation: 8 }) };
    }
    return {
      code: 0,
      stdout: JSON.stringify({
        runtimeLookupKeyBase64: Buffer.alloc(32, 7).toString("base64"),
        generation: 7
      })
    };
  }
  if (command === "helper-bad-json") {
    return { code: 0, stdout: "{not-json" };
  }
  if (command === "helper-fails") {
    return { code: 9, stderr: "helper failed hard" };
  }
  return defaultBackendResponder({ command, args: [] });
}

function failingBackendResponder({ command }: Record<string, any>) : any {
  if (["/usr/bin/security", "keyctl", "secret-tool", "pass", "pwsh-fixture"].includes(command)) {
    return { code: 5, stderr: `${command} failed intentionally` };
  }
  return { code: 5, stderr: "backend failed intentionally" };
}

function writeFailingBackendResponder({ command, args }: Record<string, any>) : any {
  if (command === "/usr/bin/security") {
    return args.includes("find-generic-password")
      ? { code: 1, stderr: "The specified item could not be found" }
      : { code: 7, stderr: "keychain write failed intentionally" };
  }
  if (command === "keyctl") {
    return args[0] === "search"
      ? { code: 1, stderr: "not found" }
      : { code: 7, stderr: "keyctl write failed intentionally" };
  }
  if (command === "secret-tool") {
    return args[0] === "lookup"
      ? { code: 1, stderr: "not found" }
      : { code: 7, stderr: "secret-tool write failed intentionally" };
  }
  if (command === "pass") {
    return args[0] === "show"
      ? { code: 1, stderr: "is not in the password store" }
      : { code: 7, stderr: "pass write failed intentionally" };
  }
  if (command === "pwsh-fixture") {
    return { code: 7, stderr: "dpapi write failed intentionally" };
  }
  return { code: 7, stderr: "backend write failed intentionally" };
}

function linuxAutoRewrapResponder({ command, args }: Record<string, any>) : any {
  if (command === "keyctl") {
    return args[0] === "search"
      ? { code: 1, stderr: "not found" }
      : { code: 8, stderr: "keyctl write unavailable" };
  }
  if (command === "secret-tool") {
    return args[0] === "lookup"
      ? { code: 1, stderr: "not found" }
      : { code: 8, stderr: "secret-tool write unavailable" };
  }
  if (command === "pass") {
    return args[0] === "show"
      ? { code: 1, stderr: "is not in the password store" }
      : { code: 0, stdout: "" };
  }
  return defaultBackendResponder({ command, args });
}

afterEach(async () : Promise<any> => {
  spawnHarness.calls = [];
  spawnHarness.spawn.mockClear();
  spawnHarness.responder = null;
  process.env.PATH = originalPath;
  if (originalDpapiCommand === undefined) {
    delete process.env.MESHRIX_WINDOWS_DPAPI_COMMAND;
  } else {
    process.env.MESHRIX_WINDOWS_DPAPI_COMMAND = originalDpapiCommand;
  }
  Object.defineProperty(process, "platform", originalPlatformDescriptor);
  await Promise.all(tempRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("authorization system backend coverage", () : any => {
  it("initializes opaque capability kernel records through mocked system backends", async () : Promise<any> => {
    spawnHarness.responder = defaultBackendResponder;
    process.env.MESHRIX_WINDOWS_DPAPI_COMMAND = "pwsh-fixture";
    const root: any = await makeTempRoot("meshrix-authz-system-opaque-");
    const backends: any[] = ["linux-kernel-keyring", "secret-service", "pass-gpg", "windows-dpapi"];
    if (process.platform === "darwin") {
      backends.unshift("macos-keychain");
    }

    for (const backend of backends) {
      const store: any = createSealedCapabilityKernelStore({
        backend,
        dataDir: root,
        alias: `opaque-${backend}`
      });
      const loaded: any = await store.keySource.loadRuntimeLookupKey();
      expect(loaded.runtimeLookupKeyBase64).toEqual(expect.any(String));
      expect(loaded.provider).toBe(backend);
      store.close();
    }

    expect(spawnHarness.calls.map((call?: any) : any => call.command)).toEqual(expect.arrayContaining([
      "keyctl",
      "secret-tool",
      "pass",
      "pwsh-fixture"
    ]));
  });

  it("initializes capability binding guard records through mocked system backends", async () : Promise<any> => {
    spawnHarness.responder = defaultBackendResponder;
    process.env.MESHRIX_WINDOWS_DPAPI_COMMAND = "pwsh-fixture";
    const root: any = await makeTempRoot("meshrix-authz-system-guard-");
    const backends: any[] = ["linux-kernel-keyring", "secret-service", "pass-gpg", "windows-dpapi"];
    if (process.platform === "darwin") {
      backends.unshift("macos-keychain");
    }

    for (const backend of backends) {
      const guard: any = createCapabilityBindingGuard({
        backend,
        dataDir: root,
        alias: `guard-${backend}`
      });
      const key: any = createCapabilityKey();
      const binding: any = await guard.bindCapabilityKey({
        capabilityKey: key,
        credentialId: `cred-${backend}`,
        context: { namespace: `tenant-${backend}` }
      });
      expect(binding.credentialId).toBe(`cred-${backend}`);
      await expect(guard.verifyCapabilityKeyBinding({
        capabilityKey: key,
        context: { namespace: `tenant-${backend}` }
      })).resolves.toMatchObject({ ok: true, applicable: true });
      guard.close();
    }
  });

  it("drives command lookup key helper success and failure paths", async () : Promise<any> => {
    spawnHarness.responder = commandHelperResponder;

    const provider: any = createOpaqueCapabilityKeyProvider({
      backend: "external-command",
      bindingStore: createMemoryCapabilityKeyBindingStore(),
      command: "helper-ok",
      args: ["--rpc"]
    });
    const issued: any = await provider.issue({
      capabilities: [apiCapabilityId("jobs.create")],
      metadata: { source: "mock-helper" }
    });
    expect(issued.runtimeLookupGeneration).toBe(7);
    await expect(provider.verify({
      capabilityKey: issued.capabilityKey,
      requiredCapability: apiCapabilityId("jobs.create"),
      includeRecordDetails: true
    })).resolves.toMatchObject({
      ok: true,
      capabilityCount: 1,
      runtimeLookupGeneration: 7
    });
    await expect(provider.describe()).resolves.toMatchObject({
      provider: "external-command",
      keySource: expect.objectContaining({ provider: "helper" })
    });

    const badJson: any = createOpaqueCapabilityKeyProvider({
      backend: "external-command",
      bindingStore: createMemoryCapabilityKeyBindingStore(),
      command: "helper-bad-json"
    });
    await expect(badJson.issue({ capabilities: [apiCapabilityId("jobs.create")] }))
      .rejects.toThrow(/invalid JSON/);

    const failing: any = createOpaqueCapabilityKeyProvider({
      backend: "external-command",
      bindingStore: createMemoryCapabilityKeyBindingStore(),
      command: "helper-fails"
    });
    await expect(failing.issue({ capabilities: [apiCapabilityId("jobs.create")] }))
      .rejects.toThrow(/helper failed hard/);
  });

  it("propagates explicit system backend failures without falling back silently", async () : Promise<any> => {
    spawnHarness.responder = failingBackendResponder;
    process.env.MESHRIX_WINDOWS_DPAPI_COMMAND = "pwsh-fixture";
    const root: any = await makeTempRoot("meshrix-authz-system-failing-");

    for (const backend of ["linux-kernel-keyring", "secret-service", "pass-gpg", "windows-dpapi"]) {
      const store: any = createSealedCapabilityKernelStore({
        backend,
        dataDir: root,
        alias: `opaque-failing-${backend}`
      });
      await expect(store.keySource.loadRuntimeLookupKey()).rejects.toThrow(/failed intentionally/);
      store.close();

      const guard: any = createCapabilityBindingGuard({
        backend,
        dataDir: root,
        alias: `guard-failing-${backend}`
      });
      await expect(guard.bindCapabilityKey({
        capabilityKey: createCapabilityKey(),
        credentialId: `cred-${backend}`,
        context: { namespace: `tenant-${backend}` }
      })).rejects.toThrow(/failed intentionally/);
      guard.close();
    }
  });

  it("propagates explicit system backend write failures after missing records are initialized", async () : Promise<any> => {
    spawnHarness.responder = writeFailingBackendResponder;
    process.env.MESHRIX_WINDOWS_DPAPI_COMMAND = "pwsh-fixture";
    const root: any = await makeTempRoot("meshrix-authz-system-write-failing-");

    for (const backend of ["linux-kernel-keyring", "secret-service", "pass-gpg", "windows-dpapi"]) {
      const store: any = createSealedCapabilityKernelStore({
        backend,
        dataDir: root,
        alias: `opaque-write-failing-${backend}`
      });
      await expect(store.keySource.loadRuntimeLookupKey()).rejects.toThrow(/write failed intentionally/);
      store.close();

      const guard: any = createCapabilityBindingGuard({
        backend,
        dataDir: root,
        alias: `guard-write-failing-${backend}`
      });
      await expect(guard.bindCapabilityKey({
        capabilityKey: createCapabilityKey(),
        credentialId: `cred-write-${backend}`,
        context: { namespace: `tenant-write-${backend}` }
      })).rejects.toThrow(/write failed intentionally/);
      guard.close();
    }
  });

  it("falls back from auto system backends to local records when probing fails", async () : Promise<any> => {
    spawnHarness.responder = failingBackendResponder;
    const root: any = await makeTempRoot("meshrix-authz-auto-fallback-");

    const provider: any = createOpaqueCapabilityKeyProvider({
      backend: "auto",
      dataDir: root,
      alias: "opaque-auto-fallback"
    });
    const issued: any = await provider.issue({
      capabilities: [apiCapabilityId("jobs.create")],
      credentialId: "cred-auto-local"
    });
    expect(issued.runtimeLookupGeneration).toBeGreaterThanOrEqual(1);
    await expect(provider.describe()).resolves.toMatchObject({
      securityMode: "degraded_file_fallback",
      keySource: expect.objectContaining({ securityMode: "degraded_file_fallback" })
    });
    provider.close();

    const guard: any = createCapabilityBindingGuard({
      backend: "auto",
      dataDir: root,
      alias: "guard-auto-fallback"
    });
    const capabilityKey: any = createCapabilityKey();
    await expect(guard.bindCapabilityKey({
      capabilityKey,
      credentialId: "cred-auto-guard",
      context: { namespace: "tenant-auto" }
    })).resolves.toMatchObject({ credentialId: "cred-auto-guard" });
    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey,
      context: { namespace: "tenant-auto" }
    })).resolves.toMatchObject({ ok: true, applicable: true });
    await expect(guard.describe()).resolves.toMatchObject({
      securityMode: "degraded_file_fallback",
      degraded: true
    });
    guard.close();
  });

  it("rewraps Linux auto records across mocked keyring backends before pass-gpg succeeds", async () : Promise<any> => {
    const root: any = await makeTempRoot("meshrix-authz-linux-auto-rewrap-");
    await installFakeCommands(root, ["systemd-creds", "keyctl", "secret-tool", "pass"]);
    spawnHarness.responder = linuxAutoRewrapResponder;

    await withMockedPlatform("linux", async () : Promise<any> => {
      const store: any = createSealedCapabilityKernelStore({
        backend: "auto",
        dataDir: root,
        alias: "opaque-linux-rewrap"
      });
      const loaded: any = await store.keySource.loadRuntimeLookupKey();
      expect(loaded.provider).toBe("pass-gpg");
      await expect(store.keySource.describe()).resolves.toMatchObject({
        provider: "pass-gpg",
        securityMode: "user_keyring",
        linuxDetectedBackends: expect.arrayContaining([
          "systemd-credentials",
          "linux-kernel-keyring",
          "secret-service",
          "pass-gpg",
          "local-file"
        ])
      });
      store.close();

      const guard: any = createCapabilityBindingGuard({
        backend: "auto",
        dataDir: root,
        alias: "guard-linux-rewrap"
      });
      const key: any = createCapabilityKey();
      await expect(guard.bindCapabilityKey({
        capabilityKey: key,
        credentialId: "cred-linux-rewrap",
        context: { namespace: "tenant-linux" }
      })).resolves.toMatchObject({ credentialId: "cred-linux-rewrap" });
      await expect(guard.verifyCapabilityKeyBinding({
        capabilityKey: key,
        context: { namespace: "tenant-linux" }
      })).resolves.toMatchObject({ ok: true, applicable: true });
      guard.close();
    });

    expect(spawnHarness.calls.map((call?: any) : any => call.command)).toEqual(expect.arrayContaining([
      "keyctl",
      "secret-tool",
      "pass"
    ]));
  });

  it("covers local opaque key recovery, expiry, wildcard, rotation, and invalidation decisions", async () : Promise<any> => {
    const root: any = await makeTempRoot("meshrix-authz-local-opaque-");

    const emptyStore: any = createSealedCapabilityKernelStore({
      backend: "local-file",
      dataDir: root,
      alias: "opaque-empty-rotate"
    });
    await expect(emptyStore.keySource.rotateRuntimeLookupKey()).resolves.toMatchObject({
      protocolVersion: "v0.0.1:risk-control:opaque-capability-key-1",
      provider: "local-file"
    });
    emptyStore.close();

    const provider: any = createOpaqueCapabilityKeyProvider({
      backend: "local-file",
      dataDir: root,
      alias: "opaque-local"
    });

    await expect(provider.issue({ capabilities: [] })).rejects.toThrow(/at least one kernel capability/);
    await expect(provider.issue({ capabilities: ["cap:api:not-real"] })).rejects.toThrow(/Unknown opaque capability/);
    await expect(provider.issue({ capabilities: ["cap:tool:sample_plugin.package.read:execute"] }))
      .rejects.toThrow(/Unknown opaque capability/);

    const dynamicIssued: any = await provider.issue({
      capabilityKey: "ock_dynamic_plugin_tool",
      credentialId: "cred-dynamic-plugin-tool",
      capabilities: ["cap:tool:sample_plugin.package.read:execute"],
      trustedCapabilityPermissions: ["cap:tool:sample_plugin.package.read:execute"]
    });
    await expect(provider.verify({
      capabilityKey: dynamicIssued.capabilityKey,
      requiredCapability: "cap:tool:sample_plugin.package.read:execute"
    })).resolves.toMatchObject({
      ok: true,
      requiredCapabilities: ["cap:tool:sample_plugin.package.read:execute"]
    });

    await expect(provider.verify({ capabilityKey: "" })).resolves.toMatchObject({
      ok: false,
      reasonCode: "capability_key_missing"
    });
    await expect(provider.verify({
      capabilityKey: createCapabilityKey(),
      requiredCapability: "cap:api:not-real"
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "unknown_capability",
      unknownCapabilities: ["cap:api:not-real"]
    });
    await expect(provider.verify({
      capabilityKey: createCapabilityKey(),
      requiredCapabilities: []
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "capability_required"
    });

    const issued: any = await provider.issue({
      capabilityKey: "ock_local_specific",
      credentialId: "cred-local-specific",
      capabilities: [apiCapabilityId("jobs.create")],
      grantVersion: 2,
      metadata: { purpose: "coverage" },
      constraints: { tenant: "tenant-a" }
    });
    await expect(provider.verify({
      capabilityKey: issued.capabilityKey,
      requiredCapability: apiCapabilityId("jobs.delete")
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "missing_capabilities",
      credentialId: "cred-local-specific",
      missingCapabilities: [apiCapabilityId("jobs.delete")]
    });
    await expect(provider.verify({
      capabilityKey: issued.capabilityKey,
      requiredCapability: apiCapabilityId("jobs.create"),
      minGrantVersion: 3
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "credential_grant_version_stale",
      credentialId: "cred-local-specific"
    });
    await expect(provider.rotateCapabilityKey({
      capabilityKey: issued.capabilityKey,
      capabilities: []
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "capabilities_required_for_rotation"
    });

    const wildcard: any = await provider.issue({
      capabilityKey: "ock_local_wildcard",
      credentialId: "cred-local-wildcard",
      capabilities: ["cap:api:*"]
    });
    await expect(provider.verify({
      capabilityKey: wildcard.capabilityKey,
      requiredCapability: apiCapabilityId("jobs.delete"),
      includeRecordDetails: true
    })).resolves.toMatchObject({
      ok: true,
      credentialId: "cred-local-wildcard",
      capabilityCount: 1
    });

    const replacedCredential: any = await provider.issue({
      capabilityKey: "ock_local_wildcard_replacement",
      credentialId: "cred-local-wildcard",
      capabilities: [apiCapabilityId("jobs.get")],
      replaceCredential: true,
      replacementReason: "coverage-reissue"
    });
    await expect(provider.verify({
      capabilityKey: wildcard.capabilityKey,
      requiredCapability: apiCapabilityId("jobs.delete")
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "capability_key_invalid",
      credentialId: "cred-local-wildcard"
    });
    await expect(provider.verify({
      capabilityKey: replacedCredential.capabilityKey,
      requiredCapability: apiCapabilityId("jobs.get")
    })).resolves.toMatchObject({
      ok: true,
      credentialId: "cred-local-wildcard"
    });

    const expired: any = await provider.issue({
      capabilityKey: "ock_local_expired",
      credentialId: "cred-local-expired",
      capabilities: [apiCapabilityId("jobs.get")],
      issuedAt: "2000-01-01T00:00:00.000Z",
      expiresAt: "2000-01-01T00:00:01.000Z"
    });
    await expect(provider.verify({
      capabilityKey: expired.capabilityKey,
      requiredCapability: apiCapabilityId("jobs.get"),
      now: "2000-01-01T00:00:02.000Z"
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "capability_key_expired",
      credentialId: "cred-local-expired"
    });

    const rotated: any = await provider.rotateCapabilityKey({
      capabilityKey: issued.capabilityKey,
      capabilities: [apiCapabilityId("jobs.delete")],
      reason: "coverage-rotation"
    });
    expect(rotated).toMatchObject({
      ok: true,
      credentialId: "cred-local-specific",
      oldStatus: "invalid",
      status: "valid"
    });
    await expect(provider.rotateCapabilityKey({
      capabilityKey: issued.capabilityKey,
      capabilities: [apiCapabilityId("jobs.delete")]
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "capability_key_invalid"
    });

    await expect(provider.invalidate({ capabilityKey: rotated.capabilityKey, reason: "revoked" }))
      .resolves.toMatchObject({ credentialId: "cred-local-specific", status: "invalid" });
    await expect(provider.invalidate({ capabilityKey: "", reason: "noop" })).resolves.toBeNull();
    await expect(provider.invalidateCredential({ credentialId: "" })).resolves.toEqual([]);
    await expect(provider.invalidateCredential({ credentialId: "cred-local-wildcard", reason: "credential revoked" }))
      .resolves.toHaveLength(1);

    await expect(provider.exportRecoveryPackage({ passphrase: "" })).rejects.toThrow(/requires a passphrase/);
    const recoveryPackage: any = await provider.exportRecoveryPackage({
      passphrase: "opaque recovery secret",
      reason: "coverage"
    });
    expect(recoveryPackage).toMatchObject({
      protocolVersion: "v0.0.1:risk-control:capability-kernel-recovery-1",
      alias: "opaque-local"
    });
    await expect(provider.importRecoveryPackage({
      recoveryPackage: { protocolVersion: "wrong" },
      passphrase: "opaque recovery secret"
    })).rejects.toThrow(/Unsupported capability kernel recovery package/);

    const importedProvider: any = createOpaqueCapabilityKeyProvider({
      backend: "local-file",
      dataDir: root,
      alias: "opaque-imported"
    });
    await expect(importedProvider.importRecoveryPackage({
      recoveryPackage,
      passphrase: "opaque recovery secret"
    })).resolves.toMatchObject({
      ok: true,
      alias: "opaque-imported",
      provider: "local-file"
    });
    await expect(importedProvider.describe()).resolves.toMatchObject({
      provider: "local-file",
      keySource: expect.objectContaining({ provider: "local-file" })
    });
    provider.close();
    importedProvider.close();
  });

  it("covers binding guard context mismatch, expiry, recovery, and invalidation decisions", async () : Promise<any> => {
    const root: any = await makeTempRoot("meshrix-authz-local-guard-");
    const guard: any = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir: root,
      alias: "guard-local"
    });

    const key: any = createCapabilityKey();
    await expect(guard.verifyCapabilityKeyBinding({ capabilityKey: "" })).resolves.toMatchObject({
      ok: false,
      reasonCode: "capability_key_missing"
    });
    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: createCapabilityKey(),
      context: { namespace: "tenant-a" }
    })).resolves.toMatchObject({
      ok: true,
      applicable: false,
      reasonCode: "capability_binding_not_registered"
    });

    await expect(guard.bindCapabilityKey({ capabilityKey: "" })).rejects.toThrow(/requires an opaque capability key/);
    const binding: any = await guard.bindCapabilityKey({
      capabilityKey: key,
      credentialId: "cred-binding",
      context: {
        namespace: "tenant-a",
        userId: "user-a",
        agentId: "agent-a",
        clientId: "client-a"
      }
    });
    expect(binding).toMatchObject({
      credentialId: "cred-binding",
      bindingStrength: "user+agent+client",
      requireUser: true,
      requireAgent: true,
      requireClient: true
    });

    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: key,
      context: { namespace: "tenant-b", userId: "user-a", agentId: "agent-a", clientId: "client-a" }
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_namespace_mismatch" });
    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: key,
      context: { namespace: "tenant-a" }
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_user_missing" });
    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: key,
      context: { namespace: "tenant-a", userId: "user-b" }
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_user_mismatch" });
    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: key,
      context: { namespace: "tenant-a", userId: "user-a" }
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_agent_missing" });
    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: key,
      context: { namespace: "tenant-a", userId: "user-a", agentId: "agent-b" }
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_agent_mismatch" });
    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: key,
      context: { namespace: "tenant-a", userId: "user-a", agentId: "agent-a" }
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_client_missing" });
    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: key,
      context: { namespace: "tenant-a", userId: "user-a", agentId: "agent-a", clientId: "client-b" }
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_client_mismatch" });
    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: key,
      context: { namespace: "tenant-a", userId: "user-a", agentId: "agent-a", clientId: "client-a" }
    })).resolves.toMatchObject({
      ok: true,
      applicable: true,
      reasonCode: "capability_binding_valid",
      credentialId: "cred-binding"
    });

    const expiredKey: any = createCapabilityKey();
    await guard.bindCapabilityKey({
      capabilityKey: expiredKey,
      credentialId: "cred-binding-expired",
      context: { namespace: "tenant-a" },
      issuedAt: "2000-01-01T00:00:00.000Z",
      expiresAt: "2000-01-01T00:00:01.000Z"
    });
    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: expiredKey,
      context: { namespace: "tenant-a" },
      now: "2000-01-01T00:00:02.000Z"
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "binding_expired",
      credentialId: "cred-binding-expired"
    });

    await expect(guard.invalidateCapabilityKeyBinding({ capabilityKey: "", credentialId: "" })).resolves.toEqual([]);
    await expect(guard.invalidateCapabilityKeyBinding({ credentialId: "cred-binding", reason: "revoked" }))
      .resolves.toHaveLength(1);
    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: key,
      context: { namespace: "tenant-a", userId: "user-a", agentId: "agent-a", clientId: "client-a" }
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "binding_invalid",
      credentialId: "cred-binding"
    });

    await expect(guard.exportRecoveryPackage({ passphrase: "" })).rejects.toThrow(/requires a passphrase/);
    const recoveryPackage: any = await guard.exportRecoveryPackage({
      passphrase: "guard recovery secret",
      reason: "coverage"
    });
    expect(recoveryPackage).toMatchObject({
      protocolVersion: "v0.0.1:risk-control:capability-binding-guard-recovery-1",
      alias: "guard-local"
    });
    await expect(guard.importRecoveryPackage({
      recoveryPackage: { protocolVersion: "wrong" },
      passphrase: "guard recovery secret"
    })).rejects.toThrow(/Unsupported capability binding guard recovery package/);

    const importedGuard: any = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir: root,
      alias: "guard-imported"
    });
    await expect(importedGuard.importRecoveryPackage({
      recoveryPackage,
      passphrase: "guard recovery secret"
    })).resolves.toMatchObject({
      ok: true,
      alias: "guard-imported",
      provider: "local-file"
    });
    await expect(importedGuard.describe()).resolves.toMatchObject({
      provider: "local-file",
      securityMode: "degraded_file_fallback",
      degraded: true
    });

    guard.close();
    importedGuard.close();
  });
});

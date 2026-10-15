import { describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("Meshrix CLI security provider ownership", () => {
  it("waits for both child-backed providers to close before the command settles", async () => {
    vi.resetModules();
    const keyStarted = deferred<void>();
    const guardStarted = deferred<void>();
    const releaseKey = deferred<void>();
    const releaseGuard = deferred<void>();
    const keyFinished = deferred<void>();
    const guardFinished = deferred<void>();

    vi.doMock("@meshrix/foundation/security/authorization/opaque-capability-key", () => ({
      capabilityKernelStatePath: () => "fixture-state",
      createOpaqueCapabilityKeyProvider: () => ({
        async describe() { return { securityMode: "fixture" }; },
        async close() {
          keyStarted.resolve();
          await releaseKey.promise;
          keyFinished.resolve();
        }
      })
    }));
    vi.doMock("@meshrix/foundation/security/authorization/capability-binding-guard", () => ({
      capabilityBindingGuardStatePath: () => "fixture-state",
      createCapabilityBindingGuard: () => ({
        async describe() { return { securityMode: "fixture" }; },
        async close() {
          guardStarted.resolve();
          await releaseGuard.promise;
          guardFinished.resolve();
        }
      })
    }));
    vi.doMock("../../../apps/server/bin/lib/meshrix-cli-common.ts", () => ({
      readJsonInput: async () => ({}),
      readStdinText: async () => "",
      trimOneTrailingNewline: (value: unknown) => String(value ?? ""),
      writeResponse: async () => undefined
    }));

    try {
      const { runSecurityCommand } = await import("../../../apps/server/bin/lib/meshrix-cli-security.ts");
      let settled = false;
      const command = runSecurityCommand({ _: ["security", "capability-kernel", "status"] })
        .then(() => { settled = true; });

      await Promise.all([keyStarted.promise, guardStarted.promise]);
      releaseKey.resolve();
      await keyFinished.promise;
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseGuard.resolve();
      await guardFinished.promise;
      await command;
      expect(settled).toBe(true);
    } finally {
      releaseKey.resolve();
      releaseGuard.resolve();
      vi.doUnmock("@meshrix/foundation/security/authorization/opaque-capability-key");
      vi.doUnmock("@meshrix/foundation/security/authorization/capability-binding-guard");
      vi.doUnmock("../../../apps/server/bin/lib/meshrix-cli-common.ts");
      vi.resetModules();
    }
  });
});

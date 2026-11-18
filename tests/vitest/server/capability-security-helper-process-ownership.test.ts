import { afterEach, describe, expect, it, vi } from "vitest";

const spawnHarness: any = vi.hoisted(() => {
  class MiniEmitter {
    handlers = new Map<any, any[]>();

    on(event: any, handler: any) {
      const handlers = this.handlers.get(event) || [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    once(event: any, handler: any) {
      const wrapped = (...args: any[]) => {
        this.off(event, wrapped);
        handler(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: any, handler: any) {
      this.handlers.set(event, (this.handlers.get(event) || []).filter((current) => current !== handler));
      return this;
    }

    emit(event: any, ...args: any[]) {
      for (const handler of [...(this.handlers.get(event) || [])]) handler(...args);
    }
  }

  const harness: any = {
    children: [],
    spawn: null
  };
  harness.spawn = vi.fn(() => {
    const child: any = new MiniEmitter();
    child.stdout = new MiniEmitter();
    child.stderr = new MiniEmitter();
    child.stdin = new MiniEmitter();
    child.stdin.end = vi.fn();
    child.kill = vi.fn(() => true);
    harness.children.push(child);
    return child;
  });
  return harness;
});

vi.mock("node:child_process", () => ({ spawn: spawnHarness.spawn }));

import { createCommandCapabilitySecurityClient } from "../../../packages/foundation/src/security/authorization/capability-security-helper-client.ts";
import { createMemoryCapabilityKeyBindingStore } from "../../../packages/foundation/src/security/authorization/opaque-capability-key-store.ts";
import { createOpaqueCapabilityKeyProvider } from "../../../packages/foundation/src/security/authorization/opaque-capability-key-provider.ts";
import { createProcessIdentityService } from "../../../packages/foundation/src/security/process-identity/index.ts";

const clients: Array<{ close: () => Promise<void> }> = [];
const providers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  spawnHarness.closeOnKill = true;
  for (const child of spawnHarness.children) child.emit("close", 0, null);
  await Promise.allSettled([
    ...clients.splice(0).map((client) => client.close()),
    ...providers.splice(0).map((provider) => provider.close())
  ]);
  spawnHarness.children.length = 0;
  vi.useRealTimers();
});

describe("capability helper subprocess ownership", () => {
  it("does not apply an unselected activity timeout", async () => {
    vi.useFakeTimers();
    const client = createCommandCapabilitySecurityClient({ command: "synthetic-helper" });
    clients.push(client);
    const result = client.describe();
    await Promise.resolve();
    await Promise.resolve();
    const child = spawnHarness.children[0];

    await vi.advanceTimersByTimeAsync(30_001);
    expect(child.kill).not.toHaveBeenCalled();

    child.stdout.emit("data", Buffer.from('{"status":"ready"}'));
    child.emit("close", 0, null);
    await expect(result).resolves.toEqual({ status: "ready" });
  });

  it("waits for an explicitly cancelled helper to exit before closing", async () => {
    const client = createCommandCapabilitySecurityClient({ command: "synthetic-helper" });
    clients.push(client);
    const request = client.issue({ requestId: "fixture" });
    await Promise.resolve();
    await Promise.resolve();
    const child = spawnHarness.children[0];
    const closing = client.close();
    let closeSettled = false;
    void closing.then(() => { closeSettled = true; });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    child.emit("close", null, "SIGTERM");

    await expect(request).rejects.toThrow("Capability security helper was cancelled by its owner.");
    await closing;
    expect(closeSettled).toBe(true);
  });

  it("preserves an explicitly selected caller budget until child exit", async () => {
    vi.useFakeTimers();
    const client = createCommandCapabilitySecurityClient({ command: "synthetic-helper", timeoutMs: 25 });
    clients.push(client);
    const request = client.describe();
    await Promise.resolve();
    await Promise.resolve();
    const child = spawnHarness.children[0];
    let requestSettled = false;
    void request.then(() => { requestSettled = true; }, () => { requestSettled = true; });

    await vi.advanceTimersByTimeAsync(25);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(requestSettled).toBe(false);
    child.emit("close", null, "SIGTERM");
    await expect(request).rejects.toThrow("Capability security helper exceeded its caller-selected budget.");
  });

  it("admits only one owned helper process at a time without dropping queued requests", async () => {
    const client = createCommandCapabilitySecurityClient({ command: "synthetic-helper" });
    clients.push(client);
    const first = client.describe();
    const second = client.verify({ requestId: "queued" });
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnHarness.children).toHaveLength(1);

    const firstChild = spawnHarness.children[0];
    firstChild.stdout.emit("data", Buffer.from('{"first":true}'));
    firstChild.emit("close", 0, null);
    const firstResult = await Promise.race([
      first,
      new Promise((resolve) => setTimeout(() => resolve("synthetic-timeout"), 500))
    ]);
    expect(firstResult).toEqual({ first: true });
    await vi.waitFor(() => expect(spawnHarness.children).toHaveLength(2), { timeout: 500 });

    const secondChild = spawnHarness.children[1];
    secondChild.stdout.emit("data", Buffer.from('{"second":true}'));
    secondChild.emit("close", 0, null);
    await expect(second).resolves.toEqual({ second: true });
  });

  it("keeps output bounded and omits helper output from failures", async () => {
    const client = createCommandCapabilitySecurityClient({ command: "synthetic-helper" });
    clients.push(client);
    const result = client.describe();
    await Promise.resolve();
    await Promise.resolve();
    const child = spawnHarness.children[0];
    child.stdout.emit("data", Buffer.alloc(1024 * 1024 + 1, 0x41));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.stderr.emit("data", Buffer.from("synthetic-sensitive-helper-output"));
    child.emit("close", null, "SIGTERM");

    const outputFailure = await result.catch((error: Error) => error);
    expect(outputFailure.message).toBe("Capability security helper exceeded the output limit.");
    expect(outputFailure.message).not.toContain("synthetic-sensitive-helper-output");

    const failedRequest = client.verify();
    const failingChild = await vi.waitFor(() => {
      expect(spawnHarness.children).toHaveLength(2);
      return spawnHarness.children[1];
    });
    failingChild.stderr.emit("data", Buffer.from("synthetic-sensitive-helper-output"));
    failingChild.emit("close", 9, null);
    const commandFailure = await failedRequest.catch((error: Error) => error);
    expect(commandFailure.message).toBe("Capability security helper failed.");
    expect(commandFailure.message).not.toContain("synthetic-sensitive-helper-output");
  });

  it("keeps provider ownership until its active lookup helper exits", async () => {
    const provider = createOpaqueCapabilityKeyProvider({
      backend: "external-command",
      bindingStore: createMemoryCapabilityKeyBindingStore(),
      command: "synthetic-helper"
    });
    providers.push(provider);
    const issue = provider.issue();
    await vi.waitFor(() => expect(spawnHarness.children).toHaveLength(1));
    const child = spawnHarness.children[0];
    const closing = provider.close();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await expect(issue).rejects.toThrow("Opaque capability key helper was cancelled by its owner.");
    await closing;
  });

  it("waits for provider shutdown before releasing process-identity ownership", async () => {
    let releaseProvider: (() => void) | null = null;
    let closeSettled = false;
    const service = createProcessIdentityService({
      capabilityKeyProvider: { close: () => new Promise<void>((resolve) => { releaseProvider = resolve; }) } as any,
      capabilityBindingGuard: { close() {} } as any
    });
    const closing = service.close();
    void closing.then(() => { closeSettled = true; });

    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseProvider?.();
    await closing;
    expect(closeSettled).toBe(true);
  });
});

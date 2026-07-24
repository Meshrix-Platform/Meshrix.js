import { beforeEach, describe, expect, it, vi } from "vitest";

const createMountManagerMock = vi.hoisted(() => vi.fn());
const createStorageKernelMock = vi.hoisted(() => vi.fn());
const createLockManagerAsyncMock = vi.hoisted(() => vi.fn());
const createClientRegistryServiceMock = vi.hoisted(() => vi.fn());

vi.mock("../../../packages/foundation/src/module-system/mount-manager.mjs", () => ({
  createMountManager: createMountManagerMock
}));

vi.mock("../../../packages/foundation/src/module-system/mount-config.mjs", () => ({
  getMountConfigPath: vi.fn(() => "<mount-config>"),
  getMountConfigPaths: vi.fn(() => ["<mount-config>"])
}));

vi.mock("../../../packages/foundation/src/storage/storage-kernel.mjs", () => ({
  createStorageKernel: createStorageKernelMock
}));

vi.mock("../../../packages/foundation/src/concurrency/lock-manager.mjs", () => ({
  createLockManagerAsync: createLockManagerAsyncMock
}));

vi.mock("../../../packages/server-runtime/src/state/client-registry-service.mjs", () => ({
  createClientRegistryService: createClientRegistryServiceMock
}));

import { createServerRuntime } from "../../../packages/server-runtime/src/module-runtime/server-runtime.mjs";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("server runtime construction unwind", () => {
  it("closes storage when client-registry construction fails", async () => {
    const storageKernel = { db: {}, close: vi.fn() };
    createStorageKernelMock.mockReturnValue(storageKernel);
    createClientRegistryServiceMock.mockImplementation(() => {
      throw new Error("client registry initialization failed");
    });

    await expect(createServerRuntime({ userDataPath: "<user-data>" }))
      .rejects.toThrow("client registry initialization failed");

    expect(storageKernel.close).toHaveBeenCalledOnce();
    expect(createLockManagerAsyncMock).not.toHaveBeenCalled();
    expect(createMountManagerMock).not.toHaveBeenCalled();
  });

  it("unwinds every earlier stage when lock-manager construction fails", async () => {
    const storageKernel = { db: {}, close: vi.fn() };
    const clientRegistryService = { close: vi.fn() };
    createStorageKernelMock.mockReturnValue(storageKernel);
    createClientRegistryServiceMock.mockReturnValue(clientRegistryService);
    createLockManagerAsyncMock.mockRejectedValue(new Error("lock initialization failed"));

    await expect(createServerRuntime({ userDataPath: "<user-data>" }))
      .rejects.toThrow("lock initialization failed");

    expect(clientRegistryService.close).toHaveBeenCalledOnce();
    expect(storageKernel.close).toHaveBeenCalledOnce();
    expect(createMountManagerMock).not.toHaveBeenCalled();
  });
});

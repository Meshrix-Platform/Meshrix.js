import { beforeEach, describe, expect, it, vi } from "vitest";

const createMountManagerMock: any = vi.hoisted(() : any => vi.fn());
const createStorageKernelMock: any = vi.hoisted(() : any => vi.fn());
const createLockManagerAsyncMock: any = vi.hoisted(() : any => vi.fn());
const createClientRegistryServiceMock: any = vi.hoisted(() : any => vi.fn());

vi.mock("#meshrix/foundation/module-system/mount-manager", () : any => ({
  createMountManager: createMountManagerMock
}));

vi.mock("#meshrix/foundation/module-system/mount-config", () : any => ({
  getMountConfigPath: vi.fn(() : any => "<mount-config>"),
  getMountConfigPaths: vi.fn(() : any => ["<mount-config>"])
}));

vi.mock("#meshrix/foundation/storage/storage-kernel", () : any => ({
  createStorageKernel: createStorageKernelMock
}));

vi.mock("#meshrix/foundation/concurrency/lock-manager", () : any => ({
  createLockManagerAsync: createLockManagerAsyncMock
}));

vi.mock("../../../packages/server-runtime/src/state/client-registry-service.ts", () : any => ({
  createClientRegistryService: createClientRegistryServiceMock
}));

import { createServerRuntime } from "../../../packages/server-runtime/src/module-runtime/server-runtime.ts";

beforeEach(() : any => {
  vi.clearAllMocks();
});

describe("server runtime construction unwind", () : any => {
  it("closes storage when client-registry construction fails", async () : Promise<any> => {
    const storageKernel: Record<string, any> = { db: {}, close: vi.fn() };
    createStorageKernelMock.mockReturnValue(storageKernel);
    createClientRegistryServiceMock.mockImplementation(() : any => {
      throw new Error("client registry initialization failed");
    });

    await expect(createServerRuntime({ userDataPath: "<user-data>" }))
      .rejects.toThrow("client registry initialization failed");

    expect(storageKernel.close).toHaveBeenCalledOnce();
    expect(createLockManagerAsyncMock).not.toHaveBeenCalled();
    expect(createMountManagerMock).not.toHaveBeenCalled();
  });

  it("unwinds every earlier stage when lock-manager construction fails", async () : Promise<any> => {
    const storageKernel: Record<string, any> = { db: {}, close: vi.fn() };
    const clientRegistryService: Record<string, any> = { close: vi.fn() };
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

import fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertPrivateStorageCapacity,
  PrivateStorageCapacityError
} from "../../../packages/foundation/src/storage/private-storage-capacity.ts";

const MINIMUM_RESERVE_BYTES = 64 * 1024 * 1024;
let rootPath = "";

beforeEach(async () => {
  rootPath = await mkdtemp(path.join(tmpdir(), "meshrix-private-storage-capacity-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(rootPath, { recursive: true, force: true });
});

describe("assertPrivateStorageCapacity", () => {
  it("uses filesystem block availability and the 64 MiB minimum reserve", async () => {
    const additionalBytes = 1024;
    const requiredBytes = MINIMUM_RESERVE_BYTES + additionalBytes;
    const statfs = vi.spyOn(fs, "statfs").mockResolvedValue({
      bavail: BigInt(requiredBytes / 512),
      bsize: 512n
    } as Awaited<ReturnType<typeof fs.statfs>>);

    await expect(assertPrivateStorageCapacity(rootPath, additionalBytes)).resolves.toBeUndefined();

    expect(statfs).toHaveBeenCalledWith(rootPath, { bigint: true });
  });

  it("uses ten percent of this write and reports a typed recoverable capacity error", async () => {
    const additionalBytes = 1024 * 1024 * 1024;
    const reserveBytes = 107_374_183;
    const requiredBytes = additionalBytes + reserveBytes;
    const availableBytes = requiredBytes - 1;
    vi.spyOn(fs, "statfs").mockResolvedValue({
      bavail: BigInt(availableBytes),
      bsize: 1n
    } as Awaited<ReturnType<typeof fs.statfs>>);

    const failure = await assertPrivateStorageCapacity(rootPath, additionalBytes).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PrivateStorageCapacityError);
    expect(failure).toMatchObject({
      name: "PrivateStorageCapacityError",
      code: "private_storage_capacity",
      reasonCode: "private_storage_capacity",
      additionalBytes,
      requiredBytes,
      availableBytes,
      reserveBytes
    });
  });

  it("propagates the filesystem statfs error unchanged", async () => {
    const statfsError = Object.assign(new Error("statfs failed"), { code: "EIO" });
    vi.spyOn(fs, "statfs").mockRejectedValue(statfsError);

    await expect(assertPrivateStorageCapacity(rootPath, 1)).rejects.toBe(statfsError);
  });

  it("rejects invalid byte counts before querying the filesystem", async () => {
    const statfs = vi.spyOn(fs, "statfs");

    await expect(assertPrivateStorageCapacity(rootPath, -1)).rejects.toBeInstanceOf(RangeError);
    await expect(assertPrivateStorageCapacity(rootPath, 1.5)).rejects.toBeInstanceOf(RangeError);
    await expect(assertPrivateStorageCapacity(rootPath, Number.MAX_SAFE_INTEGER + 1))
      .rejects.toBeInstanceOf(RangeError);
    await expect(assertPrivateStorageCapacity(rootPath, Number.MAX_SAFE_INTEGER))
      .rejects.toBeInstanceOf(RangeError);

    expect(statfs).not.toHaveBeenCalled();
  });

  it("compares very large filesystem capacities with bigint arithmetic", async () => {
    vi.spyOn(fs, "statfs").mockResolvedValue({
      bavail: 1n << 60n,
      bsize: 4096n
    } as Awaited<ReturnType<typeof fs.statfs>>);

    await expect(assertPrivateStorageCapacity(rootPath, 4096)).resolves.toBeUndefined();
  });
});

import fs from "node:fs/promises";

const MINIMUM_FREE_SPACE_RESERVE_BYTES = 64n * 1024n * 1024n;
const MAX_SAFE_BYTES = BigInt(Number.MAX_SAFE_INTEGER);

export class PrivateStorageCapacityError extends Error {
  readonly additionalBytes: number;
  readonly requiredBytes: number;
  readonly availableBytes: number;
  readonly reserveBytes: number;
  readonly code = "private_storage_capacity";
  readonly reasonCode = this.code;

  constructor(
    additionalBytes: number,
    requiredBytes: number,
    availableBytes: number,
    reserveBytes: number
  ) {
    super("Private storage has insufficient free space for this write.");
    this.name = "PrivateStorageCapacityError";
    this.additionalBytes = additionalBytes;
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
    this.reserveBytes = reserveBytes;
  }
}

/**
 * Check free space before writing new durable data.
 *
 * `additionalBytes` is the exact total byte count of the serialized or temporary
 * file contents this operation will write. `rootPath` must already exist on the
 * target filesystem; this function does not create directories or reserve space.
 * The caller still handles write-time ENOSPC and retains its pending/WAL state.
 */
export async function assertPrivateStorageCapacity(
  rootPath: string,
  additionalBytes: number
): Promise<void> {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) {
    throw new RangeError("additionalBytes must be a nonnegative safe integer.");
  }

  const additionalBytesBigInt = BigInt(additionalBytes);
  const percentageReserveBytes = (additionalBytesBigInt + 9n) / 10n;
  const reserveBytesBigInt = percentageReserveBytes > MINIMUM_FREE_SPACE_RESERVE_BYTES
    ? percentageReserveBytes
    : MINIMUM_FREE_SPACE_RESERVE_BYTES;
  const requiredBytesBigInt = additionalBytesBigInt + reserveBytesBigInt;
  if (requiredBytesBigInt > MAX_SAFE_BYTES) {
    throw new RangeError("Private storage capacity request exceeds safe byte arithmetic.");
  }

  const stats = await fs.statfs(rootPath, { bigint: true });
  const availableBytesBigInt = stats.bavail * stats.bsize;
  if (availableBytesBigInt < requiredBytesBigInt) {
    throw new PrivateStorageCapacityError(
      additionalBytes,
      Number(requiredBytesBigInt),
      Number(availableBytesBigInt),
      Number(reserveBytesBigInt)
    );
  }
}

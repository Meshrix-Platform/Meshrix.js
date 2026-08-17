import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { Hash } from "node:crypto";
import fsSync from "node:fs";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type PlainRecord = Record<string, unknown>;
type Guard = (() => unknown | Promise<unknown>) | null;
interface WorkerFailure extends Error {
  code?: string;
}
export interface FsIdentity {
  birthtimeNs: string;
  dev: string;
  ino: string;
  mode: number;
}
interface WorkerConfiguration {
  byteCount: number;
  contentDigest: string;
  parentIdentity: FsIdentity;
  preparedContentVerified: boolean;
  preparedIdentity: FsIdentity | null;
  targetLeaf: string;
  tempLeaf: string;
}
interface WorkerNames {
  intentReservation: boolean;
  temp: boolean;
  target: boolean;
}
interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
  timer: NodeJS.Timeout;
}
interface DirectoryWorkerOptions {
  parentPath?: string;
  parentIdentity?: unknown;
  preparedContentVerified?: boolean;
  preparedIdentity?: unknown;
  targetLeaf?: unknown;
  tempLeaf?: unknown;
  contentDigest?: unknown;
  byteCount?: unknown;
}
export interface MaterializationDirectoryWorker {
  reserve(): Promise<{ preparedIdentity: FsIdentity }>;
  write(chunk: Buffer): Promise<{ copiedBytes: number }>;
  finish(): Promise<{ contentDigest: string; preparedIdentity: FsIdentity }>;
  link(): Promise<{ linked: true; preparedIdentity: FsIdentity }>;
  finishPublish(): Promise<{ published: true; preparedIdentity: FsIdentity }>;
  verify(): Promise<{
    byteCount: number;
    contentDigest: string;
    preparedIdentity: FsIdentity;
    nlink: number;
  }>;
  inspectPublished(): Promise<{ preparedIdentity: FsIdentity; nlink: number }>;
  inspectRecovery(): Promise<
    WorkerNames & { preparedIdentity: FsIdentity | null }
  >;
  cleanup(): Promise<{ cleaned: true }>;
  readChunks(): AsyncGenerator<Buffer, void, void>;
  close(): Promise<void>;
  terminate(): void;
}
function plainRecord(value: unknown): PlainRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as PlainRecord)
    : null;
}
function failure(value: unknown): WorkerFailure | null {
  return value instanceof Error ? (value as WorkerFailure) : null;
}

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_CHUNK_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const TEMP_LEAF_PATTERN =
  /^\.meshrix-materialization-[A-Za-z0-9_-]{16,128}(?:\.tmp)?$/u;

function requiredOpenFlag(name: string): number {
  const value = (fsSync.constants as Record<string, number | undefined>)[name];
  if (!Number.isInteger(value)) {
    throw workerError(
      "materialization_platform_unsupported",
      `Required file-open flag ${name} is unavailable.`,
    );
  }
  return Number(value);
}

function workerError(code: string, message: string): WorkerFailure {
  return Object.assign(new Error(message), { code });
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is PlainRecord {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"),
  );
}

function safeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw workerError(
      "materialization_file_worker_protocol_invalid",
      `${label} is invalid.`,
    );
  }
  return number;
}

function digest(value: unknown, label: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw workerError(
      "materialization_file_worker_protocol_invalid",
      `${label} is invalid.`,
    );
  }
  return normalized;
}

function leaf(
  value: unknown,
  { temporary = false }: { temporary?: boolean } = {},
): string {
  const normalized = String(value || "");
  if (
    !normalized ||
    normalized.length > 255 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    (temporary && !TEMP_LEAF_PATTERN.test(normalized))
  ) {
    throw workerError(
      "materialization_file_worker_protocol_invalid",
      "Materialization leaf name is invalid.",
    );
  }
  return normalized;
}

function statMode(stat: BigIntStats): number {
  return Number(
    typeof stat.mode === "bigint" ? stat.mode & 0o7777n : stat.mode & 0o7777,
  );
}

function statSize(stat: BigIntStats): bigint {
  return typeof stat.size === "bigint" ? stat.size : BigInt(stat.size);
}

function statIdentity(stat: BigIntStats): FsIdentity {
  const birthtimeNs =
    typeof stat.birthtimeNs === "bigint"
      ? stat.birthtimeNs
      : BigInt(
          Math.max(0, Math.trunc(Number(stat.birthtimeMs || 0) * 1_000_000)),
        );
  return Object.freeze({
    birthtimeNs: String(birthtimeNs),
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: statMode(stat),
  });
}

function normalizeIdentity(
  value: unknown,
  label = "Materialization identity",
): FsIdentity {
  if (!exactObject(value, ["birthtimeNs", "dev", "ino", "mode"])) {
    throw workerError(
      "materialization_file_worker_protocol_invalid",
      `${label} is invalid.`,
    );
  }
  const normalized: Readonly<FsIdentity> = Object.freeze({
    birthtimeNs: String(value.birthtimeNs || ""),
    dev: String(value.dev || ""),
    ino: String(value.ino || ""),
    mode: safeInteger(value.mode, `${label} mode`),
  });
  if (
    !/^\d+$/u.test(normalized.birthtimeNs) ||
    !/^\d+$/u.test(normalized.dev) ||
    !/^\d+$/u.test(normalized.ino)
  ) {
    throw workerError(
      "materialization_file_worker_protocol_invalid",
      `${label} is invalid.`,
    );
  }
  return normalized;
}

function sameIdentity(stat: BigIntStats, identity: FsIdentity): boolean {
  const observed = statIdentity(stat);
  return (
    observed.birthtimeNs === identity.birthtimeNs &&
    observed.dev === identity.dev &&
    observed.ino === identity.ino &&
    observed.mode === identity.mode
  );
}

function assertPrivateFile(
  stat: BigIntStats,
  {
    identity = null,
    byteCount = null,
    nlink = null,
  }: {
    identity?: FsIdentity | null;
    byteCount?: number | null;
    nlink?: number | null;
  } = {},
): void {
  if (
    !stat?.isFile?.() ||
    stat?.isSymbolicLink?.() ||
    statMode(stat) !== PRIVATE_FILE_MODE ||
    (Number.isInteger(process.geteuid?.()) &&
      Number(stat.uid) !== process.geteuid?.()) ||
    (Number.isInteger(process.getegid?.()) &&
      Number(stat.gid) !== process.getegid?.()) ||
    (identity && !sameIdentity(stat, identity)) ||
    (byteCount !== null && statSize(stat) !== BigInt(byteCount)) ||
    (nlink !== null && Number(stat.nlink) !== nlink)
  ) {
    throw workerError(
      "materialization_target_identity_mismatch",
      "Materialization file identity is not exact.",
    );
  }
}

function assertPrivateParent(stat: BigIntStats, identity: FsIdentity): void {
  if (
    !stat?.isDirectory?.() ||
    stat?.isSymbolicLink?.() ||
    statMode(stat) !== PRIVATE_DIRECTORY_MODE ||
    (Number.isInteger(process.geteuid?.()) &&
      Number(stat.uid) !== process.geteuid?.()) ||
    (Number.isInteger(process.getegid?.()) &&
      Number(stat.gid) !== process.getegid?.()) ||
    !sameIdentity(stat, identity)
  ) {
    throw workerError(
      "materialization_parent_identity_mismatch",
      "Materialization parent identity is not exact.",
    );
  }
}

async function lstatOrMissing(candidate: string): Promise<BigIntStats | null> {
  try {
    return await fs.lstat(candidate, { bigint: true });
  } catch (error: unknown) {
    if (failure(error)?.code === "ENOENT") return null;
    throw error;
  }
}

async function hashHandle(
  handle: FileHandle,
  guard: Guard = null,
): Promise<{ byteCount: number; contentDigest: string }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(MAX_CHUNK_BYTES);
  let position = 0;
  while (true) {
    await guard?.();
    const result = await handle.read(buffer, 0, buffer.byteLength, position);
    const bytesRead = Number(result.bytesRead || 0);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return {
    byteCount: position,
    contentDigest: hash.digest("hex"),
  };
}

async function syncCurrentDirectory(): Promise<void> {
  const flags =
    requiredOpenFlag("O_RDONLY") |
    requiredOpenFlag("O_DIRECTORY") |
    requiredOpenFlag("O_NOFOLLOW");
  const handle = await fs.open(".", flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function normalizeWorkerConfiguration(value: unknown): WorkerConfiguration {
  if (
    !exactObject(value, [
      "byteCount",
      "contentDigest",
      "parentIdentity",
      "preparedContentVerified",
      "preparedIdentity",
      "targetLeaf",
      "tempLeaf",
    ])
  ) {
    throw workerError(
      "materialization_file_worker_protocol_invalid",
      "Materialization worker configuration is invalid.",
    );
  }
  if (
    typeof value.preparedContentVerified !== "boolean" ||
    (value.preparedContentVerified && value.preparedIdentity === null)
  ) {
    throw workerError(
      "materialization_file_worker_protocol_invalid",
      "Materialization prepared-content state is invalid.",
    );
  }
  return Object.freeze({
    byteCount: safeInteger(value.byteCount, "Materialization byte count"),
    contentDigest: digest(value.contentDigest, "Materialization digest"),
    parentIdentity: normalizeIdentity(
      value.parentIdentity,
      "Materialization parent identity",
    ),
    preparedContentVerified: value.preparedContentVerified,
    preparedIdentity:
      value.preparedIdentity === null
        ? null
        : normalizeIdentity(
            value.preparedIdentity,
            "Materialization prepared identity",
          ),
    targetLeaf: leaf(value.targetLeaf),
    tempLeaf: leaf(value.tempLeaf, { temporary: true }),
  });
}

async function runChildWorker(): Promise<void> {
  let configuration: WorkerConfiguration;
  let fileHandle: FileHandle | null = null;
  let fileIdentity: FsIdentity | null = null;
  let copiedBytes = 0;
  let streamHash: Hash = createHash("sha256");
  let linked = false;
  let recoveryByteCount: number | null = null;

  const closeHandle = async (): Promise<void> => {
    const handle = fileHandle;
    fileHandle = null;
    await handle?.close?.();
  };

  const assertCurrentParent = async (): Promise<BigIntStats> => {
    if (!configuration)
      throw workerError(
        "materialization_file_worker_protocol_invalid",
        "Materialization worker is not configured.",
      );
    const parentStat = await fs.stat(".", { bigint: true });
    assertPrivateParent(parentStat, configuration.parentIdentity);
    return parentStat;
  };

  const assertReservedTopology = async (
    byteCount = copiedBytes,
  ): Promise<BigIntStats> => {
    if (!configuration || !fileHandle || !fileIdentity)
      throw workerError(
        "materialization_file_worker_protocol_invalid",
        "Materialization worker is not reserved.",
      );
    const [opened, parentStat, tempStat, targetStat] = await Promise.all([
      fileHandle.stat({ bigint: true }),
      fs.stat(".", { bigint: true }),
      lstatOrMissing(configuration.tempLeaf),
      lstatOrMissing(configuration.targetLeaf),
    ]);
    assertPrivateParent(parentStat, configuration.parentIdentity);
    if (!tempStat || targetStat) {
      throw workerError(
        "materialization_target_identity_mismatch",
        "Reserved materialization names are not exact.",
      );
    }
    for (const candidate of [opened, tempStat]) {
      assertPrivateFile(candidate, {
        identity: fileIdentity,
        byteCount,
        nlink: 1,
      });
    }
    return opened;
  };

  const assertLinkedTopology = async (): Promise<BigIntStats> => {
    if (!configuration || !fileHandle || !fileIdentity)
      throw workerError(
        "materialization_file_worker_protocol_invalid",
        "Materialization worker is not linked.",
      );
    const [opened, parentStat, tempStat, targetStat] = await Promise.all([
      fileHandle.stat({ bigint: true }),
      fs.stat(".", { bigint: true }),
      lstatOrMissing(configuration.tempLeaf),
      lstatOrMissing(configuration.targetLeaf),
    ]);
    assertPrivateParent(parentStat, configuration.parentIdentity);
    if (!tempStat || !targetStat) {
      throw workerError(
        "materialization_target_identity_mismatch",
        "Linked materialization names are not exact.",
      );
    }
    for (const candidate of [opened, tempStat, targetStat]) {
      assertPrivateFile(candidate, {
        identity: fileIdentity,
        byteCount: configuration.byteCount,
        nlink: 2,
      });
    }
    return opened;
  };

  const assertPublishedTopology = async (): Promise<BigIntStats> => {
    if (!configuration || !fileHandle || !fileIdentity)
      throw workerError(
        "materialization_file_worker_protocol_invalid",
        "Materialization worker is not published.",
      );
    const [opened, parentStat, tempStat, targetStat] = await Promise.all([
      fileHandle.stat({ bigint: true }),
      fs.stat(".", { bigint: true }),
      lstatOrMissing(configuration.tempLeaf),
      lstatOrMissing(configuration.targetLeaf),
    ]);
    assertPrivateParent(parentStat, configuration.parentIdentity);
    if (tempStat || !targetStat) {
      throw workerError(
        "materialization_target_identity_mismatch",
        "Published materialization names are not exact.",
      );
    }
    for (const candidate of [opened, targetStat]) {
      assertPrivateFile(candidate, {
        identity: fileIdentity,
        byteCount: configuration.byteCount,
        nlink: 1,
      });
    }
    return opened;
  };

  const openRecoveryHandle = async (): Promise<WorkerNames> => {
    if (!configuration)
      throw workerError(
        "materialization_file_worker_protocol_invalid",
        "Materialization worker is not configured.",
      );
    await assertCurrentParent();
    const tempStat = await lstatOrMissing(configuration.tempLeaf);
    const targetStat = await lstatOrMissing(configuration.targetLeaf);
    const present: Array<[string, BigIntStats]> = [
      [configuration.tempLeaf, tempStat],
      [configuration.targetLeaf, targetStat],
    ].filter((entry): entry is [string, BigIntStats] => entry[1] !== null);
    const recoveryIdentity = configuration.preparedIdentity || fileIdentity;
    if (!recoveryIdentity) {
      if (targetStat) {
        throw workerError(
          "materialization_recovery_identity_missing",
          "An unowned materialization inode is present.",
        );
      }
      if (!tempStat) {
        return {
          intentReservation: false,
          temp: false,
          target: false,
        };
      }
      throw workerError(
        "materialization_recovery_identity_missing",
        "An identityless materialization inode cannot be adopted.",
      );
    }
    if (present.length === 0) {
      return {
        intentReservation: false,
        temp: false,
        target: false,
      };
    }
    if (
      configuration.preparedIdentity &&
      !configuration.preparedContentVerified &&
      targetStat
    ) {
      throw workerError(
        "materialization_target_identity_mismatch",
        "An unverified reservation cannot own the publication target.",
      );
    }
    const requiredLinks = present.length;
    const exactRecoveryBytes =
      configuration.preparedIdentity && configuration.preparedContentVerified
        ? configuration.byteCount
        : configuration.preparedIdentity
          ? null
          : copiedBytes;
    for (const [, stat] of present) {
      assertPrivateFile(stat, {
        identity: recoveryIdentity,
        byteCount: exactRecoveryBytes,
        nlink: requiredLinks,
      });
      if (
        exactRecoveryBytes === null &&
        statSize(stat) > BigInt(configuration.byteCount)
      ) {
        throw workerError(
          "materialization_target_identity_mismatch",
          "Reserved materialization size exceeds its binding.",
        );
      }
    }
    recoveryByteCount = exactRecoveryBytes ?? Number(statSize(present[0][1]));
    await closeHandle();
    const flags = requiredOpenFlag("O_RDONLY") | requiredOpenFlag("O_NOFOLLOW");
    fileHandle = await fs.open(present[0][0], flags);
    const openedStat = await fileHandle.stat({ bigint: true });
    assertPrivateFile(openedStat, {
      identity: recoveryIdentity,
      byteCount: recoveryByteCount,
      nlink: requiredLinks,
    });
    const assertRecoveryTopology = async (): Promise<void> => {
      if (!configuration || !fileHandle)
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization recovery handle is unavailable.",
        );
      const [currentOpened, parentStat, currentTemp, currentTarget] =
        await Promise.all([
          fileHandle.stat({ bigint: true }),
          fs.stat(".", { bigint: true }),
          lstatOrMissing(configuration.tempLeaf),
          lstatOrMissing(configuration.targetLeaf),
        ]);
      assertPrivateParent(parentStat, configuration.parentIdentity);
      if (
        Boolean(currentTemp) !== Boolean(tempStat) ||
        Boolean(currentTarget) !== Boolean(targetStat)
      ) {
        throw workerError(
          "materialization_target_identity_mismatch",
          "Materialization recovery names changed while opening.",
        );
      }
      for (const candidate of [currentTemp, currentTarget].filter(
        (value): value is BigIntStats => value !== null,
      )) {
        assertPrivateFile(candidate, {
          identity: recoveryIdentity,
          byteCount: recoveryByteCount,
          nlink: requiredLinks,
        });
      }
      assertPrivateFile(currentOpened, {
        identity: recoveryIdentity,
        byteCount: recoveryByteCount,
        nlink: requiredLinks,
      });
    };
    await assertRecoveryTopology();
    if (
      configuration.preparedIdentity &&
      configuration.preparedContentVerified
    ) {
      const observed = await hashHandle(fileHandle, assertRecoveryTopology);
      await assertRecoveryTopology();
      if (
        observed.byteCount !== configuration.byteCount ||
        observed.contentDigest !== configuration.contentDigest
      ) {
        throw workerError(
          "materialization_upload_digest_mismatch",
          "Recovered materialization content is not exact.",
        );
      }
    }
    fileIdentity = recoveryIdentity;
    return {
      intentReservation: false,
      temp: Boolean(tempStat),
      target: Boolean(targetStat),
    };
  };

  const handlers: Readonly<
    Record<string, (payload: unknown) => Promise<unknown>>
  > = Object.freeze({
    async configure(payload: unknown) {
      if (configuration) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization worker is already configured.",
        );
      }
      configuration = normalizeWorkerConfiguration(payload);
      const parentStat = await fs.stat(".", { bigint: true });
      assertPrivateParent(parentStat, configuration.parentIdentity);
      return { parentIdentity: statIdentity(parentStat) };
    },
    async reserve(payload: unknown) {
      if (!exactObject(payload, [])) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization reserve request is invalid.",
        );
      }
      if (!configuration || fileHandle) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization worker cannot reserve an inode.",
        );
      }
      await assertCurrentParent();
      const [existingTemp, existingTarget] = await Promise.all([
        lstatOrMissing(configuration.tempLeaf),
        lstatOrMissing(configuration.targetLeaf),
      ]);
      if (existingTemp || existingTarget) {
        throw workerError(
          "materialization_target_identity_mismatch",
          "Materialization names must be absent before reservation.",
        );
      }
      const flags =
        requiredOpenFlag("O_RDWR") |
        requiredOpenFlag("O_CREAT") |
        requiredOpenFlag("O_EXCL") |
        requiredOpenFlag("O_NOFOLLOW");
      try {
        fileHandle = await fs.open(
          configuration.tempLeaf,
          flags,
          PRIVATE_FILE_MODE,
        );
        await fileHandle.chmod(PRIVATE_FILE_MODE);
        const stat = await fileHandle.stat({ bigint: true });
        assertPrivateFile(stat, { byteCount: 0, nlink: 1 });
        fileIdentity = statIdentity(stat);
        copiedBytes = 0;
        streamHash = createHash("sha256");
        await assertReservedTopology(0);
        return { preparedIdentity: fileIdentity };
      } catch (error: unknown) {
        await closeHandle().catch(() => {});
        throw error;
      }
    },
    async write(payload: unknown) {
      if (
        !exactObject(payload, ["chunk"]) ||
        !Buffer.isBuffer(payload.chunk) ||
        payload.chunk.byteLength < 1 ||
        payload.chunk.byteLength > MAX_CHUNK_BYTES ||
        !fileHandle ||
        linked
      ) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization write request is invalid.",
        );
      }
      if (copiedBytes + payload.chunk.byteLength > configuration.byteCount) {
        throw workerError(
          "materialization_upload_digest_mismatch",
          "Materialization stream exceeded its byte bound.",
        );
      }
      await assertReservedTopology(copiedBytes);
      let written = 0;
      while (written < payload.chunk.byteLength) {
        const result = await fileHandle.write(
          payload.chunk,
          written,
          payload.chunk.byteLength - written,
          null,
        );
        const bytesWritten = Number(result.bytesWritten || 0);
        if (
          bytesWritten < 1 ||
          bytesWritten > payload.chunk.byteLength - written
        ) {
          throw workerError(
            "materialization_write_incomplete",
            "Materialization write made no progress.",
          );
        }
        written += bytesWritten;
      }
      await assertReservedTopology(copiedBytes + payload.chunk.byteLength);
      streamHash.update(payload.chunk);
      copiedBytes += payload.chunk.byteLength;
      return { copiedBytes };
    },
    async finish(payload: unknown) {
      if (!exactObject(payload, []) || !fileHandle || linked) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization finish request is invalid.",
        );
      }
      const observedDigest = streamHash.digest("hex");
      if (
        copiedBytes !== configuration.byteCount ||
        observedDigest !== configuration.contentDigest
      ) {
        throw workerError(
          "materialization_upload_digest_mismatch",
          "Materialization stream does not match its binding.",
        );
      }
      await assertReservedTopology(configuration.byteCount);
      await fileHandle.sync();
      await assertReservedTopology(configuration.byteCount);
      const descriptorContent = await hashHandle(fileHandle, () =>
        assertReservedTopology(configuration.byteCount).then(() => undefined),
      );
      await assertReservedTopology(configuration.byteCount);
      if (
        descriptorContent.byteCount !== configuration.byteCount ||
        descriptorContent.contentDigest !== configuration.contentDigest
      ) {
        throw workerError(
          "materialization_upload_digest_mismatch",
          "Materialization descriptor content does not match its binding.",
        );
      }
      return {
        contentDigest: observedDigest,
        preparedIdentity: fileIdentity,
      };
    },
    async link(payload: unknown) {
      if (!exactObject(payload, []) || !fileHandle || linked) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization link request is invalid.",
        );
      }
      await assertReservedTopology(configuration.byteCount);
      await fs.link(configuration.tempLeaf, configuration.targetLeaf);
      await assertLinkedTopology();
      linked = true;
      return { linked: true, preparedIdentity: fileIdentity };
    },
    async finishPublish(payload: unknown) {
      if (!exactObject(payload, []) || !fileHandle || !linked) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization publish request is invalid.",
        );
      }
      await assertLinkedTopology();
      await fs.unlink(configuration.tempLeaf);
      await assertPublishedTopology();
      await syncCurrentDirectory();
      await assertPublishedTopology();
      return { published: true, preparedIdentity: fileIdentity };
    },
    async read(payload: unknown) {
      if (!exactObject(payload, ["length", "position"]) || !fileHandle) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization read request is invalid.",
        );
      }
      const position = safeInteger(payload.position, "Read position");
      const length = Math.max(
        1,
        Math.min(safeInteger(payload.length, "Read length"), MAX_CHUNK_BYTES),
      );
      await assertPublishedTopology();
      const buffer = Buffer.allocUnsafe(length);
      const result = await fileHandle.read(buffer, 0, length, position);
      const bytesRead = Number(result.bytesRead || 0);
      await assertPublishedTopology();
      return {
        chunk: buffer.subarray(0, bytesRead),
        eof: bytesRead === 0,
      };
    },
    async verify(payload: unknown) {
      if (!exactObject(payload, []) || !fileHandle) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization verify request is invalid.",
        );
      }
      const stat = await assertPublishedTopology();
      const observed = await hashHandle(fileHandle, assertPublishedTopology);
      await assertPublishedTopology();
      if (
        observed.byteCount !== configuration.byteCount ||
        observed.contentDigest !== configuration.contentDigest
      ) {
        throw workerError(
          "materialization_upload_digest_mismatch",
          "Materialization file does not match its binding.",
        );
      }
      return {
        ...observed,
        preparedIdentity: fileIdentity,
        nlink: Number(stat.nlink),
      };
    },
    async inspectPublished(payload: unknown) {
      if (!exactObject(payload, []) || !fileHandle) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization publication inspection is invalid.",
        );
      }
      const opened = await assertPublishedTopology();
      return {
        preparedIdentity: fileIdentity,
        nlink: Number(opened.nlink),
      };
    },
    async inspectRecovery(payload: unknown) {
      if (!exactObject(payload, []) || !configuration) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization recovery request is invalid.",
        );
      }
      const names = await openRecoveryHandle();
      return {
        ...names,
        preparedIdentity: fileIdentity,
      };
    },
    async cleanup(payload: unknown) {
      if (!exactObject(payload, []) || !configuration) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization cleanup request is invalid.",
        );
      }
      const names = await openRecoveryHandle();
      if (names.target) {
        const current = await openRecoveryHandle();
        if (current.target !== true || current.temp !== names.temp) {
          throw workerError(
            "materialization_target_identity_mismatch",
            "Materialization cleanup names changed.",
          );
        }
        const stat = await fs.lstat(configuration.targetLeaf, { bigint: true });
        assertPrivateFile(stat, {
          identity: fileIdentity,
          byteCount: configuration.preparedIdentity
            ? recoveryByteCount
            : copiedBytes,
          nlink: Number(names.temp) + 1,
        });
        await fs.unlink(configuration.targetLeaf);
        await assertCurrentParent();
        const [remainingTarget, remainingTemp, opened] = await Promise.all([
          lstatOrMissing(configuration.targetLeaf),
          lstatOrMissing(configuration.tempLeaf),
          fileHandle!.stat({ bigint: true }),
        ]);
        if (remainingTarget) {
          throw workerError(
            "materialization_target_identity_mismatch",
            "Materialization target cleanup was not exact.",
          );
        }
        if (names.temp) {
          if (!remainingTemp)
            throw workerError(
              "materialization_target_identity_mismatch",
              "Materialization temporary name disappeared.",
            );
          assertPrivateFile(remainingTemp, {
            identity: fileIdentity,
            byteCount: configuration.preparedIdentity
              ? recoveryByteCount
              : copiedBytes,
            nlink: 1,
          });
          assertPrivateFile(opened, {
            identity: fileIdentity,
            byteCount: configuration.preparedIdentity
              ? recoveryByteCount
              : copiedBytes,
            nlink: 1,
          });
        } else {
          if (remainingTemp) {
            throw workerError(
              "materialization_target_identity_mismatch",
              "Materialization cleanup created an unexpected name.",
            );
          }
          assertPrivateFile(opened, {
            identity: fileIdentity,
            byteCount: configuration.preparedIdentity
              ? recoveryByteCount
              : copiedBytes,
            nlink: 0,
          });
        }
      }
      if (names.temp) {
        const current = await openRecoveryHandle();
        if (current.temp !== true || current.target !== false) {
          throw workerError(
            "materialization_target_identity_mismatch",
            "Materialization cleanup names changed.",
          );
        }
        const stat = await fs.lstat(configuration.tempLeaf, { bigint: true });
        assertPrivateFile(stat, {
          identity: fileIdentity,
          byteCount: configuration.preparedIdentity
            ? recoveryByteCount
            : copiedBytes,
          nlink: 1,
        });
        await fs.unlink(configuration.tempLeaf);
        const [opened, parentStat, remainingTemp, remainingTarget] =
          await Promise.all([
            fileHandle!.stat({ bigint: true }),
            fs.stat(".", { bigint: true }),
            lstatOrMissing(configuration.tempLeaf),
            lstatOrMissing(configuration.targetLeaf),
          ]);
        assertPrivateParent(parentStat, configuration.parentIdentity);
        if (remainingTemp || remainingTarget) {
          throw workerError(
            "materialization_target_identity_mismatch",
            "Materialization temporary cleanup was not exact.",
          );
        }
        assertPrivateFile(opened, {
          identity: fileIdentity,
          byteCount: configuration.preparedIdentity
            ? recoveryByteCount
            : copiedBytes,
          nlink: 0,
        });
      }
      await syncCurrentDirectory();
      await assertCurrentParent();
      await closeHandle();
      return { cleaned: true };
    },
    async close(payload: unknown) {
      if (!exactObject(payload, [])) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization close request is invalid.",
        );
      }
      await closeHandle();
      return { closed: true };
    },
  });

  process.on("message", async (message: unknown): Promise<void> => {
    const record = plainRecord(message);
    const id = Number(record?.id);
    const command = String(record?.command || "");
    try {
      if (
        !exactObject(message, ["command", "id", "payload"]) ||
        !Number.isSafeInteger(id) ||
        id < 1 ||
        typeof handlers[command] !== "function"
      ) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization worker request is invalid.",
        );
      }
      const result = await handlers[command](record!.payload);
      if (command === "close") {
        await new Promise<void>((resolve) => {
          if (typeof process.send !== "function") {
            resolve();
            return;
          }
          process.send({ id, ok: true, result }, () => resolve());
        });
        if (typeof process.disconnect === "function") {
          await new Promise<void>((resolve) => {
            process.once("disconnect", resolve);
            process.disconnect();
          });
        }
        process.exit(0);
        return;
      }
      process.send?.({ id, ok: true, result });
    } catch (error: unknown) {
      const observed = failure(error);
      const observedCode = String(observed?.code || "");
      const controlled = observedCode.startsWith("materialization_");
      process.send?.({
        id: Number.isSafeInteger(id) ? id : 0,
        ok: false,
        error: {
          code: (controlled
            ? observedCode
            : "materialization_file_worker_syscall_failed"
          ).slice(0, 128),
          message: (controlled
            ? String(observed?.message || "Materialization file worker failed.")
            : "Materialization file worker syscall failed."
          ).slice(0, 512),
        },
      });
    }
  });
}

function responseError(value: unknown): WorkerFailure {
  const record = plainRecord(value);
  return workerError(
    String(record?.code || "materialization_file_worker_failed"),
    String(record?.message || "Materialization file worker failed."),
  );
}

export async function createMaterializationDirectoryWorker({
  parentPath,
  parentIdentity,
  preparedContentVerified = false,
  preparedIdentity = null,
  targetLeaf,
  tempLeaf,
  contentDigest,
  byteCount,
}: DirectoryWorkerOptions = {}): Promise<MaterializationDirectoryWorker> {
  const configuration = normalizeWorkerConfiguration({
    byteCount,
    contentDigest,
    parentIdentity,
    preparedContentVerified,
    preparedIdentity,
    targetLeaf,
    tempLeaf,
  });
  const child: ChildProcess = fork(fileURLToPath(import.meta.url), [], {
    cwd: String(parentPath || ""),
    env: {
      LANG: "C",
      MESHRIX_MATERIALIZATION_FILE_WORKER: "1",
    },
    execArgv: [],
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, PendingRequest>();
  const childClosed = new Promise<void>((resolve) => {
    child.once("close", resolve);
  });

  const rejectPending = (error: unknown): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  child.on("message", (message: unknown) => {
    const record = plainRecord(message);
    const id = Number(record?.id);
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (
      !exactObject(message, ["id", "ok", "result"]) &&
      !exactObject(message, ["error", "id", "ok"])
    ) {
      entry.reject(
        workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization worker response is invalid.",
        ),
      );
      return;
    }
    if (record?.ok === true) entry.resolve(record.result);
    else entry.reject(responseError(record?.error));
  });
  child.on("error", () => {
    rejectPending(
      workerError(
        "materialization_file_worker_unavailable",
        "Materialization file worker is unavailable.",
      ),
    );
  });
  child.on("exit", (code, signal) => {
    closed = true;
    rejectPending(
      workerError(
        "materialization_file_worker_exited",
        `Materialization file worker exited (${signal || code || 0}).`,
      ),
    );
  });

  const request = (
    command: string,
    payload: PlainRecord = {},
  ): Promise<unknown> => {
    if (closed || !child.connected) {
      return Promise.reject(
        workerError(
          "materialization_file_worker_exited",
          "Materialization file worker is not connected.",
        ),
      );
    }
    const id = nextId;
    nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          workerError(
            "materialization_file_worker_timeout",
            "Materialization file worker timed out.",
          ),
        );
        child.kill("SIGKILL");
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, { reject, resolve, timer });
      child.send?.({ id, command, payload }, (error) => {
        if (!error) return;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(
          workerError(
            "materialization_file_worker_unavailable",
            "Materialization file worker is unavailable.",
          ),
        );
      });
    });
  };

  try {
    const configured = plainRecord(
      await request("configure", { ...configuration }),
    );
    if (
      JSON.stringify(configured?.parentIdentity) !==
      JSON.stringify(configuration.parentIdentity)
    ) {
      throw workerError(
        "materialization_parent_identity_mismatch",
        "Materialization parent identity changed before worker binding.",
      );
    }
  } catch (error: unknown) {
    child.kill("SIGKILL");
    await childClosed;
    throw error;
  }

  const typedRequest = async <Result>(
    command: string,
    payload: PlainRecord = {},
  ): Promise<Result> => (await request(command, payload)) as Result;
  const api: MaterializationDirectoryWorker = {
    reserve: () => typedRequest("reserve"),
    write: (chunk) => typedRequest("write", { chunk }),
    finish: () => typedRequest("finish"),
    link: () => typedRequest("link"),
    finishPublish: () => typedRequest("finishPublish"),
    verify: () => typedRequest("verify"),
    inspectPublished: () => typedRequest("inspectPublished"),
    inspectRecovery: () => typedRequest("inspectRecovery"),
    cleanup: () => typedRequest("cleanup"),
    async *readChunks(): AsyncGenerator<Buffer, void, void> {
      let position = 0;
      while (true) {
        const result = plainRecord(
          await request("read", {
            length: MAX_CHUNK_BYTES,
            position,
          }),
        );
        if (result?.eof === true) return;
        if (
          !Buffer.isBuffer(result?.chunk) ||
          result.chunk.byteLength < 1 ||
          result.chunk.byteLength > MAX_CHUNK_BYTES
        ) {
          throw workerError(
            "materialization_file_worker_protocol_invalid",
            "Materialization worker emitted an invalid content chunk.",
          );
        }
        position += result.chunk.byteLength;
        yield result.chunk;
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      try {
        await request("close");
        await childClosed;
      } finally {
        closed = true;
      }
    },
    terminate(): void {
      if (closed) return;
      closed = true;
      child.kill("SIGKILL");
    },
  };
  return Object.freeze(api);
}

if (
  process.env.MESHRIX_MATERIALIZATION_FILE_WORKER === "1" &&
  typeof process.send === "function"
) {
  void runChildWorker().catch(() => process.exit(1));
}

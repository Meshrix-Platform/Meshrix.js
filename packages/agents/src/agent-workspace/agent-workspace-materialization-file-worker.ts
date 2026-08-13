import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PRIVATE_FILE_MODE: any = 0o600;
const PRIVATE_DIRECTORY_MODE: any = 0o700;
const MAX_CHUNK_BYTES: any = 64 * 1024;
const REQUEST_TIMEOUT_MS: any = 30_000;
const TEMP_LEAF_PATTERN: any =
  /^\.meshrix-materialization-[A-Za-z0-9_-]{16,128}(?:\.tmp)?$/u;

function requiredOpenFlag(name?: any) : any {
  const value: any = (fsSync.constants as Record<string, any>)[name];
  if (!Number.isInteger(value)) {
    throw workerError(
      "materialization_platform_unsupported",
      `Required file-open flag ${name} is unavailable.`
    );
  }
  return value;
}

function workerError(code?: any, message?: any) : any {
  return Object.assign(new Error(message), { code });
}

function exactObject(value?: any, keys?: any) : any {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function safeInteger(value?: any, label?: any) : any {
  const number: any = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw workerError(
      "materialization_file_worker_protocol_invalid",
      `${label} is invalid.`
    );
  }
  return number;
}

function digest(value?: any, label?: any) : any {
  const normalized: any = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw workerError(
      "materialization_file_worker_protocol_invalid",
      `${label} is invalid.`
    );
  }
  return normalized;
}

function leaf(value?: any, { temporary = false }: Record<string, any> = {}) : any {
  const normalized: any = String(value || "");
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
      "Materialization leaf name is invalid."
    );
  }
  return normalized;
}

function statMode(stat?: any) : any {
  return Number(
    typeof stat.mode === "bigint"
      ? stat.mode & 0o7777n
      : stat.mode & 0o7777
  );
}

function statSize(stat?: any) : any {
  return typeof stat.size === "bigint" ? stat.size : BigInt(stat.size);
}

function statIdentity(stat?: any) : any {
  const birthtimeNs: any = typeof stat.birthtimeNs === "bigint"
    ? stat.birthtimeNs
    : BigInt(Math.max(0, Math.trunc(Number(stat.birthtimeMs || 0) * 1_000_000)));
  return Object.freeze({
    birthtimeNs: String(birthtimeNs),
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: statMode(stat)
  });
}

function normalizeIdentity(value?: any, label: any = "Materialization identity") : any {
  if (!exactObject(value, ["birthtimeNs", "dev", "ino", "mode"])) {
    throw workerError(
      "materialization_file_worker_protocol_invalid",
      `${label} is invalid.`
    );
  }
  const normalized: Readonly<Record<string, any>> = Object.freeze({
    birthtimeNs: String(value.birthtimeNs || ""),
    dev: String(value.dev || ""),
    ino: String(value.ino || ""),
    mode: safeInteger(value.mode, `${label} mode`)
  });
  if (
    !/^\d+$/u.test(normalized.birthtimeNs) ||
    !/^\d+$/u.test(normalized.dev) ||
    !/^\d+$/u.test(normalized.ino)
  ) {
    throw workerError(
      "materialization_file_worker_protocol_invalid",
      `${label} is invalid.`
    );
  }
  return normalized;
}

function sameIdentity(stat?: any, identity?: any) : any {
  const observed: any = statIdentity(stat);
  return (
    observed.birthtimeNs === identity.birthtimeNs &&
    observed.dev === identity.dev &&
    observed.ino === identity.ino &&
    observed.mode === identity.mode
  );
}

function assertPrivateFile(stat?: any, {
  identity = null,
  byteCount = null,
  nlink = null
}: Record<string, any> = {}) : any {
  if (
    !stat?.isFile?.() ||
    stat?.isSymbolicLink?.() ||
    statMode(stat) !== PRIVATE_FILE_MODE ||
    (
      Number.isInteger(process.geteuid?.()) &&
      Number(stat.uid) !== process.geteuid?.()
    ) ||
    (
      Number.isInteger(process.getegid?.()) &&
      Number(stat.gid) !== process.getegid?.()
    ) ||
    (identity && !sameIdentity(stat, identity)) ||
    (byteCount !== null && statSize(stat) !== BigInt(byteCount)) ||
    (nlink !== null && Number(stat.nlink) !== nlink)
  ) {
    throw workerError(
      "materialization_target_identity_mismatch",
      "Materialization file identity is not exact."
    );
  }
}

function assertPrivateParent(stat?: any, identity?: any) : any {
  if (
    !stat?.isDirectory?.() ||
    stat?.isSymbolicLink?.() ||
    statMode(stat) !== PRIVATE_DIRECTORY_MODE ||
    (
      Number.isInteger(process.geteuid?.()) &&
      Number(stat.uid) !== process.geteuid?.()
    ) ||
    (
      Number.isInteger(process.getegid?.()) &&
      Number(stat.gid) !== process.getegid?.()
    ) ||
    !sameIdentity(stat, identity)
  ) {
    throw workerError(
      "materialization_parent_identity_mismatch",
      "Materialization parent identity is not exact."
    );
  }
}

async function lstatOrMissing(candidate?: any) : Promise<any> {
  try {
    return await fs.lstat(candidate, { bigint: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function hashHandle(handle?: any, guard: any = null) : Promise<any> {
  const hash: any = createHash("sha256");
  const buffer: any = Buffer.allocUnsafe(MAX_CHUNK_BYTES);
  let position: any = 0;
  while (true) {
    await guard?.();
    const result: any = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      position
    );
    const bytesRead: any = Number(result?.bytesRead || 0);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return {
    byteCount: position,
    contentDigest: hash.digest("hex")
  };
}

async function syncCurrentDirectory() : Promise<any> {
  const flags: any =
    requiredOpenFlag("O_RDONLY") |
    requiredOpenFlag("O_DIRECTORY") |
    requiredOpenFlag("O_NOFOLLOW");
  const handle: any = await fs.open(".", flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function normalizeWorkerConfiguration(value?: any) : any {
  if (
    !exactObject(value, [
      "byteCount",
      "contentDigest",
      "parentIdentity",
      "preparedContentVerified",
      "preparedIdentity",
      "targetLeaf",
      "tempLeaf"
    ])
  ) {
    throw workerError(
      "materialization_file_worker_protocol_invalid",
      "Materialization worker configuration is invalid."
    );
  }
  if (
    typeof value.preparedContentVerified !== "boolean" ||
    (
      value.preparedContentVerified &&
      value.preparedIdentity === null
    )
  ) {
    throw workerError(
      "materialization_file_worker_protocol_invalid",
      "Materialization prepared-content state is invalid."
    );
  }
  return Object.freeze({
    byteCount: safeInteger(value.byteCount, "Materialization byte count"),
    contentDigest: digest(value.contentDigest, "Materialization digest"),
    parentIdentity: normalizeIdentity(
      value.parentIdentity,
      "Materialization parent identity"
    ),
    preparedContentVerified: value.preparedContentVerified,
    preparedIdentity: value.preparedIdentity === null
      ? null
      : normalizeIdentity(
          value.preparedIdentity,
          "Materialization prepared identity"
        ),
    targetLeaf: leaf(value.targetLeaf),
    tempLeaf: leaf(value.tempLeaf, { temporary: true })
  });
}

async function runChildWorker() : Promise<any> {
  let configuration: any = null;
  let fileHandle: any = null;
  let fileIdentity: any = null;
  let copiedBytes: any = 0;
  let streamHash: any = createHash("sha256");
  let linked: any = false;
  let recoveryByteCount: any = null;

  const closeHandle: any = async () : Promise<any> => {
    const handle: any = fileHandle;
    fileHandle = null;
    await handle?.close?.();
  };

  const assertCurrentParent: any = async () : Promise<any> => {
    const parentStat: any = await fs.stat(".", { bigint: true });
    assertPrivateParent(parentStat, configuration.parentIdentity);
    return parentStat;
  };

  const assertReservedTopology: any = async (byteCount: any = copiedBytes) : Promise<any> => {
    const [opened, parentStat, tempStat, targetStat] = await Promise.all([
      fileHandle.stat({ bigint: true }),
      fs.stat(".", { bigint: true }),
      lstatOrMissing(configuration.tempLeaf),
      lstatOrMissing(configuration.targetLeaf)
    ]);
    assertPrivateParent(parentStat, configuration.parentIdentity);
    if (!tempStat || targetStat) {
      throw workerError(
        "materialization_target_identity_mismatch",
        "Reserved materialization names are not exact."
      );
    }
    for (const candidate of [opened, tempStat]) {
      assertPrivateFile(candidate, {
        identity: fileIdentity,
        byteCount,
        nlink: 1
      });
    }
    return opened;
  };

  const assertLinkedTopology: any = async () : Promise<any> => {
    const [opened, parentStat, tempStat, targetStat] = await Promise.all([
      fileHandle.stat({ bigint: true }),
      fs.stat(".", { bigint: true }),
      lstatOrMissing(configuration.tempLeaf),
      lstatOrMissing(configuration.targetLeaf)
    ]);
    assertPrivateParent(parentStat, configuration.parentIdentity);
    if (!tempStat || !targetStat) {
      throw workerError(
        "materialization_target_identity_mismatch",
        "Linked materialization names are not exact."
      );
    }
    for (const candidate of [opened, tempStat, targetStat]) {
      assertPrivateFile(candidate, {
        identity: fileIdentity,
        byteCount: configuration.byteCount,
        nlink: 2
      });
    }
    return opened;
  };

  const assertPublishedTopology: any = async () : Promise<any> => {
    const [opened, parentStat, tempStat, targetStat] = await Promise.all([
      fileHandle.stat({ bigint: true }),
      fs.stat(".", { bigint: true }),
      lstatOrMissing(configuration.tempLeaf),
      lstatOrMissing(configuration.targetLeaf)
    ]);
    assertPrivateParent(parentStat, configuration.parentIdentity);
    if (tempStat || !targetStat) {
      throw workerError(
        "materialization_target_identity_mismatch",
        "Published materialization names are not exact."
      );
    }
    for (const candidate of [opened, targetStat]) {
      assertPrivateFile(candidate, {
        identity: fileIdentity,
        byteCount: configuration.byteCount,
        nlink: 1
      });
    }
    return opened;
  };

  const openRecoveryHandle: any = async () : Promise<any> => {
    await assertCurrentParent();
    const tempStat: any = await lstatOrMissing(configuration.tempLeaf);
    const targetStat: any = await lstatOrMissing(configuration.targetLeaf);
    const present: any = [
      [configuration.tempLeaf, tempStat],
      [configuration.targetLeaf, targetStat]
    ].filter(([, stat]: any[]) : any => stat);
    const recoveryIdentity: any =
      configuration.preparedIdentity || fileIdentity;
    if (!recoveryIdentity) {
      if (targetStat) {
        throw workerError(
          "materialization_recovery_identity_missing",
          "An unowned materialization inode is present."
        );
      }
      if (!tempStat) {
        return {
          intentReservation: false,
          temp: false,
          target: false
        };
      }
      throw workerError(
        "materialization_recovery_identity_missing",
        "An identityless materialization inode cannot be adopted."
      );
    }
    if (present.length === 0) {
      return {
        intentReservation: false,
        temp: false,
        target: false
      };
    }
    if (
      configuration.preparedIdentity &&
      !configuration.preparedContentVerified &&
      targetStat
    ) {
      throw workerError(
        "materialization_target_identity_mismatch",
        "An unverified reservation cannot own the publication target."
      );
    }
    const requiredLinks: any = present.length;
    const exactRecoveryBytes: any = configuration.preparedIdentity &&
      configuration.preparedContentVerified
      ? configuration.byteCount
      : configuration.preparedIdentity
        ? null
        : copiedBytes;
    for (const [, stat] of present) {
      assertPrivateFile(stat, {
        identity: recoveryIdentity,
        byteCount: exactRecoveryBytes,
        nlink: requiredLinks
      });
      if (
        exactRecoveryBytes === null &&
        statSize(stat) > BigInt(configuration.byteCount)
      ) {
        throw workerError(
          "materialization_target_identity_mismatch",
          "Reserved materialization size exceeds its binding."
        );
      }
    }
    recoveryByteCount = exactRecoveryBytes ??
      Number(statSize(present[0][1]));
    await closeHandle();
    const flags: any =
      requiredOpenFlag("O_RDONLY") |
      requiredOpenFlag("O_NOFOLLOW");
    fileHandle = await fs.open(present[0][0], flags);
    const openedStat: any = await fileHandle.stat({ bigint: true });
    assertPrivateFile(openedStat, {
      identity: recoveryIdentity,
      byteCount: recoveryByteCount,
      nlink: requiredLinks
    });
    const assertRecoveryTopology: any = async () : Promise<any> => {
      const [currentOpened, parentStat, currentTemp, currentTarget] =
        await Promise.all([
          fileHandle.stat({ bigint: true }),
          fs.stat(".", { bigint: true }),
          lstatOrMissing(configuration.tempLeaf),
          lstatOrMissing(configuration.targetLeaf)
        ]);
      assertPrivateParent(parentStat, configuration.parentIdentity);
      if (
        Boolean(currentTemp) !== Boolean(tempStat) ||
        Boolean(currentTarget) !== Boolean(targetStat)
      ) {
        throw workerError(
          "materialization_target_identity_mismatch",
          "Materialization recovery names changed while opening."
        );
      }
      for (const candidate of [currentTemp, currentTarget].filter(Boolean)) {
        assertPrivateFile(candidate, {
          identity: recoveryIdentity,
          byteCount: recoveryByteCount,
          nlink: requiredLinks
        });
      }
      assertPrivateFile(currentOpened, {
        identity: recoveryIdentity,
        byteCount: recoveryByteCount,
        nlink: requiredLinks
      });
    };
    await assertRecoveryTopology();
    if (
      configuration.preparedIdentity &&
      configuration.preparedContentVerified
    ) {
      const observed: any = await hashHandle(
        fileHandle,
        assertRecoveryTopology
      );
      await assertRecoveryTopology();
      if (
        observed.byteCount !== configuration.byteCount ||
        observed.contentDigest !== configuration.contentDigest
      ) {
        throw workerError(
          "materialization_upload_digest_mismatch",
          "Recovered materialization content is not exact."
        );
      }
    }
    fileIdentity = recoveryIdentity;
    return {
      intentReservation: false,
      temp: Boolean(tempStat),
      target: Boolean(targetStat)
    };
  };

  const handlers: Readonly<Record<string, any>> = Object.freeze({
    async configure(payload?: any) : Promise<any> {
      if (configuration) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization worker is already configured."
        );
      }
      configuration = normalizeWorkerConfiguration(payload);
      const parentStat: any = await fs.stat(".", { bigint: true });
      assertPrivateParent(parentStat, configuration.parentIdentity);
      return { parentIdentity: statIdentity(parentStat) };
    },
    async reserve(payload?: any) : Promise<any> {
      if (!exactObject(payload, [])) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization reserve request is invalid."
        );
      }
      if (!configuration || fileHandle) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization worker cannot reserve an inode."
        );
      }
      await assertCurrentParent();
      const [existingTemp, existingTarget] = await Promise.all([
        lstatOrMissing(configuration.tempLeaf),
        lstatOrMissing(configuration.targetLeaf)
      ]);
      if (existingTemp || existingTarget) {
        throw workerError(
          "materialization_target_identity_mismatch",
          "Materialization names must be absent before reservation."
        );
      }
      const flags: any =
        requiredOpenFlag("O_RDWR") |
        requiredOpenFlag("O_CREAT") |
        requiredOpenFlag("O_EXCL") |
        requiredOpenFlag("O_NOFOLLOW");
      try {
        fileHandle = await fs.open(
          configuration.tempLeaf,
          flags,
          PRIVATE_FILE_MODE
        );
        await fileHandle.chmod(PRIVATE_FILE_MODE);
        const stat: any = await fileHandle.stat({ bigint: true });
        assertPrivateFile(stat, { byteCount: 0, nlink: 1 });
        fileIdentity = statIdentity(stat);
        copiedBytes = 0;
        streamHash = createHash("sha256");
        await assertReservedTopology(0);
        return { preparedIdentity: fileIdentity };
      } catch (error: any) {
        await closeHandle().catch(() : any => {});
        throw error;
      }
    },
    async write(payload?: any) : Promise<any> {
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
          "Materialization write request is invalid."
        );
      }
      if (
        copiedBytes + payload.chunk.byteLength >
        configuration.byteCount
      ) {
        throw workerError(
          "materialization_upload_digest_mismatch",
          "Materialization stream exceeded its byte bound."
        );
      }
      await assertReservedTopology(copiedBytes);
      let written: any = 0;
      while (written < payload.chunk.byteLength) {
        const result: any = await fileHandle.write(
          payload.chunk,
          written,
          payload.chunk.byteLength - written,
          null
        );
        const bytesWritten: any = Number(result?.bytesWritten || 0);
        if (
          bytesWritten < 1 ||
          bytesWritten > payload.chunk.byteLength - written
        ) {
          throw workerError(
            "materialization_write_incomplete",
            "Materialization write made no progress."
          );
        }
        written += bytesWritten;
      }
      await assertReservedTopology(
        copiedBytes + payload.chunk.byteLength
      );
      streamHash.update(payload.chunk);
      copiedBytes += payload.chunk.byteLength;
      return { copiedBytes };
    },
    async finish(payload?: any) : Promise<any> {
      if (!exactObject(payload, []) || !fileHandle || linked) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization finish request is invalid."
        );
      }
      const observedDigest: any = streamHash.digest("hex");
      if (
        copiedBytes !== configuration.byteCount ||
        observedDigest !== configuration.contentDigest
      ) {
        throw workerError(
          "materialization_upload_digest_mismatch",
          "Materialization stream does not match its binding."
        );
      }
      await assertReservedTopology(configuration.byteCount);
      await fileHandle.sync();
      await assertReservedTopology(configuration.byteCount);
      const descriptorContent: any = await hashHandle(
        fileHandle,
        () : any => assertReservedTopology(configuration.byteCount)
      );
      await assertReservedTopology(configuration.byteCount);
      if (
        descriptorContent.byteCount !== configuration.byteCount ||
        descriptorContent.contentDigest !== configuration.contentDigest
      ) {
        throw workerError(
          "materialization_upload_digest_mismatch",
          "Materialization descriptor content does not match its binding."
        );
      }
      return {
        contentDigest: observedDigest,
        preparedIdentity: fileIdentity
      };
    },
    async link(payload?: any) : Promise<any> {
      if (!exactObject(payload, []) || !fileHandle || linked) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization link request is invalid."
        );
      }
      await assertReservedTopology(configuration.byteCount);
      await fs.link(configuration.tempLeaf, configuration.targetLeaf);
      await assertLinkedTopology();
      linked = true;
      return { linked: true, preparedIdentity: fileIdentity };
    },
    async finishPublish(payload?: any) : Promise<any> {
      if (!exactObject(payload, []) || !fileHandle || !linked) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization publish request is invalid."
        );
      }
      await assertLinkedTopology();
      await fs.unlink(configuration.tempLeaf);
      await assertPublishedTopology();
      await syncCurrentDirectory();
      await assertPublishedTopology();
      return { published: true, preparedIdentity: fileIdentity };
    },
    async read(payload?: any) : Promise<any> {
      if (
        !exactObject(payload, ["length", "position"]) ||
        !fileHandle
      ) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization read request is invalid."
        );
      }
      const position: any = safeInteger(payload.position, "Read position");
      const length: any = Math.max(
        1,
        Math.min(
          safeInteger(payload.length, "Read length"),
          MAX_CHUNK_BYTES
        )
      );
      await assertPublishedTopology();
      const buffer: any = Buffer.allocUnsafe(length);
      const result: any = await fileHandle.read(
        buffer,
        0,
        length,
        position
      );
      const bytesRead: any = Number(result?.bytesRead || 0);
      await assertPublishedTopology();
      return {
        chunk: buffer.subarray(0, bytesRead),
        eof: bytesRead === 0
      };
    },
    async verify(payload?: any) : Promise<any> {
      if (!exactObject(payload, []) || !fileHandle) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization verify request is invalid."
        );
      }
      const stat: any = await assertPublishedTopology();
      const observed: any = await hashHandle(
        fileHandle,
        assertPublishedTopology
      );
      await assertPublishedTopology();
      if (
        observed.byteCount !== configuration.byteCount ||
        observed.contentDigest !== configuration.contentDigest
      ) {
        throw workerError(
          "materialization_upload_digest_mismatch",
          "Materialization file does not match its binding."
        );
      }
      return {
        ...observed,
        preparedIdentity: fileIdentity,
        nlink: Number(stat.nlink)
      };
    },
    async inspectPublished(payload?: any) : Promise<any> {
      if (!exactObject(payload, []) || !fileHandle) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization publication inspection is invalid."
        );
      }
      const opened: any = await assertPublishedTopology();
      return {
        preparedIdentity: fileIdentity,
        nlink: Number(opened.nlink)
      };
    },
    async inspectRecovery(payload?: any) : Promise<any> {
      if (!exactObject(payload, []) || !configuration) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization recovery request is invalid."
        );
      }
      let names: any;
      try {
        names = await openRecoveryHandle();
      } catch (error: any) {
        throw error;
      }
      return {
        ...names,
        preparedIdentity: fileIdentity
      };
    },
    async cleanup(payload?: any) : Promise<any> {
      if (!exactObject(payload, []) || !configuration) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization cleanup request is invalid."
        );
      }
      const names: any = await openRecoveryHandle();
      if (names.target) {
        const current: any = await openRecoveryHandle();
        if (
          current.target !== true ||
          current.temp !== names.temp
        ) {
          throw workerError(
            "materialization_target_identity_mismatch",
            "Materialization cleanup names changed."
          );
        }
        const stat: any = await fs.lstat(
          configuration.targetLeaf,
          { bigint: true }
        );
        assertPrivateFile(stat, {
          identity: fileIdentity,
          byteCount: configuration.preparedIdentity
            ? recoveryByteCount
            : copiedBytes,
          nlink: Number(names.temp) + 1
        });
        await fs.unlink(configuration.targetLeaf);
        await assertCurrentParent();
        const [remainingTarget, remainingTemp, opened] =
          await Promise.all([
            lstatOrMissing(configuration.targetLeaf),
            lstatOrMissing(configuration.tempLeaf),
            fileHandle.stat({ bigint: true })
          ]);
        if (remainingTarget) {
          throw workerError(
            "materialization_target_identity_mismatch",
            "Materialization target cleanup was not exact."
          );
        }
        if (names.temp) {
          assertPrivateFile(remainingTemp, {
            identity: fileIdentity,
            byteCount: configuration.preparedIdentity
              ? recoveryByteCount
              : copiedBytes,
            nlink: 1
          });
          assertPrivateFile(opened, {
            identity: fileIdentity,
            byteCount: configuration.preparedIdentity
              ? recoveryByteCount
              : copiedBytes,
            nlink: 1
          });
        } else {
          if (remainingTemp) {
            throw workerError(
              "materialization_target_identity_mismatch",
              "Materialization cleanup created an unexpected name."
            );
          }
          assertPrivateFile(opened, {
            identity: fileIdentity,
            byteCount: configuration.preparedIdentity
              ? recoveryByteCount
              : copiedBytes,
            nlink: 0
          });
        }
      }
      if (names.temp) {
        const current: any = await openRecoveryHandle();
        if (current.temp !== true || current.target !== false) {
          throw workerError(
            "materialization_target_identity_mismatch",
            "Materialization cleanup names changed."
          );
        }
        const stat: any = await fs.lstat(
          configuration.tempLeaf,
          { bigint: true }
        );
        assertPrivateFile(stat, {
          identity: fileIdentity,
          byteCount: configuration.preparedIdentity
            ? recoveryByteCount
            : copiedBytes,
          nlink: 1
        });
        await fs.unlink(configuration.tempLeaf);
        const [opened, parentStat, remainingTemp, remainingTarget] =
          await Promise.all([
            fileHandle.stat({ bigint: true }),
            fs.stat(".", { bigint: true }),
            lstatOrMissing(configuration.tempLeaf),
            lstatOrMissing(configuration.targetLeaf)
          ]);
        assertPrivateParent(parentStat, configuration.parentIdentity);
        if (remainingTemp || remainingTarget) {
          throw workerError(
            "materialization_target_identity_mismatch",
            "Materialization temporary cleanup was not exact."
          );
        }
        assertPrivateFile(opened, {
          identity: fileIdentity,
          byteCount: configuration.preparedIdentity
            ? recoveryByteCount
            : copiedBytes,
          nlink: 0
        });
      }
      await syncCurrentDirectory();
      await assertCurrentParent();
      await closeHandle();
      return { cleaned: true };
    },
    async close(payload?: any) : Promise<any> {
      if (!exactObject(payload, [])) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization close request is invalid."
        );
      }
      await closeHandle();
      return { closed: true };
    }
  });

  process.on("message", async (message?: any) : Promise<any> => {
    const id: any = Number(message?.id);
    const command: any = String(message?.command || "");
    try {
      if (
        !exactObject(message, ["command", "id", "payload"]) ||
        !Number.isSafeInteger(id) ||
        id < 1 ||
        typeof handlers[command] !== "function"
      ) {
        throw workerError(
          "materialization_file_worker_protocol_invalid",
          "Materialization worker request is invalid."
        );
      }
      const result: any = await handlers[command](message.payload);
      if (command === "close") {
        await new Promise((resolve?: any) : any => {
          if (typeof process.send !== "function") {
            resolve();
            return;
          }
          process.send({ id, ok: true, result }, () : any => resolve());
        });
        if (typeof process.disconnect === "function") {
          await new Promise((resolve?: any) : any => {
            process.once("disconnect", resolve);
            process.disconnect();
          });
        }
        process.exit(0);
        return;
      }
      process.send?.({ id, ok: true, result });
    } catch (error: any) {
      const observedCode: any = String(error?.code || "");
      const controlled: any = observedCode.startsWith("materialization_");
      process.send?.({
        id: Number.isSafeInteger(id) ? id : 0,
        ok: false,
        error: {
          code: (
            controlled
              ? observedCode
              : "materialization_file_worker_syscall_failed"
          ).slice(0, 128),
          message: (
            controlled
              ? String(error?.message || "Materialization file worker failed.")
              : "Materialization file worker syscall failed."
          ).slice(0, 512)
        }
      });
    }
  });
}

function responseError(value?: any) : any {
  return workerError(
    String(value?.code || "materialization_file_worker_failed"),
    String(value?.message || "Materialization file worker failed.")
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
  byteCount
}: Record<string, any> = {}) : Promise<any> {
  const configuration: any = normalizeWorkerConfiguration({
    byteCount,
    contentDigest,
    parentIdentity,
    preparedContentVerified,
    preparedIdentity,
    targetLeaf,
    tempLeaf
  });
  const child: any = fork(fileURLToPath(import.meta.url), [], {
    cwd: String(parentPath || ""),
    env: {
      LANG: "C",
      MESHRIX_MATERIALIZATION_FILE_WORKER: "1"
    },
    execArgv: [],
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  let nextId: any = 1;
  let closed: any = false;
  const pending: any = new Map<any, any>();
  const childClosed: any = new Promise((resolve?: any) : any => {
    child.once("close", resolve);
  });

  const rejectPending: any = (error?: any) : any => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  child.on("message", (message?: any) : any => {
    const id: any = Number(message?.id);
    const entry: any = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (
      !exactObject(message, ["id", "ok", "result"]) &&
      !exactObject(message, ["error", "id", "ok"])
    ) {
      entry.reject(workerError(
        "materialization_file_worker_protocol_invalid",
        "Materialization worker response is invalid."
      ));
      return;
    }
    if (message.ok === true) entry.resolve(message.result);
    else entry.reject(responseError(message.error));
  });
  child.on("error", () : any => {
    rejectPending(workerError(
      "materialization_file_worker_unavailable",
      "Materialization file worker is unavailable."
    ));
  });
  child.on("exit", (code?: any, signal?: any) : any => {
    closed = true;
    rejectPending(workerError(
      "materialization_file_worker_exited",
      `Materialization file worker exited (${signal || code || 0}).`
    ));
  });

  const request: any = (command?: any, payload: Record<string, any> = {}) : any => {
    if (closed || !child.connected) {
      return Promise.reject(workerError(
        "materialization_file_worker_exited",
        "Materialization file worker is not connected."
      ));
    }
    const id: any = nextId;
    nextId += 1;
    return new Promise((resolve?: any, reject?: any) : any => {
      const timer: any = setTimeout(() : any => {
        pending.delete(id);
        reject(workerError(
          "materialization_file_worker_timeout",
          "Materialization file worker timed out."
        ));
        child.kill("SIGKILL");
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, { reject, resolve, timer });
      child.send({ id, command, payload }, (error?: any) : any => {
        if (!error) return;
        const entry: any = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(workerError(
          "materialization_file_worker_unavailable",
          "Materialization file worker is unavailable."
        ));
      });
    });
  };

  try {
    const configured: any = await request("configure", configuration);
    if (
      JSON.stringify(configured?.parentIdentity) !==
      JSON.stringify(configuration.parentIdentity)
    ) {
      throw workerError(
        "materialization_parent_identity_mismatch",
        "Materialization parent identity changed before worker binding."
      );
    }
  } catch (error: any) {
    child.kill("SIGKILL");
    await childClosed;
    throw error;
  }

  const api: Record<string, any> = {
    reserve: () : any => request("reserve"),
    write: (chunk?: any) : any => request("write", { chunk }),
    finish: () : any => request("finish"),
    link: () : any => request("link"),
    finishPublish: () : any => request("finishPublish"),
    verify: () : any => request("verify"),
    inspectPublished: () : any => request("inspectPublished"),
    inspectRecovery: () : any => request("inspectRecovery"),
    cleanup: () : any => request("cleanup"),
    async *readChunks() : AsyncGenerator<any, any, any> {
      let position: any = 0;
      while (true) {
        const result: any = await request("read", {
          length: MAX_CHUNK_BYTES,
          position
        });
        if (result?.eof === true) return;
        if (
          !Buffer.isBuffer(result?.chunk) ||
          result.chunk.byteLength < 1 ||
          result.chunk.byteLength > MAX_CHUNK_BYTES
        ) {
          throw workerError(
            "materialization_file_worker_protocol_invalid",
            "Materialization worker emitted an invalid content chunk."
          );
        }
        position += result.chunk.byteLength;
        yield result.chunk;
      }
    },
    async close() : Promise<any> {
      if (closed) return;
      try {
        await request("close");
        await childClosed;
      } finally {
        closed = true;
      }
    },
    terminate() : any {
      if (closed) return;
      closed = true;
      child.kill("SIGKILL");
    }
  };
  return Object.freeze(api);
}

if (
  process.env.MESHRIX_MATERIALIZATION_FILE_WORKER === "1" &&
  typeof process.send === "function"
) {
  void runChildWorker().catch(() : any => process.exit(1));
}

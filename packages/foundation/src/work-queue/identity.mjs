import { randomBytes } from "node:crypto";
import { systemQueueTimeSource } from "./time-source.mjs";

const UUID_V7_RANDOM_BYTES = 10;
const UUID_V7_MAX_TIMESTAMP = (1n << 48n) - 1n;

function toByte(value) {
  return Number(value & 0xffn);
}

export function formatUuidBytes(bytes) {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createUuidV7({ timeSource = systemQueueTimeSource, randomBytesFn = randomBytes } = {}) {
  const nowMs = BigInt(Math.max(0, Math.trunc(Number(timeSource.nowMs()))));
  const timestamp = nowMs > UUID_V7_MAX_TIMESTAMP ? UUID_V7_MAX_TIMESTAMP : nowMs;
  const entropy = Buffer.from(randomBytesFn(UUID_V7_RANDOM_BYTES));
  if (entropy.length < UUID_V7_RANDOM_BYTES) {
    throw new Error("UUIDv7 entropy source returned too few bytes.");
  }

  const bytes = Buffer.alloc(16);
  bytes[0] = toByte(timestamp >> 40n);
  bytes[1] = toByte(timestamp >> 32n);
  bytes[2] = toByte(timestamp >> 24n);
  bytes[3] = toByte(timestamp >> 16n);
  bytes[4] = toByte(timestamp >> 8n);
  bytes[5] = toByte(timestamp);
  entropy.copy(bytes, 6, 0, UUID_V7_RANDOM_BYTES);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuidBytes(bytes);
}

export const QUEUE_ID_PREFIXES = Object.freeze({
  workItem: "wqwi",
  lease: "wqls",
  journalEntry: "wqje",
  subscription: "wqsub",
  queueDefinition: "wqdef",
  worker: "wqwrk",
  fallbackTask: "wqfb",
  snapshot: "wqsnap"
});

export function createQueueIdentityGenerator({
  timeSource = systemQueueTimeSource,
  randomBytesFn = randomBytes,
  prefixes = QUEUE_ID_PREFIXES
} = {}) {
  function uuid() {
    return createUuidV7({ timeSource, randomBytesFn });
  }

  function id(kind) {
    const prefix = prefixes[kind];
    if (!prefix) {
      throw new Error(`Unknown queue identity kind: ${kind}`);
    }
    return `${prefix}_${uuid()}`;
  }

  return Object.freeze({
    uuid,
    id,
    workItemId: () => id("workItem"),
    leaseId: () => id("lease"),
    journalEntryId: () => id("journalEntry"),
    subscriptionId: () => id("subscription"),
    queueDefinitionId: () => id("queueDefinition"),
    workerId: () => id("worker"),
    fallbackTaskId: () => id("fallbackTask"),
    snapshotId: () => id("snapshot")
  });
}

export const queueIdentityGenerator = createQueueIdentityGenerator();

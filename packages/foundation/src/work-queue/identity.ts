import { randomBytes } from "node:crypto";
import { systemQueueTimeSource } from "./time-source.ts";

const UUID_V7_RANDOM_BYTES: any = 10;
const UUID_V7_MAX_TIMESTAMP: any = (1n << 48n) - 1n;

function toByte(value?: any) : any {
  return Number(value & 0xffn);
}

export function formatUuidBytes(bytes?: any) : any {
  const hex: any = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createUuidV7({ timeSource = systemQueueTimeSource, randomBytesFn = randomBytes }: Record<string, any> = {}) : any {
  const nowMs: any = BigInt(Math.max(0, Math.trunc(Number(timeSource.nowMs()))));
  const timestamp: any = nowMs > UUID_V7_MAX_TIMESTAMP ? UUID_V7_MAX_TIMESTAMP : nowMs;
  const entropy: any = Buffer.from(randomBytesFn(UUID_V7_RANDOM_BYTES));
  if (entropy.length < UUID_V7_RANDOM_BYTES) {
    throw new Error("UUIDv7 entropy source returned too few bytes.");
  }

  const bytes: any = Buffer.alloc(16);
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

export const QUEUE_ID_PREFIXES: Readonly<Record<string, any>> = Object.freeze({
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
}: Record<string, any> = {}) : any {
  function uuid() : any {
    return createUuidV7({ timeSource, randomBytesFn });
  }

  function id(kind?: any) : any {
    const prefix: any = prefixes[kind];
    if (!prefix) {
      throw new Error(`Unknown queue identity kind: ${kind}`);
    }
    return `${prefix}_${uuid()}`;
  }

  return Object.freeze({
    uuid,
    id,
    workItemId: () : any => id("workItem"),
    leaseId: () : any => id("lease"),
    journalEntryId: () : any => id("journalEntry"),
    subscriptionId: () : any => id("subscription"),
    queueDefinitionId: () : any => id("queueDefinition"),
    workerId: () : any => id("worker"),
    fallbackTaskId: () : any => id("fallbackTask"),
    snapshotId: () : any => id("snapshot")
  });
}

export const queueIdentityGenerator: any = createQueueIdentityGenerator();

import { normalizeService } from "./support.ts";

const DEFAULT_POLL_INTERVAL_MS: any = 500;
const MANIFEST_DIGEST: any = /^[a-f0-9]{64}$/u;

function assertRecordIdentity(record?: any) : any {
  if (typeof record?.serviceId !== "string" || !record.serviceId.startsWith("svc_")) {
    throw new Error("Upstream manifest record identity is invalid.");
  }
  if (!Number.isSafeInteger(record.serviceRevision) || record.serviceRevision < 1) {
    throw new Error("Upstream manifest record revision is invalid.");
  }
  if (typeof record.manifestDigest !== "string" || !MANIFEST_DIGEST.test(record.manifestDigest)) {
    throw new Error("Upstream manifest record digest is invalid.");
  }
}

function assertUniqueOperations(service?: any) : any {
  const keys: any = new Set<any>();
  for (const operation of service.operations) {
    if (keys.has(operation.operationKey)) {
      throw new Error("Upstream manifest operation identities must be unique within a service.");
    }
    keys.add(operation.operationKey);
  }
}

function deepFreezeRuntimeValue(value?: any) : any {
  if (!value || typeof value !== "object") return value;
  for (const nested of (Object.values(value) as any[])) deepFreezeRuntimeValue(nested);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function runtimeServiceFromRecord(record?: any) : any {
  assertRecordIdentity(record);
  const state: any = record?.manifest?.payload?.state;
  if (state === "removed") return null;
  const descriptor: any = record?.manifest?.payload?.descriptor;
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("Upstream manifest descriptor is unavailable.");
  }
  if (descriptor.serviceProtocol !== "mcp" &&
      (!Array.isArray(descriptor.operations) || descriptor.operations.length === 0)) {
    throw new Error("Upstream manifest requires at least one explicit operation before runtime publication.");
  }
  const credentialReferences: any = record.manifest.references
    .filter((reference?: any) : any => reference.type === "credential")
    .map((reference?: any) : any => Object.freeze({
      ...reference,
      ...(reference.scopes ? { scopes: Object.freeze([...reference.scopes]) } : {})
    }));
  const credentialRefs: any = credentialReferences.map((reference?: any) : any => reference.reference);
  const service: any = normalizeService({
    ...descriptor,
    serviceId: record.serviceId,
    credentialRefs,
    credentialReferences,
    disabled: state === "disabled",
    updatedAt: `revision-${record.serviceRevision}`
  }, {});
  if (service.serviceId !== record.serviceId) {
    throw new Error("Upstream manifest record identity changed during projection.");
  }
  assertUniqueOperations(service);
  return deepFreezeRuntimeValue({
    ...service,
    createdAt: `revision-${record.serviceRevision}`,
    updatedAt: `revision-${record.serviceRevision}`,
    credentialReferences: service.credentialReferences.map((reference?: any) : any => ({
      ...reference,
      scopes: [...reference.scopes]
    })),
    manifestDigest: record.manifestDigest,
    serviceRevision: record.serviceRevision
  });
}

function immutableRuntimeSnapshot(storageSnapshot?: any) : any {
  const records: any = storageSnapshot.listServices();
  if (!Array.isArray(records)) {
    throw new Error("Upstream manifest service listing is invalid.");
  }
  if (!Number.isSafeInteger(storageSnapshot.serviceCount) || storageSnapshot.serviceCount < 0 ||
      storageSnapshot.serviceCount !== records.length) {
    throw new Error("Upstream manifest service count does not match its listing.");
  }
  const services: any = new Map<any, any>();
  for (const record of records) {
    if (services.has(record?.serviceId)) {
      throw new Error("Upstream manifest service identities must be unique within a set.");
    }
    const service: any = runtimeServiceFromRecord(record);
    services.set(record.serviceId, service);
  }
  const serviceEntries: any = Object.freeze(
    [...services.entries()]
      .filter(([, service]: any[]) : any => service !== null)
      .map(([serviceId, service]: any[]) : any => Object.freeze([serviceId, service]))
  );
  return Object.freeze({
    setRevision: storageSnapshot.setRevision,
    setDigest: storageSnapshot.setDigest,
    serviceEntries,
    serviceCount: serviceEntries.length
  });
}

export function createUpstreamManifestObserver({
  readerPort,
  onSnapshot,
  onError = null,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
}: Record<string, any>) : any {
  if (typeof readerPort?.getSnapshot !== "function" || typeof onSnapshot !== "function") {
    throw new TypeError("Upstream manifest observer requires a reader port and snapshot callback.");
  }
  const interval: any = Math.max(10, Math.min(Number(pollIntervalMs || DEFAULT_POLL_INTERVAL_MS), 60_000));
  let acceptedSetRevision: any = -1;
  let acceptedSetDigest: any = "";
  let building: any = false;
  let pending: any = false;
  let closed: any = false;
  let timer: any = null;
  let activeScan: any = null;
  const lifecycleAbort: any = new AbortController();

  async function report(error?: any, reasonCode?: any) : Promise<any> {
    try {
      await onError?.(Object.freeze({ reasonCode, errorCode: String(error?.code || "manifest_observation_failed") }));
    } catch {
      // Observation reporting cannot replace the retry path.
    }
  }

  function schedule(delay: any = interval) : any {
    if (closed) return;
    if (timer) {
      if (delay !== 0) return;
      clearTimeout(timer);
      timer = null;
    }
    timer = setTimeout(() : any => {
      timer = null;
      void scan().finally(() : any => schedule(interval));
    }, delay);
    timer.unref?.();
  }

  async function executeScan({ signal, force }: Record<string, any>) : Promise<any> {
    try {
      const scanSignal: any = signal
        ? AbortSignal.any([signal, lifecycleAbort.signal])
        : lifecycleAbort.signal;
      const storageSnapshot: any = await readerPort.getSnapshot({ signal: scanSignal });
      if (closed) return Object.freeze({ outcome: "closed", setRevision: acceptedSetRevision });
      if (!Number.isSafeInteger(storageSnapshot.setRevision) || storageSnapshot.setRevision < 0 ||
          typeof storageSnapshot.setDigest !== "string" || !MANIFEST_DIGEST.test(storageSnapshot.setDigest)) {
        throw new Error("Upstream manifest set identity is invalid.");
      }
      if (storageSnapshot.setRevision < acceptedSetRevision) {
        throw new Error("Upstream manifest set revision cannot move backward.");
      }
      if (storageSnapshot.setRevision === acceptedSetRevision) {
        if (storageSnapshot.setDigest !== acceptedSetDigest) {
          throw new Error("Upstream manifest set revision conflicts with its accepted digest.");
        }
        if (!force) {
          return Object.freeze({ outcome: "unchanged", setRevision: acceptedSetRevision });
        }
      }
      const candidate: any = immutableRuntimeSnapshot(storageSnapshot);
      if (closed) return Object.freeze({ outcome: "closed", setRevision: acceptedSetRevision });
      await onSnapshot(candidate);
      if (closed) return Object.freeze({ outcome: "closed", setRevision: acceptedSetRevision });
      acceptedSetRevision = candidate.setRevision;
      acceptedSetDigest = candidate.setDigest;
      return Object.freeze({
        outcome: force ? "reapplied" : "accepted",
        setRevision: acceptedSetRevision
      });
    } catch (error: any) {
      if (closed) return Object.freeze({ outcome: "closed", setRevision: acceptedSetRevision });
      await report(error, "manifest_candidate_rejected");
      return Object.freeze({ outcome: "rejected", setRevision: acceptedSetRevision });
    }
  }

  function scan({ signal, force = false }: Record<string, any> = {}) : any {
    if (closed) {
      return Promise.resolve(Object.freeze({ outcome: "closed", setRevision: acceptedSetRevision }));
    }
    if (building) {
      pending = true;
      return Promise.resolve(Object.freeze({ outcome: "coalesced", setRevision: acceptedSetRevision }));
    }
    building = true;
    activeScan = executeScan({ signal, force }).finally(() : any => {
      building = false;
      activeScan = null;
      if (pending && !closed) {
        pending = false;
        schedule(0);
      }
    });
    return activeScan;
  }

  return Object.freeze({
    async start() : Promise<any> {
      const outcome: any = await scan();
      schedule(interval);
      return outcome;
    },
    invalidate() : any {
      if (closed) return false;
      if (building) pending = true;
      else schedule(0);
      return true;
    },
    /**
     * Force the current durable snapshot through onSnapshot again.
     * Used after Operation Permission commit binding so a pre-bind gateway-only
     * accept is paired into the catalog without waiting for a new revision.
     */
    reapplyAccepted() : any {
      return scan({ force: true });
    },
    scan,
    state() : any {
      return Object.freeze({ acceptedSetRevision, acceptedSetDigest, building, pending, closed });
    },
    async close() : Promise<any> {
      if (closed) {
        await activeScan;
        return;
      }
      closed = true;
      lifecycleAbort.abort(new Error("Upstream manifest observer closed."));
      if (timer) clearTimeout(timer);
      timer = null;
      pending = false;
      await activeScan;
    }
  });
}

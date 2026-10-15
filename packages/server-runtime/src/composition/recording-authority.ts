/**
 * Enterprise recording authority: the composition root's single owner of
 * self-hosted recording configuration, the tenant-scoped durable sink stores
 * and the producer facade shared by the gateway, the dispatch runtime and the
 * Console governance surface.
 *
 * Canonical configuration source: `runtimeOptions.recording`, populated from
 * the runtime-instance JSON `recording` section (see
 * tools/server-scripts/start-server.ts) or supplied directly by hosts that
 * compose `startHttpServer`/`bootstrapServer`. Normalization happens once
 * here; no second configuration path exists downstream.
 *
 * Topology: one `RecordingGovernanceProvider` owns every tenant's
 * RecordingSinkStore beneath the configured recording root. The Console uses
 * the provider directly; producers never touch stores themselves — the
 * `recordingSink` port they receive is a tenant-routing producer facade whose
 * `session(...)` resolves the tenant's own store. A tenant without a
 * provisioned store resolves to a null producer, so absence of a published
 * policy records nothing and requires nothing — matching the contract rule
 * that an empty configuration enables no optional history.
 */
import fs from "node:fs";
import path from "node:path";

import {
  createRecordingProducer,
  recordingProducerForPort,
  sanitizeRecordingRef,
  RECORDING_PRODUCER_PROTOCOL_VERSION
} from "@meshrix/foundation/recording/producer";
import {
  RECORDING_SINK_DATABASE_FILE
} from "@meshrix/foundation/recording/sink-store";
import {
  createRecordingGovernanceProvider,
  normalizeRecordingTenantId,
  RecordingGovernanceError
} from "./console-domain/recording-governance-provider.ts";

type UnknownRecord = Record<string, unknown>;

export const RECORDING_RUNTIME_CONFIG_KEY = "recording";
export const RECORDING_DEFAULT_ROOT_DIR = "recording";
export const RECORDING_DEFAULT_SINK_ID = "recording-sink-local";
export const RECORDING_DEFAULT_POLICY_ID = "recording-policy";
export const RECORDING_DEFAULT_ISSUER_ROLE = "system";
export const RECORDING_DEFAULT_CONFIGURER_ROLES: readonly string[] =
  Object.freeze(["owner", "maintainer"]);

const RECORDING_BUDGET_KEYS: readonly string[] = Object.freeze([
  "maxRecordBytes",
  "maxContentBytes",
  "maxIndexBytes",
  "maxBufferedRecords",
  "maxPendingWrites"
]);

const RECORDING_CONFIG_KEYS: readonly string[] = Object.freeze([
  "root",
  "sinkId",
  "budgets",
  "reservationTtlMs",
  "retentionSweepMs",
  "policy"
]);

const RECORDING_POLICY_CONFIG_KEYS: readonly string[] = Object.freeze([
  "policyId",
  "issuerRole",
  "configurerRoles"
]);

/**
 * Retired recording storage markers recognized during startup. The check
 * reports locations that predate the tenant-isolated sink layout or belong to
 * superseded recording designs so operators can reconcile them deliberately;
 * it never deletes data and never stays armed as a startup gate.
 */
const RETIRED_RECORDING_MARKERS: readonly { name: string; kind: string }[] = Object.freeze([
  { name: "recordings", kind: "retired_recording_root" },
  { name: "recorded-history", kind: "retired_recording_root" },
  { name: "recording-audit.sqlite", kind: "retired_recording_store" },
  { name: "operation-recording.sqlite", kind: "retired_recording_store" },
  { name: "recording.json", kind: "retired_recording_state" }
]);

function isPlainObject(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidConfig(message: string): RecordingGovernanceError {
  return new RecordingGovernanceError("recording_config_invalid", message);
}

function safeStat(candidate: string): fs.Stats | null {
  try {
    return fs.statSync(candidate);
  } catch {
    return null;
  }
}

/**
 * Normalize `runtimeOptions.recording` into the single recording configuration
 * the self-hosted lifecycle consumes. Unknown keys, malformed budgets and
 * contradictory values fail startup honestly instead of silently diverging
 * from the enterprise's stated intent. An absent section yields the default
 * local recording layout beneath `userDataPath`.
 */
export function normalizeRecordingRuntimeConfig(
  value: unknown,
  { userDataPath }: { userDataPath?: unknown } = {}
): {
  rootPath: string;
  sinkId: string;
  budgets: UnknownRecord;
  reservationTtlMs: number | undefined;
  retentionSweepMs: number | undefined;
  policy: { policyId: string; issuerRole: string; configurerRoles: string[] };
} {
  const dataRoot = path.resolve(String(userDataPath || "").trim() || ".");
  const input = value === undefined || value === null ? {} : value;
  if (!isPlainObject(input)) {
    throw invalidConfig("runtimeOptions.recording must be a plain object when supplied.");
  }
  for (const key of Object.keys(input)) {
    if (!RECORDING_CONFIG_KEYS.includes(key)) {
      throw invalidConfig(`runtimeOptions.recording.${key} is not a supported recording configuration key.`);
    }
  }
  let rootPath = path.join(dataRoot, RECORDING_DEFAULT_ROOT_DIR);
  if (input.root !== undefined) {
    const configured = String(input.root || "").trim();
    if (!configured) {
      throw invalidConfig("runtimeOptions.recording.root must be a non-empty path when supplied.");
    }
    rootPath = path.isAbsolute(configured)
      ? path.normalize(configured)
      : path.resolve(dataRoot, configured);
  }
  const sinkId = input.sinkId === undefined
    ? RECORDING_DEFAULT_SINK_ID
    : String(input.sinkId || "").trim();
  if (!sinkId) {
    throw invalidConfig("runtimeOptions.recording.sinkId must be a non-empty string.");
  }
  const budgets: UnknownRecord = {};
  if (input.budgets !== undefined) {
    if (!isPlainObject(input.budgets)) {
      throw invalidConfig("runtimeOptions.recording.budgets must be a plain object.");
    }
    for (const [key, entry] of Object.entries(input.budgets)) {
      if (!RECORDING_BUDGET_KEYS.includes(key)) {
        throw invalidConfig(`runtimeOptions.recording.budgets.${key} is not a recording sink budget.`);
      }
      if (!Number.isSafeInteger(entry) || (entry as number) < 0) {
        throw invalidConfig(`runtimeOptions.recording.budgets.${key} must be a non-negative integer.`);
      }
      budgets[key] = entry;
    }
  }
  let reservationTtlMs: number | undefined;
  if (input.reservationTtlMs !== undefined) {
    const ttl = Number(input.reservationTtlMs);
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 24 * 60 * 60 * 1000) {
      throw invalidConfig(
        "runtimeOptions.recording.reservationTtlMs must be an integer between 1000 and 86400000."
      );
    }
    reservationTtlMs = ttl;
  }
  let retentionSweepMs: number | undefined;
  if (input.retentionSweepMs !== undefined) {
    const sweep = Number(input.retentionSweepMs);
    if (!Number.isSafeInteger(sweep) || sweep < 0 || sweep > 24 * 60 * 60 * 1000) {
      throw invalidConfig(
        "runtimeOptions.recording.retentionSweepMs must be an integer between 0 and 86400000."
      );
    }
    retentionSweepMs = sweep;
  }
  const policyInput = input.policy === undefined ? {} : input.policy;
  if (!isPlainObject(policyInput)) {
    throw invalidConfig("runtimeOptions.recording.policy must be a plain object.");
  }
  for (const key of Object.keys(policyInput)) {
    if (!RECORDING_POLICY_CONFIG_KEYS.includes(key)) {
      throw invalidConfig(`runtimeOptions.recording.policy.${key} is not a supported policy identity key.`);
    }
  }
  const policyId = policyInput.policyId === undefined
    ? RECORDING_DEFAULT_POLICY_ID
    : String(policyInput.policyId || "").trim();
  const issuerRole = policyInput.issuerRole === undefined
    ? RECORDING_DEFAULT_ISSUER_ROLE
    : String(policyInput.issuerRole || "").trim();
  if (!policyId || !issuerRole) {
    throw invalidConfig("runtimeOptions.recording.policy requires non-empty policyId and issuerRole.");
  }
  const configurerRoles = policyInput.configurerRoles === undefined
    ? [...RECORDING_DEFAULT_CONFIGURER_ROLES]
    : Array.isArray(policyInput.configurerRoles)
      ? policyInput.configurerRoles.map((role) => String(role || "").trim()).filter(Boolean)
      : null;
  if (!configurerRoles || configurerRoles.length === 0) {
    throw invalidConfig(
      "runtimeOptions.recording.policy.configurerRoles must be a non-empty array of role names."
    );
  }
  return Object.freeze({
    rootPath,
    sinkId,
    budgets: Object.freeze(budgets),
    reservationTtlMs,
    retentionSweepMs,
    policy: Object.freeze({ policyId, issuerRole, configurerRoles })
  });
}

/**
 * One-time startup recognition of retired recording storage. Existing
 * locations are reported verbatim for operator reconciliation; the check is
 * read-only, runs once during composition and leaves startup unblocked —
 * nothing here is a permanent gate or a migration writer.
 */
export function inspectRecordingStorage(
  { userDataPath, rootPath }: { userDataPath?: unknown; rootPath?: unknown } = {}
): UnknownRecord {
  const report: UnknownRecord = {
    checked: false,
    checkedAt: new Date().toISOString(),
    rootPath: String(rootPath || ""),
    retiredPaths: [] as UnknownRecord[]
  };
  try {
    const dataRoot = path.resolve(String(userDataPath || "").trim() || ".");
    const root = path.resolve(String(rootPath || "").trim() || path.join(dataRoot, RECORDING_DEFAULT_ROOT_DIR));
    const retiredPaths = report.retiredPaths as UnknownRecord[];
    for (const marker of RETIRED_RECORDING_MARKERS) {
      const candidate = path.join(dataRoot, marker.name);
      if (safeStat(candidate)) {
        retiredPaths.push({ path: candidate, kind: marker.kind });
      }
    }
    const rootStat = safeStat(root);
    if (rootStat && !rootStat.isDirectory()) {
      retiredPaths.push({ path: root, kind: "recording_root_not_directory" });
    } else if (rootStat) {
      // A sink database or artifact directory directly at the recording root
      // predates tenant isolation: flat-layout data is recognized, reported
      // and left untouched for the operator to retire deliberately.
      for (const [name, kind] of [
        [RECORDING_SINK_DATABASE_FILE, "retired_flat_recording_store"],
        ["artifacts", "retired_flat_recording_artifacts"]
      ] as const) {
        const candidate = path.join(root, name);
        if (safeStat(candidate)) {
          retiredPaths.push({ path: candidate, kind });
        }
      }
    }
    report.checked = true;
  } catch (error: unknown) {
    report.error = error instanceof Error ? error.message : String(error || "");
  }
  return Object.freeze(report);
}

/**
 * Producer facade that routes every recording call to the producing tenant's
 * own durable store. `recordingProducerForPort` recognizes the
 * session/noteUsage shape and returns this facade unchanged, so the gateway,
 * dispatch recorders and the operation-permission runtime all share it while
 * each tenant's policy revision and bytes stay inside its own store.
 */
function createTenantRecordingProducerRouter(
  { provider, now }: { provider: any; now?: () => number }
): UnknownRecord {
  const producers = new Map<string, any>();
  const nullProducer = createRecordingProducer({ sink: null, ...(now ? { now } : {}) });
  let closed = false;

  function tenantIdFor(ref: unknown): string {
    return normalizeRecordingTenantId(sanitizeRecordingRef(ref) || "tenant.local");
  }

  function producerForTenant(tenantId: string): any {
    if (closed) return nullProducer;
    let producer = producers.get(tenantId);
    if (producer) return producer;
    if (!provider.hasStore(tenantId)) return nullProducer;
    producer = recordingProducerForPort(provider.storeFor(tenantId), now ? { now } : {});
    producers.set(tenantId, producer);
    return producer;
  }

  function producerFor(ref: unknown): any {
    return producerForTenant(tenantIdFor(ref));
  }

  /**
   * Sessions bind lazily and upgrade once: a session created before the
   * tenant's store existed re-binds to the real producer at the next
   * collection point after provisioning, so a published policy governs all
   * later collection while never backfilling earlier bytes.
   */
  function session(input: UnknownRecord = {}): UnknownRecord {
    const tenantRef = sanitizeRecordingRef(input.tenantRef) || "tenant.local";
    const tenantId = normalizeRecordingTenantId(tenantRef);
    const boundInput = { ...input, tenantRef };
    let inner: any = null;
    let boundToNullProducer = false;
    function current(): any {
      if (inner && boundToNullProducer && !closed && provider.hasStore(tenantId)) {
        inner = null;
      }
      if (!inner) {
        const producer = producerForTenant(tenantId);
        boundToNullProducer = producer === nullProducer;
        inner = producer.session(boundInput);
      }
      return inner;
    }
    return Object.freeze({
      get operationRef(): string {
        return current().operationRef;
      },
      tenantRef,
      collect: (value: UnknownRecord = {}): any => current().collect(value),
      admitBeforeEffect: (value: UnknownRecord = {}): any => current().admitBeforeEffect(value),
      settle: (value: UnknownRecord = {}): any => current().settle(value),
      settlePending: (value: UnknownRecord = {}): any => current().settlePending(value),
      putArtifact: (value: UnknownRecord = {}): any => current().putArtifact(value),
      pendingObligations: (): any => current().pendingObligations(),
      outcomeFor: (value: UnknownRecord = {}): any => current().outcomeFor(value),
      touched: (): any => current().touched()
    });
  }

  function tenantFanOut(apply: (producer: any) => unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const producer of producers.values()) {
      out.push(...apply(producer));
    }
    return out;
  }

  return Object.freeze({
    protocolVersion: RECORDING_PRODUCER_PROTOCOL_VERSION,
    policy: (tenantRef?: unknown): any => producerFor(tenantRef).policy(),
    selectionFor: (category: unknown, tenantRef?: unknown): any =>
      producerFor(tenantRef).selectionFor(category),
    categoryEnabled: (category: unknown, tenantRef?: unknown): any =>
      producerFor(tenantRef).categoryEnabled(category),
    session,
    noteUsage: (input: UnknownRecord = {}): any => producerFor(input.tenantRef).noteUsage(input),
    flushUsage: (input: UnknownRecord = {}): number =>
      [...producers.values()].reduce((total, producer) => total + Number(producer.flushUsage(input) || 0), 0),
    flushStaleUsage: (): number =>
      [...producers.values()].reduce((total, producer) => total + Number(producer.flushStaleUsage() || 0), 0),
    pendingUsageBuckets: (): number =>
      [...producers.values()].reduce((total, producer) => total + Number(producer.pendingUsageBuckets() || 0), 0),
    outcomeFor: (input: UnknownRecord = {}): any => producerFor(input.tenantRef).outcomeFor(input),
    reconcileOperation: (input: UnknownRecord = {}): any => {
      if (sanitizeRecordingRef(input.tenantRef)) {
        return producerFor(input.tenantRef).reconcileOperation(input);
      }
      return tenantFanOut((producer) => producer.reconcileOperation(input));
    },
    pendingObligationsFor: (operationRef: unknown): any =>
      tenantFanOut((producer) => producer.pendingObligationsFor(operationRef)),
    putArtifact: (input: UnknownRecord = {}): any => producerFor(input.tenantRef).putArtifact(input),
    close(): void {
      if (closed) return;
      closed = true;
      for (const producer of producers.values()) {
        try {
          producer.close();
        } catch {
          // A producer shutdown never blocks the owning authority's close.
        }
      }
      producers.clear();
      nullProducer.close();
    }
  });
}

/**
 * Compose the self-hosted recording authority: normalized configuration, the
 * retired-storage recognition report, the tenant-scoped governance provider
 * and the shared tenant-routing `recordingSink` producer facade. Created once
 * inside `createServerCompositionRoot` so startup failure cleanup, shutdown
 * ordering and the single configuration source all follow the existing
 * self-hosted lifecycle.
 */
export function createEnterpriseRecordingAuthority(options: UnknownRecord = {}): UnknownRecord {
  const userDataPath = String(options.userDataPath || "").trim();
  if (!userDataPath) {
    throw new TypeError("Enterprise recording authority requires an explicit userDataPath.");
  }
  const config = normalizeRecordingRuntimeConfig(options.recording, { userDataPath });
  const migration = inspectRecordingStorage({ userDataPath, rootPath: config.rootPath });
  const provider = createRecordingGovernanceProvider({
    userDataPath,
    recordingRoot: config.rootPath,
    sink: { sinkId: config.sinkId, budgets: config.budgets },
    policy: config.policy,
    reservationTtlMs: config.reservationTtlMs,
    retentionSweepMs: config.retentionSweepMs,
    now: options.now,
    sinkFactory: options.sinkFactory
  });
  const recordingSink = createTenantRecordingProducerRouter({ provider, now: options.now as never });
  const logger = (options.logger || null) as
    { warn?: (event: string, details?: UnknownRecord) => void } | null;
  const retiredPaths = (migration.retiredPaths as UnknownRecord[]) || [];
  if (retiredPaths.length > 0) {
    logger?.warn?.("recording.retired_paths_detected", {
      retiredPaths: retiredPaths.map((entry) => ({ path: entry.path, kind: entry.kind }))
    });
  }
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    config,
    recordingSink,
    recordingGovernanceProvider: provider,
    migration,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        (recordingSink as { close(): void }).close();
        await provider.close();
      })();
      return closePromise;
    }
  });
}

/**
 * Recording governance provider: the console-facing owner of the per-tenant
 * enterprise-local recording sink. Each normalized tenant id maps to an
 * isolated RecordingSinkStore directory so a console session can only ever
 * see or publish its own tenant's policy revision history.
 *
 * The provider adds no recording authority of its own: policy CAS and
 * configurer-role enforcement stay inside `RecordingSinkStore.publishPolicy`
 * (assertRecordingPolicyChange), and recorded bytes never leave the
 * enterprise-local artifacts owned by the store. The console only ever reads
 * policy metadata, sink health and pending-obligation truth — never record
 * payloads.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createEmptyRecordingPolicy,
  createRecordingSink,
  parseRecordingPolicy
} from "@meshrix/contracts/recording";
import {
  createRecordingSinkStore,
  RecordingSinkError,
  RECORDING_SINK_DATABASE_FILE
} from "@meshrix/foundation/recording/sink-store";
import { normalizeTenantId } from "@meshrix/foundation/security/auth/console-auth";

type UnknownRecord = Record<string, unknown>;

const RECORDING_ROOT_DIR = "recording";
const RECORDING_SINK_ID = "recording-sink-local";
const RECORDING_POLICY_ID = "recording-policy";
const GENESIS_ISSUER_ROLE = "system";
const GENESIS_CONFIGURER_ROLES: readonly string[] = Object.freeze(["owner", "maintainer"]);

const DEFAULT_SINK_BUDGETS: UnknownRecord = Object.freeze({
  maxRecordBytes: 262_144,
  maxContentBytes: 1_073_741_824,
  maxIndexBytes: 268_435_456,
  maxBufferedRecords: 65_536,
  maxPendingWrites: 4_096
});

export class RecordingGovernanceError extends Error {
  readonly code: string;
  readonly currentRevision: number;
  constructor(code: string, message: string, currentRevision: number = 0) {
    super(message);
    this.name = "RecordingGovernanceError";
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

function isPlainObjectInput(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function classifiedPolicyError(error: unknown): RecordingGovernanceError {
  const message = error instanceof Error ? error.message : String(error || "");
  if (error instanceof RecordingGovernanceError) return error;
  if (error instanceof RecordingSinkError) {
    return new RecordingGovernanceError(error.code, "Recording storage operation failed.");
  }
  if (message.startsWith("RECORDING_POLICY_IDENTITY_CHANGED")) {
    return new RecordingGovernanceError(
      "recording_policy_identity_changed",
      "The recording policy identity cannot be changed."
    );
  }
  if (message.startsWith("RECORDING_POLICY_REVISION_NOT_ADVANCED")) {
    return new RecordingGovernanceError(
      "recording_policy_revision_not_advanced",
      "The next policy revision must advance."
    );
  }
  if (message.startsWith("RECORDING_POLICY_CHANGE_DENIED")) {
    return new RecordingGovernanceError(
      "recording_policy_change_denied",
      "The current role cannot change the recording policy."
    );
  }
  return new RecordingGovernanceError(
    "recording_governance_unavailable",
    "Recording governance is temporarily unavailable."
  );
}

export function normalizeRecordingTenantId(value?: unknown): string {
  try {
    return normalizeTenantId(value);
  } catch {
    throw new RecordingGovernanceError(
      "tenant_id_invalid",
      "tenantId is not a valid console tenant identifier."
    );
  }
}

/**
 * Deterministic per-tenant store directory. The tenant id is hashed into the
 * directory name so the path can never escape the recording root and tenant
 * identities never appear in filesystem layout. `recordingRoot` is the
 * resolved parent that owns every `tenant-*` store directory.
 */
export function recordingTenantRoot(recordingRoot: unknown, tenantId: unknown): string {
  const root = String(recordingRoot || "").trim();
  if (!root) {
    throw new RecordingGovernanceError(
      "recording_governance_unavailable",
      "Recording governance requires an explicit recording root."
    );
  }
  const digest = createHash("sha256").update(String(tenantId)).digest("hex").slice(0, 24);
  return path.join(path.resolve(root), `tenant-${digest}`);
}

/**
 * True when the tenant already owns a durable store under `recordingRoot` —
 * an open store or a `recording-sink.sqlite` left by an earlier process. The
 * probe never creates storage, so callers can distinguish "recorded before"
 * from "never provisioned" without side effects.
 */
export function recordingTenantStoreExists(recordingRoot: unknown, tenantId: unknown): boolean {
  let rootPath = "";
  try {
    rootPath = recordingTenantRoot(recordingRoot, tenantId);
  } catch {
    return false;
  }
  try {
    return fs.statSync(path.join(rootPath, RECORDING_SINK_DATABASE_FILE)).isFile();
  } catch {
    return false;
  }
}

export function createRecordingGovernanceProvider(options: Record<string, unknown> = {}) {
  const userDataPath = String(options.userDataPath || "").trim();
  const configuredRoot = String(options.recordingRoot || "").trim();
  if (!userDataPath && !configuredRoot) {
    throw new TypeError("Recording governance provider requires an explicit userDataPath or recordingRoot.");
  }
  const recordingRoot = configuredRoot
    ? path.resolve(configuredRoot)
    : path.join(path.resolve(userDataPath), RECORDING_ROOT_DIR);
  const now = typeof options.now === "function" ? (options.now as () => number) : () => Date.now();
  const sinkFactory = typeof options.sinkFactory === "function"
    ? (options.sinkFactory as (input: UnknownRecord) => UnknownRecord)
    : null;
  const sinkOptions = isPlainObjectInput(options.sink) ? options.sink : {};
  const policyOptions = isPlainObjectInput(options.policy) ? options.policy : {};
  const reservationTtlMs = options.reservationTtlMs;
  const retentionSweepMs = options.retentionSweepMs;
  const stores = new Map<string, any>();

  function genesisPolicy(): UnknownRecord {
    return createEmptyRecordingPolicy({
      policyId: String(policyOptions.policyId || "").trim() || RECORDING_POLICY_ID,
      policyRevision: 1,
      issuedAt: new Date(now()).toISOString(),
      issuerRole: String(policyOptions.issuerRole || "").trim() || GENESIS_ISSUER_ROLE,
      configurerRoles: Array.isArray(policyOptions.configurerRoles) && policyOptions.configurerRoles.length > 0
        ? policyOptions.configurerRoles.map((role) => String(role))
        : [...GENESIS_CONFIGURER_ROLES]
    }) as unknown as UnknownRecord;
  }

  function defaultSink(): UnknownRecord {
    return createRecordingSink({
      sinkId: String(sinkOptions.sinkId || "").trim() || RECORDING_SINK_ID,
      custody: "enterprise_local",
      durable: true,
      budgets: {
        ...DEFAULT_SINK_BUDGETS,
        ...(isPlainObjectInput(sinkOptions.budgets) ? sinkOptions.budgets : {})
      }
    }) as unknown as UnknownRecord;
  }

  function hasStore(tenantId: unknown): boolean {
    const normalized = normalizeRecordingTenantId(tenantId);
    return stores.has(normalized) || recordingTenantStoreExists(recordingRoot, normalized);
  }

  function storeFor(tenantId: unknown): any {
    const normalized = normalizeRecordingTenantId(tenantId);
    const existing = stores.get(normalized);
    if (existing) return existing;
    const rootPath = recordingTenantRoot(recordingRoot, normalized);
    let store: any = null;
    try {
      // A store that already holds a policy reopens it; supplying the genesis
      // policy again would clash with the persisted revision. Only a fresh
      // root receives the initial policy — publishPolicy is the sole revision
      // path from then on.
      const persisted = recordingTenantStoreExists(recordingRoot, normalized);
      store = sinkFactory
        ? sinkFactory({ rootPath, tenantId: normalized })
        : createRecordingSinkStore({
            rootPath,
            sink: defaultSink(),
            ...(persisted ? {} : { policy: genesisPolicy() }),
            now,
            ...(reservationTtlMs === undefined ? {} : { reservationTtlMs }),
            ...(retentionSweepMs === undefined ? {} : { retentionSweepMs })
          });
    } catch (error: unknown) {
      throw classifiedPolicyError(error);
    }
    stores.set(normalized, store);
    return store;
  }

  function authority(): UnknownRecord {
    return {
      custody: "enterprise_local",
      durable: true,
      // Truthful custody: recorded bytes are unencrypted private files under
      // this deployment's recording root (owner-only permissions). The
      // operating organization — and anyone with filesystem access to the
      // recording root — can read them; no separate key boundary exists.
      contentAccess: "organization",
      contentAccessNote:
        "Recorded content is stored unencrypted in private local files under this deployment's recording root. The operating organization and its filesystem administrators can read recorded content; no separate encryption or key boundary exists."
    };
  }

  function describe({ tenantId }: UnknownRecord = {}): UnknownRecord {
    const store = storeFor(tenantId);
    return {
      tenantId: normalizeRecordingTenantId(tenantId),
      sink: store.descriptor(),
      authority: authority(),
      policy: store.getPolicy(),
      sinkState: store.sinkState(),
      pendingObligations: store.pendingObligations()
    };
  }

  function publishPolicy(input: UnknownRecord = {}): UnknownRecord {
    const tenantId = normalizeRecordingTenantId(input.tenantId);
    const store = storeFor(tenantId);
    const current = store.getPolicy();
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new RecordingGovernanceError(
        "recording_policy_expected_revision_invalid",
        "expectedRevision must be the caller-visible current policy revision."
      );
    }
    const currentRevision = Number(current.policyRevision);
    if (expectedRevision !== currentRevision) {
      throw new RecordingGovernanceError(
        "recording_policy_revision_conflict",
        "The recording policy was published by another revision; reload before publishing.",
        currentRevision
      );
    }
    const role = String(input.configurerRole || "").trim();
    if (!role) {
      throw new RecordingGovernanceError(
        "recording_policy_change_denied",
        "A configurer role is required to publish a recording policy revision."
      );
    }
    // The issuer is the authenticated configurer role, not whatever the caller
    // typed: publish provenance stays truthful at the owner.
    const stamped = isPlainObjectInput(input.policy)
      ? { ...input.policy, issuerRole: role }
      : input.policy;
    const next = parseRecordingPolicy(stamped);
    if (!next) {
      throw new RecordingGovernanceError(
        "recording_policy_invalid",
        "The supplied policy does not satisfy the recording contract."
      );
    }
    if (Number(next.policyRevision) !== expectedRevision + 1) {
      throw new RecordingGovernanceError(
        "recording_policy_revision_invalid",
        "policyRevision must equal expectedRevision + 1.",
        currentRevision
      );
    }
    if (next.policyId !== current.policyId) {
      throw new RecordingGovernanceError(
        "recording_policy_identity_changed",
        "A policy revision cannot rebind the policy identity.",
        currentRevision
      );
    }
    let admitted: UnknownRecord;
    try {
      admitted = store.publishPolicy(stamped, role) as UnknownRecord;
    } catch (error: unknown) {
      throw classifiedPolicyError(error);
    }
    return {
      tenantId,
      policy: admitted,
      sinkState: store.sinkState(),
      pendingObligations: store.pendingObligations()
    };
  }

  function sinkHealth(input: UnknownRecord = {}): UnknownRecord {
    const tenantId = normalizeRecordingTenantId(input.tenantId);
    const store = storeFor(tenantId);
    // A closed or failed store must still answer health truthfully:
    // `state.available` reports the degraded recorder rather than masking it
    // as an application error.
    let policyRevision = 0;
    try {
      policyRevision = Number(store.getPolicy().policyRevision) || 0;
    } catch {
      policyRevision = 0;
    }
    const health: UnknownRecord = {
      tenantId,
      sink: store.descriptor(),
      authority: authority(),
      state: store.sinkState(),
      policyRevision
    };
    if (input.integrity === true) {
      try {
        health.integrity = store.verifyIntegrity();
      } catch (error: unknown) {
        health.integrity = {
          intact: false,
          errorCode: "recording_integrity_check_failed",
          error: "Recording integrity verification failed."
        };
      }
    }
    return health;
  }

  async function close(): Promise<void> {
    const failures: string[] = [];
    for (const [tenant, store] of [...stores.entries()]) {
      try {
        store?.close?.();
      } catch {
        failures.push(tenant);
      }
      stores.delete(tenant);
    }
    if (failures.length > 0) {
      throw new RecordingGovernanceError(
        "recording_sink_close_failed",
        `${failures.length} recording sink store(s) did not close cleanly.`
      );
    }
  }

  return Object.freeze({
    describe,
    publishPolicy,
    sinkHealth,
    storeFor,
    hasStore,
    recordingRoot,
    close
  });
}

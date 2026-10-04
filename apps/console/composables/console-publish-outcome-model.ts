import { computed, ref, type ComputedRef, type Ref } from "vue";

// Publish outcome model (REQ-017): a client-derivable stage projection over
// the publish flow plus an interpreted runtime-health result. Stages are data
// records (id + dictionary label key + one of four states) rendered by one
// projection; transitions are a linear advance/fail enforced here.
//
// The publish client exposes three client-derivable boundaries — (1) the
// create/replace/republish request (one opaque call returning
// `UpstreamServicePublishingResult`), (2) the accepted-publication observation
// (`observeUpstreamServicePublication`, one owned request/timer per retained
// service revision), and (3) the runtime health check. The accepted server
// publication and the client-owned observer lifetime are modeled separately: a
// stopped, interrupted, replaced, or unavailable observer never changes the
// accepted server state and never becomes a server-failure projection.

export const PUBLISH_STAGE_IDS: readonly string[] = [
  "publish-request",
  "gateway-publication",
  "runtime-health",
];

/** Flat dictionary keys inside the `publishOutcome` group (REQ-004). */
export const PUBLISH_STAGE_LABEL_KEYS: Record<string, string> = {
  "publish-request": "stagePublishRequest",
  "gateway-publication": "stageGatewayPublication",
  "runtime-health": "stageRuntimeHealth",
};

/** Verified console surfaces (each slug exists in the admin route registry). */
export const PUBLISH_REMEDIATION_ROUTES: Record<string, string> = {
  publish: "/admin/publish-upstream-service",
  gatewayDetail: "/admin/upstream-services",
  operationPermission: "/admin/operation-permission",
  logs: "/admin/logs",
};

export type PublishStageState = "pending" | "active" | "done" | "failed";

export type PublishStage = {
  id: string;
  /** Flat dictionary key into the `publishOutcome` group. */
  label: string;
  state: PublishStageState;
};

export type InterpretedHealthStatus = "pass" | "warn" | "fail";

export type InterpretedHealthCheck = {
  id: string;
  /** Flat dictionary key into the `publishOutcome` group. */
  label: string;
  status: InterpretedHealthStatus;
  statusCode?: number;
  remediation?: { route: string; query?: Record<string, string> };
};

export type InterpretedHealth = {
  ok: boolean;
  checks: InterpretedHealthCheck[];
  /** Raw payload retained for the disclosure — never dropped. */
  raw: unknown;
};

/** Flow handles the outcome model needs from the view; selection stays view-owned. */
export type PublishFlowHandles = {
  /** Current selection; read for the done-state handoff to the success next steps. */
  serviceId: () => string;
};

/**
 * Client-owned observation lifetime. It never represents a server state: the
 * accepted publication below is retained across every transition.
 */
export type PublishObservationStatus = "idle" | "observing" | "interrupted" | "stopped";

/** The accepted server publication an observer tracks, independent of the observer. */
export type AcceptedPublication = {
  serviceId: string;
  serviceRevision: number;
  setRevision: number;
};

export type PublishOutcomeModel = {
  stages: Ref<PublishStage[]>;
  health: Ref<InterpretedHealth | null>;
  /** Retained accepted publication; only a newer run or selection clears it. */
  acceptedPublication: Ref<AcceptedPublication | null>;
  /** Client-only observer lifecycle for the accepted publication. */
  observation: Ref<PublishObservationStatus>;
  /** All stages done — the success next steps attach to this state. */
  done: ComputedRef<boolean>;
  begin: (stageId: string) => void;
  advance: () => void;
  complete: (stageId: string, payload?: unknown) => void;
  fail: (stageId: string, payload?: unknown) => void;
  /** Records the accepted server publication and starts its observation. */
  acceptPublication: (publication: AcceptedPublication) => void;
  /** Resumes observation of the retained accepted publication. */
  beginObservation: () => void;
  /** Temporary client-side interruption; the accepted publication is retained. */
  interruptObservation: () => void;
  /** Explicit stop; the accepted publication is retained for a later resume. */
  stopObservation: () => void;
  /** Observer settled: the accepted publication is no longer observed. */
  clearPublication: () => void;
  /** Starts a fresh projection: pending stages, no health, no accepted publication. */
  resetRun: () => void;
};

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function gatewayDetailRemediation(serviceId: string): { route: string; query?: Record<string, string> } {
  if (serviceId) {
    return { route: PUBLISH_REMEDIATION_ROUTES.gatewayDetail, query: { serviceId } };
  }
  return { route: PUBLISH_REMEDIATION_ROUTES.publish };
}

/**
 * Maps the real `UpstreamServiceRuntimeHealth` payload onto per-check records.
 * Real payload fields (verified against the server's gateway health builder):
 * `ok`, `endpoints: [{ endpoint, ok, status }]`, `protocol: "mcp"` +
 * `toolCount`, `error`, `latencyMs`, `checkedAt`, counts. Unknown/absent
 * checks degrade to a single warn record with generic copy — check names are
 * never invented beyond what the payload substantiates.
 */
export function interpretUpstreamHealth(payload: unknown, serviceId: string): InterpretedHealth {
  const raw: unknown = payload;
  const record: Record<string, any> = isRecord(payload) ? payload : {};
  const ok: boolean = record.ok === true;
  const checks: InterpretedHealthCheck[] = [];

  const endpoints: unknown[] = Array.isArray(record.endpoints) ? record.endpoints : [];
  for (const endpoint of endpoints) {
    const endpointRecord: Record<string, any> = isRecord(endpoint) ? endpoint : {};
    const publicEndpoint: Record<string, any> = isRecord(endpointRecord.endpoint) ? endpointRecord.endpoint : {};
    const endpointId = isRecord(endpointRecord.endpoint)
      ? (typeof publicEndpoint.endpointId === "string" ? publicEndpoint.endpointId : "")
      : (typeof endpointRecord.endpoint === "string" ? endpointRecord.endpoint : "");
    const healthy: boolean = endpointRecord.ok === true;
    checks.push({
      id: endpointId,
      label: "checkEndpoint",
      status: healthy ? "pass" : "fail",
      ...(Number.isSafeInteger(endpointRecord.status) && endpointRecord.status >= 100 && endpointRecord.status <= 599
        ? { statusCode: endpointRecord.status }
        : {}),
      ...(healthy ? {} : { remediation: gatewayDetailRemediation(serviceId) }),
    });
  }

  if (record.protocol === "mcp") {
    checks.push({
      id: "mcp-tools",
      label: "checkMcpTools",
      status: ok ? "pass" : "fail",
      ...(ok ? {} : { remediation: { route: PUBLISH_REMEDIATION_ROUTES.logs } }),
    });
  }

  if (checks.length === 0) {
    checks.push({
      id: "summary",
      label: "checkSummary",
      status: ok ? "pass" : "warn",
      ...(ok ? {} : { remediation: { route: PUBLISH_REMEDIATION_ROUTES.logs } }),
    });
  }

  return { ok, checks, raw };
}

export function createPublishOutcomeModel(flow: PublishFlowHandles): PublishOutcomeModel {
  const stages: Ref<PublishStage[]> = ref(
    PUBLISH_STAGE_IDS.map((id) => ({
      id,
      label: PUBLISH_STAGE_LABEL_KEYS[id] || id,
      state: "pending" as PublishStageState,
    })),
  );
  const health: Ref<InterpretedHealth | null> = ref(null);
  const acceptedPublication: Ref<AcceptedPublication | null> = ref(null);
  const observation: Ref<PublishObservationStatus> = ref("idle");

  function stageById(stageId: string): PublishStage | undefined {
    return stages.value.find((stage) => stage.id === stageId);
  }

  function clearPublication(): void {
    acceptedPublication.value = null;
    observation.value = "idle";
  }

  function resetRun(): void {
    for (const stage of stages.value) {
      stage.state = "pending";
    }
    health.value = null;
    clearPublication();
  }

  function acceptPublication(publication: AcceptedPublication): void {
    acceptedPublication.value = { ...publication };
    observation.value = "observing";
  }

  function beginObservation(): void {
    if (acceptedPublication.value) {
      observation.value = "observing";
    }
  }

  function interruptObservation(): void {
    if (acceptedPublication.value) {
      observation.value = "interrupted";
    }
  }

  function stopObservation(): void {
    if (acceptedPublication.value) {
      observation.value = "stopped";
    }
  }

  function begin(stageId: string): void {
    const index: number = PUBLISH_STAGE_IDS.indexOf(stageId);
    if (index < 0) {
      return;
    }
    // A terminal state (failed run, or a completed run) starts a fresh one.
    const terminal: boolean =
      stages.value.some((stage) => stage.state === "failed") ||
      stages.value[0]?.state === "done";
    if (terminal) {
      resetRun();
    } else {
      // A new publish run supersedes the previously retained observation; the
      // accepted server publication it tracked is no longer the live target.
      clearPublication();
    }
    for (let i = 0; i < stages.value.length; i += 1) {
      const stage = stages.value[i];
      if (i === index) {
        stage.state = "active";
      } else if (i > index) {
        stage.state = "pending";
      } else if (stage.state === "active") {
        // Defensive: an earlier stage still marked active settles to done.
        stage.state = "done";
      }
    }
  }

  function advance(): void {
    const index: number = stages.value.findIndex((stage) => stage.state === "active");
    if (index < 0) {
      return;
    }
    stages.value[index].state = "done";
    const next: PublishStage | undefined = stages.value[index + 1];
    if (next && next.state === "pending") {
      next.state = "active";
    }
  }

  function complete(stageId: string, payload?: unknown): void {
    const stage: PublishStage | undefined = stageById(stageId);
    if (!stage) {
      return;
    }
    stage.state = "done";
    if (stageId === "runtime-health" && payload !== undefined) {
      health.value = interpretUpstreamHealth(payload, flow.serviceId());
    }
  }

  function fail(stageId: string, payload?: unknown): void {
    const stage: PublishStage | undefined = stageById(stageId);
    if (!stage) {
      return;
    }
    stage.state = "failed";
    // Failed short-circuits later stages: they never become active.
    for (const candidate of stages.value) {
      if (candidate.id !== stageId && candidate.state === "active") {
        candidate.state = "pending";
      }
    }
    if (stageId === "runtime-health" && payload !== undefined) {
      health.value = interpretUpstreamHealth(payload, flow.serviceId());
    }
  }

  const done: ComputedRef<boolean> = computed(
    () => stages.value.length > 0 && stages.value.every((stage) => stage.state === "done"),
  );

  return {
    stages,
    health,
    acceptedPublication,
    observation,
    done,
    begin,
    advance,
    complete,
    fail,
    acceptPublication,
    beginObservation,
    interruptObservation,
    stopObservation,
    clearPublication,
    resetRun,
  };
}

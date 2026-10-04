import { getJson, sendJson } from "@meshrix/ui-console/bridge-http";
import { UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION } from "@meshrix/contracts/upstream-service-publishing";
import type {
  PublishedUpstreamServiceDetail,
  PublishedUpstreamServiceSummary,
  TypedServiceReference,
  UpstreamMcpDescriptor,
  UpstreamPayloadTransport,
  UpstreamPublishingAction,
  UpstreamRequestRepresentationMode,
  UpstreamResponseRepresentationMode,
  UpstreamServiceCreateCommand,
  UpstreamServiceDescriptor,
  UpstreamServiceDetailResponse,
  UpstreamServiceDisableCommand,
  UpstreamServiceListResponse,
  UpstreamServicePublication,
  UpstreamServicePublishingCommandBase,
  UpstreamServicePublishingResult,
  UpstreamServiceRemoveCommand,
  UpstreamServiceRepublishCommand,
  UpstreamServiceReplaceCommand,
} from "@meshrix/contracts/upstream-service-publishing";

export { UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION };
export type {
  PublishedUpstreamServiceDetail,
  PublishedUpstreamServiceSummary,
  TypedServiceReference,
  UpstreamMcpDescriptor,
  UpstreamPayloadTransport,
  UpstreamRequestRepresentationMode,
  UpstreamResponseRepresentationMode,
  UpstreamServiceDescriptor,
  UpstreamServiceDetailResponse,
  UpstreamServiceListResponse,
  UpstreamServicePublication,
  UpstreamServicePublishingResult,
};

/** Runtime health payload returned by the gateway health route. */
export type UpstreamServiceRuntimeHealth = { ok: boolean; [key: string]: unknown };

export const UPSTREAM_SERVICE_OBSERVATION_INTERVAL_MS = 500;

/** The accepted server publication an observer tracks; the server keeps it. */
export interface UpstreamServicePublicationObservationTarget {
  serviceId: string;
  serviceRevision: number;
}

export interface UpstreamServicePublicationObservationOptions {
  signal?: AbortSignal | null;
  intervalMs?: number;
  delay?: (milliseconds: number, signal: AbortSignal | null) => Promise<void>;
}

export type UpstreamPublicationObservationFailureReason = "interrupted" | "superseded";

export interface UpstreamPublicationObservationFailureContext {
  serviceId: string;
  observedRevision: number;
  currentRevision?: number;
  message: string;
  cause?: unknown;
}

/**
 * Observation outcome for the accepted revision. `interrupted` is a temporary
 * client-side interruption (network or status-query failure); `superseded` is
 * the authoritative server fact that the observed revision is no longer the
 * candidate (replaced, disabled or removed).
 */
export class UpstreamPublicationObservationError extends Error {
  readonly reason: UpstreamPublicationObservationFailureReason;
  readonly serviceId: string;
  readonly observedRevision: number;
  readonly currentRevision: number | null;

  constructor(reason: UpstreamPublicationObservationFailureReason, context: UpstreamPublicationObservationFailureContext) {
    super(context.message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = "UpstreamPublicationObservationError";
    this.reason = reason;
    this.serviceId = context.serviceId;
    this.observedRevision = context.observedRevision;
    this.currentRevision = context.currentRevision ?? null;
  }
}

function observationAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The publication observation was stopped.", "AbortError");
}

export function isUpstreamPublicationObservationAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function observationIntervalDelay(milliseconds: number, signal: AbortSignal | null): Promise<void> {
  if (!signal) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
  if (signal.aborted) {
    return Promise.reject(observationAbortReason(signal));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(observationAbortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function idempotencyKey(action: UpstreamPublishingAction): string {
  return `${action}:${crypto.randomUUID()}`;
}

function commandBase<Action extends UpstreamPublishingAction>(
  action: Action,
  expectedServiceRevision: number,
  expectedSetRevision: number,
): UpstreamServicePublishingCommandBase & { action: Action } {
  return {
    schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
    action,
    expectedServiceRevision,
    expectedSetRevision,
    idempotencyKey: idempotencyKey(action),
  };
}

export function createUpstreamService(
  serviceKey: string,
  descriptor: UpstreamServiceDescriptor,
  expectedSetRevision: number,
): Promise<UpstreamServicePublishingResult> {
  const command: UpstreamServiceCreateCommand = {
    ...commandBase("create", 0, expectedSetRevision),
    serviceKey,
    descriptor,
  };
  return sendJson<UpstreamServicePublishingResult>("/api/gateway/v1/services", "POST", command);
}

export function replaceUpstreamService(
  serviceId: string,
  descriptor: UpstreamServiceDescriptor,
  expectedServiceRevision: number,
  expectedSetRevision: number,
): Promise<UpstreamServicePublishingResult> {
  const command: UpstreamServiceReplaceCommand = {
    ...commandBase("replace", expectedServiceRevision, expectedSetRevision),
    serviceId,
    descriptor,
  };
  return sendJson<UpstreamServicePublishingResult>(
    `/api/gateway/v1/services/${encodeURIComponent(serviceId)}`,
    "PUT",
    command,
  );
}

export function disableUpstreamService(
  serviceId: string,
  serviceRevision: number,
  setRevision: number,
): Promise<UpstreamServicePublishingResult> {
  const command: UpstreamServiceDisableCommand = {
    ...commandBase("disable", serviceRevision, setRevision),
    serviceId,
  };
  return sendJson<UpstreamServicePublishingResult>(
    `/api/gateway/v1/services/${encodeURIComponent(serviceId)}/disable`,
    "POST",
    command,
  );
}

export function republishUpstreamService(
  serviceId: string,
  serviceRevision: number,
  setRevision: number,
): Promise<UpstreamServicePublishingResult> {
  const command: UpstreamServiceRepublishCommand = {
    ...commandBase("republish", serviceRevision, setRevision),
    serviceId,
  };
  return sendJson<UpstreamServicePublishingResult>(
    `/api/gateway/v1/services/${encodeURIComponent(serviceId)}/republish`,
    "POST",
    command,
  );
}

export function removeUpstreamService(
  serviceId: string,
  serviceRevision: number,
  setRevision: number,
): Promise<UpstreamServicePublishingResult> {
  const command: UpstreamServiceRemoveCommand = {
    ...commandBase("remove", serviceRevision, setRevision),
    serviceId,
  };
  return sendJson<UpstreamServicePublishingResult>(
    `/api/gateway/v1/services/${encodeURIComponent(serviceId)}`,
    "DELETE",
    command,
    { safetyConfirm: true },
  );
}

export function listPublishedServices(): Promise<UpstreamServiceListResponse> {
  return getJson<UpstreamServiceListResponse>("/api/gateway/v1/services");
}

export function getPublishedService(
  serviceId: string,
  options: { signal?: AbortSignal } = {},
): Promise<UpstreamServiceDetailResponse> {
  return getJson<UpstreamServiceDetailResponse>(
    `/api/gateway/v1/services/${encodeURIComponent(serviceId)}`,
    options,
  );
}

export function checkUpstreamServiceRuntimeHealth(serviceId: string): Promise<UpstreamServiceRuntimeHealth> {
  return getJson<UpstreamServiceRuntimeHealth>(
    `/api/gateway/v1/external-services/${encodeURIComponent(serviceId)}/health`,
  );
}

/**
 * Observes one retained accepted publication until an authoritative fact
 * settles it. There is no attempt or business deadline: a slow publication
 * keeps observing until it publishes, the caller aborts the owned request
 * (stop, selection change, navigation, unmount), the observed revision is
 * superseded by a newer server revision, or a status query fails. A failed
 * status query ends only the observation and never asserts a server failure.
 */
export async function observeUpstreamServicePublication(
  target: UpstreamServicePublicationObservationTarget,
  options: UpstreamServicePublicationObservationOptions = {},
): Promise<UpstreamServiceDetailResponse> {
  const serviceId: string = String(target?.serviceId || "").trim();
  const observedRevision: number = target?.serviceRevision;
  if (!serviceId) throw new Error("Publication observation requires the accepted service id.");
  if (!Number.isSafeInteger(observedRevision) || observedRevision < 1) {
    throw new Error("Publication observation requires the accepted service revision.");
  }
  const signal: AbortSignal | null = options.signal ?? null;
  const intervalMs: number = options.intervalMs ?? UPSTREAM_SERVICE_OBSERVATION_INTERVAL_MS;
  const delay: (milliseconds: number, signal: AbortSignal | null) => Promise<void> =
    options.delay ?? observationIntervalDelay;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
    throw new Error("Publication observation interval must be a non-negative integer.");
  }

  for (;;) {
    if (signal?.aborted) throw observationAbortReason(signal);
    let detail: UpstreamServiceDetailResponse;
    try {
      detail = await getPublishedService(serviceId, signal ? { signal } : {});
    } catch (error: unknown) {
      if (signal?.aborted || isUpstreamPublicationObservationAbort(error)) throw error;
      throw new UpstreamPublicationObservationError("interrupted", {
        serviceId,
        observedRevision,
        message: `Publication observation was interrupted before revision ${observedRevision} published.`,
        cause: error,
      });
    }
    if (signal?.aborted) throw observationAbortReason(signal);
    if (detail.service.state === "removed" || detail.service.serviceRevision !== observedRevision) {
      throw new UpstreamPublicationObservationError("superseded", {
        serviceId,
        observedRevision,
        currentRevision: detail.service.serviceRevision,
        message: `Accepted publication revision ${observedRevision} was superseded by revision ${detail.service.serviceRevision}.`,
      });
    }
    if (detail.service.publication.status === "server_published") {
      return detail;
    }
    await delay(intervalMs, signal);
  }
}

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

export interface UpstreamServicePublicationWaitOptions {
  maxAttempts?: number;
  intervalMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
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

export function getPublishedService(serviceId: string): Promise<UpstreamServiceDetailResponse> {
  return getJson<UpstreamServiceDetailResponse>(`/api/gateway/v1/services/${encodeURIComponent(serviceId)}`);
}

export function checkUpstreamServiceRuntimeHealth(serviceId: string): Promise<UpstreamServiceRuntimeHealth> {
  return getJson<UpstreamServiceRuntimeHealth>(
    `/api/gateway/v1/external-services/${encodeURIComponent(serviceId)}/health`,
  );
}

export async function waitForUpstreamServicePublication(
  serviceId: string,
  options: UpstreamServicePublicationWaitOptions = {},
): Promise<UpstreamServiceDetailResponse> {
  const maxAttempts: number = options.maxAttempts ?? 20;
  const intervalMs: number = options.intervalMs ?? 500;
  const delay: (milliseconds: number) => Promise<void> = options.delay ??
    ((milliseconds: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer.");

  let latest: UpstreamServiceDetailResponse | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    latest = await getPublishedService(serviceId);
    if (latest.service.publication.status === "server_published") {
      return latest;
    }
    if (attempt + 1 < maxAttempts) await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for service publication after ${maxAttempts} attempts.`);
}

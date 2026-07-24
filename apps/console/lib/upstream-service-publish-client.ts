import { getJson, sendJson } from "@meshrix/ui-console/bridge-http";
import { UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION } from "@meshrix/contracts/upstream-service-publishing";
import type {
  TypedServiceReference,
  UpstreamPayloadTransport,
  UpstreamRequestRepresentationMode,
  UpstreamResponseRepresentationMode,
  UpstreamServiceDescriptor,
} from "@meshrix/contracts/upstream-service-publishing";

export { UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION };
export type {
  TypedServiceReference,
  UpstreamPayloadTransport,
  UpstreamRequestRepresentationMode,
  UpstreamResponseRepresentationMode,
  UpstreamServiceDescriptor,
};

export interface PublishingResult {
  ok: boolean;
  serviceId: string;
  state: "rejected" | "accepted" | "publishing" | "disabled" | "removed" | "server_published";
  serviceRevision: number;
  setRevision: number;
  manifestDigest: string;
  receiptRef: string;
  publication: UpstreamServicePublication;
  replayed: boolean;
}

export interface UpstreamServicePublication {
  publicationRef: string;
  status: "publishing" | "server_published";
  candidateRevision: number;
  candidateDigest: string;
  terminal?: {
    sourceRevision: number;
    sourceDigest: string;
    catalogRevision: string;
    audienceRevision: number;
    protocolRevision: number;
  };
}

export interface PublishedServiceSummary {
  serviceId: string;
  state: PublishingResult["state"];
  serviceRevision: number;
  manifestDigest: string;
  publication: UpstreamServicePublication;
}

export interface PublishedServiceDetail extends PublishedServiceSummary {
  descriptor: UpstreamServiceDescriptor | null;
  references: TypedServiceReference[];
}

export interface ServiceListResponse {
  ok: boolean;
  setRevision: number;
  services: PublishedServiceSummary[];
}

export interface ServiceDetailResponse {
  ok: boolean;
  setRevision: number;
  service: PublishedServiceDetail;
}

export type UpstreamServiceRuntimeHealth = { ok: boolean; [key: string]: unknown };

function idempotencyKey(action: string) {
  return `${action}:${crypto.randomUUID()}`;
}

function commandBase(action: string, expectedServiceRevision: number, expectedSetRevision: number) {
  return {
    schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
    action,
    expectedServiceRevision,
    expectedSetRevision,
    idempotencyKey: idempotencyKey(action),
  };
}

export function createUpstreamService(serviceKey: string, descriptor: UpstreamServiceDescriptor, expectedSetRevision: number) {
  return sendJson<PublishingResult>("/api/gateway/v1/services", "POST", {
    ...commandBase("create", 0, expectedSetRevision),
    serviceKey,
    descriptor,
  });
}

export function replaceUpstreamService(
  serviceId: string,
  descriptor: UpstreamServiceDescriptor,
  expectedServiceRevision: number,
  expectedSetRevision: number,
) {
  return sendJson<PublishingResult>(`/api/gateway/v1/services/${encodeURIComponent(serviceId)}`, "PUT", {
    ...commandBase("replace", expectedServiceRevision, expectedSetRevision),
    serviceId,
    descriptor,
  });
}

function stateCommand(action: "disable" | "remove" | "republish", serviceId: string, serviceRevision: number, setRevision: number) {
  return {
    ...commandBase(action, serviceRevision, setRevision),
    serviceId,
  };
}

export function disableUpstreamService(serviceId: string, serviceRevision: number, setRevision: number) {
  return sendJson<PublishingResult>(
    `/api/gateway/v1/services/${encodeURIComponent(serviceId)}/disable`,
    "POST",
    stateCommand("disable", serviceId, serviceRevision, setRevision),
  );
}

export function republishUpstreamService(serviceId: string, serviceRevision: number, setRevision: number) {
  return sendJson<PublishingResult>(
    `/api/gateway/v1/services/${encodeURIComponent(serviceId)}/republish`,
    "POST",
    stateCommand("republish", serviceId, serviceRevision, setRevision),
  );
}

export function removeUpstreamService(serviceId: string, serviceRevision: number, setRevision: number) {
  return sendJson<PublishingResult>(
    `/api/gateway/v1/services/${encodeURIComponent(serviceId)}`,
    "DELETE",
    stateCommand("remove", serviceId, serviceRevision, setRevision),
    { safetyConfirm: true },
  );
}

export function listPublishedServices() {
  return getJson<ServiceListResponse>("/api/gateway/v1/services");
}

export function getPublishedService(serviceId: string) {
  return getJson<ServiceDetailResponse>(`/api/gateway/v1/services/${encodeURIComponent(serviceId)}`);
}

export function checkUpstreamServiceRuntimeHealth(serviceId: string) {
  return getJson<UpstreamServiceRuntimeHealth>(
    `/api/gateway/v1/external-services/${encodeURIComponent(serviceId)}/health`,
  );
}

export async function waitForUpstreamServicePublication(
  serviceId: string,
  options: { maxAttempts?: number; intervalMs?: number; delay?: (milliseconds: number) => Promise<void> } = {},
) {
  const maxAttempts = options.maxAttempts ?? 20;
  const intervalMs = options.intervalMs ?? 500;
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer.");

  let latest: ServiceDetailResponse | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    latest = await getPublishedService(serviceId);
    if (latest.service.publication.status === "server_published" || latest.service.state === "server_published") {
      return latest;
    }
    if (attempt + 1 < maxAttempts) await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for service publication after ${maxAttempts} attempts.`);
}

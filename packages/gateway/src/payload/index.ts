import type { JsonObject } from "@meshrix/contracts/gateway";
import { cloneJson, isPlainRecord } from "../utils.ts";

export const HOP_OWNED_FIELDS = Object.freeze([
  "protocolVersion",
  "clientInfo",
  "clientCapabilities",
  "requestState",
  "jsonrpc",
  "id",
  "subscriptionId",
  "traceparent",
  "tracestate"
] as const);

export const MESHRIX_EVIDENCE_NAMESPACE = "io.meshrix/governance" as const;

export interface PayloadTransform {
  readonly id: string;
  readonly version: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  apply(value: unknown): unknown;
}

export interface PayloadPartition {
  readonly application: unknown;
  readonly protocol: Readonly<Record<string, unknown>>;
  readonly applicationMetadata: Readonly<Record<string, unknown>>;
  readonly upstreamEvidence: Readonly<Record<string, unknown>>;
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? cloneJson(value) : {};
}

/**
 * Payload ownership is determined by the envelope position, not by field
 * names. A business object may legitimately contain `traceId`, `auditId`,
 * `url`, `headers`, or any other application key.
 */
export function partitionPayload(envelope: unknown): PayloadPartition {
  const record = cloneRecord(envelope);
  const protocol: Record<string, unknown> = {};
  const applicationMetadata: Record<string, unknown> = {};
  const upstreamEvidence: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if ((HOP_OWNED_FIELDS as readonly string[]).includes(key)) {
      protocol[key] = value;
      continue;
    }
    if (key === "_meta" && isPlainRecord(value)) {
      applicationMetadata[key] = cloneJson(value);
      continue;
    }
    if (key === MESHRIX_EVIDENCE_NAMESPACE) {
      upstreamEvidence[key] = cloneJson(value);
      continue;
    }
  }
  return Object.freeze({
    application: cloneJson(envelope),
    protocol: Object.freeze(protocol),
    applicationMetadata: Object.freeze(applicationMetadata),
    upstreamEvidence: Object.freeze(upstreamEvidence)
  });
}

export function preserveBusinessPayload(value: unknown): unknown {
  return cloneJson(value);
}

export function preserveApplicationMetadata(value: unknown): Readonly<Record<string, unknown>> {
  return Object.freeze(cloneRecord(value));
}

export function trustedGatewayEvidence(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) return Object.freeze({});
  return Object.freeze({
    route: value.route,
    endpoint: value.endpoint,
    decisionRef: value.decisionRef,
    permitId: value.permitId,
    effectOutcome: value.effectOutcome
  });
}

export function applyPayloadTransform(value: unknown, transform?: PayloadTransform): unknown {
  if (!transform) return preserveBusinessPayload(value);
  const transformed = transform.apply(preserveBusinessPayload(value));
  return preserveBusinessPayload(transformed);
}

export function rewriteProtocolSlot(value: unknown, mappings: Readonly<Record<string, string>>): unknown {
  if (typeof value !== "string") return value;
  return Object.hasOwn(mappings, value) ? mappings[value] : value;
}

export function rewriteKnownResourceSlots(value: unknown, mappings: Readonly<Record<string, string>>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteKnownResourceSlots(item, mappings));
  if (!isPlainRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "uri" || key === "name" || key === "resourceUri" || key === "template") {
      output[key] = rewriteProtocolSlot(child, mappings);
    } else {
      output[key] = rewriteKnownResourceSlots(child, mappings);
    }
  }
  return output;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainRecord(value);
}

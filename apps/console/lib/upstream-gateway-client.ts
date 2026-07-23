import { getJson } from "@lico/ui-console/bridge-http";

export type UpstreamGatewayService = {
  serviceId: string;
  label: string;
  baseUrl: string;
  healthPath: string;
  disabled: boolean;
  credentialRefs?: string[];
  redactedCredentialInput?: boolean;
  operations?: Array<{
    operationKey: string;
    method: string;
    path: string;
    risk: string;
    requiredScopes?: string[];
  }>;
  trafficPolicy?: Record<string, number>;
};

export type UpstreamGatewayAuditItem = {
  auditId?: string;
  eventType?: string;
  serviceId?: string;
  status?: string;
  result?: string;
  reasonCode?: string;
  createdAt?: string;
  finishedAt?: string;
  startedAt?: string;
  [key: string]: unknown;
};

export type UpstreamGatewayMetrics = {
  totalForwardCount?: number;
  totalFailureCount?: number;
  [key: string]: unknown;
};

export function listUpstreamGatewayServices() {
  return getJson<{ items?: UpstreamGatewayService[] }>("/api/gateway/v1/external-services");
}

export function listUpstreamGatewayAudit() {
  return getJson<{ items?: UpstreamGatewayAuditItem[] }>("/api/gateway/v1/audit");
}

export function getUpstreamGatewayMetrics() {
  return getJson<UpstreamGatewayMetrics>("/api/gateway/v1/metrics");
}

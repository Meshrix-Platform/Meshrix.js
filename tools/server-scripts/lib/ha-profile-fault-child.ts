#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createEndpointTrafficController } from "../../../packages/agents/src/upstream-gateway/endpoint-traffic.ts";

const reportPath: any = path.resolve(String(process.argv[2] || ""));

async function main() : Promise<any> {
  const trafficBuckets: any = new Map<any, any>();
  const endpointCursors: any = new Map<any, any>();
  const endpointCircuits: any = new Map<any, any>();
  const audits: any[] = [];
  const metrics: any[] = [];
  const controller: any = createEndpointTrafficController({
    trafficBuckets,
    endpointCursors,
    endpointCircuits,
    appendAudit: (entry?: any) : any => {
      audits.push(entry);
    },
    recordMetric: (entry?: any) : any => {
      metrics.push(entry);
    },
    persist: async () : Promise<any> => undefined,
  });
  const service: Record<string, any> = {
    serviceId: "ha-fault-service",
    baseUrl: "http://127.0.0.1:0",
    circuitBreaker: {
      enabled: true,
      failureThreshold: 2,
      cooldownMs: 50,
    },
  };
  const operation: Record<string, any> = { operationKey: "invoke" };
  const initial: any = controller.selectEndpointTraffic(service, operation);
  const endpoint: any = initial.endpoint;
  controller.recordEndpointOutcome(service, operation, endpoint, { statusCode: 500, ok: false });
  controller.recordEndpointOutcome(service, operation, endpoint, { statusCode: 500, ok: false });
  const openSelection: any = controller.selectEndpointTraffic(service, operation);
  const openRejected: any = openSelection.traffic?.allowed === false &&
    openSelection.traffic?.deniedReason === "circuit_open";
  await new Promise((resolve?: any) : any => setTimeout(resolve, 60));
  const recoveredSelection: any = controller.selectEndpointTraffic(service, operation);
  const recovered: any = recoveredSelection.traffic?.allowed === true &&
    recoveredSelection.endpoint?.endpointId === endpoint.endpointId;
  const payload: Record<string, any> = {
    schemaVersion: "v0.0.1:ha:ha-profile-fault-child-1",
    generatedAt: new Date().toISOString(),
    profile: "ha",
    accepted: openRejected && recovered,
    summary: {
      circuitOpened: openRejected,
      circuitRecovered: recovered,
      auditEvents: audits.length,
      metricEvents: metrics.length,
    },
    privacySafe: true,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  if (!payload.accepted) process.exitCode = 1;
}

main().catch(() : any => {
  process.exitCode = 1;
});

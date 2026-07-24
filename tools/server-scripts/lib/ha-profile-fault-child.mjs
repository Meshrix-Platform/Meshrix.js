#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createEndpointTrafficController } from "../../../packages/agents/src/upstream-gateway/endpoint-traffic.mjs";

const reportPath = path.resolve(String(process.argv[2] || ""));

async function main() {
  const trafficBuckets = new Map();
  const endpointCursors = new Map();
  const endpointCircuits = new Map();
  const audits = [];
  const metrics = [];
  const controller = createEndpointTrafficController({
    trafficBuckets,
    endpointCursors,
    endpointCircuits,
    appendAudit: (entry) => {
      audits.push(entry);
    },
    recordMetric: (entry) => {
      metrics.push(entry);
    },
    persist: async () => undefined,
  });
  const service = {
    serviceId: "ha-fault-service",
    baseUrl: "http://127.0.0.1:0",
    circuitBreaker: {
      enabled: true,
      failureThreshold: 2,
      cooldownMs: 50,
    },
  };
  const operation = { operationKey: "invoke" };
  const initial = controller.selectEndpointTraffic(service, operation);
  const endpoint = initial.endpoint;
  controller.recordEndpointOutcome(service, operation, endpoint, { statusCode: 500, ok: false });
  controller.recordEndpointOutcome(service, operation, endpoint, { statusCode: 500, ok: false });
  const openSelection = controller.selectEndpointTraffic(service, operation);
  const openRejected = openSelection.traffic?.allowed === false &&
    openSelection.traffic?.deniedReason === "circuit_open";
  await new Promise((resolve) => setTimeout(resolve, 60));
  const recoveredSelection = controller.selectEndpointTraffic(service, operation);
  const recovered = recoveredSelection.traffic?.allowed === true &&
    recoveredSelection.endpoint?.endpointId === endpoint.endpointId;
  const payload = {
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

main().catch(() => {
  process.exitCode = 1;
});

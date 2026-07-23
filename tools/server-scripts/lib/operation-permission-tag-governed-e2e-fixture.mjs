import http from "node:http";

import { seedVerifierUpstreamServices } from "./upstream-gateway-verifier-publication.mjs";
import {
  OPERATION_PERMISSION_TAG_GOVERNED_E2E
} from "./operation-permission-tag-governed-e2e-constants.mjs";

export function createTagGovernedFixtureState() {
  return { echoCount: 0 };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

export function closeServer(target) {
  return new Promise((resolve) => {
    if (!target?.close) {
      resolve();
      return;
    }
    target.close(() => resolve());
  });
}

export function startTagGovernedFixtureServer(fixtureState) {
  return new Promise((resolve) => {
    const upstream = http.createServer(async (request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      await new Promise((done) => request.on("end", done));
      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/echo") {
        fixtureState.echoCount += 1;
        const body = Buffer.concat(chunks).toString("utf8");
        sendJson(response, 200, {
          ok: true,
          echoed: body ? JSON.parse(body) : {}
        });
        return;
      }
      sendJson(response, 404, { ok: false, error: "not_found" });
    });
    upstream.listen(0, "127.0.0.1", () => {
      const address = upstream.address();
      resolve({
        server: upstream,
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

export async function seedTagGovernedUpstreamService({
  userDataPath,
  fixtureUrl
} = {}) {
  await seedVerifierUpstreamServices({
    userDataPath,
    services: [
      {
        serviceId: OPERATION_PERMISSION_TAG_GOVERNED_E2E.serviceId,
        label: "Tag governed external service verifier",
        baseUrl: fixtureUrl,
        allowLocalNetwork: true,
        healthPath: "/health",
        operations: [
          {
            operationKey: "echo",
            method: "POST",
            path: "/echo",
            risk: "safe_write",
            requiredScopes: ["gateway:write"]
          },
          {
            operationKey: "approval",
            method: "POST",
            path: "/echo",
            risk: "repair_write",
            requiredScopes: ["gateway:maintain"],
            requiresApproval: true
          }
        ]
      }
    ]
  });
}

import http from "node:http";

import { seedVerifierUpstreamServices } from "./upstream-gateway-verifier-publication.ts";
import {
  OPERATION_PERMISSION_TAG_GOVERNED_E2E
} from "./operation-permission-tag-governed-e2e-constants.ts";

export function createTagGovernedFixtureState() : any {
  return { echoCount: 0 };
}

function sendJson(response?: any, status?: any, payload?: any) : any {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

export function closeServer(target?: any) : any {
  return new Promise((resolve?: any) : any => {
    if (!target?.close) {
      resolve();
      return;
    }
    target.close(() : any => resolve());
  });
}

export function startTagGovernedFixtureServer(fixtureState?: any) : any {
  return new Promise((resolve?: any) : any => {
    const upstream: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
      const url: any = new URL(request.url || "/", "http://127.0.0.1");
      const chunks: any[] = [];
      request.on("data", (chunk?: any) : any => chunks.push(chunk));
      await new Promise((done?: any) : any => request.on("end", done));
      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/echo") {
        fixtureState.echoCount += 1;
        const body: any = Buffer.concat(chunks).toString("utf8");
        sendJson(response, 200, {
          ok: true,
          echoed: body ? JSON.parse(body) : {}
        });
        return;
      }
      sendJson(response, 404, { ok: false, error: "not_found" });
    });
    upstream.listen(0, "127.0.0.1", () : any => {
      const address: any = upstream.address();
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
}: Record<string, any> = {}) : Promise<any> {
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
            requiredScopes: ["gateway:write"],
            payloadTransport: {
              request: { mode: "structured_json", maxBytes: 1024 * 1024, mediaTypes: ["application/json"] },
              response: { mode: "structured_json", maxBytes: 1024 * 1024, mediaTypes: ["application/json"] }
            }
          },
          {
            operationKey: "approval",
            method: "POST",
            path: "/echo",
            risk: "repair_write",
            requiredScopes: ["gateway:maintain"],
            requiresApproval: true,
            payloadTransport: {
              request: { mode: "structured_json", maxBytes: 1024 * 1024, mediaTypes: ["application/json"] },
              response: { mode: "structured_json", maxBytes: 1024 * 1024, mediaTypes: ["application/json"] }
            }
          }
        ]
      }
    ]
  });
}

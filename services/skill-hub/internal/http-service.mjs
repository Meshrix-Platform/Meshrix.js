import crypto from "node:crypto";

import { createSkillHubApplication } from "./application.mjs";
import { createServiceData } from "./service-data.mjs";

const OPERATION_PATTERN = /^\/v1\/operations\/([a-z][a-z0-9_.]{2,96})$/u;

function writeJson(response, status, payload) {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "x-content-type-options": "nosniff"
  });
  response.end(bytes);
}

async function readJson(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body is invalid."), { status: 400 });
  }
}

function authorized(request, authToken) {
  const header = String(request.headers.authorization || "");
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(authToken, "utf8");
  const accepted = presented.byteLength === expected.byteLength && crypto.timingSafeEqual(presented, expected);
  presented.fill(0);
  expected.fill(0);
  return accepted;
}

export async function createSkillHubHttpHandler({
  dataRoot,
  maxRequestBytes = 2 * 1024 * 1024,
  authToken = "synthetic-skill-hub-test-token-000000000000"
} = {}) {
  if (Buffer.byteLength(String(authToken), "utf8") < 32 || Buffer.byteLength(String(authToken), "utf8") > 512) {
    throw new TypeError("Skill Hub HTTP service requires a bounded authentication token.");
  }
  const application = await createSkillHubApplication({ serviceData: createServiceData(dataRoot) });
  const handler = async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://skill-hub.invalid");
      if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
        writeJson(response, 200, { ok: true, service: "skill-hub", protocolVersion: "v0.0.1:skill-hub:service-1" });
        return;
      }
      if (!authorized(request, authToken)) {
        writeJson(response, 401, { ok: false, error: { code: "authentication_required" } });
        return;
      }
      const match = OPERATION_PATTERN.exec(url.pathname);
      if (request.method !== "POST" || !match) {
        writeJson(response, 404, { ok: false, error: { code: "route_not_found" } });
        return;
      }
      const result = await application.invoke(match[1], await readJson(request, maxRequestBytes));
      writeJson(response, 200, result);
    } catch (error) {
      writeJson(response, Number(error?.status || 500), {
        ok: false,
        error: { code: Number(error?.status) === 413 ? "request_too_large" : "request_invalid" }
      });
    }
  };
  handler.close = () => application.close();
  return handler;
}

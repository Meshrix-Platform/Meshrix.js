import crypto from "node:crypto";

import { createSkillHubApplication } from "./application.mjs";
import { createServiceData } from "./service-data.mjs";
import { createSkillHubEventJournal, isSkillHubMutation } from "./service-events.mjs";

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
  const serviceData = createServiceData(dataRoot);
  const application = await createSkillHubApplication({ serviceData });
  const events = await createSkillHubEventJournal({ serviceData });
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
      if (request.method === "GET" && url.pathname === "/v1/events") {
        const headerCursor = Number.parseInt(String(request.headers["last-event-id"] || "0"), 10);
        const queryCursor = Number.parseInt(String(url.searchParams.get("cursor") || "0"), 10);
        const cursor = Number.isSafeInteger(headerCursor) && headerCursor >= 0 ? headerCursor : queryCursor;
        response.writeHead(200, {
          "cache-control": "no-store, no-transform",
          "content-type": "text/event-stream; charset=utf-8",
          connection: "keep-alive",
          "x-content-type-options": "nosniff"
        });
        response.flushHeaders?.();
        const subscription = events.subscribe({ request, response, cursor });
        if (!subscription.ok) response.destroy();
        return;
      }
      const match = OPERATION_PATTERN.exec(url.pathname);
      if (request.method !== "POST" || !match) {
        writeJson(response, 404, { ok: false, error: { code: "route_not_found" } });
        return;
      }
      const input = await readJson(request, maxRequestBytes);
      const result = await application.invoke(match[1], input);
      if (result?.statusCode >= 200 && result.statusCode < 400 && isSkillHubMutation(match[1], input)) {
        await events.publish(match[1]);
      }
      writeJson(response, 200, result);
    } catch (error) {
      writeJson(response, Number(error?.status || 500), {
        ok: false,
        error: { code: Number(error?.status) === 413 ? "request_too_large" : "request_invalid" }
      });
    }
  };
  handler.close = async () => {
    await events.close();
    await application.close();
  };
  return handler;
}

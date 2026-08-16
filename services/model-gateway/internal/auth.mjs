import crypto from "node:crypto";

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");
  return leftBuffer.byteLength === rightBuffer.byteLength &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizeClients(envClients) {
  if (!isPlainObject(envClients)) {
    throw new TypeError("MODEL_GATEWAY_CLIENTS must be a JSON object keyed by clientId.");
  }
  const normalized = {};
  for (const [clientId, client] of Object.entries(envClients)) {
    if (!clientId || clientId.length > 128) {
      throw new TypeError("clientId must be a non-empty string of at most 128 characters.");
    }
    if (!isPlainObject(client)) {
      throw new TypeError(`client ${clientId} must be an object.`);
    }
    if (typeof client.subject !== "string" || client.subject.length === 0) {
      throw new TypeError(`client ${clientId} requires a non-empty subject.`);
    }
    const secretBytes = typeof client.secret === "string"
      ? Buffer.byteLength(client.secret, "utf8")
      : 0;
    if (secretBytes < 32 || secretBytes > 512) {
      throw new TypeError(`client ${clientId} requires a secret between 32 and 512 bytes.`);
    }
    if (!Array.isArray(client.scopes) ||
        client.scopes.some((scope) => typeof scope !== "string" || scope.length === 0)) {
      throw new TypeError(`client ${clientId} requires a non-empty string array of scopes.`);
    }
    normalized[clientId] = {
      subject: client.subject,
      secret: client.secret,
      scopes: [...client.scopes],
    };
  }
  return normalized;
}

function presentedToken(headers) {
  const authorization = String(headers?.authorization ?? "");
  if (authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const apiKey = String(headers?.["x-api-key"] ?? "");
  return apiKey || null;
}

export function createClientAuthenticator({ clients }) {
  const clientList = Object.values(clients ?? {});
  function authenticate(headers) {
    const presented = presentedToken(headers);
    if (!presented) return null;
    for (const client of clientList) {
      if (timingSafeEqual(presented, client.secret ?? "")) return client;
    }
    return null;
  }
  function hasScope(client, scope) {
    return Boolean(client && Array.isArray(client.scopes) && client.scopes.includes(scope));
  }
  return { authenticate, hasScope };
}

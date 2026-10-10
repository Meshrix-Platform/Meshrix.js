/**
 * Meshrix private relay Worker — local Workerd runtime.
 *
 * Routes:
 *   GET  /healthz                                   service liveness (no auth)
 *   GET  /session/:tenantId/:routeId                WebSocket upgrade for an
 *                                                   authenticated endpoint socket
 *   POST /vault/:vaultId                            bounded recovery-wire API
 *   POST /admin/tenants/:tenantId/enroll            local enrollment provisioning
 *   POST /admin/tenants/:tenantId/revoke            local revocation authority
 *   GET  /admin/tenants/:tenantId/directory         operator view (digests hidden)
 *   POST /admin/vaults/:vaultId/provision           writer/recovery key provisioning
 *   GET  /admin/counters/:object/:key               per-object operation counters
 *   GET  /admin/metrics?tenant=<id>[&vault=<id>]    Prometheus text exposition
 *                                                   fanned out over the tenant's
 *                                                   enumerated objects
 *
 * The admin surface is a local-provisioning boundary guarded by the
 * RELAY_ADMIN_TOKEN var (synthetic in wrangler.toml for local checks). It is
 * not part of the wire contract and never appears on public traffic.
 */

import type { PrivateRelayEnv } from "./env.ts";
import { RELAY_RUNTIME_LIMITS, adminSurfaceMode, integerEnv } from "./env.ts";
import { verifySessionCredential } from "./ticket.ts";
import { verifyInviteTicket } from "./invite.ts";
import { verifyAccessJwt } from "./access.ts";
import { JOIN_PAGE_HTML } from "./join-page.ts";
import { bearerToken, jsonResponse, readBoundedJson } from "./http.ts";
import { constantTimeEqual, directoryObjectName, isOpaqueId, mailboxObjectName, sessionObjectName, vaultObjectName } from "./ids.ts";
import type { RelayCounterKey, RelayCountersShape, RelayMetricSample } from "./metrics.ts";
import { RELAY_COUNTER_KEYS, emptyCounters, renderPrometheusExposition } from "./metrics.ts";

export { RelayDirectoryDO } from "./relay-directory.ts";
export { RelaySessionDO } from "./relay-session.ts";
export { RecoveryVaultDO } from "./recovery-vault.ts";
export { MailboxDO } from "./mailbox.ts";

function adminAuthorized(request: Request, env: PrivateRelayEnv): boolean {
  const configured = env.RELAY_ADMIN_TOKEN;
  if (typeof configured !== "string" || configured.length < 16) return false;
  const presented = bearerToken(request);
  return presented !== null && constantTimeEqual(presented, configured);
}

/**
 * In-process damper for requests that hit unauthenticated or pre-object
 * paths. Each isolate keeps a small per-source-IP bucket so sustained
 * forging from one address is throttled instead of looping at full
 * request volume. Honest scope: a damper inside one isolate, not a
 * fleet-wide limiter — distributed abuse is the edge/WAF layer's job (the
 * separately designed public-admission work).
 */
const SOURCE_ATTEMPT_LIMIT = 30;
const SOURCE_ATTEMPT_WINDOW_MS = 60_000;
const SOURCE_ATTEMPT_MAX_SOURCES = 10_000;
const sourceAttempts = new Map<string, { count: number; resetAt: number }>();

function sourceAttemptOverLimit(request: Request): boolean {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const now = Date.now();
  let bucket = sourceAttempts.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + SOURCE_ATTEMPT_WINDOW_MS };
    sourceAttempts.set(ip, bucket);
  }
  bucket.count += 1;
  if (sourceAttempts.size > SOURCE_ATTEMPT_MAX_SOURCES) {
    for (const [key, entry] of sourceAttempts) {
      if (entry.resetAt <= now) sourceAttempts.delete(key);
    }
    if (sourceAttempts.size > SOURCE_ATTEMPT_MAX_SOURCES) sourceAttempts.clear();
  }
  return bucket.count > SOURCE_ATTEMPT_LIMIT;
}

function unauthenticatedRequest(request: Request, status: number, error: string): Response {
  if (sourceAttemptOverLimit(request)) {
    return jsonResponse({ error: "rate_limited" }, 429);
  }
  return jsonResponse({ error }, status);
}

/**
 * Uniform response hardening for the public surface: HSTS (long-lived —
 * clients must not get a cleartext downgrade after first contact),
 * nosniff, and a default no-store so wire data is never cached. WebSocket
 * upgrade responses pass through untouched — mutating a 101 would break
 * the socket handoff.
 */
function withSecurityHeaders(response: Response): Response {
  if (response.status === 101 || response.webSocket) return response;
  const headers = new Headers(response.headers);
  headers.set("strict-transport-security", "max-age=63072000; includeSubDomains");
  headers.set("x-content-type-options", "nosniff");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function propagateRevocation(
  env: PrivateRelayEnv,
  tenantId: string,
  outcome: {
    revocationRevision: number;
    affectedRouteIds: string[];
    affectedDevices?: { routeId: string; deviceId: string }[];
    deviceId: string | null;
    routeId: string | null;
    all: boolean;
  },
): Promise<void> {
  const routes = outcome.affectedRouteIds.slice(0, RELAY_RUNTIME_LIMITS.maxRoutesPerTenant);
  const routeRevoked = outcome.all || outcome.routeId !== null;
  await Promise.all(routes.map(async (routeId) => {
    const stub = env.RELAY_SESSION.get(env.RELAY_SESSION.idFromName(sessionObjectName(tenantId, routeId)));
    const response = await stub.fetch("http://session/internal/apply-revocation", {
      method: "POST",
      body: JSON.stringify({
        revocationRevision: outcome.revocationRevision,
        deviceId: outcome.deviceId,
        routeRevoked,
      }),
    });
    // Drain the small body: an unconsumed response stream keeps the session
    // object referenced and delays hibernation/eviction accounting.
    await response.arrayBuffer();
  }));
  // Mailbox partitions learn owner revocation through the same push so
  // stale-session races still answer honestly (bundles, acks) or drop.
  const devices = (outcome.affectedDevices ?? []).slice(0, RELAY_RUNTIME_LIMITS.maxDevicesPerTenant);
  await Promise.all(devices.map(async ({ routeId, deviceId }) => {
    const stub = env.RELAY_MAILBOX.get(env.RELAY_MAILBOX.idFromName(mailboxObjectName(tenantId, routeId, deviceId)));
    const response = await stub.fetch("http://mailbox/internal/apply-revocation", {
      method: "POST",
      body: JSON.stringify({
        revocationRevision: outcome.revocationRevision,
        deviceId: outcome.deviceId,
        routeRevoked,
      }),
    });
    await response.arrayBuffer();
  }));
}

/**
 * Read one object's `/internal/counters` into the honest tier split. The
 * merged `counters` member is intentionally ignored — scope labels must come
 * from the real tiers. Unknown keys and non-numeric values are dropped; a
 * payload missing the split contributes nothing rather than fake a tier.
 */
function normalizeCounterTier(value: unknown): RelayCountersShape | null {
  if (!value || typeof value !== "object") return null;
  const shape = emptyCounters();
  for (const key of RELAY_COUNTER_KEYS) {
    const raw = (value as Record<RelayCounterKey, unknown>)[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) shape[key] = raw;
  }
  return shape;
}

async function scrapeCounterTiers(stub: DurableObjectStub, url: string): Promise<{ durable: RelayCountersShape; ephemeral: RelayCountersShape } | null> {
  try {
    const response = await stub.fetch(url);
    const payload = await response.json().catch(() => null) as {
      durable?: unknown;
      ephemeral?: unknown;
    } | null;
    if (!response.ok || !payload) return null;
    const durable = normalizeCounterTier(payload.durable);
    const ephemeral = normalizeCounterTier(payload.ephemeral);
    if (!durable || !ephemeral) return null;
    return { durable, ephemeral };
  } catch {
    return null;
  }
}

/**
 * Prometheus text exposition for one tenant: the directory's own counters
 * plus its bounded inventory drive the fan-out — every enumerated route's
 * session object and every enumerated device's mailbox partition is scraped
 * through `/internal/counters`. Vault objects have no tenant-scoped
 * registry, so they are included only for explicit `vault` query ids and
 * are summed into one `object="vault"` series (the exposition label set
 * carries no vault id). Values are counts labeled by opaque ids; nothing
 * else leaves the objects.
 */
async function handleAdminMetrics(url: URL, env: PrivateRelayEnv): Promise<Response> {
  const tenantId = url.searchParams.get("tenant") ?? "";
  if (!isOpaqueId(tenantId)) return jsonResponse({ error: "identity_ambiguous" }, 400);
  const vaultIds = [...new Set(url.searchParams.getAll("vault"))]
    .slice(0, RELAY_RUNTIME_LIMITS.maxRoutesPerTenant);
  for (const vaultId of vaultIds) {
    if (!isOpaqueId(vaultId)) return jsonResponse({ error: "identity_ambiguous" }, 400);
  }

  const directory = env.RELAY_DIRECTORY.get(env.RELAY_DIRECTORY.idFromName(directoryObjectName(tenantId)));
  const [directoryCountersResponse, inventoryResponse] = await Promise.all([
    scrapeCounterTiers(directory, "http://directory.internal/internal/counters"),
    directory.fetch("http://directory.internal/internal/inventory").catch(() => null),
  ]);
  const inventory = inventoryResponse?.ok
    ? await inventoryResponse.json() as { routes?: string[]; devices?: { routeId: string; deviceId: string }[] }
    : { routes: [], devices: [] };
  const routeIds = (Array.isArray(inventory.routes) ? inventory.routes : [])
    .filter(isOpaqueId)
    .slice(0, RELAY_RUNTIME_LIMITS.maxRoutesPerTenant);
  const devices = (Array.isArray(inventory.devices) ? inventory.devices : [])
    .filter((device) => isOpaqueId(device?.routeId) && isOpaqueId(device?.deviceId))
    .slice(0, RELAY_RUNTIME_LIMITS.maxDevicesPerTenant);

  const samples: RelayMetricSample[] = [];
  if (directoryCountersResponse) {
    samples.push({
      labels: { object: "directory", tenant: tenantId, route: "", device: "" },
      ...directoryCountersResponse,
    });
  }

  // `Promise.all` preserves declaration order — sessions by route, then
  // mailboxes — so exposition ordering stays deterministic. Vault objects
  // share the fixed (object,tenant,route,device) label set, so their
  // counters are summed into a single object-class series instead of
  // emitting duplicate label sets.
  const [fanned, vaultScrapes] = await Promise.all([
    Promise.all([
      ...routeIds.map(async (routeId) => {
        const stub = env.RELAY_SESSION.get(env.RELAY_SESSION.idFromName(sessionObjectName(tenantId, routeId)));
        const tiers = await scrapeCounterTiers(stub, "http://session.internal/internal/counters");
        return tiers ? { labels: { object: "session" as const, tenant: tenantId, route: routeId, device: "" }, ...tiers } : null;
      }),
      ...devices.map(async ({ routeId, deviceId }) => {
        const stub = env.RELAY_MAILBOX.get(env.RELAY_MAILBOX.idFromName(mailboxObjectName(tenantId, routeId, deviceId)));
        const tiers = await scrapeCounterTiers(stub, "http://mailbox.internal/internal/counters");
        return tiers ? { labels: { object: "mailbox" as const, tenant: tenantId, route: routeId, device: deviceId }, ...tiers } : null;
      }),
    ]),
    Promise.all(vaultIds.map((vaultId) => {
      const stub = env.RECOVERY_VAULT.get(env.RECOVERY_VAULT.idFromName(vaultObjectName(vaultId)));
      return scrapeCounterTiers(stub, "http://vault.internal/internal/counters");
    })),
  ]);
  for (const sample of fanned) if (sample) samples.push(sample);
  const vaultTotals = { durable: emptyCounters(), ephemeral: emptyCounters() };
  let vaultSeen = false;
  for (const tiers of vaultScrapes) {
    if (!tiers) continue;
    vaultSeen = true;
    for (const key of RELAY_COUNTER_KEYS) {
      vaultTotals.durable[key] += tiers.durable[key];
      vaultTotals.ephemeral[key] += tiers.ephemeral[key];
    }
  }
  if (vaultSeen) {
    samples.push({ labels: { object: "vault", tenant: tenantId, route: "", device: "" }, ...vaultTotals });
  }

  return new Response(renderPrometheusExposition(samples), {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}

async function handleRequest(request: Request, env: PrivateRelayEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/healthz") {
      return jsonResponse({ ok: true, service: "meshrix-private-relay" });
    }

    // --- Invite-only join surface -------------------------------------
    // The page is a static invite-redemption UI; redemption itself is a
    // signed-ticket check at the worker edge (zero storage on a forgery)
    // and a transaction-bound spend inside the tenant directory object.
    if (request.method === "GET" && path === "/join") {
      return new Response(JOIN_PAGE_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'",
        },
      });
    }
    if (request.method === "POST" && path === "/invite/redeem") {
      const body = await readBoundedJson(request, 16_384) as Record<string, unknown> | null;
      const invite = typeof body?.invite === "string" ? body.invite.trim() : "";
      const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
      const verified = invite ? await verifyInviteTicket(env, invite) : null;
      if (!verified || !isOpaqueId(deviceId)) {
        return unauthenticatedRequest(request, 401, "invite_invalid");
      }
      const { claims } = verified;
      const stub = env.RELAY_DIRECTORY.get(env.RELAY_DIRECTORY.idFromName(directoryObjectName(claims.tenantId)));
      const enrolled = await stub.fetch("http://directory.internal/internal/redeem-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jti: claims.jti,
          tenantId: claims.tenantId,
          routeId: claims.routeId,
          role: claims.role,
          mode: claims.mode,
          deviceId,
        }),
      });
      if (!enrolled.ok) return enrolled;
      const payload = await enrolled.json<Record<string, unknown>>();
      return jsonResponse({ ...payload, tenantId: claims.tenantId });
    }

    // --- Endpoint socket upgrade -------------------------------------
    const sessionMatch = path.match(/^\/session\/([^/]+)\/([^/]+)$/u);
    if (sessionMatch && request.method === "GET") {
      const [, tenantId, routeId] = sessionMatch;
      if (!isOpaqueId(tenantId) || !isOpaqueId(routeId)) {
        return jsonResponse({ error: "identity_ambiguous" }, 400);
      }
      if (request.headers.get("upgrade") !== "websocket") {
        return jsonResponse({ error: "websocket_required" }, 426);
      }
      // Stateless cost gate: every upgrade that reaches a Durable Object
      // instantiates it (session + directory lookup = billed compute and
      // storage reads). A ticketed credential is verified here with zero
      // storage; forged upgrades die before any object exists. The DO
      // remains the admission authority — this only bounds unauthenticated
      // cost on public routes.
      const auth = request.headers.get("authorization") ?? "";
      const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!presented || !(await verifySessionCredential(env, presented, { tenantId, routeId }))) {
        return unauthenticatedRequest(request, 401, "unauthorized");
      }
      const stub = env.RELAY_SESSION.get(
        env.RELAY_SESSION.idFromName(sessionObjectName(tenantId, routeId)),
      );
      const forward = new URL("http://session.internal/session");
      forward.searchParams.set("tenantId", tenantId);
      forward.searchParams.set("routeId", routeId);
      return stub.fetch(new Request(forward.toString(), request));
    }

    // --- Recovery vault wire API --------------------------------------
    const vaultMatch = path.match(/^\/vault\/([^/]+)$/u);
    if (vaultMatch && request.method === "POST") {
      const vaultId = vaultMatch[1];
      if (!isOpaqueId(vaultId)) return unauthenticatedRequest(request, 404, "not_found");
      // Every well-formed attempt is counted against its source *before*
      // the object exists — the post-hoc "count the refusal" pass used to
      // let the 31st forged POST still pay one instantiation. The bound
      // is generous for real clients (vault ops are rare per device) and
      // caps forged-flood cost at the damper's per-source allowance.
      if (sourceAttemptOverLimit(request)) {
        return jsonResponse({ error: "rate_limited" }, 429);
      }
      // Declared size must exist and fit the bound before instantiation:
      // a missing Content-Length used to skip the check entirely and let
      // the object pay the cost of truncating the body instead.
      const rawLength = request.headers.get("content-length");
      if (rawLength === null) return jsonResponse({ error: "length_required" }, 411);
      const declaredBytes = Number(rawLength);
      const maxVaultBytes = integerEnv(env.RELAY_MAX_VAULT_MESSAGE_BYTES, RELAY_RUNTIME_LIMITS.defaultMaxVaultMessageBytes, 1, 16 * 1024 * 1024);
      if (!Number.isFinite(declaredBytes) || declaredBytes < 0) {
        return jsonResponse({ error: "invalid_body" }, 400);
      }
      if (declaredBytes > maxVaultBytes) {
        return jsonResponse({ error: "request_too_large" }, 413);
      }
      const stub = env.RECOVERY_VAULT.get(env.RECOVERY_VAULT.idFromName(vaultObjectName(vaultId)));
      const forward = new Request("http://vault.internal/vault", request);
      const response = await stub.fetch(forward);
      // Existence oracle: the object distinguishes an unprovisioned vault
      // (404 not_found) from a provisioned vault with an invalid proof
      // (403 proof_invalid). Collapsing both into one refusal — status
      // and body — keeps probing from mapping which vault ids exist.
      if (response.status === 404 || response.status === 403) {
        return jsonResponse({ error: "refused" }, 403);
      }
      return response;
    }

    // --- Admin control plane ------------------------------------------
    // Closed by deployment choice, not just by credential: `off` (the
    // default) answers 404 so the surface does not exist on public routes;
    // `access` requires a *verified* Access JWT — header presence alone is
    // forgeable on routes that never traverse an Access policy (workers.dev
    // is disabled on the public shape regardless).
    if (path.startsWith("/admin/")) {
      const surface = adminSurfaceMode(env);
      if (surface === "off") {
        return jsonResponse({ error: "not_found" }, 404);
      }
      if (surface === "access" && !(await verifyAccessJwt(env, request))) {
        return jsonResponse({ error: "not_found" }, 404);
      }
      if (!adminAuthorized(request, env)) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      const enrollMatch = path.match(/^\/admin\/tenants\/([^/]+)\/enroll$/u);
      if (enrollMatch && request.method === "POST") {
        const tenantId = enrollMatch[1];
        if (!isOpaqueId(tenantId)) return jsonResponse({ error: "identity_ambiguous" }, 400);
        const stub = env.RELAY_DIRECTORY.get(env.RELAY_DIRECTORY.idFromName(directoryObjectName(tenantId)));
        return stub.fetch(new Request("http://directory.internal/enroll", request));
      }
      const revokeMatch = path.match(/^\/admin\/tenants\/([^/]+)\/revoke$/u);
      if (revokeMatch && request.method === "POST") {
        const tenantId = revokeMatch[1];
        if (!isOpaqueId(tenantId)) return jsonResponse({ error: "identity_ambiguous" }, 400);
        const stub = env.RELAY_DIRECTORY.get(env.RELAY_DIRECTORY.idFromName(directoryObjectName(tenantId)));
        const response = await stub.fetch(new Request("http://directory.internal/revoke", request));
        if (response.ok) {
          const outcome = await response.clone().json() as {
            revocationRevision: number;
            affectedRouteIds: string[];
            deviceId: string | null;
            routeId: string | null;
            all: boolean;
          };
          await propagateRevocation(env, tenantId, outcome);
        }
        return response;
      }
      const directoryMatch = path.match(/^\/admin\/tenants\/([^/]+)\/directory$/u);
      if (directoryMatch && request.method === "GET") {
        const tenantId = directoryMatch[1];
        if (!isOpaqueId(tenantId)) return jsonResponse({ error: "identity_ambiguous" }, 400);
        const stub = env.RELAY_DIRECTORY.get(env.RELAY_DIRECTORY.idFromName(directoryObjectName(tenantId)));
        return stub.fetch("http://directory.internal/state");
      }
      const provisionMatch = path.match(/^\/admin\/vaults\/([^/]+)\/provision$/u);
      if (provisionMatch && request.method === "POST") {
        const vaultId = provisionMatch[1];
        if (!isOpaqueId(vaultId)) return jsonResponse({ error: "not_found" }, 404);
        const stub = env.RECOVERY_VAULT.get(env.RECOVERY_VAULT.idFromName(vaultObjectName(vaultId)));
        return stub.fetch(new Request("http://vault.internal/internal/provision", request));
      }
      const countersMatch = path.match(/^\/admin\/counters\/(session|directory|vault|mailbox)\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/u);
      if (countersMatch && request.method === "GET") {
        const [, kind, first, second, third] = countersMatch;
        if (kind === "session") {
          if (!second || !isOpaqueId(first) || !isOpaqueId(second)) return jsonResponse({ error: "not_found" }, 404);
          const stub = env.RELAY_SESSION.get(env.RELAY_SESSION.idFromName(sessionObjectName(first, second)));
          return stub.fetch("http://session.internal/internal/counters");
        }
        if (kind === "mailbox") {
          if (!second || !third || !isOpaqueId(first) || !isOpaqueId(second) || !isOpaqueId(third)) {
            return jsonResponse({ error: "not_found" }, 404);
          }
          const stub = env.RELAY_MAILBOX.get(env.RELAY_MAILBOX.idFromName(mailboxObjectName(first, second, third)));
          return stub.fetch("http://mailbox.internal/internal/counters");
        }
        if (kind === "directory") {
          if (!isOpaqueId(first)) return jsonResponse({ error: "not_found" }, 404);
          const stub = env.RELAY_DIRECTORY.get(env.RELAY_DIRECTORY.idFromName(directoryObjectName(first)));
          return stub.fetch("http://directory.internal/internal/counters");
        }
        if (!isOpaqueId(first)) return jsonResponse({ error: "not_found" }, 404);
        const stub = env.RECOVERY_VAULT.get(env.RECOVERY_VAULT.idFromName(vaultObjectName(first)));
        return stub.fetch("http://vault.internal/internal/counters");
      }
      if (path === "/admin/metrics" && request.method === "GET") {
        return await handleAdminMetrics(url, env);
      }
      const vaultStateMatch = path.match(/^\/admin\/vaults\/([^/]+)\/state$/u);
      if (vaultStateMatch && request.method === "GET") {
        const vaultId = vaultStateMatch[1];
        if (!isOpaqueId(vaultId)) return jsonResponse({ error: "not_found" }, 404);
        const stub = env.RECOVERY_VAULT.get(env.RECOVERY_VAULT.idFromName(vaultObjectName(vaultId)));
        return stub.fetch("http://vault.internal/internal/state");
      }
      return jsonResponse({ error: "not_found" }, 404);
    }

    return jsonResponse({ error: "not_found" }, 404);
}

export default {
  async fetch(request: Request, env: PrivateRelayEnv): Promise<Response> {
    // HTTPS enforcement at the Cloudflare edge: the visitor scheme arrives
    // in `cf-visitor` (absent on local runtimes, where plain http is
    // correct for wrangler dev and vitest). A cleartext hit gets a
    // permanent redirect before any routing — bearer credentials must
    // never traverse plaintext. (The audit-confirmed finding: plain http
    // used to answer /healthz identically, so a client that ever fell back
    // to http:// would send Authorization headers in cleartext.)
    const visitor = request.headers.get("cf-visitor");
    if (visitor?.includes('"scheme":"http"')) {
      const target = new URL(request.url);
      target.protocol = "https:";
      return Response.redirect(target.toString(), 308);
    }
    const response = await handleRequest(request, env);
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<PrivateRelayEnv>;

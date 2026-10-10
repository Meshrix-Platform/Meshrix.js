/**
 * RelayDirectoryDO — the tenant-scoped admission and revocation authority.
 *
 * One Durable Object instance per tenantId holds the enrolled device
 * bindings, route memberships, the monotonically increasing tenant
 * revocationRevision and per-binding admissionGeneration. This is the only
 * place where relay-visible enrollment state is authoritative; session
 * objects re-check it on admission and on every reconnect.
 *
 * Stored records contain opaque routing identifiers, credential digests,
 * modes, roles and revisions only — never plaintext, credentials, semantic
 * grants or product names.
 */

import { DurableObject } from "cloudflare:workers";

import type { PrivateRelayEnv } from "./env.ts";
import { RELAY_RUNTIME_LIMITS, metricsDurableEnabled } from "./env.ts";
import { jsonResponse, readBoundedJson } from "./http.ts";
import { isOpaqueId, randomToken, sha256Hex } from "./ids.ts";
import { issueSessionCredential } from "./ticket.ts";
import { RelayCounters } from "./metrics.ts";

interface DirectoryMeta {
  tenantId: string;
  revocationRevision: number;
  admissionGenerationCounter: number;
  /** Enrollment bounds kept as counters — no list() scans on the hot path. */
  deviceCount: number;
  routeCount: number;
  createdAt: string;
}

interface DeviceRecord {
  deviceId: string;
  credentialDigest: string;
  routeId: string;
  role: "entry" | "endpoint";
  mode: "personal" | "enterprise";
  admissionGeneration: number;
  revoked: boolean;
  enrolledAt: string;
  revokedAt: string | null;
}

interface RouteRecord {
  routeId: string;
  mode: "personal" | "enterprise";
  entryDeviceId: string | null;
  endpointDeviceId: string | null;
  revoked: boolean;
  createdAt: string;
}

const META_KEY = "meta";
const DEVICE_PREFIX = "dev:";
const ROUTE_PREFIX = "route:";
/** Credential-digest index: cred:<sha256 hex> -> deviceId (never the secret). */
const CRED_PREFIX = "cred:";
/** Invitation spend ledger: inv:<jti> -> {usesLeft, deviceIds} (bounded). */
const INVITE_PREFIX = "inv:";

export class RelayDirectoryDO extends DurableObject<PrivateRelayEnv> {
  private meta: DirectoryMeta | null = null;
  private counters = new RelayCounters(undefined, { durable: metricsDurableEnabled(this.env) });

  constructor(ctx: DurableObjectState, env: PrivateRelayEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.counters.count("storageReads");
      const [meta, counters] = await Promise.all([
        ctx.storage.get<DirectoryMeta>(META_KEY),
        ctx.storage.get("counters"),
      ]);
      if (meta) this.meta = meta;
      if (counters) this.counters = new RelayCounters(counters as Record<string, number>, { durable: metricsDurableEnabled(this.env) });
    });
  }

  private async requireMeta(): Promise<DirectoryMeta> {
    if (!this.meta) {
      this.meta = {
        tenantId: this.ctx.id.name?.replace(/^directory:/, "") ?? "unknown",
        revocationRevision: 0,
        admissionGenerationCounter: 0,
        deviceCount: 0,
        routeCount: 0,
        createdAt: new Date().toISOString(),
      };
      this.counters.count("storageWrites");
      await this.ctx.storage.put(META_KEY, this.meta);
    }
    this.meta.deviceCount ??= 0;
    this.meta.routeCount ??= 0;
    return this.meta;
  }

  private async flushCounters(): Promise<void> {
    this.counters.count("storageWrites");
    await this.counters.flush((key, value) => this.ctx.storage.put(key, value));
  }

  async fetch(request: Request): Promise<Response> {
    this.counters.count("httpRequests");
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/enroll") {
        return await this.handleEnroll(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/redeem-invite") {
        return await this.handleRedeemInvite(request);
      }
      if (request.method === "POST" && url.pathname === "/revoke") {
        return await this.handleRevoke(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/credential-lookup") {
        return await this.handleCredentialLookup(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/admission-check") {
        return await this.handleAdmissionCheck(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/route-peer") {
        return await this.handleRoutePeer(request);
      }
      if (request.method === "GET" && url.pathname === "/internal/counters") {
        return jsonResponse(this.counters.tieredSnapshot());
      }
      if (request.method === "GET" && url.pathname === "/internal/inventory") {
        return await this.handleInventory();
      }
      if (request.method === "GET" && url.pathname === "/state") {
        return await this.handleState();
      }
      return jsonResponse({ error: "not_found" }, 404);
    } finally {
      await this.flushCounters();
    }
  }

  /**
   * Shared enrollment core — one source of truth for the check set and the
   * put set. Runs inside a caller-supplied storage transaction so the
   * invite-redeem path can bind a ticket spend to the enrollment atomically.
   * Returns the opaque bearer credential exactly once; only its sha256
   * digest is retained.
   */
  private async enrollDeviceInTxn(
    store: {
      get<T>(key: string): Promise<T | undefined>;
      put(key: string, value: unknown): Promise<void>;
    },
    meta: DirectoryMeta,
    input: { deviceId: string; routeId: string; role: "entry" | "endpoint"; mode: "personal" | "enterprise" },
  ): Promise<{ error: string; status: number } | { body: Record<string, unknown> }> {
    const { deviceId, routeId, role, mode } = input;
    this.counters.count("storageReads", 2);
    const [existingDevice, route] = await Promise.all([
      store.get<DeviceRecord>(`${DEVICE_PREFIX}${deviceId}`),
      store.get<RouteRecord>(`${ROUTE_PREFIX}${routeId}`),
    ]);
    if (existingDevice) return { error: "already_enrolled", status: 409 };

    if (meta.deviceCount >= RELAY_RUNTIME_LIMITS.maxDevicesPerTenant) {
      return { error: "capacity_exceeded", status: 429 };
    }
    if (!route) {
      if (meta.routeCount >= RELAY_RUNTIME_LIMITS.maxRoutesPerTenant) {
        return { error: "capacity_exceeded", status: 429 };
      }
    } else {
      if (route.mode !== mode) return { error: "mode_mismatch", status: 400 };
      if (route.revoked) return { error: "revoked", status: 403 };
      const slot = role === "entry" ? route.entryDeviceId : route.endpointDeviceId;
      if (slot) return { error: "role_occupied", status: 409 };
    }

    meta.admissionGenerationCounter += 1;
    meta.deviceCount += 1;
    if (!route) meta.routeCount += 1;
    const now = new Date().toISOString();
    const credential = await issueSessionCredential(this.env, randomToken(), {
      tenantId: meta.tenantId,
      routeId,
    });
    const credentialDigest = await sha256Hex(credential);
    const device: DeviceRecord = {
      deviceId,
      credentialDigest,
      routeId,
      role,
      mode,
      admissionGeneration: meta.admissionGenerationCounter,
      revoked: false,
      enrolledAt: now,
      revokedAt: null,
    };
    const nextRoute: RouteRecord = route ?? {
      routeId,
      mode,
      entryDeviceId: null,
      endpointDeviceId: null,
      revoked: false,
      createdAt: now,
    };
    if (role === "entry") nextRoute.entryDeviceId = deviceId;
    else nextRoute.endpointDeviceId = deviceId;

    this.counters.count("storageWrites", 4);
    await store.put(META_KEY, meta);
    await store.put(`${DEVICE_PREFIX}${deviceId}`, device);
    await store.put(`${ROUTE_PREFIX}${routeId}`, nextRoute);
    await store.put(`${CRED_PREFIX}${credentialDigest}`, deviceId);
    return {
      body: {
        deviceId,
        routeId,
        role,
        mode,
        credential,
        admissionGeneration: device.admissionGeneration,
        revocationRevision: meta.revocationRevision,
      },
    };
  }

  /**
   * Enroll a device into a route slot (operator/admin path). The shared
   * core runs inside a storage transaction for an atomic write set.
   */
  private async handleEnroll(request: Request): Promise<Response> {
    const meta = await this.requireMeta();
    const body = await readBoundedJson(request, 16_384);
    if (!body || typeof body !== "object") return jsonResponse({ error: "invalid_body" }, 400);
    const { deviceId, routeId, role, mode } = body as Record<string, unknown>;
    if (!isOpaqueId(deviceId) || !isOpaqueId(routeId)) {
      return jsonResponse({ error: "identity_ambiguous" }, 400);
    }
    if (role !== "entry" && role !== "endpoint") return jsonResponse({ error: "invalid_role" }, 400);
    if (mode !== "personal" && mode !== "enterprise") return jsonResponse({ error: "mode_mismatch" }, 400);
    const outcome = await this.ctx.storage.transaction((txn) =>
      this.enrollDeviceInTxn(txn, meta, { deviceId, routeId, role, mode }));
    return "error" in outcome ? jsonResponse({ error: outcome.error }, outcome.status) : jsonResponse(outcome.body);
  }

  /**
   * Spend a verified invitation: the outer fetch already validated the HMAC
   * ticket, so this handler binds the one-time `jti` spend to the
   * enrollment in a single transaction — an invite can never over-issue
   * beyond its minted `uses`, and replayed tickets fail closed.
   */
  private async handleRedeemInvite(request: Request): Promise<Response> {
    const meta = await this.requireMeta();
    const body = await readBoundedJson(request, 16_384);
    if (!body || typeof body !== "object") return jsonResponse({ error: "invalid_body" }, 400);
    const { jti, tenantId, routeId, role, mode, deviceId } = body as Record<string, unknown>;
    if (!isOpaqueId(jti) || !isOpaqueId(deviceId) || !isOpaqueId(routeId)) {
      return jsonResponse({ error: "identity_ambiguous" }, 400);
    }
    if (tenantId !== meta.tenantId) return jsonResponse({ error: "tenant_mismatch" }, 403);
    if (role !== "entry" && role !== "endpoint") return jsonResponse({ error: "invalid_role" }, 400);
    if (mode !== "personal" && mode !== "enterprise") return jsonResponse({ error: "mode_mismatch" }, 400);
    const inviteKey = `${INVITE_PREFIX}${jti}`;
    const outcome = await this.ctx.storage.transaction(async (txn) => {
      this.counters.count("storageReads");
      const invite = await txn.get<{ redeemedBy: string; redeemedAt: string }>(inviteKey);
      // Single-use by slot semantics: a route holds exactly one device per
      // role, so one jti can only ever mint once.
      if (invite) {
        return invite.redeemedBy === deviceId
          ? ({ error: "already_redeemed", status: 409 } as const)
          : ({ error: "invite_spent", status: 410 } as const);
      }
      const enrolled = await this.enrollDeviceInTxn(txn, meta, { deviceId, routeId, role, mode });
      if ("error" in enrolled) return enrolled;
      this.counters.count("storageWrites");
      await txn.put(inviteKey, { redeemedBy: deviceId, redeemedAt: new Date().toISOString() });
      return enrolled;
    });
    return "error" in outcome ? jsonResponse({ error: outcome.error }, outcome.status) : jsonResponse(outcome.body);
  }

  /**
   * Revoke a device or a whole route. The tenant revocationRevision only ever
   * increases; session objects are pushed the new revision by the router so
   * live sockets close promptly.
   */
  private async handleRevoke(request: Request): Promise<Response> {
    const meta = await this.requireMeta();
    const body = await readBoundedJson(request, 8_192);
    if (!body || typeof body !== "object") return jsonResponse({ error: "invalid_body" }, 400);
    const { deviceId, routeId, all } = body as Record<string, unknown>;
    const now = new Date().toISOString();
    meta.revocationRevision += 1;
    const affectedRoutes = new Set<string>();
    const affectedDevices = new Map<string, { routeId: string; deviceId: string }>();
    const writes: [string, unknown][] = [[META_KEY, meta]];

    if (all === true) {
      this.counters.count("storageReads");
      const routes = await this.ctx.storage.list<RouteRecord>({ prefix: ROUTE_PREFIX });
      for (const [key, route] of routes) {
        if (route.revoked) continue;
        route.revoked = true;
        writes.push([key, route]);
        affectedRoutes.add(route.routeId);
      }
      const devices = await this.ctx.storage.list<DeviceRecord>({ prefix: DEVICE_PREFIX });
      for (const [key, device] of devices) {
        if (device.revoked) continue;
        device.revoked = true;
        device.revokedAt = now;
        writes.push([key, device]);
        affectedDevices.set(device.deviceId, { routeId: device.routeId, deviceId: device.deviceId });
      }
    } else if (isOpaqueId(deviceId)) {
      this.counters.count("storageReads");
      const device = await this.ctx.storage.get<DeviceRecord>(`${DEVICE_PREFIX}${deviceId}`);
      if (!device) return jsonResponse({ error: "identity_unknown" }, 404);
      if (!device.revoked) {
        device.revoked = true;
        device.revokedAt = now;
        writes.push([`${DEVICE_PREFIX}${deviceId}`, device]);
      }
      affectedRoutes.add(device.routeId);
      affectedDevices.set(device.deviceId, { routeId: device.routeId, deviceId: device.deviceId });
    } else if (isOpaqueId(routeId)) {
      this.counters.count("storageReads");
      const route = await this.ctx.storage.get<RouteRecord>(`${ROUTE_PREFIX}${routeId}`);
      if (!route) return jsonResponse({ error: "identity_unknown" }, 404);
      if (!route.revoked) {
        route.revoked = true;
        writes.push([`${ROUTE_PREFIX}${routeId}`, route]);
      }
      affectedRoutes.add(route.routeId);
      for (const member of [route.entryDeviceId, route.endpointDeviceId]) {
        if (member) affectedDevices.set(member, { routeId: route.routeId, deviceId: member });
      }
    } else {
      return jsonResponse({ error: "invalid_body" }, 400);
    }

    this.counters.count("storageWrites", writes.length);
    await this.ctx.storage.transaction(async (txn) => {
      for (const [key, value] of writes) await txn.put(key, value);
    });
    return jsonResponse({
      revocationRevision: meta.revocationRevision,
      affectedRouteIds: [...affectedRoutes].slice(0, RELAY_RUNTIME_LIMITS.maxRoutesPerTenant),
      affectedDevices: [...affectedDevices.values()].slice(0, RELAY_RUNTIME_LIMITS.maxDevicesPerTenant),
      deviceId: isOpaqueId(deviceId) ? deviceId : null,
      routeId: isOpaqueId(routeId) ? routeId : null,
      all: all === true,
    });
  }

  /**
   * Resolve the paired route peer for a mailbox partition: returns the other
   * enrolled slot's deviceId plus both sides' current revoked flags. Used by
   * MailboxDO to verify that a caller naming a peer is that peer's live
   * route partner — never a cross-route or self-declared pairing.
   */
  private async handleRoutePeer(request: Request): Promise<Response> {
    await this.requireMeta();
    const body = (await readBoundedJson(request, 8_192)) as Record<string, unknown> | null;
    const { routeId, deviceId } = body ?? {};
    if (!isOpaqueId(routeId) || !isOpaqueId(deviceId)) {
      return jsonResponse({ ok: false, reason: "identity_ambiguous" });
    }
    this.counters.count("storageReads", 2);
    const [route, device] = await Promise.all([
      this.ctx.storage.get<RouteRecord>(`${ROUTE_PREFIX}${routeId}`),
      this.ctx.storage.get<DeviceRecord>(`${DEVICE_PREFIX}${deviceId}`),
    ]);
    if (!route || route.revoked) {
      return jsonResponse({ ok: false, reason: "revoked" });
    }
    if (!device || device.routeId !== routeId
      || (route.entryDeviceId !== deviceId && route.endpointDeviceId !== deviceId)) {
      return jsonResponse({ ok: false, reason: "peer_unpaired" });
    }
    const peerDeviceId = route.entryDeviceId === deviceId ? route.endpointDeviceId : route.entryDeviceId;
    let peerRevoked = false;
    if (peerDeviceId) {
      this.counters.count("storageReads");
      const peerDevice = await this.ctx.storage.get<DeviceRecord>(`${DEVICE_PREFIX}${peerDeviceId}`);
      peerRevoked = peerDevice?.revoked ?? true;
    }
    return jsonResponse({
      ok: true,
      peerDeviceId,
      peerRevoked,
      deviceRevoked: device.revoked,
    });
  }

  /**
   * Map an admitted credential digest to its enrolled identity. Used once per
   * socket upgrade; the credential itself is never stored or returned.
   */
  private async handleCredentialLookup(request: Request): Promise<Response> {
    const meta = await this.requireMeta();
    const body = await readBoundedJson(request, 8_192);
    const credentialDigest = (body as Record<string, unknown> | null)?.credentialDigest;
    if (typeof credentialDigest !== "string" || credentialDigest.length !== 64) {
      return jsonResponse({ ok: false, reason: "identity_unknown" });
    }
    // Keyed index lookup: two point reads regardless of tenant size.
    this.counters.count("storageReads", 2);
    const deviceId = await this.ctx.storage.get<string>(`${CRED_PREFIX}${credentialDigest}`);
    const device = deviceId ? await this.ctx.storage.get<DeviceRecord>(`${DEVICE_PREFIX}${deviceId}`) : undefined;
    if (!device) return jsonResponse({ ok: false, reason: "identity_unknown" });
    if (device.revoked) return jsonResponse({ ok: false, reason: "revoked" });
    return jsonResponse({
      ok: true,
      device: {
        deviceId: device.deviceId,
        routeId: device.routeId,
        role: device.role,
        mode: device.mode,
        admissionGeneration: device.admissionGeneration,
      },
      revocationRevision: meta.revocationRevision,
    });
  }

  /**
   * Current-authority admission check: re-validates enrollment, mode, role
   * and route membership, then reconciles the presented revocation revision.
   */
  private async handleAdmissionCheck(request: Request): Promise<Response> {
    const meta = await this.requireMeta();
    const body = (await readBoundedJson(request, 8_192)) as Record<string, unknown> | null;
    if (!body) return jsonResponse({ ok: false, reason: "identity_unknown" });
    const { deviceId, routeId, role, mode, revocationRevision } = body;
    if (!isOpaqueId(deviceId) || !isOpaqueId(routeId)) {
      return jsonResponse({ ok: false, reason: "identity_ambiguous" });
    }
    this.counters.count("storageReads", 2);
    const [device, route] = await Promise.all([
      this.ctx.storage.get<DeviceRecord>(`${DEVICE_PREFIX}${deviceId}`),
      this.ctx.storage.get<RouteRecord>(`${ROUTE_PREFIX}${routeId}`),
    ]);
    if (!device || device.routeId !== routeId || device.role !== role || device.mode !== mode) {
      return jsonResponse({ ok: false, reason: "identity_unknown" });
    }
    if (!route || route.revoked || device.revoked) {
      return jsonResponse({ ok: false, reason: "revoked" });
    }
    if (route.mode !== mode) {
      return jsonResponse({ ok: false, reason: "mode_mismatch" });
    }
    const presented = typeof revocationRevision === "number" ? revocationRevision : -1;
    if (presented < meta.revocationRevision) {
      return jsonResponse({
        ok: false,
        reason: "stale_revocation_revision",
        expectedRevocationRevision: meta.revocationRevision,
        retryable: true,
      });
    }
    if (presented > meta.revocationRevision) {
      return jsonResponse({
        ok: false,
        reason: "authority_stale",
        expectedRevocationRevision: meta.revocationRevision,
        retryable: true,
      });
    }
    return jsonResponse({
      ok: true,
      admissionGeneration: device.admissionGeneration,
      revocationRevision: meta.revocationRevision,
    });
  }

  /**
   * Bounded enumeration of this tenant's routes and enrolled devices for
   * metrics fan-out. Uses the same list-prefix derivation the revoke path
   * builds `affectedRouteIds`/`affectedDevices` with — deduplicated sets
   * sliced to the tenant enrollment bounds — so enumeration can never exceed
   * the limits the directory itself enforces. Revoked tombstones stay
   * enumerated: their session/mailbox objects may still hold counters.
   */
  private async handleInventory(): Promise<Response> {
    this.counters.count("storageReads", 2);
    const [devices, routes] = await Promise.all([
      this.ctx.storage.list<DeviceRecord>({ prefix: DEVICE_PREFIX }),
      this.ctx.storage.list<RouteRecord>({ prefix: ROUTE_PREFIX }),
    ]);
    const affectedRoutes = new Set<string>();
    const affectedDevices = new Map<string, { routeId: string; deviceId: string }>();
    for (const route of routes.values()) affectedRoutes.add(route.routeId);
    for (const device of devices.values()) {
      affectedDevices.set(device.deviceId, { routeId: device.routeId, deviceId: device.deviceId });
    }
    return jsonResponse({
      routes: [...affectedRoutes].slice(0, RELAY_RUNTIME_LIMITS.maxRoutesPerTenant),
      devices: [...affectedDevices.values()].slice(0, RELAY_RUNTIME_LIMITS.maxDevicesPerTenant),
    });
  }

  /** Bounded operator view: routing records without credential digests. */
  private async handleState(): Promise<Response> {
    const meta = await this.requireMeta();
    this.counters.count("storageReads", 2);
    const [devices, routes] = await Promise.all([
      this.ctx.storage.list<DeviceRecord>({ prefix: DEVICE_PREFIX }),
      this.ctx.storage.list<RouteRecord>({ prefix: ROUTE_PREFIX }),
    ]);
    return jsonResponse({
      tenantId: meta.tenantId,
      revocationRevision: meta.revocationRevision,
      devices: [...devices.values()].map((d) => ({
        deviceId: d.deviceId,
        routeId: d.routeId,
        role: d.role,
        mode: d.mode,
        admissionGeneration: d.admissionGeneration,
        revoked: d.revoked,
      })),
      routes: [...routes.values()].map((r) => ({
        routeId: r.routeId,
        mode: r.mode,
        entryDeviceId: r.entryDeviceId,
        endpointDeviceId: r.endpointDeviceId,
        revoked: r.revoked,
      })),
    });
  }
}

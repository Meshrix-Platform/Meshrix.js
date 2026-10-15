import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CLIENT_REGISTRATION_RETENTION_SECONDS,
  MAX_MESHRIX_CLIENT_REGISTRATIONS,
  createClientRegistryService,
  initializeClientRegistrySchema,
  isClientCredential,
  isClientEnrollmentToken
} from "../../../packages/server-runtime/src/state/client-registry-repository.ts";
import { executeDiscoveryOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/discovery-executor.ts";

const databases: any[] = [];

function createRegistry(options: Record<string, any> = {}) : any {
  const db: any = new Database(":memory:");
  databases.push(db);
  initializeClientRegistrySchema(db);
  return createClientRegistryService({ db, ...options });
}

function checkIn(registry?: any, clientId?: any, offlineAfterSeconds: any = 0) : any {
  return registry.recordClientCheckIn({
    clientId,
    offlineAfterSeconds
  });
}

afterEach(() : any => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});

describe("public discovery client registry capacity recovery", () : any => {
  it("accepts a legitimate client after 2000 expired unique registrations", () : any => {
    let now: any = Date.UTC(2025, 0, 1);
    const registry: any = createRegistry({ now: () : any => now });

    for (let index: any = 0; index < MAX_MESHRIX_CLIENT_REGISTRATIONS; index += 1) {
      expect(checkIn(registry, `expired-client-${index}`).ok).toBe(true);
    }
    expect(checkIn(registry, "capacity-probe")).toMatchObject({
      ok: false,
      code: "client_registration_capacity_exceeded",
      statusCode: 429
    });

    now += (DEFAULT_CLIENT_REGISTRATION_RETENTION_SECONDS + 1) * 1000;
    expect(checkIn(registry, "recovered-client").ok).toBe(true);

    const clients: any = registry.listClientRegistrations().items;
    expect(clients).toHaveLength(1);
    expect(clients[0].clientId).toBe("recovered-client");
  });

  it("keeps recently active registrations while reclaiming only expired capacity", () : any => {
    let now: any = Date.UTC(2025, 0, 1);
    const registry: any = createRegistry({
      maxClientRegistrations: 2,
      registrationRetentionSeconds: 60,
      now: () : any => now
    });

    expect(checkIn(registry, "active-client").ok).toBe(true);
    expect(checkIn(registry, "stale-client").ok).toBe(true);

    now += 59_000;
    expect(checkIn(registry, "active-client").ok).toBe(true);
    expect(checkIn(registry, "early-client")).toMatchObject({
      ok: false,
      code: "client_registration_capacity_exceeded"
    });

    now += 2_000;
    expect(checkIn(registry, "replacement-client").ok).toBe(true);

    const clientIds: any = registry.listClientRegistrations().items
      .map((client?: any) : any => client.clientId)
      .sort();
    expect(clientIds).toEqual(["active-client", "replacement-client"]);
  });

  it("honors an explicit offline threshold when it is longer than internal retention", () : any => {
    let now: any = Date.UTC(2025, 0, 1);
    const registry: any = createRegistry({
      maxClientRegistrations: 1,
      registrationRetentionSeconds: 60,
      now: () : any => now
    });

    expect(checkIn(registry, "configured-active-client", 120).ok).toBe(true);
    now += 61_000;

    expect(checkIn(registry, "new-client", 120)).toMatchObject({
      ok: false,
      code: "client_registration_capacity_exceeded"
    });
    expect(registry.listClientRegistrations().items.map((client?: any) : any => client.clientId))
      .toEqual(["configured-active-client"]);
  });
});

describe("client check-in credentials", () : any => {
  it("issues a single-use enrollment token that expires", () : any => {
    let now: any = Date.UTC(2025, 0, 1);
    const registry: any = createRegistry({ now: () : any => now });

    const issued: any = registry.issueEnrollmentToken({ ttlSeconds: 600 });
    expect(issued.ok).toBe(true);
    expect(isClientEnrollmentToken(issued.token)).toBe(true);
    expect(issued.expiresAt).toBe(new Date(now + 600_000).toISOString());

    expect(registry.consumeEnrollmentToken(issued.token)).toEqual({ ok: true });
    expect(registry.consumeEnrollmentToken(issued.token)).toMatchObject({
      ok: false,
      code: "client_enrollment_token_invalid"
    });
    expect(registry.consumeEnrollmentToken("met_forged-token")).toMatchObject({
      ok: false,
      code: "client_enrollment_token_invalid"
    });

    const second: any = registry.issueEnrollmentToken({ ttlSeconds: 60 });
    now += 61_000;
    expect(registry.consumeEnrollmentToken(second.token)).toMatchObject({
      ok: false,
      code: "client_enrollment_token_invalid"
    });
  });

  it("binds issued client credentials to their registration identity", () : any => {
    const registry: any = createRegistry();
    const issued: any = registry.issueClientCredential({ clientId: "client_abc" });

    expect(issued.ok).toBe(true);
    expect(isClientCredential(issued.credential)).toBe(true);
    expect(registry.resolveClientCredential(issued.credential)).toEqual({
      ok: true,
      clientId: "client_abc"
    });
    expect(registry.resolveClientCredential(`${issued.credential}x`)).toMatchObject({ ok: false });
    expect(registry.resolveClientCredential("mck_short")).toMatchObject({ ok: false });
    expect(registry.resolveClientCredential("")).toMatchObject({ ok: false });
  });

  it("requires a credential for check_in when the policy is credential", async () : any => {
    const registry: any = createRegistry();
    const context: any = {
      clientRegistryService: registry,
      discoveryState: { checkInPolicy: "credential", serverId: "srv-1" }
    };

    const denied: any = await executeDiscoveryOperation({
      operationId: "discovery.check_in",
      input: { clientId: "attacker-chosen-id" },
      context
    });
    expect(denied).toMatchObject({
      status: 401,
      payload: { code: "client_credential_required" }
    });
    expect(registry.listClientRegistrations().items).toHaveLength(0);
  });

  it("issues a credential on enrollment and binds later check-ins to it", async () : any => {
    const registry: any = createRegistry();
    const context: any = {
      clientRegistryService: registry,
      discoveryState: { checkInPolicy: "credential", serverId: "srv-1" }
    };

    const token: any = registry.issueEnrollmentToken({ ttlSeconds: 600 });
    const enrolled: any = await executeDiscoveryOperation({
      operationId: "discovery.check_in",
      input: { enrollmentToken: token.token, clientId: "attacker-chosen-id" },
      context
    });
    expect(enrolled.status).toBe(200);
    expect(isClientCredential(enrolled.payload.credential)).toBe(true);
    const enrolledClientId: any = enrolled.payload.client.clientId;
    expect(enrolledClientId).not.toContain("attacker-chosen-id");

    // The one-time token cannot mint a second registration.
    const replayed: any = await executeDiscoveryOperation({
      operationId: "discovery.check_in",
      input: { enrollmentToken: token.token },
      context
    });
    expect(replayed.status).toBe(403);
    expect(registry.listClientRegistrations().items).toHaveLength(1);

    // The issued credential writes only its own record; a foreign credential is refused.
    const checkedIn: any = await executeDiscoveryOperation({
      operationId: "discovery.check_in",
      input: { clientId: "another-forged-id" },
      context: {
        ...context,
        request: { headers: { authorization: `Bearer ${enrolled.payload.credential}` } }
      }
    });
    expect(checkedIn.status).toBe(200);
    expect(checkedIn.payload.client.clientId).toBe(enrolledClientId);
    expect(registry.listClientRegistrations().items).toHaveLength(1);

    const invalid: any = await executeDiscoveryOperation({
      operationId: "discovery.check_in",
      input: {},
      context: {
        ...context,
        request: { headers: { authorization: "Bearer mck_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }
      }
    });
    expect(invalid).toMatchObject({
      status: 401,
      payload: { code: "client_credential_invalid" }
    });
  });

  it("keeps the legacy input-derived identity only under an explicit open policy", async () : any => {
    const registry: any = createRegistry();
    const openContext: any = {
      clientRegistryService: registry,
      discoveryState: { checkInPolicy: "open", serverId: "srv-1" }
    };
    const legacy: any = await executeDiscoveryOperation({
      operationId: "discovery.check_in",
      input: { clientId: "legacy-device" },
      context: openContext
    });
    expect(legacy.status).toBe(200);
    expect(registry.listClientRegistrations().items).toHaveLength(1);
  });

  it("mints enrollment tokens only through the authorized operation", async () : any => {
    const registry: any = createRegistry();
    const issued: any = await executeDiscoveryOperation({
      operationId: "discovery.clients.enrollment_token",
      input: { ttlSeconds: 300 },
      context: {
        clientRegistryService: registry,
        discoveryState: { serverId: "srv-1" }
      }
    });
    expect(issued.status).toBe(200);
    expect(isClientEnrollmentToken(issued.payload.token)).toBe(true);
  });
});

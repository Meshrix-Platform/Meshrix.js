import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CLIENT_REGISTRATION_RETENTION_SECONDS,
  MAX_MESHRIX_CLIENT_REGISTRATIONS,
  createClientRegistryService,
  initializeClientRegistrySchema
} from "../../../packages/server-runtime/src/state/client-registry-repository.ts";

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

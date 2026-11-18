import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteProtocolEventStore } from "../../../packages/server-runtime/src/events/sqlite-protocol-event-store.ts";

const roots = new Set<string>();

async function createStore() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-event-store-read-cost-"));
  roots.add(userDataPath);
  return createSqliteProtocolEventStore({ userDataPath });
}

afterEach(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("SQLite protocol event read state", () => {
  it("omits revision metadata for plain reads and keeps the default revision contract", async () => {
    const store = await createStore();
    try {
      for (let index = 1; index <= 2; index += 1) {
        await store.publish({
          schemaVersion: "v0.0.1:pubsub:event-schema-1",
          id: `event-${index}`,
          topic: "audit",
          type: "created",
          publisher: "test",
          publishedAt: new Date(index).toISOString(),
          payload: { index },
          traceId: "",
          requestId: "",
          spanId: ""
        });
      }

      const plainPage = await store.read({ cursor: 0, limit: 10, includeRevision: false });
      expect(plainPage.events.map(({ offset }) => offset)).toEqual([1, 2]);
      expect(plainPage.nextCursor).toBe(2);
      expect(plainPage).not.toHaveProperty("revision");

      const subscriptionPage = await store.read({ cursor: 0, limit: 10 });
      expect(subscriptionPage.revision).toBe(2);
    } finally {
      store.close();
    }
  });
});

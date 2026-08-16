import assert from "node:assert/strict";
import test from "node:test";

import { normalizeClients } from "../internal/auth.mjs";

const CLIENT = Object.freeze({
  subject: "service:test",
  scopes: ["model:invoke"],
});

test("client secrets enforce the documented UTF-8 byte bounds", () => {
  assert.throws(
    () => normalizeClients({ test: { ...CLIENT, secret: "x".repeat(31) } }),
    /between 32 and 512 bytes/u,
  );
  assert.throws(
    () => normalizeClients({ test: { ...CLIENT, secret: "é".repeat(257) } }),
    /between 32 and 512 bytes/u,
  );

  const clients = normalizeClients({ test: { ...CLIENT, secret: "é".repeat(16) } });
  assert.equal(clients.test.secret, "é".repeat(16));
});

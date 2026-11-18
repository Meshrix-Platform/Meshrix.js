import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelGatewayApplication } from "../internal/application.mjs";
import { ADMIN_CLIENTS, startService } from "./helpers.mjs";

test("a competing application is rejected before reading existing state", async (t) => {
  const owner = await startService();
  t.after(() => owner.close());
  const statePath = `${owner.dataRoot}/state.json`;
  const original = await readFile(statePath);
  await writeFile(statePath, "{", { mode: 0o600 });
  try {
    await assert.rejects(
      createModelGatewayApplication({ dataRoot: owner.dataRoot, clients: ADMIN_CLIENTS }),
      /model_gateway_data_root_in_use/u
    );
  } finally {
    await writeFile(statePath, original, { mode: 0o600 });
  }
});

test("failed state initialization releases its data-root owner lock", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "model-gateway-owner-failure-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  await writeFile(path.join(dataRoot, "state.json"), "{", { mode: 0o600 });
  await assert.rejects(createModelGatewayApplication({ dataRoot, clients: ADMIN_CLIENTS }));
  await unlink(path.join(dataRoot, "state.json"));
  const application = await createModelGatewayApplication({ dataRoot, clients: ADMIN_CLIENTS });
  await application.close();
});

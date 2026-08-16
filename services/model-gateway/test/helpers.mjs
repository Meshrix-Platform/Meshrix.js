import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { createModelGatewayHttpHandler } from "../internal/http-service.mjs";
import { startFixtureProvider } from "./fixture-provider.mjs";

export const ADMIN_CLIENTS = {
  "service-admin": {
    subject: "direct-client",
    secret: "model-gateway-test-admin-secret-0000000000000000000000",
    scopes: ["model:call", "model:manage", "ledger:read"]
  }
};

export const DEFAULT_PRICES = {
  inputTokenRate: { currency: "USD", units: 0, nanos: 1_000_000 },
  outputTokenRate: { currency: "USD", units: 0, nanos: 2_000_000 }
};

export async function startService(options = {}) {
  const dataRoot = options.dataRoot || await mkdtemp(path.join(os.tmpdir(), "model-gateway-test-"));
  const fixture = options.fixture || await startFixtureProvider();
  if (options.configureEgress !== false) {
    await writeFile(
      path.join(dataRoot, "provider-egress.json"),
      JSON.stringify({
        prov1: { baseUrl: fixture.baseUrl, timeoutMs: 5000 },
        prov2: { baseUrl: fixture.baseUrl, timeoutMs: 5000 }
      })
    );
    await writeFile(
      path.join(dataRoot, "secrets.json"),
      JSON.stringify({
        prov1: "fixture-provider-secret-00000000000000000000000000",
        prov2: "fixture-provider-secret-00000000000000000000000000"
      })
    );
  }
  const handler = await createModelGatewayHttpHandler({
    dataRoot,
    clients: options.clients || ADMIN_CLIENTS,
    bounds: options.bounds,
    maxAttempts: options.maxAttempts,
    maxRequestBytes: options.maxRequestBytes
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    dataRoot,
    fixture,
    baseUrl,
    handler,
    server,
    clientSecret: ADMIN_CLIENTS["service-admin"].secret,
    async close({ keepDataRoot = false } = {}) {
      await handler.close();
      await new Promise((resolve) => server.close(resolve));
      await fixture.close();
      if (!keepDataRoot) await rm(dataRoot, { recursive: true, force: true });
    }
  };
}

export async function provision(service) {
  const headers = {
    authorization: `Bearer ${service.clientSecret}`,
    "content-type": "application/json"
  };
  const provider = await fetch(`${service.baseUrl}/v1/model-gateway/providers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ providerId: "prov1", protocol: "openai", enabled: true })
  });
  const pricing = await fetch(`${service.baseUrl}/v1/model-gateway/pricing-revisions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      revisionRef: "price-1",
      modelRef: "model-1",
      currency: "USD",
      ...DEFAULT_PRICES,
      immutable: true
    })
  });
  const model = await fetch(`${service.baseUrl}/v1/model-gateway/models`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      modelId: "model-1",
      providerRef: "prov1",
      pricingRevisionRef: "price-1",
      enabled: true
    })
  });
  return { provider, pricing, model };
}

import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

// These are deterministic driver/reducer tests, not observations of the host or a deployment.
const authority = vi.hoisted(() => ({
  resourcesRemoved: vi.fn(async (_state: unknown) => {}),
  environment: { architecture: "x64", nodeVersion: "24.16.0", platform: "linux", runner: "ubuntu-24.04", runnerEnvironment: "local" }
}));
vi.mock("../../../tools/server-scripts/lib/release-deployment/authority.ts", async (original) => ({
  ...await original<typeof import("../../../tools/server-scripts/lib/release-deployment/authority.ts")>(),
  observeReleaseDeploymentEnvironment: async () => ({ ...authority.environment }),
  assertReleaseDeploymentResourcesRemoved: authority.resourcesRemoved
}));
beforeEach(() => { authority.resourcesRemoved.mockReset().mockResolvedValue(undefined); });

import {
  RELEASE_DEPLOYMENT_SCENARIOS,
  assertReleaseDeploymentReceipt,
  validateDriverAggregate,
} from "../../../tools/server-scripts/lib/release-deployment/contract.ts";
import {
  driveDeployment,
  parseLoopbackOrigin,
} from "../../../tools/server-scripts/release-deployment-driver.ts";
import { reduceDeploymentEvidence } from "../../../tools/server-scripts/reduce-release-deployment.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURE_PROVIDER = path.join(ROOT, "services/model-gateway/test/fixture-provider.mjs");
const CREDENTIAL = "private-focused-fixture-credential";
const FAST_BUDGETS: Record<string, any> = Object.freeze({
  success: Object.freeze({ requests: 4, concurrency: 2, timeoutMs: 500 }),
  concurrency: Object.freeze({ requests: 16, concurrency: 4, timeoutMs: 500 }),
  cancellation: Object.freeze({ requests: 4, concurrency: 2, timeoutMs: 500, cancelAfterMs: 30 }),
  "provider-fault": Object.freeze({ requests: 4, concurrency: 2, timeoutMs: 500 }),
});

function sendJson(response: any, status: number, payload: any): void {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { "content-type": "application/json", "content-length": bytes.byteLength });
  response.end(bytes);
}

async function startOneOrigin({ malformedSuccess = false }: Record<string, any> = {}): Promise<any> {
  const seen = { directProviderRoute: false, targetHeaderObserved: false, authorizedCalls: 0, requestIds: [] as number[] };
  let providerFaultCalls = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://one-origin.invalid");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>runtime-ui fixture</title>");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname.startsWith("/v1/")) {
      seen.directProviderRoute = true;
      sendJson(response, 404, { error: "provider routes are private" });
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/mcp") {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    if (request.headers["x-meshrix.js-api-key"] !== CREDENTIAL) {
      sendJson(response, 401, { error: { code: "credential_required" } });
      return;
    }
    seen.targetHeaderObserved ||= request.headers["x-meshrix.js-mcp-target"] !== undefined;
    seen.authorizedCalls += 1;
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || "{}");
    seen.requestIds.push(Number(body.id));
    const model = body?.params?.arguments?.model;
    if (model === "fixture-openai-cancel") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!response.destroyed) sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result: {} });
      return;
    }
    if (malformedSuccess && body.id === 1) {
      sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result: {} });
      return;
    }
    const providerFault = model === "fixture-openai-fault";
    if (providerFault) providerFaultCalls += 1;
    if (providerFaultCalls === 4) {
      sendJson(response, 429, {
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32000,
          message: "Upstream gateway traffic limit exceeded.",
          data: { code: "upstream_gateway_circuit_open", status: 429 },
        },
      });
      return;
    }
    const providerPayload = providerFault
      ? { error: { code: "provider_unavailable" } }
      : model.startsWith("fixture-anthropic")
        ? { type: "message", model: "fixture-anthropic" }
        : { object: "chat.completion", model: "fixture-openai" };
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [],
        structuredContent: {
          payload: {
            ok: !providerFault,
            upstream: { status: providerFault ? 503 : 200 },
            response: { json: providerPayload },
          },
        },
      },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    seen,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

describe("external synthetic deployment requests", () => {
  it("uses one authenticated loopback origin and fixed-memory aggregate outcomes", async () => {
    const service = await startOneOrigin();
    try {
      const aggregate = await driveDeployment({
        originUrl: service.origin,
        credential: CREDENTIAL,
        openAiTool: "upstream.release-smoke.openai-chat",
        anthropicTool: "upstream.release-smoke.anthropic-messages",
        budgets: FAST_BUDGETS,
      });
      expect(validateDriverAggregate(aggregate)).toEqual([]);
      expect(Object.keys(aggregate.scenarios).sort()).toEqual([...RELEASE_DEPLOYMENT_SCENARIOS].sort());
      expect(aggregate.scenarios.success.successful).toBe(FAST_BUDGETS.success.requests);
      expect(aggregate.scenarios.concurrency.successful).toBe(FAST_BUDGETS.concurrency.requests);
      expect(aggregate.scenarios.cancellation.timeoutOrCancellation)
        .toBe(FAST_BUDGETS.cancellation.requests);
      expect(aggregate.scenarios["provider-fault"].expectedFault)
        .toBe(FAST_BUDGETS["provider-fault"].requests);
      expect(service.seen.directProviderRoute).toBe(false);
      expect(service.seen.targetHeaderObserved).toBe(false);
      expect(service.seen.authorizedCalls).toBe(28);
      expect(new Set(service.seen.requestIds).size).toBe(28);
      expect([...service.seen.requestIds].sort((left, right) => left - right))
        .toEqual(Array.from({ length: 28 }, (_unused, index) => index + 1));
      expect(JSON.stringify(aggregate)).not.toContain(service.origin);
      expect(JSON.stringify(aggregate)).not.toContain(CREDENTIAL);
    } finally {
      await service.close();
    }
  });

  it("rejects a malformed successful HTTP response instead of counting it as model success", async () => {
    const service = await startOneOrigin({ malformedSuccess: true });
    try {
      await expect(driveDeployment({
        originUrl: service.origin,
        credential: CREDENTIAL,
        openAiTool: "upstream.release-smoke.openai-chat",
        anthropicTool: "upstream.release-smoke.anthropic-messages",
        budgets: FAST_BUDGETS,
      })).rejects.toMatchObject({ code: "success:scenario_success_outcome_invalid" });
    } finally {
      await service.close();
    }
  });

  it("reduces only a complete aggregate after the cleanup authority verifies its state", async () => {
    const service = await startOneOrigin();
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-driver-reducer-test-"));
    try {
      const aggregate = await driveDeployment({
        originUrl: service.origin,
        credential: CREDENTIAL,
        openAiTool: "upstream.release-smoke.openai-chat",
        anthropicTool: "upstream.release-smoke.anthropic-messages",
        budgets: FAST_BUDGETS,
      });
      const resourceId = randomUUID();
      const cleanupState = {
        schemaVersion: "meshrix.release-deployment.cleanup/2", resourceId,
        sourceRevision: "a".repeat(40), candidateDigest: "b".repeat(64),
        containerName: `meshrix-release-smoke-${resourceId}`,
        fixtureContainerName: `meshrix-release-fixture-${resourceId}`,
        imageName: `meshrix-release-smoke:${resourceId}`,
        networkName: `meshrix-release-network-${resourceId}`,
        dataVolume: `meshrix-release-data-${resourceId}`,
        backupVolume: `meshrix-release-backup-${resourceId}`,
        tempRoot: path.join(os.tmpdir(), `meshrix-release-deployment-${resourceId}`)
      };
      const cleanupStatePath = path.join(scratch, "cleanup.json");
      await fs.writeFile(cleanupStatePath, JSON.stringify(cleanupState), { mode: 0o600 });
      const input = { aggregate, sourceRevision: cleanupState.sourceRevision,
        candidateDigest: cleanupState.candidateDigest, functionalReceiptDigest: "c".repeat(64), cleanupStatePath };
      const receipt = await reduceDeploymentEvidence(input);
      expect(authority.resourcesRemoved).toHaveBeenCalledWith(cleanupState);
      assertReleaseDeploymentReceipt(receipt);
      expect(receipt.cleanup).toBe(true);
      expect(receipt.externalBoundary).toBe(true);
      expect(receipt.releaseDeploymentVerified).toBe(true);
      expect(receipt.capacityCertified).toBe(false);
      expect(receipt.privacy.containsRuntimeValues).toBe(false);
      authority.resourcesRemoved.mockRejectedValueOnce(Object.assign(new Error("fixture resource still exists"), {
        code: "release_reducer_cleanup_incomplete"
      }));
      await expect(reduceDeploymentEvidence(input)).rejects.toMatchObject({ code: "release_reducer_cleanup_incomplete" });
      await expect(reduceDeploymentEvidence({ ...input, cleanupStatePath: "" }))
        .rejects.toMatchObject({ code: "release_reducer_cleanup_state_invalid" });
    } finally {
      await service.close();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it("selects fixture behavior only from closed model identifiers and bounds holds", async () => {
    const fixtureModule: any = await import(pathToFileURL(FIXTURE_PROVIDER).href);
    const fixture = await fixtureModule.startFixtureProvider({ cancellationDelayMs: 80, holdTimeoutMs: 40 });
    try {
      const success = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture-openai" }),
      });
      const fault = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture-openai-fault" }),
      });
      const held = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture-openai-hold" }),
      });
      const unknown = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "unknown-fixture-model" }),
      });
      expect(success.status).toBe(200);
      expect(fault.status).toBe(503);
      expect(held.status).toBe(200);
      expect(unknown.status).toBe(400);
    } finally {
      await fixture.close();
    }
  });

  it("rejects non-loopback, credential-bearing, and path-bearing origins", () => {
    expect(parseLoopbackOrigin("http://127.0.0.1:7228")).toBe("http://127.0.0.1:7228");
    const credentialBearingOrigin = new URL("http://127.0.0.1:7228");
    credentialBearingOrigin.username = "fixture-user";
    credentialBearingOrigin.password = "fixture-secret";
    for (const origin of [
      "https://127.0.0.1:7228",
      "http://localhost:7228",
      "http://127.0.0.1:7228/mcp",
      credentialBearingOrigin.href,
    ]) {
      expect(() => parseLoopbackOrigin(origin)).toThrowError(
        expect.objectContaining({ code: "release_driver_origin_invalid" }),
      );
    }
  });

  it("keeps the controller on external process and runtime-ui container boundaries", async () => {
    const source = await fs.readFile(
      path.join(ROOT, "tools/server-scripts/verify-release-deployment.ts"),
      "utf8",
    );
    const driver = await fs.readFile(
      path.join(ROOT, "tools/server-scripts/release-deployment-driver.ts"),
      "utf8",
    );
    expect(source).toContain('"build", "--target", "runtime-ui"');
    expect(source).toContain("fixture-provider.mjs");
    expect(source).toContain("release-deployment-driver.ts");
    expect(source).toContain("reduce-release-deployment.ts");
    expect(source).not.toContain("--service-command");
    expect(source).not.toContain("startFixtureProvider");
    expect(driver).not.toMatch(/apps\/server|server-runtime|startHttpServer|stress-mcp-gateway/u);
    expect(driver).not.toContain("fixture-provider.mjs");
    expect(driver).not.toContain("observations.push");
    expect(driver).toContain("createHistogram");
  });
});

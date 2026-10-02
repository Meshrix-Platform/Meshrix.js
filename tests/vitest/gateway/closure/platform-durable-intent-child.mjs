import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";
import { createInterface } from "node:readline";
import path from "node:path";
import { createOperationProofSubstrate } from "../../../../packages/foundation/src/proof/proof-substrate/index.ts";
import { createUpstreamGatewayRegistry } from "../../../../packages/agents/src/upstream-gateway/index.ts";
import { createPlatformMcpGateway } from "../../../../packages/server-runtime/src/composition/gateway-composition.ts";
import { installUpstreamRuntimeServices } from "../../../helpers/upstream-runtime-snapshot.ts";
import { mcpModernJsonRpcMessage, mcpModernRequestHeaders } from "../../../../packages/protocols/mcp/modern-downstream/protocol.ts";

const [dataRoot, peerUrl, mode, risk = "safe_write"] = process.argv.slice(2);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let authorityAllowed = true;
const proof = createOperationProofSubstrate({ dataDir: path.join(dataRoot, "proof") });
const stdioPeerScript = String.raw`
import fs from "node:fs/promises";
const counterPath = process.argv[1];
let buffer = "";
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\n"); }
function result(id, value) { send({ jsonrpc: "2.0", id, result: value }); }
async function handle(message) {
  if (message.method === "initialize") {
    result(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "durable-stdio-fixture", version: "1" } });
  } else if (message.method === "tools/list") {
    result(message.id, { tools: [{ name: "echo", inputSchema: { type: "object", properties: {
      label: { type: "string" }, url: { type: "string" }, path: { type: "string" }, headers: { type: "object" }
    }, required: ["label"], additionalProperties: false } }] });
  } else if (message.method === "tools/call") {
    let prior = 0;
    try { prior = Number(await fs.readFile(counterPath, "utf8")) || 0; } catch {}
    const temporaryPath = counterPath + ".next";
    await fs.writeFile(temporaryPath, String(prior + 1), { mode: 0o600 });
    await fs.rename(temporaryPath, counterPath);
    result(message.id, { structuredContent: { accepted: true } });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) if (line.trim()) void handle(JSON.parse(line));
});
`;
const proofPort = {
  ...proof,
  async beginLifecycle(input) {
    if (mode === "fail-intent") {
      throw Object.assign(new Error("synthetic operation-proof persistence failure"), {
        code: "synthetic_proof_persistence_failure"
      });
    }
    const entry = await proof.beginLifecycle(input);
    send({ kind: "intent", ledgerEventId: entry.ledgerEventId, status: entry.status });
    if (mode === "pause-after-intent") await new Promise(() => {});
    return entry;
  },
  async recordReceipt(input) {
    const entry = await proof.recordReceipt(input);
    if (input.operationId === "meshrix.mcp.dispatch-admission") {
      send({ kind: "dispatch-marker", ledgerEventId: entry.ledgerEventId, status: entry.status });
    }
    return entry;
  },
  async finishLifecycle(input) {
    const entry = await proof.finishLifecycle(input);
    send({ kind: "terminal", ledgerEventId: input.entry?.ledgerEventId || input.ledgerEventId, status: entry.status });
    return entry;
  }
};
const registry = createUpstreamGatewayRegistry({ schemaPort: createGatewaySchemaPort() });
await installUpstreamRuntimeServices(registry, [{
  serviceId: "durable-fixture",
  serviceProtocol: "mcp",
  label: "durable-fixture",
  allowLocalNetwork: true,
  operations: [{ operationKey: "tools/call", protocol: "mcp", risk, requiredScopes: [risk === "read_only" ? "gateway:read" : "gateway:write"] }],
  mcp: mode === "stdio"
    ? { transport: "stdio", command: process.execPath, args: ["-e", stdioPeerScript, path.join(dataRoot, "stdio-peer-effect-count")] }
    : { transport: "http", url: peerUrl, protocolVersion: "2026-07-28" }
}]);
const grant = {
  id: "synthetic-grant",
  revision: "synthetic-grant-r1",
  subjectId: "synthetic-caller",
  tenantId: "synthetic-tenant",
  scopes: ["gateway:read", "gateway:write"],
  dynamicCapabilities: ["cap:upstream:durable-fixture:tools-call-echo"]
};
const platform = createPlatformMcpGateway({
  upstreamGatewayRegistry: registry,
  operationProofSubstrate: proofPort,
  toolSkillManagementProvider: {
    authorizeMcpClientRequest: async () => authorityAllowed ? ({
      ok: true,
      tenantId: "synthetic-tenant",
      grant,
      subject: {
        type: "tool-grant",
        subjectId: "synthetic-caller",
        grantId: grant.id,
        scopes: grant.scopes,
        dynamicCapabilities: grant.dynamicCapabilities
      }
    }) : ({ ok: false, status: 403, error: "synthetic authority revoked" }),
    listVisibleTools: () => []
  }
});

function request(method, id, params = {}) {
  const body = mcpModernJsonRpcMessage({ jsonrpc: "2.0", id, method, params });
  return {
    method: "POST",
    headers: mcpModernRequestHeaders(body, { "content-type": "application/json" }),
    body
  };
}

await platform.gateway.start();
const listing = await platform.adapter.handle(request("tools/list", "fixture-list"));
const listingBody = listing?.body || {};
const tool = (listingBody.result?.tools || []).find((item) => item?._meta?.serviceId === "durable-fixture");
if (!tool?.name) throw new Error("Synthetic MCP fixture tool was not published.");
send({ kind: "ready", toolName: tool.name, status: listing.status });

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let command;
  try { command = JSON.parse(line); } catch { continue; }
  if (command.type === "proof-head") {
    const head = await proof.pactiumRuntime.core.readLedgerHead();
    send({ kind: "proof-head", size: Number(head?.size || 0) });
    continue;
  }
  if (command.type === "call") {
    void (async () => {
      const result = await platform.adapter.handle(request("tools/call", command.id || "fixture-call", {
        name: tool.name,
        arguments: command.arguments || {}
      }));
      const body = result?.body || {};
      send({
        kind: "response",
        status: Number(result?.status || 0),
        resultType: String(body.result?.resultType || ""),
        errorCode: String(body.error?.data?.code || ""),
        isError: body.result?.isError === true
      });
    })().catch((error) => send({ kind: "fixture-error", message: String(error?.message || error) }));
    continue;
  }
  if (command.type === "revoke-authority") {
    authorityAllowed = false;
    send({ kind: "authority-revoked" });
    continue;
  }
  if (command.type === "close") {
    await platform.close();
    await registry.close();
    await proof.close();
    await new Promise((resolve) => process.stdout.write(`${JSON.stringify({ kind: "closed" })}\n`, resolve));
    process.exit(0);
  }
}

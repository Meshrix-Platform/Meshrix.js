import { createInterface } from "node:readline";
import { createGateway } from "../../../packages/gateway/src/index.ts";
import { createModernDownstreamAdapter } from "../../../packages/protocols/mcp/modern-downstream/index.ts";

const TARGET_PROTOCOL_VERSION = "2026-07-28";
const RESOURCE_URI = "fixture://artifact/order-demo";
const IMAGE_DATA = Buffer.from("neutral-image-fixture", "utf8").toString("base64");
const AUDIO_DATA = Buffer.from("neutral-audio-fixture", "utf8").toString("base64");

const descriptor = Object.freeze({
  kind: "tool",
  publicName: "route.demo",
  upstreamName: "route.demo",
  description: "Local Meshrix gateway interop candidate",
  inputSchema: { type: "object" },
  route: Object.freeze({
    logicalRoute: "route.demo",
    upstreamIdentity: "interop-candidate",
    endpointIdentity: "interop-candidate:route.demo",
    protocolVersion: TARGET_PROTOCOL_VERSION,
    schemaDigest: "schema:interop-candidate",
    policyRef: "interop-candidate-policy",
    revision: "interop-candidate:route.demo",
    effectClass: "read",
    operation: "tools/call",
    upstreamName: "route.demo",
    metadata: Object.freeze({ kind: "interop-candidate" })
  })
});

const allowContext = Object.freeze({
  tenant: "tenant-demo",
  principal: "interop-candidate",
  authGeneration: "candidate-auth-1",
  grant: Object.freeze({ revision: "candidate-grant-1", routes: ["route.demo"], methods: ["tools/call"] }),
  trace: Object.freeze({ traceparent: "00-candidate" })
});

const denyContext = Object.freeze({
  ...allowContext,
  principal: "interop-candidate-deny",
  grant: Object.freeze({ revision: "candidate-grant-deny", routes: ["route.demo"], methods: ["tools/call"], revoked: true })
});

const payload = Object.freeze({
  traceId: "business-trace",
  auditId: "business-audit",
  toolExecutionId: "business-execution",
  order: { id: "order-demo", quantity: 2, labels: ["alpha", "🌏"] },
  artifact: "demo",
  resourceUri: RESOURCE_URI,
  route: "route.demo",
  duplicate: false
});

const upstream = {
  async invoke({ request }) {
    if (!request.requestState) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          resultType: "input_required",
          requestState: "candidate-upstream-state-1",
          inputRequests: { "confirm-name": { method: "elicitation/create" } }
        }
      };
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      // The upstream answers the way an MCP tool does: one tool result whose business
      // value is published under `structuredContent`, with the mixed content blocks and
      // the application `_meta` beside it. The platform's projection passes a value that
      // already is a tool result through unchanged (`completeToolResult`), so the peer
      // reads the business payload where the plan's normative skeleton puts it. A value
      // that spelled the business fields as top-level siblings of `content` instead would
      // be forwarded verbatim and the payload would never reach `structuredContent`.
      body: {
        resultType: "complete",
        value: {
          content: [
            { type: "text", text: "artifact prepared" },
            { type: "image", data: IMAGE_DATA, mimeType: "image/png" },
            { type: "audio", data: AUDIO_DATA, mimeType: "audio/wav" },
            { type: "resource", resource: { uri: RESOURCE_URI, text: "artifact body", mimeType: "text/plain" } },
            { type: "resource_link", uri: RESOURCE_URI, name: "artifact", mimeType: "text/plain" }
          ],
          structuredContent: { ...payload },
          _meta: {
            "business-id": "order-demo",
            "com.example/traceId": "business-trace",
            "com.example/status": "ready"
          }
        }
      }
    };
  }
};

const gateway = createGateway({
  continuationKey: new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1)),
  descriptors: [descriptor],
  upstream,
  serverInfo: { name: "meshrix-interop-candidate", version: "0.1.0-fix-b" }
});
const adapter = createModernDownstreamAdapter({ gateway });

function contextFor(message) {
  return message?.params?._meta?.["interop-authorization"] === "deny" ? denyContext : allowContext;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

await gateway.start();
const lines = createInterface({ input: process.stdin });
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "tools/list" && message.params?.slowGoodPath === true) {
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    const response = await adapter.handle({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: message,
      context: contextFor(message)
    });
    if (response.body !== undefined && message.id !== undefined) send(response.body);
  }
} finally {
  await gateway.close();
}

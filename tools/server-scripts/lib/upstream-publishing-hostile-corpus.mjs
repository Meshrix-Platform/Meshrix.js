import { UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION } from "../../../packages/agents/src/upstream-gateway/publishing-application.mjs";

function validCommand(baseUrl) {
  return {
    schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
    action: "create",
    serviceKey: "raw-boundary-service",
    expectedServiceRevision: 0,
    expectedSetRevision: 0,
    idempotencyKey: "raw-boundary-create",
    descriptor: {
      serviceProtocol: "http",
      label: "Raw boundary",
      baseUrl,
      references: [],
      operations: [{
        operationKey: "echo",
        method: "POST",
        path: "/echo",
        payloadTransport: {
          request: { mode: "structured_json", maxBytes: 1024 * 1024, mediaTypes: ["application/json"] },
          response: { mode: "structured_json", maxBytes: 1024 * 1024, mediaTypes: ["application/json"] }
        }
      }]
    }
  };
}

export function createUpstreamPublishingHostileCorpus(baseUrl) {
  const valid = validCommand(baseUrl);
  const withDescriptor = (descriptor) => JSON.stringify({ ...valid, descriptor: { ...valid.descriptor, ...descriptor } });
  const withOperation = (operation) => withDescriptor({ operations: [{ ...valid.descriptor.operations[0], ...operation }] });
  const duplicate = JSON.stringify(valid).replace('"action":"create"', '"action":"create","action":"replace"');
  const control = JSON.stringify(valid).replace('"label":"Raw boundary"', '"label":"\\u0001"');
  const oversized = JSON.stringify({ ...valid, unsupportedPadding: "x".repeat(128 * 1024) });
  let nested = "0";
  for (let depth = 0; depth < 34; depth += 1) nested = `{"nested":${nested}}`;
  const objectCardinality = `{${Array.from({ length: 513 }, (_, index) => `"k${index}":0`).join(",")}}`;
  const arrayCardinality = JSON.stringify({ ...valid, unsupportedItems: Array.from({ length: 513 }, () => 0) });
  const totalCardinality = JSON.stringify({
    ...valid,
    unsupportedMatrix: Array.from({ length: 9 }, () => Array.from({ length: 512 }, () => 0))
  });
  return Object.freeze([
    ["duplicate-key", duplicate],
    ["unknown-field", JSON.stringify({ ...valid, unsupported: true })],
    ["prototype-key", `{"__proto__":{},"schemaVersion":"${UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION}"}`],
    ["malformed-json", `${JSON.stringify(valid)} trailing`],
    ["control-character", control],
    ["unsafe-route", withOperation({ path: "/echo/../admin" })],
    ["unsafe-target", withDescriptor({ baseUrl: "file:///local/service" })],
    ["unsafe-header", withDescriptor({ headers: { authorization: "not-materialized" } })],
    ["unsafe-schema", withOperation({ requestSchema: { regex: ".*" } })],
    ["byte-limit", oversized],
    ["depth-limit", nested],
    ["object-cardinality", objectCardinality],
    ["array-cardinality", arrayCardinality],
    ["total-cardinality", totalCardinality]
  ].map(([id, raw]) => Object.freeze({ id, raw })));
}

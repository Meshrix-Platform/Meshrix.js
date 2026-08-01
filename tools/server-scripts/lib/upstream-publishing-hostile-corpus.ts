import { UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION } from "../../../packages/agents/src/upstream-gateway/publishing-application.ts";

function validCommand(baseUrl?: any) : any {
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

export function createUpstreamPublishingHostileCorpus(baseUrl?: any) : any {
  const valid: any = validCommand(baseUrl);
  const withDescriptor: any = (descriptor?: any) : any => JSON.stringify({ ...valid, descriptor: { ...valid.descriptor, ...descriptor } });
  const withOperation: any = (operation?: any) : any => withDescriptor({ operations: [{ ...valid.descriptor.operations[0], ...operation }] });
  const duplicate: any = JSON.stringify(valid).replace('"action":"create"', '"action":"create","action":"replace"');
  const control: any = JSON.stringify(valid).replace('"label":"Raw boundary"', '"label":"\\u0001"');
  const oversized: any = JSON.stringify({ ...valid, unsupportedPadding: "x".repeat(128 * 1024) });
  let nested: any = "0";
  for (let depth: any = 0; depth < 34; depth += 1) nested = `{"nested":${nested}}`;
  const objectCardinality: any = `{${Array.from({ length: 513 }, (_?: any, index?: any) : any => `"k${index}":0`).join(",")}}`;
  const arrayCardinality: any = JSON.stringify({ ...valid, unsupportedItems: Array.from({ length: 513 }, () : any => 0) });
  const totalCardinality: any = JSON.stringify({
    ...valid,
    unsupportedMatrix: Array.from({ length: 9 }, () : any => Array.from({ length: 512 }, () : any => 0))
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
  ].map(([id, raw]: any[]) : any => Object.freeze({ id, raw })));
}

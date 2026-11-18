import { MCP_PROTOCOL_VERSION } from "./adapter/http-mcp-adapter-constants.ts";
import {
  SERVICE_COLLABORATION_CORE_STATE_GENERATION,
  SERVICE_COLLABORATION_FALLBACK_METHODS,
  SERVICE_COLLABORATION_PROFILE_METHODS,
  SERVICE_COLLABORATION_PROTOCOL_VERSION,
  SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD,
  SERVICE_COLLABORATION_SUBSCRIBE_METHOD,
  createFallbackDescriptor,
  decodeCollaborationMessage,
  encodeCollaborationMessage,
  parseCollaborationMessage,
  selectProtocolPath
} from "@meshrix/contracts/service-collaboration-contract";

export const SERVICE_COLLABORATION_MCP_ENVELOPE_VERSION: any = "v0.0.1:service-collaboration:mcp-envelope-1";
export const SERVICE_COLLABORATION_JSONRPC_VERSION: any = "2.0";

const KIND_TO_METHOD: any = Object.freeze({
  "open-request": "meshrix/collaboration/open",
  "open-response": "meshrix/collaboration/open",
  "observe-request": "meshrix/collaboration/observe",
  "observe-response": "meshrix/collaboration/observe",
  "commit-request": "meshrix/collaboration/commit",
  acknowledge: "meshrix/collaboration/acknowledge",
  "subscribe-request": SERVICE_COLLABORATION_SUBSCRIBE_METHOD,
  "resource-updated": SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD,
  "rebase-request": "meshrix/collaboration/rebase",
  "rebase-response": "meshrix/collaboration/rebase",
  "resync-request": "meshrix/collaboration/resync",
  "resync-response": "meshrix/collaboration/resync",
  "effect-command": "meshrix/collaboration/effect",
  fallback: "tools/call"
});

function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value?: any, expected?: any) : any {
  if (!isPlainObject(value)) return false;
  const keys: any = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key?: any, index?: any) : any => key === keys[index]);
}

export function assertServiceCollaborationProtocolVersion() : any {
  if (SERVICE_COLLABORATION_PROTOCOL_VERSION !== MCP_PROTOCOL_VERSION) {
    throw new Error("Service collaboration protocol version must remain MCP 2026-07-28.");
  }
  if (SERVICE_COLLABORATION_PROTOCOL_VERSION !== "2026-07-28") {
    throw new Error("Service collaboration must not advertise a second protocol generation.");
  }
  return MCP_PROTOCOL_VERSION;
}

export function collaborationMethodFor(kind?: any) : any {
  return KIND_TO_METHOD[kind] || "";
}

export function isNotificationKind(kind?: any) : any {
  return kind === "resource-updated";
}

export function parseMcpCollaborationEnvelope(value?: any) : any {
  assertServiceCollaborationProtocolVersion();
  if (!isPlainObject(value) || value.jsonrpc !== SERVICE_COLLABORATION_JSONRPC_VERSION) return null;
  const notification: any = isPlainObject(value) && !Object.prototype.hasOwnProperty.call(value, "id");
  const expected: any = notification
    ? ["jsonrpc", "method", "params"].sort()
    : ["id", "jsonrpc", "method", "params"].sort();
  if (!hasExactKeys(value, expected)) return null;
  if (notification && value.method !== SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD) return null;
  if (!notification && typeof value.id !== "string") return null;
  if (typeof value.method !== "string" || !value.method) return null;
  const params: any = parseCollaborationMessage(value.params);
  if (!params) return null;
  const expectedMethod: any = collaborationMethodFor(params.kind);
  if (!expectedMethod || expectedMethod !== value.method) return null;
  if (params.kind === "edit-view") return null;
  return Object.freeze({
    jsonrpc: SERVICE_COLLABORATION_JSONRPC_VERSION,
    ...(notification ? {} : { id: value.id }),
    method: value.method,
    params
  });
}

export function createMcpCollaborationEnvelope({
  id = "peer-1",
  message
}: Record<string, any> = {}) : any {
  const params: any = parseCollaborationMessage(message);
  if (!params) throw new TypeError("MCP collaboration envelope requires a versioned collaboration message.");
  if (params.kind === "edit-view") {
    throw new TypeError("Edit remains a local Working View and is not an MCP request.");
  }
  const method: any = collaborationMethodFor(params.kind);
  if (!method) throw new TypeError("Collaboration kind has no MCP method projection.");
  const envelope: any = isNotificationKind(params.kind)
    ? { jsonrpc: SERVICE_COLLABORATION_JSONRPC_VERSION, method, params }
    : { jsonrpc: SERVICE_COLLABORATION_JSONRPC_VERSION, id, method, params };
  const parsed: any = parseMcpCollaborationEnvelope(envelope);
  if (!parsed) throw new TypeError("MCP collaboration envelope does not satisfy the wire contract.");
  return parsed;
}

export function encodeMcpCollaborationEnvelope(value?: any) : any {
  const parsed: any = parseMcpCollaborationEnvelope(value);
  return parsed ? JSON.stringify(parsed) : "";
}

export function decodeMcpCollaborationEnvelope(value?: any) : any {
  if (typeof value !== "string" || !value) return null;
  try {
    return parseMcpCollaborationEnvelope(JSON.parse(value));
  } catch {
    return null;
  }
}

export function createServiceCollaborationMcpPeer(peerId: any = "peer-a") : any {
  const normalizedPeerId: any = String(peerId || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(normalizedPeerId)) {
    throw new TypeError("Neutral MCP collaboration peer requires a stable opaque identity.");
  }
  let sequence: any = 0;
  return Object.freeze({
    peerId: normalizedPeerId,
    encode(message?: any) : any {
      const kind: any = message?.kind;
      const id: any = isNotificationKind(kind) ? undefined : `${normalizedPeerId}-${++sequence}`;
      return encodeMcpCollaborationEnvelope(createMcpCollaborationEnvelope({ id, message }));
    },
    decode: decodeMcpCollaborationEnvelope,
    validate: parseMcpCollaborationEnvelope,
    encodeContract: encodeCollaborationMessage,
    decodeContract: decodeCollaborationMessage
  });
}

export function agreeServiceCollaborationMcpPeers(left?: any, right?: any, message?: any) : any {
  if (!left?.encode || !right?.encode || !left?.decode || !right?.decode) return null;
  const encodedByLeft: any = left.encode(message);
  const encodedByRight: any = right.encode(message);
  if (!encodedByLeft || !encodedByRight) return null;
  const leftView: any = right.decode(encodedByLeft);
  const rightView: any = left.decode(encodedByRight);
  if (!leftView || !rightView) return null;
  if (JSON.stringify(leftView.params) !== JSON.stringify(rightView.params)) return null;
  if (leftView.method !== rightView.method) return null;
  if (leftView.jsonrpc !== rightView.jsonrpc) return null;
  if ((leftView.id && !rightView.id) || (!leftView.id && rightView.id)) return null;
  return leftView.params;
}

export function ordinaryMcpFallbackMethods() : any {
  return Object.freeze([...SERVICE_COLLABORATION_FALLBACK_METHODS]);
}

export function negotiatedCollaborationMethods() : any {
  return Object.freeze([...SERVICE_COLLABORATION_PROFILE_METHODS]);
}

export function projectProtocolNegotiation(supportsCollaboration: any = false) : any {
  assertServiceCollaborationProtocolVersion();
  const selected: any = selectProtocolPath(supportsCollaboration);
  if (selected.coreStateGeneration !== SERVICE_COLLABORATION_CORE_STATE_GENERATION) {
    throw new Error("Protocol negotiation must retain one Core state generation.");
  }
  return Object.freeze({
    protocolVersion: MCP_PROTOCOL_VERSION,
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    profile: selected.profile,
    methods: selected.methods,
    fallback: createFallbackDescriptor()
  });
}

import { randomBytes } from "node:crypto";
import {
  MCP_PROXY_SESSION_HEADER,
  MCP_PROXY_SESSION_HEADER_LOWER,
  MCP_PROXY_SESSION_MAX_BYTES,
  normalizeMcpProxySessionId
} from "#lico/contracts/mcp-catalog-delivery";

export {
  MCP_PROXY_SESSION_HEADER,
  MCP_PROXY_SESSION_HEADER_LOWER,
  MCP_PROXY_SESSION_MAX_BYTES,
  normalizeMcpProxySessionId
};

export function createMcpProxySessionId() {
  return randomBytes(24).toString("base64url");
}

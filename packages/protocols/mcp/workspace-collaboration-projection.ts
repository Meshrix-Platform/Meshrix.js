/*
 * Workspace collaboration MCP projection. Ordinary tools/call and
 * resources/read remain the non-optimized fallback. Meshrix.js retains one
 * Core state generation.
 */

import {
  SERVICE_COLLABORATION_CORE_STATE_GENERATION,
  SERVICE_COLLABORATION_FALLBACK_METHODS,
  SERVICE_COLLABORATION_PROFILE_METHODS,
  SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD,
  SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED,
  SERVICE_COLLABORATION_SUBSCRIBE_METHOD,
  createFallbackDescriptor
} from "@meshrix/contracts/service-collaboration-contract";
import {
  createMcpCollaborationEnvelope,
  negotiatedCollaborationMethods,
  ordinaryMcpFallbackMethods,
  projectProtocolNegotiation
} from "./service-collaboration-projection.ts";

export const WORKSPACE_COLLABORATION_PROJECTION_OWNED_MODULE: any =
  "packages/protocols/mcp/workspace-collaboration-projection.ts";

export function projectWorkspaceCollaborationMcp({
  id = "wrm-peer-1",
  message
}: Record<string, any> = {}) : any {
  return createMcpCollaborationEnvelope({ id, message });
}

export function workspaceOrdinaryMcpFallback() : any {
  return createFallbackDescriptor();
}

export function workspaceCollaborationMethods() : any {
  return negotiatedCollaborationMethods();
}

export function workspaceOrdinaryMcpMethods() : any {
  return ordinaryMcpFallbackMethods();
}

export function assertWorkspaceCollaborationProtocolPath() : any {
  if (SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED !== false) {
    throw new Error("Workspace collaboration cannot advertise a second Core generation.");
  }
  const collaborative: any = projectProtocolNegotiation(true);
  const ordinary: any = projectProtocolNegotiation(false);
  if (collaborative.coreStateGeneration !== SERVICE_COLLABORATION_CORE_STATE_GENERATION) {
    throw new Error("Workspace collaboration must retain one Core state generation.");
  }
  if (ordinary.coreStateGeneration !== collaborative.coreStateGeneration) {
    throw new Error("Ordinary MCP fallback must not mint a second Core generation.");
  }
  const fallback: any = workspaceOrdinaryMcpFallback();
  if (JSON.stringify(fallback.methods) !== JSON.stringify([...SERVICE_COLLABORATION_FALLBACK_METHODS])) {
    throw new Error("Ordinary MCP fallback methods must remain tools/call and Resource reads.");
  }
  return Object.freeze({
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    subscribeMethod: SERVICE_COLLABORATION_SUBSCRIBE_METHOD,
    notificationMethod: SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD,
    profileMethods: [...SERVICE_COLLABORATION_PROFILE_METHODS],
    ordinaryMethods: [...SERVICE_COLLABORATION_FALLBACK_METHODS],
    secondCoreGenerationAllowed: false
  });
}

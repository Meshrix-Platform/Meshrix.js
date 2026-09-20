import type { AuthenticatedContext, ResourcePort, RouteSnapshot } from "@meshrix/contracts/gateway";

export type ResourceReader = ResourcePort["read"];

/** Small, protocol-neutral resource port factory for embedded applications. */
export function createResourcePort(read: ResourceReader): ResourcePort {
  return Object.freeze({ read });
}

export interface ResourceRequest {
  readonly context: AuthenticatedContext;
  readonly route: RouteSnapshot;
  readonly uri: string;
  readonly signal?: AbortSignal;
}


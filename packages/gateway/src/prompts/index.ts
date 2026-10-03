import type { AuthenticatedContext, PromptPort, RouteSnapshot } from "@meshrix/contracts/gateway";

export type PromptGetter = PromptPort["get"];
export type PromptCompleter = NonNullable<PromptPort["complete"]>;

/** Small, protocol-neutral prompt port factory for embedded applications. */
export function createPromptPort(input: { readonly get: PromptGetter; readonly complete?: PromptCompleter }): PromptPort {
  return Object.freeze({ get: input.get, ...(input.complete ? { complete: input.complete } : {}) });
}

export interface PromptRequest {
  readonly context: AuthenticatedContext;
  readonly route: RouteSnapshot;
  readonly name: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

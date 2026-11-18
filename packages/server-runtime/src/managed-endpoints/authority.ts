import type { ManagedActor } from "@meshrix/contracts/managed-endpoints";
import type {
  FinalProtectedSinkSubject,
  FinalProtectedSinkAttemptContext
} from "@meshrix/foundation/security/final-protected-sink-permit";
import { managedActorFromSession } from "./domain.ts";

export interface ManagedTaskAuthority {
  readonly kind: "console" | "api-key";
  readonly binding: Readonly<Record<string, unknown>>;
}

export interface ManagedAuthorityDecision {
  readonly allowed: boolean;
  readonly revoked?: boolean;
  readonly reasonCode?: string;
  readonly actor?: ManagedActor;
  readonly subject?: FinalProtectedSinkSubject;
  readonly context?: FinalProtectedSinkAttemptContext;
}

export interface ManagedTaskAuthorityPort {
  capture(input: {
    request: any; authSession: any; operation: any; input: Record<string, unknown>;
    persist: (authority: ManagedTaskAuthority) => { taskId: string; created: boolean };
  }): Promise<ManagedTaskAuthority>;
  revalidate(authority: ManagedTaskAuthority, input: Record<string, unknown>): Promise<ManagedAuthorityDecision>;
  release(authority: ManagedTaskAuthority, settlement?: { taskId: string; state: string }): Promise<void>;
}

export function createManagedTaskAuthorityPort({
  deferredConsoleAuthorityPort,
  getOperationPermissionPlatform,
  resolveOperation
}: {
  deferredConsoleAuthorityPort: any;
  getOperationPermissionPlatform: () => any;
  resolveOperation: (id: string) => any;
}): ManagedTaskAuthorityPort {
  const operation = () => {
    const resolved = resolveOperation("endpoints.tasks.submit");
    if (!resolved) throw new Error("Managed task operation is unavailable.");
    return { ...resolved, externalAuth: false };
  };
  return Object.freeze<ManagedTaskAuthorityPort>({
    async capture({ request, authSession, input, persist }) {
      const commit = async (authority: ManagedTaskAuthority) => {
        try {
          persist(authority);
          return authority;
        } catch (error) {
          if (authority.kind === "console") await deferredConsoleAuthorityPort.revoke({
            authorityRef: authority.binding.authorityRef, reason: "managed_admission_failed"
          });
          throw error;
        }
      };
      const capture = request?.__meshrixCaptureManagedTaskAuthority;
      if (typeof capture === "function") {
        const binding = await capture(input, (binding: Readonly<Record<string, unknown>>) =>
          persist({ kind: "api-key", binding }));
        return { kind: "api-key", binding };
      }
      if (request?.__meshrixExternalAuth?.apiKeyAuthorization) {
        const platform = getOperationPermissionPlatform();
        const binding = await platform.runtime.captureDeferredTaskAuthority({
          request,
          authorization: request.__meshrixExternalAuth.apiKeyAuthorization,
          input,
          persist: (binding: Readonly<Record<string, unknown>>) => persist({ kind: "api-key", binding })
        });
        return { kind: "api-key", binding };
      }
      if (!authSession?.sessionId) {
        throw Object.assign(new Error("Managed requester authority is required."), {
          code: "managed_authority_required", statusCode: 403
        });
      }
      const binding = await deferredConsoleAuthorityPort.capture({
        request, authSession, operation: operation(), input
      });
      return commit({
        kind: "console",
        binding: { ...binding, actor: managedActorFromSession(authSession) }
      });
    },
    async revalidate(authority, input) {
      if (authority.kind === "api-key") {
        return getOperationPermissionPlatform().runtime.revalidateDeferredTaskAuthority(authority.binding, input);
      }
      if (authority.kind !== "console") return { allowed: false, reasonCode: "managed_authority_required" };
      const decision = await deferredConsoleAuthorityPort.revalidate({
        ...authority.binding, operation: operation(), input
      });
      const actor = authority.binding.actor as ManagedActor;
      if (decision.allowed && (decision.subject?.subjectId !== actor?.subjectId ||
          decision.subject?.tenantId !== actor?.tenantId)) {
        return { allowed: false, reasonCode: "managed_authority_changed" };
      }
      return { ...decision, actor };
    },
    async release(authority, settlement) {
      if (authority.kind === "console") {
        await deferredConsoleAuthorityPort.revoke({
          authorityRef: authority.binding.authorityRef, reason: "managed_task_settled"
        });
      } else if (settlement) {
        await getOperationPermissionPlatform().runtime.settleDeferredTaskAuthority(authority.binding, settlement);
      }
    }
  });
}

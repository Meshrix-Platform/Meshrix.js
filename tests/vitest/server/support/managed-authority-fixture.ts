import type { ManagedActor } from "../../../../packages/contracts/src/managed-endpoints.ts";
import type { ManagedTaskAuthorityPort } from "../../../../packages/server-runtime/src/managed-endpoints/authority.ts";
import { managedActorFromSession } from "../../../../packages/server-runtime/src/managed-endpoints/domain.ts";

export function controlledManagedAuthority(actor: ManagedActor): ManagedTaskAuthorityPort {
  return {
    async capture({ authSession, persist }) {
      const authority = { kind: "console" as const, binding: { actor: authSession ? managedActorFromSession(authSession) : actor } };
      persist(authority);
      return authority;
    },
    async revalidate(authority) {
      const requester = authority.binding.actor as ManagedActor;
      return {
        allowed: true,
        actor: requester,
        subject: {
          subjectId: requester.subjectId, tenantId: requester.tenantId,
          type: "console-user", generation: "synthetic-generation"
        },
        context: {
          approvalRevision: "synthetic-approval", grantRevision: "synthetic-grant",
          policyRevision: "synthetic-policy", riskRevision: "synthetic-risk",
          workloadGeneration: "synthetic-workload"
        }
      };
    },
    async release() {}
  };
}

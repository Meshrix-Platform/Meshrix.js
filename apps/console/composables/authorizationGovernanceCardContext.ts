import { inject, provide, type InjectionKey } from "vue";
import type { OperationPermissionViewContext } from "./operationPermissionViewContext";

export type AuthorizationGovernanceCardContext = Pick<
  OperationPermissionViewContext,
  | "authorizationGovernance"
  | "authorizationGovernanceEditorBody"
  | "authorizationGovernanceEditorKind"
  | "authorizationGovernanceEditorKinds"
  | "authorizationGovernanceEditorStatus"
  | "authorizationGovernanceError"
  | "authorizationGovernanceMetrics"
  | "authorizationGovernanceSaving"
  | "itemText"
  | "policyCount"
  | "resetAuthorizationGovernanceEditor"
  | "saveAuthorizationGovernanceEditor"
  | "shortList"
>;

const authorizationGovernanceCardKey: any = Symbol("authorization-governance-card") as InjectionKey<AuthorizationGovernanceCardContext>;

export function createAuthorizationGovernanceCardContext(
  context: OperationPermissionViewContext,
): AuthorizationGovernanceCardContext {
  return {
    authorizationGovernance: context.authorizationGovernance,
    authorizationGovernanceEditorBody: context.authorizationGovernanceEditorBody,
    authorizationGovernanceEditorKind: context.authorizationGovernanceEditorKind,
    authorizationGovernanceEditorKinds: context.authorizationGovernanceEditorKinds,
    authorizationGovernanceEditorStatus: context.authorizationGovernanceEditorStatus,
    authorizationGovernanceError: context.authorizationGovernanceError,
    authorizationGovernanceMetrics: context.authorizationGovernanceMetrics,
    authorizationGovernanceSaving: context.authorizationGovernanceSaving,
    itemText: context.itemText,
    policyCount: context.policyCount,
    resetAuthorizationGovernanceEditor: context.resetAuthorizationGovernanceEditor,
    saveAuthorizationGovernanceEditor: context.saveAuthorizationGovernanceEditor,
    shortList: context.shortList,
  };
}

export function provideAuthorizationGovernanceCardContext(context: AuthorizationGovernanceCardContext) : any {
  provide(authorizationGovernanceCardKey, context);
}

export function useAuthorizationGovernanceCardContext() : any {
  const context: any = inject(authorizationGovernanceCardKey);
  if (!context) {
    throw new Error("Authorization governance card context is not available");
  }
  return context;
}

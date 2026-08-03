import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  ORGANIZATION_GOVERNANCE_MAX_DEPTH,
  ORGANIZATION_GOVERNANCE_MAX_NODES
} from "./organization-model.ts";

export const API_KEY_MANAGEMENT_ACTION = "operation_permission.api_keys.manage";

export class ApiKeyIssuerAuthorityError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 403) {
    super(message);
    this.name = "ApiKeyIssuerAuthorityError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function authorityError(code: string, message: string, statusCode = 403): never {
  throw new ApiKeyIssuerAuthorityError(code, message, statusCode);
}

function record(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values: any = []): string[] {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value?: any) : any => String(value || "").trim())
    .filter(Boolean))].sort();
}

function revisionTuple(organizationSnapshot: any, governanceSummary: any): Readonly<Record<string, any>> {
  const policyRevision: any = governanceSummary?.policyRevision || {};
  return Object.freeze({
    organizationRevision: Number(organizationSnapshot?.revision || 0),
    authorizationRevision: Number(policyRevision.revision || 0),
    authorizationUpdatedAt: String(policyRevision.updatedAt || "")
  });
}

function validateOrganizationSnapshot(snapshot: any): Map<string, any> {
  if (!record(snapshot) || snapshot.configured !== true ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 ||
      !Array.isArray(snapshot.nodes) || snapshot.nodes.length < 1 ||
      snapshot.nodes.length > ORGANIZATION_GOVERNANCE_MAX_NODES) {
    authorityError("api_key_authority_unavailable", "Organization governance is unavailable.", 503);
  }
  const nodesById: any = new Map<string, any>();
  for (const node of snapshot.nodes) {
    const nodeId: any = String(node?.nodeId || "").trim();
    const nodeType: any = String(node?.nodeType || "").trim();
    const parentId: any = String(node?.parentId || "").trim();
    if (!nodeId || nodesById.has(nodeId) ||
        !["group", "organization", "department", "team"].includes(nodeType)) {
      authorityError("api_key_authority_unavailable", "Organization governance is malformed.", 503);
    }
    nodesById.set(nodeId, Object.freeze({ ...node, nodeId, nodeType, parentId }));
  }
  for (const node of nodesById.values()) {
    const seen: any = new Set<string>([node.nodeId]);
    let cursor: any = node;
    let depth: any = 0;
    while (cursor.parentId) {
      const parent: any = nodesById.get(cursor.parentId);
      if (!parent || seen.has(parent.nodeId) || ++depth > ORGANIZATION_GOVERNANCE_MAX_DEPTH) {
        authorityError("api_key_authority_unavailable", "Organization governance is malformed.", 503);
      }
      seen.add(parent.nodeId);
      cursor = parent;
    }
  }
  const roots: any[] = [...nodesById.values()].filter((node?: any) : any => !node.parentId);
  if (roots.length !== 1 || roots[0].nodeType !== "group") {
    authorityError("api_key_authority_unavailable", "Organization governance is malformed.", 503);
  }
  return nodesById;
}

export function organizationLineage(nodeId: string, nodesById: Map<string, any>): string[] {
  const lineage: any[] = [];
  const seen: any = new Set<string>();
  let cursor: any = nodesById.get(String(nodeId || ""));
  while (cursor) {
    if (seen.has(cursor.nodeId) || lineage.length > ORGANIZATION_GOVERNANCE_MAX_DEPTH) {
      authorityError("api_key_authority_unavailable", "Organization governance is malformed.", 503);
    }
    seen.add(cursor.nodeId);
    lineage.push(cursor.nodeId);
    cursor = cursor.parentId ? nodesById.get(cursor.parentId) : null;
  }
  if (lineage.length === 0) {
    authorityError("api_key_scope_denied", "Organization node is outside the issuer scope.", 403);
  }
  return lineage.reverse();
}

export function organizationLineageDigest(nodeId: string, nodesById: Map<string, any>): string {
  return crypto.createHash("sha256")
    .update(canonicalJson(organizationLineage(nodeId, nodesById)))
    .digest("base64url");
}

function isDescendantOrSelf(nodeId: string, rootId: string, nodesById: Map<string, any>): boolean {
  return organizationLineage(nodeId, nodesById).includes(rootId);
}

function reduceRoots(rootIds: string[], nodesById: Map<string, any>): string[] {
  return uniqueStrings(rootIds).filter((candidate?: any) : any =>
    !rootIds.some((other?: any) : any => other !== candidate && isDescendantOrSelf(candidate, other, nodesById)));
}

export function evaluateApiKeyIssuerScopes({
  subjectId,
  organizationSnapshot,
  governanceSummary
}: Record<string, any> = {}): any {
  const canonicalSubjectId: any = String(subjectId || "").trim();
  if (!canonicalSubjectId) {
    authorityError("api_key_scope_denied", "An authenticated issuer is required.", 403);
  }
  const nodesById: any = validateOrganizationSnapshot(organizationSnapshot);
  if (!record(governanceSummary)) {
    authorityError("api_key_authority_unavailable", "Authorization governance is unavailable.", 503);
  }
  const userPolicy: any = (governanceSummary.userPolicies || [])
    .find((policy?: any) : any => String(policy?.userId || "") === canonicalSubjectId);
  const organizationRoles: any = new Map((organizationSnapshot.roles || [])
    .map((role?: any) : any => [String(role?.roleId || ""), role]));
  const currentRoles: any = new Map((governanceSummary.roles || [])
    .filter((role?: any) : any => role?.enabled !== false)
    .map((role?: any) : any => [String(role?.roleId || role?.id || ""), role]));
  const roots: any[] = [];
  for (const roleId of uniqueStrings(userPolicy?.enabled === true ? userPolicy.roleIds : [])) {
    const currentRole: any = currentRoles.get(roleId);
    const organizationRole: any = organizationRoles.get(roleId);
    if (!currentRole || !organizationRole) continue;
    const actions: any[] = uniqueStrings(currentRole.managementActions);
    const scopeNodeId: any = String(currentRole.scopeNodeId || "").trim();
    const node: any = nodesById.get(scopeNodeId);
    const assignmentMatchesPublishedRole: any =
      String(organizationRole.scopeNodeId || "").trim() === scopeNodeId &&
      uniqueStrings(organizationRole.managementActions).includes(API_KEY_MANAGEMENT_ACTION);
    if (assignmentMatchesPublishedRole && actions.includes(API_KEY_MANAGEMENT_ACTION) && node) roots.push(scopeNodeId);
  }
  for (const assignment of governanceSummary.apiKeyRecoveryAssignments || []) {
    if (assignment?.enabled !== true || assignment?.serverAuthored !== true ||
        String(assignment.subjectId || "") !== canonicalSubjectId ||
        String(assignment.action || "") !== API_KEY_MANAGEMENT_ACTION) continue;
    const rootNodeId: any = String(assignment.rootNodeId || "").trim();
    const node: any = nodesById.get(rootNodeId);
    if (node && !node.parentId) roots.push(rootNodeId);
  }
  const reducedRoots: any[] = reduceRoots(roots, nodesById);
  const eligibleNodeIds: any[] = [...nodesById.keys()]
    .filter((nodeId?: any) : any => reducedRoots.some((rootId?: any) : any =>
      isDescendantOrSelf(nodeId, rootId, nodesById)))
    .sort();
  return Object.freeze({
    subjectId: canonicalSubjectId,
    roots: Object.freeze(reducedRoots.map((nodeId?: any) : any => Object.freeze({ ...nodesById.get(nodeId) }))),
    eligibleNodeIds: Object.freeze(eligibleNodeIds),
    revision: revisionTuple(organizationSnapshot, governanceSummary)
  });
}

export function assertApiKeyIssuerTarget(scopes: any, targetNodeId: string): void {
  if (!scopes?.eligibleNodeIds?.includes(String(targetNodeId || ""))) {
    authorityError("api_key_scope_denied", "Organization node is outside the issuer scope.", 403);
  }
}

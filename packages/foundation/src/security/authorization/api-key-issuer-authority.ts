import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  ORGANIZATION_GOVERNANCE_MAX_DEPTH,
  ORGANIZATION_GOVERNANCE_MAX_NODES
} from "./organization-model.ts";

export const API_KEY_MANAGEMENT_ACTION = "operation_permission.api_keys.manage";

interface OrganizationNodeRecord extends Record<string, unknown> {
  nodeId: string;
  nodeType: string;
  parentId: string;
}

interface ApiKeyIssuerScopeResult {
  readonly eligibleNodeIds: readonly string[];
}

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

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values: unknown = []): string[] {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].sort();
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(record) : [];
}

function revisionTuple(
  organizationSnapshot: Record<string, unknown>,
  governanceSummary: Record<string, unknown>
): Readonly<Record<string, string | number>> {
  const policyRevision = record(governanceSummary.policyRevision) ? governanceSummary.policyRevision : {};
  return Object.freeze({
    organizationRevision: Number(organizationSnapshot?.revision || 0),
    authorizationRevision: Number(policyRevision.revision || 0),
    authorizationUpdatedAt: String(policyRevision.updatedAt || "")
  });
}

function validateOrganizationSnapshot(snapshot: unknown): Map<string, OrganizationNodeRecord> {
  if (!record(snapshot) || snapshot.configured !== true ||
      !Number.isSafeInteger(snapshot.revision) || Number(snapshot.revision) < 1 ||
      !Array.isArray(snapshot.nodes) || snapshot.nodes.length < 1 ||
      snapshot.nodes.length > ORGANIZATION_GOVERNANCE_MAX_NODES) {
    authorityError("api_key_authority_unavailable", "Organization governance is unavailable.", 503);
  }
  const nodesById = new Map<string, OrganizationNodeRecord>();
  for (const value of snapshot.nodes) {
    const node = record(value) ? value : {};
    const nodeId = String(node.nodeId || "").trim();
    const nodeType = String(node.nodeType || "").trim();
    const parentId = String(node.parentId || "").trim();
    if (!record(value) || !nodeId || nodesById.has(nodeId) ||
        !["group", "organization", "department", "team"].includes(nodeType)) {
      authorityError("api_key_authority_unavailable", "Organization governance is malformed.", 503);
    }
    nodesById.set(nodeId, Object.freeze({ ...node, nodeId, nodeType, parentId }));
  }
  for (const node of nodesById.values()) {
    const seen = new Set<string>([node.nodeId]);
    let cursor = node;
    let depth = 0;
    while (cursor.parentId) {
      const parent = nodesById.get(cursor.parentId);
      if (!parent || seen.has(parent.nodeId) || ++depth > ORGANIZATION_GOVERNANCE_MAX_DEPTH) {
        authorityError("api_key_authority_unavailable", "Organization governance is malformed.", 503);
      }
      seen.add(parent.nodeId);
      cursor = parent;
    }
  }
  const roots = [...nodesById.values()].filter((node) => !node.parentId);
  if (roots.length !== 1 || roots[0].nodeType !== "group") {
    authorityError("api_key_authority_unavailable", "Organization governance is malformed.", 503);
  }
  return nodesById;
}

export function organizationLineage(nodeId: string, nodesById: Map<string, OrganizationNodeRecord>): string[] {
  const lineage: string[] = [];
  const seen = new Set<string>();
  let cursor: OrganizationNodeRecord | undefined = nodesById.get(String(nodeId || ""));
  while (cursor) {
    if (seen.has(cursor.nodeId) || lineage.length > ORGANIZATION_GOVERNANCE_MAX_DEPTH) {
      authorityError("api_key_authority_unavailable", "Organization governance is malformed.", 503);
    }
    seen.add(cursor.nodeId);
    lineage.push(cursor.nodeId);
    cursor = cursor.parentId ? nodesById.get(cursor.parentId) : undefined;
  }
  if (lineage.length === 0) {
    authorityError("api_key_scope_denied", "Organization node is outside the issuer scope.", 403);
  }
  return lineage.reverse();
}

export function organizationLineageDigest(nodeId: string, nodesById: Map<string, OrganizationNodeRecord>): string {
  return crypto.createHash("sha256")
    .update(canonicalJson(organizationLineage(nodeId, nodesById)))
    .digest("base64url");
}

function isDescendantOrSelf(nodeId: string, rootId: string, nodesById: Map<string, OrganizationNodeRecord>): boolean {
  return organizationLineage(nodeId, nodesById).includes(rootId);
}

function reduceRoots(rootIds: string[], nodesById: Map<string, OrganizationNodeRecord>): string[] {
  return uniqueStrings(rootIds).filter((candidate) =>
    !rootIds.some((other) => other !== candidate && isDescendantOrSelf(candidate, other, nodesById)));
}

export function evaluateApiKeyIssuerScopes({
  subjectId,
  organizationSnapshot,
  governanceSummary
}: {
  subjectId?: unknown;
  organizationSnapshot?: unknown;
  governanceSummary?: unknown;
} = {}) {
  const canonicalSubjectId = String(subjectId || "").trim();
  if (!canonicalSubjectId) {
    authorityError("api_key_scope_denied", "An authenticated issuer is required.", 403);
  }
  if (!record(organizationSnapshot)) {
    authorityError("api_key_authority_unavailable", "Organization governance is unavailable.", 503);
  }
  const nodesById = validateOrganizationSnapshot(organizationSnapshot);
  if (!record(governanceSummary)) {
    authorityError("api_key_authority_unavailable", "Authorization governance is unavailable.", 503);
  }
  const userPolicies = records(governanceSummary.userPolicies);
  const userPolicy = userPolicies.find((policy) => String(policy.userId || "") === canonicalSubjectId);
  const publishedRoles = records(organizationSnapshot.roles);
  const governanceRoles = records(governanceSummary.roles);
  const organizationRoles = new Map<string, Record<string, unknown>>(publishedRoles
    .map((role) => [String(role.roleId || ""), role]));
  const currentRoles = new Map<string, Record<string, unknown>>(governanceRoles
    .filter((role) => role.enabled !== false)
    .map((role) => [String(role.roleId || role.id || ""), role]));
  const roots: string[] = [];
  for (const roleId of uniqueStrings(userPolicy?.enabled === true ? userPolicy.roleIds : [])) {
    const currentRole = currentRoles.get(roleId);
    const organizationRole = organizationRoles.get(roleId);
    if (!currentRole || !organizationRole) continue;
    const actions = uniqueStrings(currentRole.managementActions);
    const scopeNodeId = String(currentRole.scopeNodeId || "").trim();
    const node = nodesById.get(scopeNodeId);
    const assignmentMatchesPublishedRole =
      String(organizationRole.scopeNodeId || "").trim() === scopeNodeId &&
      uniqueStrings(organizationRole.managementActions).includes(API_KEY_MANAGEMENT_ACTION);
    if (assignmentMatchesPublishedRole && actions.includes(API_KEY_MANAGEMENT_ACTION) && node) roots.push(scopeNodeId);
  }
  const recoveryAssignments = records(governanceSummary.apiKeyRecoveryAssignments);
  for (const assignment of recoveryAssignments) {
    if (assignment.enabled !== true || assignment.serverAuthored !== true ||
        String(assignment.subjectId || "") !== canonicalSubjectId ||
        String(assignment.action || "") !== API_KEY_MANAGEMENT_ACTION) continue;
    const rootNodeId = String(assignment.rootNodeId || "").trim();
    const node = nodesById.get(rootNodeId);
    if (node && !node.parentId) roots.push(rootNodeId);
  }
  const reducedRoots = reduceRoots(roots, nodesById);
  const eligibleNodeIds = [...nodesById.keys()]
    .filter((nodeId) => reducedRoots.some((rootId) =>
      isDescendantOrSelf(nodeId, rootId, nodesById)))
    .sort();
  return Object.freeze({
    subjectId: canonicalSubjectId,
    roots: Object.freeze(reducedRoots.map((nodeId) => Object.freeze({ ...nodesById.get(nodeId) }))),
    eligibleNodeIds: Object.freeze(eligibleNodeIds),
    revision: revisionTuple(organizationSnapshot, governanceSummary)
  });
}

export function assertApiKeyIssuerTarget(scopes: ApiKeyIssuerScopeResult | null | undefined, targetNodeId: string): void {
  if (!scopes?.eligibleNodeIds?.includes(String(targetNodeId || ""))) {
    authorityError("api_key_scope_denied", "Organization node is outside the issuer scope.", 403);
  }
}

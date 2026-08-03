import { getJson, postJson } from "@meshrix/ui-console/bridge-http";

export const ORGANIZATION_TEMPLATE_SCHEMA_VERSION =
  "v0.0.1:authorization:organization-template-1" as const;
export const ORGANIZATION_GOVERNANCE_PROTOCOL_VERSION =
  "v0.0.1:authorization:organization-governance-1" as const;

export type OrganizationGovernanceNodeType = "group" | "organization" | "department" | "team";

export interface OrganizationGovernanceNode {
  nodeId: string;
  nodeType: OrganizationGovernanceNodeType;
  parentId: string;
  name: string;
  organizationLevel?: number;
}

export interface OrganizationTemplateTag {
  tagId: string;
  kind: "organization" | "group" | "role" | "custom";
  label: string;
  parentTagId: string;
  description: string;
  scopePrerequisites: string[];
}

export interface OrganizationTemplateRole {
  roleId: string;
  name: string;
  scopeNodeId: string;
  scopeNodeType: OrganizationGovernanceNodeType;
  managementActions: string[];
  businessResourceActions: readonly [];
  assignedSubjectIds: readonly [];
}

export interface OrganizationGovernanceTemplateDraft {
  schemaVersion: typeof ORGANIZATION_TEMPLATE_SCHEMA_VERSION;
  templateKey: string;
  templateName: string;
  description: string;
  organizationDepth: number;
  nodes: OrganizationGovernanceNode[];
  tags: OrganizationTemplateTag[];
  roles: OrganizationTemplateRole[];
}

export interface OrganizationGovernanceSnapshot extends OrganizationGovernanceTemplateDraft {
  protocolVersion: typeof ORGANIZATION_GOVERNANCE_PROTOCOL_VERSION;
  configured: boolean;
  revision: number;
  publishedAt: string;
}

export type OrganizationGovernancePreview = OrganizationGovernanceTemplateDraft;

export interface OrganizationTemplateSummary {
  templateKey: string;
  templateName: string;
  description: string;
  organizationDepth: number;
  nodeCount: number;
  tagCount: number;
  roleCount: number;
  fileName: string;
}

export interface OrganizationGovernanceGetResponse {
  snapshot: OrganizationGovernanceSnapshot;
  templates: OrganizationTemplateSummary[];
}

export interface OrganizationGovernanceImportResponse { draft: OrganizationGovernanceTemplateDraft; }
export interface OrganizationGovernancePreviewResponse { preview: OrganizationGovernancePreview; }
export interface OrganizationGovernancePublishResponse { snapshot: OrganizationGovernanceSnapshot; }
export interface OrganizationGovernancePublishInput extends OrganizationGovernanceTemplateDraft { expectedRevision: number; }

const ENDPOINT = "/api/authorization/organization-governance";

export function getOrganizationGovernance(): Promise<OrganizationGovernanceGetResponse> {
  return getJson<OrganizationGovernanceGetResponse>(ENDPOINT);
}

export function importOrganizationGovernance(
  input: { templateKey: string } | { source: string; fileName: string },
): Promise<OrganizationGovernanceImportResponse> {
  return postJson<OrganizationGovernanceImportResponse>(`${ENDPOINT}/import`, input);
}

export function previewOrganizationGovernance(
  draft: OrganizationGovernanceTemplateDraft,
): Promise<OrganizationGovernancePreviewResponse> {
  return postJson<OrganizationGovernancePreviewResponse>(`${ENDPOINT}/preview`, draft);
}

export function publishOrganizationGovernance(
  input: OrganizationGovernancePublishInput,
): Promise<OrganizationGovernancePublishResponse> {
  return postJson<OrganizationGovernancePublishResponse>(`${ENDPOINT}/publish`, input, { safetyConfirm: true });
}

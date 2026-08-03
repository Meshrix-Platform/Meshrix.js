import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "smol-toml";

export const ORGANIZATION_TEMPLATE_SCHEMA_VERSION: any =
  "v0.0.1:authorization:organization-template-1";
export const ORGANIZATION_GOVERNANCE_PROTOCOL_VERSION: any =
  "v0.0.1:authorization:organization-governance-1";
export const ORGANIZATION_GOVERNANCE_MAX_DEPTH: any = 32;
export const ORGANIZATION_GOVERNANCE_MAX_NODES: any = 2048;
export const ORGANIZATION_GOVERNANCE_MAX_SOURCE_BYTES: any = 256 * 1024;
export const ORGANIZATION_GOVERNANCE_MANAGEMENT_ACTIONS: readonly string[] = Object.freeze([
  "organization.structure.read",
  "organization.membership.read",
  "organization.membership.manage",
  "operation_permission.api_keys.manage"
]);

// Console-auth membership records use this stable identifier. It is not template state.
export const MESHRIX_ROOT_ORGANIZATION_ID: any = "meshrix-root";

const moduleDirectory: any = path.dirname(fileURLToPath(import.meta.url));
export const ORGANIZATION_TEMPLATE_CATALOG_DIRECTORY: any = path.resolve(
  moduleDirectory,
  "../../../config/organization-governance"
);
const IDENTIFIER: any = /^[a-z0-9][a-z0-9._:-]{0,159}$/u;
const NODE_TYPES: any = new Set<any>(["group", "organization", "department", "team"]);
const TAG_KINDS: any = new Set<any>(["organization", "group", "role", "custom"]);
const MANAGEMENT_ACTIONS: any = new Set<any>(ORGANIZATION_GOVERNANCE_MANAGEMENT_ACTIONS);
const DRAFT_KEYS: any = new Set<any>([
  "schemaVersion", "templateKey", "templateName", "description", "organizationDepth",
  "nodes", "tags", "roles"
]);
const NODE_KEYS: any = new Set<any>(["nodeId", "nodeType", "parentId", "name", "organizationLevel"]);
const TAG_KEYS: any = new Set<any>(["tagId", "kind", "label", "parentTagId", "description", "scopePrerequisites"]);
const ROLE_KEYS: any = new Set<any>([
  "roleId", "name", "scopeNodeId", "scopeNodeType", "managementActions",
  "businessResourceActions", "assignedSubjectIds"
]);
const LEGAL_CHILDREN: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  group: new Set<any>(["organization", "department", "team"]),
  organization: new Set<any>(["organization", "department", "team"]),
  department: new Set<any>(["team"]),
  team: new Set<any>()
});

export class OrganizationGovernanceError extends Error {
  code: string;
  statusCode: number;
  issues: readonly any[];
  currentRevision?: number;

  constructor(code: string, message: string, options: Record<string, any> = {}) {
    super(message);
    this.name = "OrganizationGovernanceError";
    this.code = code;
    this.statusCode = Number(options.statusCode || 400);
    this.issues = Object.freeze([...(options.issues || [])].slice(0, 64));
    if (Number.isInteger(options.currentRevision)) this.currentRevision = options.currentRevision;
  }
}

function problem(pathValue: string, code: string): any {
  return Object.freeze({ path: pathValue.slice(0, 256), code });
}

function invalid(issues: any[], message = "Organization governance template is invalid."): never {
  throw new OrganizationGovernanceError("organization_governance_invalid", message, {
    statusCode: 400,
    issues
  });
}

function unavailable(message = "Organization governance storage is unavailable."): never {
  throw new OrganizationGovernanceError("organization_governance_unavailable", message, { statusCode: 503 });
}

function record(value: any): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: any, pathValue: string, maximum: number, issues: any[]): string {
  if (typeof value !== "string") {
    issues.push(problem(pathValue, "string_required"));
    return "";
  }
  const normalized: any = value.trim().normalize("NFC");
  if (!normalized) issues.push(problem(pathValue, "string_empty"));
  if (normalized.length > maximum) issues.push(problem(pathValue, "string_too_long"));
  if (/\p{Cc}/u.test(normalized)) issues.push(problem(pathValue, "string_control_character"));
  return normalized.slice(0, maximum);
}

function identifier(value: any, pathValue: string, issues: any[]): string {
  const normalized: any = boundedText(value, pathValue, 160, issues);
  if (normalized && !IDENTIFIER.test(normalized)) issues.push(problem(pathValue, "identifier_invalid"));
  return normalized;
}

function exactKeys(value: Record<string, any>, allowed: Set<any>, prefix: string, issues: any[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(problem(prefix ? `${prefix}.${key}` : key, "unknown_field"));
  }
}

function stringList(value: any, pathValue: string, issues: any[], maximum = 64): string[] {
  if (!Array.isArray(value)) {
    issues.push(problem(pathValue, "array_required"));
    return [];
  }
  if (value.length > maximum) issues.push(problem(pathValue, "array_too_long"));
  const result: any[] = value.slice(0, maximum).map((entry?: any, index?: any) : any =>
    identifier(entry, `${pathValue}[${index}]`, issues));
  if (new Set<any>(result).size !== result.length) issues.push(problem(pathValue, "duplicate_value"));
  return result;
}

export function emptyOrganizationGovernanceSnapshot(): any {
  return Object.freeze({
    protocolVersion: ORGANIZATION_GOVERNANCE_PROTOCOL_VERSION,
    schemaVersion: ORGANIZATION_TEMPLATE_SCHEMA_VERSION,
    configured: false,
    revision: 0,
    templateKey: "",
    templateName: "",
    description: "",
    organizationDepth: 0,
    nodes: Object.freeze([]),
    tags: Object.freeze([]),
    roles: Object.freeze([]),
    publishedAt: ""
  });
}

export function normalizeOrganizationGovernanceDraft(input: Record<string, any> = {}): any {
  if (!record(input)) invalid([problem("$", "draft_object_required")]);
  const issues: any[] = [];
  exactKeys(input, DRAFT_KEYS, "", issues);
  if (input.schemaVersion !== ORGANIZATION_TEMPLATE_SCHEMA_VERSION) {
    issues.push(problem("schemaVersion", "schema_version_invalid"));
  }
  const templateKey: any = identifier(input.templateKey, "templateKey", issues);
  const templateName: any = boundedText(input.templateName, "templateName", 200, issues);
  const description: any = boundedText(input.description, "description", 1000, issues);
  if (!Array.isArray(input.nodes)) issues.push(problem("nodes", "array_required"));
  if (!Array.isArray(input.tags)) issues.push(problem("tags", "array_required"));
  if (!Array.isArray(input.roles)) issues.push(problem("roles", "array_required"));
  const nodeSources: any[] = Array.isArray(input.nodes) ? input.nodes : [];
  const tagSources: any[] = Array.isArray(input.tags) ? input.tags : [];
  const roleSources: any[] = Array.isArray(input.roles) ? input.roles : [];
  if (nodeSources.length > ORGANIZATION_GOVERNANCE_MAX_NODES) issues.push(problem("nodes", "node_count_out_of_bounds"));
  if (tagSources.length > ORGANIZATION_GOVERNANCE_MAX_NODES) issues.push(problem("tags", "tag_count_out_of_bounds"));
  if (roleSources.length > ORGANIZATION_GOVERNANCE_MAX_NODES) issues.push(problem("roles", "role_count_out_of_bounds"));

  const nodes: any[] = [];
  const nodesById: any = new Map<any, any>();
  for (const [index, source] of nodeSources.slice(0, ORGANIZATION_GOVERNANCE_MAX_NODES).entries()) {
    const prefix: any = `nodes[${index}]`;
    if (!record(source)) { issues.push(problem(prefix, "object_required")); continue; }
    exactKeys(source, NODE_KEYS, prefix, issues);
    const nodeId: any = identifier(source.nodeId, `${prefix}.nodeId`, issues);
    const nodeType: any = String(source.nodeType || "");
    const parentId: any = typeof source.parentId === "string" ? source.parentId.trim().normalize("NFC") : "";
    const name: any = boundedText(source.name, `${prefix}.name`, 200, issues);
    if (!NODE_TYPES.has(nodeType)) issues.push(problem(`${prefix}.nodeType`, "node_type_invalid"));
    if (source.parentId === undefined || typeof source.parentId !== "string") issues.push(problem(`${prefix}.parentId`, "string_required"));
    if (parentId && !IDENTIFIER.test(parentId)) issues.push(problem(`${prefix}.parentId`, "identifier_invalid"));
    if (nodesById.has(nodeId)) issues.push(problem(`${prefix}.nodeId`, "duplicate_node_id"));
    const node: any = { nodeId, nodeType, parentId, name, sourceIndex: index };
    nodes.push(node);
    if (nodeId && !nodesById.has(nodeId)) nodesById.set(nodeId, node);
  }
  const groups: any[] = nodes.filter((node?: any) : any => node.nodeType === "group");
  if (groups.length !== 1) issues.push(problem("nodes", "exactly_one_group_required"));
  const group: any = groups[0];
  if (group?.parentId) issues.push(problem(`nodes[${group.sourceIndex}].parentId`, "group_parent_must_be_empty"));
  const children: any = new Map<any, any[]>();
  for (const node of nodes) {
    if (node === group) continue;
    const parent: any = nodesById.get(node.parentId);
    if (!parent) { issues.push(problem(`nodes[${node.sourceIndex}].parentId`, "parent_not_found")); continue; }
    if (!LEGAL_CHILDREN[parent.nodeType]?.has(node.nodeType)) {
      issues.push(problem(`nodes[${node.sourceIndex}].parentId`, "illegal_parent"));
    }
    const siblings: any[] = children.get(parent.nodeId) || [];
    siblings.push(node);
    children.set(parent.nodeId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a?: any, b?: any) : any => a.nodeId.localeCompare(b.nodeId));
  const orderedNodes: any[] = [];
  const visited: any = new Set<any>();
  let organizationDepth: any = 0;
  if (group) {
    const stack: any[] = [{ node: group, depth: 0 }];
    while (stack.length) {
      const current: any = stack.pop();
      if (visited.has(current.node.nodeId)) { issues.push(problem("nodes", "cycle")); continue; }
      visited.add(current.node.nodeId);
      const depth: any = current.node.nodeType === "organization" ? current.depth + 1 : current.depth;
      organizationDepth = Math.max(organizationDepth, depth);
      orderedNodes.push(Object.freeze({
        nodeId: current.node.nodeId,
        nodeType: current.node.nodeType,
        parentId: current.node.parentId,
        name: current.node.name,
        ...(current.node.nodeType === "organization" ? { organizationLevel: depth } : {})
      }));
      const next: any[] = children.get(current.node.nodeId) || [];
      for (let index: any = next.length - 1; index >= 0; index -= 1) stack.push({ node: next[index], depth });
    }
  }
  if (visited.size !== nodes.length) issues.push(problem("nodes", "graph_disconnected_or_cyclic"));
  if (organizationDepth > ORGANIZATION_GOVERNANCE_MAX_DEPTH) issues.push(problem("nodes", "organization_depth_out_of_bounds"));
  if (input.organizationDepth !== undefined && input.organizationDepth !== organizationDepth) {
    issues.push(problem("organizationDepth", "organization_depth_mismatch"));
  }

  const tags: any[] = [];
  const tagsById: any = new Map<any, any>();
  for (const [index, source] of tagSources.slice(0, ORGANIZATION_GOVERNANCE_MAX_NODES).entries()) {
    const prefix: any = `tags[${index}]`;
    if (!record(source)) { issues.push(problem(prefix, "object_required")); continue; }
    exactKeys(source, TAG_KEYS, prefix, issues);
    const tagId: any = identifier(source.tagId, `${prefix}.tagId`, issues);
    const kind: any = String(source.kind || "");
    const parentTagId: any = typeof source.parentTagId === "string" ? source.parentTagId.trim().normalize("NFC") : "";
    if (!TAG_KINDS.has(kind)) issues.push(problem(`${prefix}.kind`, "tag_kind_invalid"));
    if (parentTagId && !IDENTIFIER.test(parentTagId)) issues.push(problem(`${prefix}.parentTagId`, "identifier_invalid"));
    if (tagsById.has(tagId)) issues.push(problem(`${prefix}.tagId`, "duplicate_tag_id"));
    const tag: any = Object.freeze({
      tagId,
      kind,
      label: boundedText(source.label, `${prefix}.label`, 200, issues),
      parentTagId,
      description: boundedText(source.description, `${prefix}.description`, 1000, issues),
      scopePrerequisites: stringList(source.scopePrerequisites, `${prefix}.scopePrerequisites`, issues)
    });
    tags.push(tag);
    if (tagId && !tagsById.has(tagId)) tagsById.set(tagId, tag);
  }
  for (const [index, tag] of tags.entries()) {
    if (tag.parentTagId && !tagsById.has(tag.parentTagId)) issues.push(problem(`tags[${index}].parentTagId`, "parent_tag_not_found"));
    const seen: any = new Set<any>([tag.tagId]);
    let cursor: any = tag;
    while (cursor.parentTagId) {
      cursor = tagsById.get(cursor.parentTagId);
      if (!cursor) break;
      if (seen.has(cursor.tagId)) { issues.push(problem(`tags[${index}].parentTagId`, "tag_cycle")); break; }
      seen.add(cursor.tagId);
    }
  }

  const roles: any[] = [];
  const roleIds: any = new Set<any>();
  for (const [index, source] of roleSources.slice(0, ORGANIZATION_GOVERNANCE_MAX_NODES).entries()) {
    const prefix: any = `roles[${index}]`;
    if (!record(source)) { issues.push(problem(prefix, "object_required")); continue; }
    exactKeys(source, ROLE_KEYS, prefix, issues);
    const roleId: any = identifier(source.roleId, `${prefix}.roleId`, issues);
    const scopeNodeId: any = identifier(source.scopeNodeId, `${prefix}.scopeNodeId`, issues);
    const scopeNode: any = nodesById.get(scopeNodeId);
    const managementActions: any[] = stringList(source.managementActions, `${prefix}.managementActions`, issues);
    if (roleIds.has(roleId)) issues.push(problem(`${prefix}.roleId`, "duplicate_role_id"));
    roleIds.add(roleId);
    if (tagsById.has(roleId) || tagsById.has(`role:${roleId}`)) {
      issues.push(problem(`${prefix}.roleId`, "tag_role_collision"));
    }
    if (!scopeNode) issues.push(problem(`${prefix}.scopeNodeId`, "scope_node_not_found"));
    if (!tagsById.has(scopeNodeId)) issues.push(problem(`${prefix}.scopeNodeId`, "scope_tag_not_found"));
    if (source.scopeNodeType !== undefined && source.scopeNodeType !== scopeNode?.nodeType) {
      issues.push(problem(`${prefix}.scopeNodeType`, "scope_node_type_mismatch"));
    }
    if (managementActions.some((action?: any) : any => !MANAGEMENT_ACTIONS.has(action))) {
      issues.push(problem(`${prefix}.managementActions`, "management_action_invalid"));
    }
    if (source.businessResourceActions !== undefined && (!Array.isArray(source.businessResourceActions) || source.businessResourceActions.length)) {
      issues.push(problem(`${prefix}.businessResourceActions`, "business_authority_forbidden"));
    }
    if (source.assignedSubjectIds !== undefined && (!Array.isArray(source.assignedSubjectIds) || source.assignedSubjectIds.length)) {
      issues.push(problem(`${prefix}.assignedSubjectIds`, "subject_assignment_forbidden"));
    }
    roles.push(Object.freeze({
      roleId,
      name: boundedText(source.name, `${prefix}.name`, 200, issues),
      scopeNodeId,
      scopeNodeType: scopeNode?.nodeType || "group",
      managementActions: Object.freeze(managementActions),
      businessResourceActions: Object.freeze([]),
      assignedSubjectIds: Object.freeze([])
    }));
  }
  if (issues.length) invalid(issues);
  return Object.freeze({
    schemaVersion: ORGANIZATION_TEMPLATE_SCHEMA_VERSION,
    templateKey,
    templateName,
    description,
    organizationDepth,
    nodes: Object.freeze(orderedNodes),
    tags: Object.freeze(tags),
    roles: Object.freeze(roles)
  });
}

function tomlToDraft(document: any): any {
  if (!record(document)) invalid([problem("$", "toml_document_required")]);
  const issues: any[] = [];
  const rootKeys: any = new Set<any>(["schema_version", "template", "nodes", "tags", "roles"]);
  exactKeys(document, rootKeys, "", issues);
  if (!record(document.template)) issues.push(problem("template", "object_required"));
  else exactKeys(document.template, new Set<any>(["key", "name", "description"]), "template", issues);
  const sourceCollections: any[] = [
    [document.nodes, new Set<any>(["id", "type", "parent", "name"]), "nodes"],
    [document.tags, new Set<any>(["id", "kind", "label", "parent", "description", "scope_prerequisites"]), "tags"],
    [document.roles, new Set<any>(["id", "name", "scope_node_id", "management_actions"]), "roles"]
  ];
  for (const [items, allowed, collectionName] of sourceCollections) {
    if (!Array.isArray(items)) {
      issues.push(problem(collectionName, "array_required"));
      continue;
    }
    for (const [index, item] of items.entries()) {
      if (!record(item)) issues.push(problem(`${collectionName}[${index}]`, "object_required"));
      else exactKeys(item, allowed, `${collectionName}[${index}]`, issues);
    }
  }
  const mapRecords: any = (items: any, kind: string) : any[] => (Array.isArray(items) ? items : []).map((item?: any) : any => {
    if (kind === "node") return {
      nodeId: item?.id, nodeType: item?.type, parentId: item?.parent, name: item?.name
    };
    if (kind === "tag") return {
      tagId: item?.id, kind: item?.kind, label: item?.label, parentTagId: item?.parent,
      description: item?.description, scopePrerequisites: item?.scope_prerequisites
    };
    return {
      roleId: item?.id, name: item?.name, scopeNodeId: item?.scope_node_id,
      managementActions: item?.management_actions
    };
  });
  if (issues.length) invalid(issues);
  return {
    schemaVersion: document.schema_version,
    templateKey: document.template?.key,
    templateName: document.template?.name,
    description: document.template?.description,
    nodes: mapRecords(document.nodes, "node"),
    tags: mapRecords(document.tags, "tag"),
    roles: mapRecords(document.roles, "role")
  };
}

export function importOrganizationGovernanceTemplate(source: any, fileName = "template.toml"): any {
  if (typeof source !== "string") invalid([problem("source", "string_required")]);
  if (!String(fileName).toLowerCase().endsWith(".toml")) invalid([problem("fileName", "toml_file_required")]);
  if (Buffer.byteLength(source, "utf8") > ORGANIZATION_GOVERNANCE_MAX_SOURCE_BYTES) {
    invalid([problem("source", "source_too_large")]);
  }
  if (source.includes("\u0000") || Buffer.from(source, "utf8").toString("utf8") !== source) {
    invalid([problem("source", "source_encoding_invalid")]);
  }
  try {
    return normalizeOrganizationGovernanceDraft(tomlToDraft(parse(source)));
  } catch (error: any) {
    if (error instanceof OrganizationGovernanceError) throw error;
    invalid([problem("source", "toml_invalid")]);
  }
}

export function loadOrganizationGovernanceCatalog(
  catalogDirectory: string = ORGANIZATION_TEMPLATE_CATALOG_DIRECTORY
): any {
  let names: string[];
  try {
    names = fs.readdirSync(catalogDirectory).filter((name?: any) : any => name.endsWith(".toml")).sort();
  } catch {
    unavailable("Organization governance template catalog is unavailable.");
  }
  const entries: any[] = names.map((name?: any) : any => {
    const draft: any = importOrganizationGovernanceTemplate(
      fs.readFileSync(path.join(catalogDirectory, name), "utf8"), name
    );
    return Object.freeze({
      templateKey: draft.templateKey,
      templateName: draft.templateName,
      description: draft.description,
      organizationDepth: draft.organizationDepth,
      nodeCount: draft.nodes.length,
      tagCount: draft.tags.length,
      roleCount: draft.roles.length,
      fileName: name
    });
  });
  if (new Set<any>(entries.map((entry?: any) : any => entry.templateKey)).size !== entries.length) {
    unavailable("Organization governance template catalog contains duplicate keys.");
  }
  return Object.freeze(entries);
}

export function createOrganizationGovernanceService({
  tagManagementStore,
  catalogDirectory = ORGANIZATION_TEMPLATE_CATALOG_DIRECTORY
}: Record<string, any> = {}): any {
  if (!tagManagementStore?.getOrganizationGovernance ||
      !tagManagementStore?.publishOrganizationGovernance) unavailable();
  const templates: any = loadOrganizationGovernanceCatalog(catalogDirectory);
  const summariesByKey: any = new Map<any, any>(templates.map((entry?: any) : any => [entry.templateKey, entry]));
  return Object.freeze({
    getOrganizationGovernance() : any { return tagManagementStore.getOrganizationGovernance(); },
    listOrganizationGovernanceTemplates() : any { return templates; },
    importOrganizationGovernance(input: Record<string, any> = {}) : any {
      if (!record(input)) invalid([problem("$", "import_object_required")]);
      const keys: any[] = Object.keys(input);
      const byKey: any = keys.length === 1 && typeof input.templateKey === "string";
      const byFile: any = keys.length === 2 && typeof input.source === "string" && typeof input.fileName === "string";
      if (!byKey && !byFile) invalid([problem("$", "exactly_one_import_source_required")]);
      if (byFile) return importOrganizationGovernanceTemplate(input.source, input.fileName);
      const summary: any = summariesByKey.get(input.templateKey);
      if (!summary) {
        throw new OrganizationGovernanceError("organization_governance_template_not_found", "Unknown organization template.", { statusCode: 404 });
      }
      return importOrganizationGovernanceTemplate(
        fs.readFileSync(path.join(catalogDirectory, summary.fileName), "utf8"), summary.fileName
      );
    },
    previewOrganizationGovernance(input: Record<string, any> = {}) : any {
      return normalizeOrganizationGovernanceDraft(input);
    },
    publishOrganizationGovernance(input: Record<string, any> = {}) : any {
      const expectedRevision: any = input?.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        invalid([problem("expectedRevision", "revision_invalid")]);
      }
      const { expectedRevision: _ignored, ...draft } = input;
      return tagManagementStore.publishOrganizationGovernance(
        normalizeOrganizationGovernanceDraft(draft), expectedRevision
      );
    }
  });
}

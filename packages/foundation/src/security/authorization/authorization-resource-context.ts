import { firstString, objectOrNull, stringsFrom, uniqueStrings } from "./authorization-engine-common.ts";

interface ResourceRecord extends Record<string, unknown> {
  metadata?: Record<string, unknown>;
}

interface ResourceResolutionInput {
  operation?: ResourceRecord;
  tool?: ResourceRecord | null;
  input?: ResourceRecord;
  context?: ResourceRecord;
}

function valueAtPath(source: ResourceRecord = {}, path: unknown = ""): unknown {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  const key = String(path || "").trim();
  if (!key) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    return source[key];
  }
  if (!key.includes(".")) {
    return undefined;
  }
  let current: unknown = source;
  for (const part of key.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function fieldMapAliases(key: unknown, ...resources: ResourceRecord[]): string[] {
  const values: unknown[] = [];
  for (const resource of resources) {
    const fieldMap = objectOrNull(resource.fieldMap) || {};
    values.push(fieldMap[String(key || "")]);
  }
  return stringsFrom(...values);
}

function mappedResourceValues({
  key,
  input = {},
  context = {},
  inputResource = {},
  contextResource = {},
  operationResource = {},
  operationResourceContext = {},
  toolResource = {},
  toolResourceContext = {}
}: {
  key?: unknown;
  input?: ResourceRecord;
  context?: ResourceRecord;
  inputResource?: ResourceRecord;
  contextResource?: ResourceRecord;
  operationResource?: ResourceRecord;
  operationResourceContext?: ResourceRecord;
  toolResource?: ResourceRecord;
  toolResourceContext?: ResourceRecord;
} = {}) {
  const aliases = fieldMapAliases(
    key,
    operationResourceContext,
    operationResource,
    toolResourceContext,
    toolResource
  );
  const values: unknown[] = [];
  for (const alias of aliases) {
    values.push(
      valueAtPath(input, alias),
      valueAtPath(inputResource, alias),
      valueAtPath(context, alias),
      valueAtPath(contextResource, alias)
    );
  }
  return values;
}

export function resolveResourceContext({ operation = {}, tool = null, input = {}, context = {} }: ResourceResolutionInput = {}) {
  const inputResource: ResourceRecord = {
    ...objectOrNull(input.resourceContext),
    ...objectOrNull(input.resource)
  };
  const contextResource: ResourceRecord = {
    ...objectOrNull(context.resourceContext),
    ...objectOrNull(context.resource)
  };
  const operationResource = objectOrNull(operation.resource) || {};
  const operationResourceContext = objectOrNull(operation.resourceContext) || {};
  const toolResource = objectOrNull(tool?.resource) || {};
  const toolResourceContext = objectOrNull(tool?.resourceContext) || {};
  const mapped = (key?: unknown) => mappedResourceValues({
    key,
    input,
    context,
    inputResource,
    contextResource,
    operationResource,
    operationResourceContext,
    toolResource,
    toolResourceContext
  });
  return {
    tenantId: firstString(
      input.tenantId,
      input["tenant-id"],
      inputResource.tenantId,
      inputResource["tenant-id"],
      ...mapped("tenantId"),
      context.tenantId,
      contextResource.tenantId,
      contextResource["tenant-id"],
      operationResource.tenantId,
      operationResourceContext.tenantId,
      toolResource.tenantId,
      toolResourceContext.tenantId
    ),
    workspaceId: firstString(
      input.workspaceId,
      input.workspace,
      input["workspace-id"],
      input.workspaceIds,
      input["workspace-ids"],
      input.allowedWorkspaceIds,
      input["allowed-workspace-ids"],
      input.metadata?.allowedWorkspaceIds,
      input.registryWorkspaceId,
      input["registry-workspace-id"],
      input.targetWorkspaceId,
      input["target-workspace-id"],
      input.parentWorkspaceId,
      input["parent-workspace-id"],
      inputResource.workspaceId,
      inputResource.workspace,
      inputResource["workspace-id"],
      inputResource.workspaceIds,
      inputResource["workspace-ids"],
      inputResource.allowedWorkspaceIds,
      inputResource["allowed-workspace-ids"],
      inputResource.registryWorkspaceId,
      inputResource["registry-workspace-id"],
      inputResource.targetWorkspaceId,
      inputResource["target-workspace-id"],
      inputResource.parentWorkspaceId,
      inputResource["parent-workspace-id"],
      ...mapped("workspaceId"),
      context.workspaceId,
      context.workspace,
      context["workspace-id"],
      context.workspaceIds,
      context["workspace-ids"],
      context.allowedWorkspaceIds,
      context["allowed-workspace-ids"],
      context.registryWorkspaceId,
      context["registry-workspace-id"],
      context.targetWorkspaceId,
      context["target-workspace-id"],
      context.parentWorkspaceId,
      context["parent-workspace-id"],
      contextResource.workspaceId,
      contextResource.workspace,
      contextResource["workspace-id"],
      contextResource.workspaceIds,
      contextResource["workspace-ids"],
      contextResource.allowedWorkspaceIds,
      contextResource["allowed-workspace-ids"],
      contextResource.registryWorkspaceId,
      contextResource["registry-workspace-id"],
      contextResource.targetWorkspaceId,
      contextResource["target-workspace-id"],
      contextResource.parentWorkspaceId,
      contextResource["parent-workspace-id"],
      operationResource.workspaceId,
      operationResourceContext.workspaceId,
      toolResource.workspaceId,
      toolResourceContext.workspaceId
    ),
    workspaceIds: stringsFrom(
      input.workspaceId,
      input.workspace,
      input["workspace-id"],
      input.workspaceIds,
      input["workspace-ids"],
      input.allowedWorkspaceIds,
      input["allowed-workspace-ids"],
      input.metadata?.allowedWorkspaceIds,
      input.registryWorkspaceId,
      input["registry-workspace-id"],
      input.targetWorkspaceId,
      input["target-workspace-id"],
      input.parentWorkspaceId,
      input["parent-workspace-id"],
      inputResource.workspaceId,
      inputResource.workspace,
      inputResource["workspace-id"],
      inputResource.workspaceIds,
      inputResource["workspace-ids"],
      inputResource.allowedWorkspaceIds,
      inputResource["allowed-workspace-ids"],
      inputResource.registryWorkspaceId,
      inputResource["registry-workspace-id"],
      inputResource.targetWorkspaceId,
      inputResource["target-workspace-id"],
      inputResource.parentWorkspaceId,
      inputResource["parent-workspace-id"],
      ...mapped("workspaceId"),
      context.workspaceId,
      context.workspace,
      context["workspace-id"],
      context.workspaceIds,
      context["workspace-ids"],
      context.allowedWorkspaceIds,
      context["allowed-workspace-ids"],
      context.registryWorkspaceId,
      context["registry-workspace-id"],
      context.targetWorkspaceId,
      context["target-workspace-id"],
      context.parentWorkspaceId,
      context["parent-workspace-id"],
      contextResource.workspaceId,
      contextResource.workspace,
      contextResource["workspace-id"],
      contextResource.workspaceIds,
      contextResource["workspace-ids"],
      contextResource.allowedWorkspaceIds,
      contextResource["allowed-workspace-ids"],
      contextResource.registryWorkspaceId,
      contextResource["registry-workspace-id"],
      contextResource.targetWorkspaceId,
      contextResource["target-workspace-id"],
      contextResource.parentWorkspaceId,
      contextResource["parent-workspace-id"],
      operationResource.workspaceId,
      operationResource.workspaceIds,
      operationResourceContext.workspaceId,
      operationResourceContext.workspaceIds,
      toolResource.workspaceId,
      toolResource.workspaceIds,
      toolResourceContext.workspaceId,
      toolResourceContext.workspaceIds
    ),
    accountId: firstString(
      input.accountId,
      input.account,
      input["account-id"],
      inputResource.accountId,
      inputResource.account,
      inputResource["account-id"],
      ...mapped("accountId"),
      context.accountId,
      context.account,
      context["account-id"],
      contextResource.accountId,
      contextResource.account,
      contextResource["account-id"],
      operationResource.accountId,
      operationResourceContext.accountId,
      toolResource.accountId,
      toolResourceContext.accountId
    ),
    endpointId: firstString(
      input.endpointId,
      input.endpoint,
      input["endpoint-id"],
      inputResource.endpointId,
      inputResource.endpoint,
      inputResource["endpoint-id"],
      ...mapped("endpointId"),
      context.endpointId,
      context.endpoint,
      context["endpoint-id"],
      contextResource.endpointId,
      contextResource.endpoint,
      contextResource["endpoint-id"],
      operationResource.endpointId,
      operationResourceContext.endpointId,
      toolResource.endpointId,
      toolResourceContext.endpointId
    ),
    opaqueMailboxId: firstString(
      input.opaqueMailboxId,
      input.mailboxId,
      input.mailbox,
      input["opaque-mailbox-id"],
      input["mailbox-id"],
      inputResource.opaqueMailboxId,
      inputResource.mailboxId,
      inputResource.mailbox,
      inputResource["opaque-mailbox-id"],
      inputResource["mailbox-id"],
      ...mapped("opaqueMailboxId"),
      context.opaqueMailboxId,
      context.mailboxId,
      context.mailbox,
      context["opaque-mailbox-id"],
      context["mailbox-id"],
      contextResource.opaqueMailboxId,
      contextResource.mailboxId,
      contextResource.mailbox,
      contextResource["opaque-mailbox-id"],
      contextResource["mailbox-id"],
      operationResource.opaqueMailboxId,
      operationResourceContext.opaqueMailboxId,
      toolResource.opaqueMailboxId,
      toolResourceContext.opaqueMailboxId
    ),
    accountBoundaryRequired: Boolean(
      input.accountBoundaryRequired ||
      inputResource.accountBoundaryRequired ||
      context.accountBoundaryRequired ||
      contextResource.accountBoundaryRequired ||
      operationResource.accountBoundaryRequired ||
      operationResourceContext.accountBoundaryRequired ||
      toolResource.accountBoundaryRequired ||
      toolResourceContext.accountBoundaryRequired
    ),
    endpointBoundaryRequired: Boolean(
      input.endpointBoundaryRequired ||
      inputResource.endpointBoundaryRequired ||
      context.endpointBoundaryRequired ||
      contextResource.endpointBoundaryRequired ||
      operationResource.endpointBoundaryRequired ||
      operationResourceContext.endpointBoundaryRequired ||
      toolResource.endpointBoundaryRequired ||
      toolResourceContext.endpointBoundaryRequired
    ),
    mailboxBoundaryRequired: Boolean(
      input.mailboxBoundaryRequired ||
      inputResource.mailboxBoundaryRequired ||
      context.mailboxBoundaryRequired ||
      contextResource.mailboxBoundaryRequired ||
      operationResource.mailboxBoundaryRequired ||
      operationResourceContext.mailboxBoundaryRequired ||
      toolResource.mailboxBoundaryRequired ||
      toolResourceContext.mailboxBoundaryRequired
    ),
    dataClass: firstString(
      input.dataClass,
      input["data-class"],
      input.allowedDataClasses,
      input["allowed-data-classes"],
      input.metadata?.allowedDataClasses,
      inputResource.dataClass,
      inputResource["data-class"],
      inputResource.allowedDataClasses,
      inputResource["allowed-data-classes"],
      ...mapped("dataClass"),
      context.dataClass,
      context["data-class"],
      context.allowedDataClasses,
      context["allowed-data-classes"],
      contextResource.dataClass,
      contextResource["data-class"],
      contextResource.allowedDataClasses,
      contextResource["allowed-data-classes"],
      operationResource.dataClass,
      operationResourceContext.dataClass,
      toolResource.dataClass,
      toolResourceContext.dataClass
    ),
    requestedEgress: firstString(
      input.requestedEgress,
      input["requested-egress"],
      input.requestedEgresses,
      input["requested-egresses"],
      input.allowedEgress,
      input["allowed-egress"],
      input.metadata?.allowedEgress,
      inputResource.requestedEgress,
      inputResource["requested-egress"],
      inputResource.requestedEgresses,
      inputResource["requested-egresses"],
      inputResource.allowedEgress,
      inputResource["allowed-egress"],
      ...mapped("requestedEgress"),
      context.requestedEgress,
      context["requested-egress"],
      context.requestedEgresses,
      context["requested-egresses"],
      context.allowedEgress,
      context["allowed-egress"],
      contextResource.requestedEgress,
      contextResource["requested-egress"],
      contextResource.requestedEgresses,
      contextResource["requested-egresses"],
      contextResource.allowedEgress,
      contextResource["allowed-egress"],
      operationResource.requestedEgress,
      operationResourceContext.requestedEgress,
      toolResource.requestedEgress,
      toolResourceContext.requestedEgress
    ),
    requestedEgresses: stringsFrom(
      input.requestedEgress,
      input["requested-egress"],
      input.requestedEgresses,
      input["requested-egresses"],
      input.allowedEgress,
      input["allowed-egress"],
      input.metadata?.allowedEgress,
      inputResource.requestedEgress,
      inputResource["requested-egress"],
      inputResource.requestedEgresses,
      inputResource["requested-egresses"],
      inputResource.allowedEgress,
      inputResource["allowed-egress"],
      ...mapped("requestedEgress"),
      context.requestedEgress,
      context["requested-egress"],
      context.requestedEgresses,
      context["requested-egresses"],
      context.allowedEgress,
      context["allowed-egress"],
      contextResource.requestedEgress,
      contextResource["requested-egress"],
      contextResource.requestedEgresses,
      contextResource["requested-egresses"],
      contextResource.allowedEgress,
      contextResource["allowed-egress"],
      operationResource.requestedEgress,
      operationResource.requestedEgresses,
      operationResourceContext.requestedEgress,
      operationResourceContext.requestedEgresses,
      toolResource.requestedEgress,
      toolResource.requestedEgresses,
      toolResourceContext.requestedEgress,
      toolResourceContext.requestedEgresses
    ),
    serviceId: firstString(
      input.serviceId,
      input["service-id"],
      input.serviceIds,
      input["service-ids"],
      input.allowedServiceIds,
      input["allowed-service-ids"],
      input.metadata?.allowedServiceIds,
      input.upstreamId,
      input["upstream-id"],
      inputResource.serviceId,
      inputResource["service-id"],
      inputResource.serviceIds,
      inputResource["service-ids"],
      inputResource.allowedServiceIds,
      inputResource["allowed-service-ids"],
      inputResource.upstreamId,
      inputResource["upstream-id"],
      ...mapped("serviceId"),
      context.serviceId,
      context["service-id"],
      context.serviceIds,
      context["service-ids"],
      context.allowedServiceIds,
      context["allowed-service-ids"],
      context.upstreamId,
      context["upstream-id"],
      contextResource.serviceId,
      contextResource["service-id"],
      contextResource.serviceIds,
      contextResource["service-ids"],
      contextResource.allowedServiceIds,
      contextResource["allowed-service-ids"],
      contextResource.upstreamId,
      contextResource["upstream-id"],
      operationResource.serviceId,
      operationResourceContext.serviceId,
      toolResource.serviceId,
      toolResourceContext.serviceId
    ),
    serviceIds: stringsFrom(
      input.serviceId,
      input["service-id"],
      input.serviceIds,
      input["service-ids"],
      input.allowedServiceIds,
      input["allowed-service-ids"],
      input.metadata?.allowedServiceIds,
      input.upstreamId,
      input["upstream-id"],
      inputResource.serviceId,
      inputResource["service-id"],
      inputResource.serviceIds,
      inputResource["service-ids"],
      inputResource.allowedServiceIds,
      inputResource["allowed-service-ids"],
      inputResource.upstreamId,
      inputResource["upstream-id"],
      ...mapped("serviceId"),
      context.serviceId,
      context["service-id"],
      context.serviceIds,
      context["service-ids"],
      context.allowedServiceIds,
      context["allowed-service-ids"],
      context.upstreamId,
      context["upstream-id"],
      contextResource.serviceId,
      contextResource["service-id"],
      contextResource.serviceIds,
      contextResource["service-ids"],
      contextResource.allowedServiceIds,
      contextResource["allowed-service-ids"],
      contextResource.upstreamId,
      contextResource["upstream-id"],
      operationResource.serviceId,
      operationResource.serviceIds,
      operationResourceContext.serviceId,
      operationResourceContext.serviceIds,
      toolResource.serviceId,
      toolResource.serviceIds,
      toolResourceContext.serviceId,
      toolResourceContext.serviceIds
    ),
    secretBindingId: firstString(
      input.secretBindingId,
      input["secret-binding-id"],
      input.secretBindingIds,
      input["secret-binding-ids"],
      input.allowedSecretBindings,
      input["allowed-secret-bindings"],
      input.metadata?.allowedSecretBindings,
      input.authBindingId,
      input["auth-binding-id"],
      input.bindingId,
      input["binding-id"],
      input.credentialRef,
      input.credentialRefs,
      input.secretRef,
      input.secretRefs,
      inputResource.secretBindingId,
      inputResource["secret-binding-id"],
      inputResource.secretBindingIds,
      inputResource["secret-binding-ids"],
      inputResource.allowedSecretBindings,
      inputResource["allowed-secret-bindings"],
      inputResource.authBindingId,
      inputResource["auth-binding-id"],
      inputResource.bindingId,
      inputResource["binding-id"],
      inputResource.credentialRef,
      inputResource.credentialRefs,
      inputResource.secretRef,
      inputResource.secretRefs,
      ...mapped("secretBindingId"),
      context.secretBindingId,
      context["secret-binding-id"],
      context.secretBindingIds,
      context["secret-binding-ids"],
      context.allowedSecretBindings,
      context["allowed-secret-bindings"],
      context.authBindingId,
      context["auth-binding-id"],
      context.bindingId,
      context["binding-id"],
      context.credentialRef,
      context.credentialRefs,
      context.secretRef,
      context.secretRefs,
      contextResource.secretBindingId,
      contextResource["secret-binding-id"],
      contextResource.secretBindingIds,
      contextResource["secret-binding-ids"],
      contextResource.allowedSecretBindings,
      contextResource["allowed-secret-bindings"],
      contextResource.authBindingId,
      contextResource["auth-binding-id"],
      contextResource.bindingId,
      contextResource["binding-id"],
      contextResource.credentialRef,
      contextResource.credentialRefs,
      contextResource.secretRef,
      contextResource.secretRefs,
      operationResource.secretBindingId,
      operationResource.secretBindingIds,
      operationResource.authBindingId,
      operationResource.bindingId,
      operationResourceContext.secretBindingId,
      operationResourceContext.secretBindingIds,
      operationResourceContext.authBindingId,
      operationResourceContext.bindingId,
      toolResource.secretBindingId,
      toolResource.secretBindingIds,
      toolResource.authBindingId,
      toolResource.bindingId,
      toolResourceContext.secretBindingId,
      toolResourceContext.secretBindingIds,
      toolResourceContext.authBindingId,
      toolResourceContext.bindingId
    ),
    secretBindingIds: stringsFrom(
      input.secretBindingId,
      input["secret-binding-id"],
      input.secretBindingIds,
      input["secret-binding-ids"],
      input.allowedSecretBindings,
      input["allowed-secret-bindings"],
      input.metadata?.allowedSecretBindings,
      input.authBindingId,
      input["auth-binding-id"],
      input.bindingId,
      input["binding-id"],
      input.credentialRef,
      input.credentialRefs,
      input.secretRef,
      input.secretRefs,
      inputResource.secretBindingId,
      inputResource["secret-binding-id"],
      inputResource.secretBindingIds,
      inputResource["secret-binding-ids"],
      inputResource.allowedSecretBindings,
      inputResource["allowed-secret-bindings"],
      inputResource.authBindingId,
      inputResource["auth-binding-id"],
      inputResource.bindingId,
      inputResource["binding-id"],
      inputResource.credentialRef,
      inputResource.credentialRefs,
      inputResource.secretRef,
      inputResource.secretRefs,
      ...mapped("secretBindingId"),
      context.secretBindingId,
      context["secret-binding-id"],
      context.secretBindingIds,
      context["secret-binding-ids"],
      context.allowedSecretBindings,
      context["allowed-secret-bindings"],
      context.authBindingId,
      context["auth-binding-id"],
      context.bindingId,
      context["binding-id"],
      context.credentialRef,
      context.credentialRefs,
      context.secretRef,
      context.secretRefs,
      contextResource.secretBindingId,
      contextResource["secret-binding-id"],
      contextResource.secretBindingIds,
      contextResource["secret-binding-ids"],
      contextResource.allowedSecretBindings,
      contextResource["allowed-secret-bindings"],
      contextResource.authBindingId,
      contextResource["auth-binding-id"],
      contextResource.bindingId,
      contextResource["binding-id"],
      contextResource.credentialRef,
      contextResource.credentialRefs,
      contextResource.secretRef,
      contextResource.secretRefs,
      operationResource.secretBindingId,
      operationResource.secretBindingIds,
      operationResource.authBindingId,
      operationResource.bindingId,
      operationResourceContext.secretBindingId,
      operationResourceContext.secretBindingIds,
      operationResourceContext.authBindingId,
      operationResourceContext.bindingId,
      toolResource.secretBindingId,
      toolResource.secretBindingIds,
      toolResource.authBindingId,
      toolResource.bindingId,
      toolResourceContext.secretBindingId,
      toolResourceContext.secretBindingIds,
      toolResourceContext.authBindingId,
      toolResourceContext.bindingId
    ),
    staticSemanticFamilyId: firstString(
      input.staticSemanticFamilyId,
      input["static-semantic-family-id"],
      input.familyId,
      input["family-id"],
      inputResource.staticSemanticFamilyId,
      inputResource["static-semantic-family-id"],
      inputResource.familyId,
      inputResource["family-id"],
      ...mapped("staticSemanticFamilyId"),
      context.staticSemanticFamilyId,
      context["static-semantic-family-id"],
      context.familyId,
      context["family-id"],
      contextResource.staticSemanticFamilyId,
      contextResource["static-semantic-family-id"],
      contextResource.familyId,
      contextResource["family-id"],
      operationResource.staticSemanticFamilyId,
      operationResourceContext.staticSemanticFamilyId,
      toolResource.staticSemanticFamilyId,
      toolResourceContext.staticSemanticFamilyId
    ),
    capabilityDomain: firstString(
      input.capabilityDomain,
      input["capability-domain"],
      inputResource.capabilityDomain,
      inputResource["capability-domain"],
      ...mapped("capabilityDomain"),
      context.capabilityDomain,
      context["capability-domain"],
      contextResource.capabilityDomain,
      contextResource["capability-domain"],
      operationResource.capabilityDomain,
      operationResourceContext.capabilityDomain,
      toolResource.capabilityDomain,
      toolResourceContext.capabilityDomain
    ),
    capabilityVerb: firstString(
      input.capabilityVerb,
      input["capability-verb"],
      inputResource.capabilityVerb,
      inputResource["capability-verb"],
      ...mapped("capabilityVerb"),
      context.capabilityVerb,
      context["capability-verb"],
      contextResource.capabilityVerb,
      contextResource["capability-verb"],
      operationResource.capabilityVerb,
      operationResourceContext.capabilityVerb,
      toolResource.capabilityVerb,
      toolResourceContext.capabilityVerb
    ),
    resourceKind: firstString(
      input.resourceKind,
      input["resource-kind"],
      inputResource.resourceKind,
      inputResource["resource-kind"],
      ...mapped("resourceKind"),
      context.resourceKind,
      context["resource-kind"],
      contextResource.resourceKind,
      contextResource["resource-kind"],
      operationResource.resourceKind,
      operationResourceContext.resourceKind,
      toolResource.resourceKind,
      toolResourceContext.resourceKind
    ),
    effectKind: firstString(
      input.effectKind,
      input["effect-kind"],
      inputResource.effectKind,
      inputResource["effect-kind"],
      ...mapped("effectKind"),
      context.effectKind,
      context["effect-kind"],
      contextResource.effectKind,
      contextResource["effect-kind"],
      operationResource.effectKind,
      operationResourceContext.effectKind,
      toolResource.effectKind,
      toolResourceContext.effectKind
    ),
    dataClasses: uniqueStrings([
      ...stringsFrom(
        input.dataClasses,
        input["data-classes"],
        input.allowedDataClasses,
        input["allowed-data-classes"],
        input.metadata?.allowedDataClasses,
        inputResource.dataClasses,
        inputResource["data-classes"],
        inputResource.allowedDataClasses,
        inputResource["allowed-data-classes"],
        mapped("dataClasses"),
        context.dataClasses,
        context["data-classes"],
        context.allowedDataClasses,
        context["allowed-data-classes"],
        contextResource.dataClasses,
        contextResource["data-classes"],
        contextResource.allowedDataClasses,
        contextResource["allowed-data-classes"],
        operationResource.dataClasses,
        operationResourceContext.dataClasses,
        toolResource.dataClasses,
        toolResourceContext.dataClasses
      )
    ])
  };
}

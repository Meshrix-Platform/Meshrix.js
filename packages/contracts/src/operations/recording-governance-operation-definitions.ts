/**
 * Recording governance console operations: tenant-scoped administration of the
 * organization-controlled RecordingPolicy and the enterprise-local recording
 * sink. These operations expose policy selection, sink health and revision
 * publication; they never carry recorded content and never mint decryption
 * authority — key custody stays with the organization at its own boundary.
 */
import {
  protocolOperation,
  schema
} from "./protocol-operation-builders.ts";

const TENANT_ID_PROPERTY: any = {
  type: "string",
  pattern: "^[a-zA-Z0-9._:-]{1,120}$"
};

const OPAQUE_ID_PROPERTY: any = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$"
};

const STRING_LIST_PROPERTY: any = {
  type: "array",
  maxItems: 64,
  items: OPAQUE_ID_PROPERTY
};

const RETENTION_SCHEMA: any = schema(["maxAgeSeconds", "maxRecords", "maxContentBytes", "maxIndexBytes"], {
  maxAgeSeconds: { type: "integer", minimum: 1, maximum: 31_536_000 },
  maxRecords: { type: "integer", minimum: 1, maximum: 1_000_000 },
  maxContentBytes: { type: "integer", minimum: 0, maximum: 1_073_741_824 },
  maxIndexBytes: { type: "integer", minimum: 1, maximum: 1_073_741_824 }
});

const CAPACITY_SCHEMA: any = schema(["maxBufferedRecords", "maxRecordBytes"], {
  maxBufferedRecords: { type: "integer", minimum: 1, maximum: 65_536 },
  maxRecordBytes: { type: "integer", minimum: 1, maximum: 262_144 }
});

const CATEGORY_SELECTION_SCHEMA: any = schema(
  ["obligation", "sinkRef", "fieldAllow", "fieldRedact", "eventAllow", "readerRoles", "configurerRoles", "retention", "capacity"],
  {
    obligation: { type: "string", enum: ["optional", "required_before_effect"] },
    sinkRef: OPAQUE_ID_PROPERTY,
    fieldAllow: STRING_LIST_PROPERTY,
    fieldRedact: STRING_LIST_PROPERTY,
    eventAllow: STRING_LIST_PROPERTY,
    readerRoles: { type: "array", minItems: 1, maxItems: 16, items: OPAQUE_ID_PROPERTY },
    configurerRoles: { type: "array", minItems: 1, maxItems: 16, items: OPAQUE_ID_PROPERTY },
    retention: RETENTION_SCHEMA,
    capacity: CAPACITY_SCHEMA
  }
);

const RECORDING_POLICY_SCHEMA: any = schema(
  ["schemaVersion", "kind", "policyId", "policyRevision", "issuedAt", "issuerRole", "configurerRoles", "categories"],
  {
    schemaVersion: { type: "string", const: "v0.0.1:recording:policy-1" },
    kind: { type: "string", const: "recording-policy" },
    policyId: OPAQUE_ID_PROPERTY,
    policyRevision: { type: "integer", minimum: 1 },
    issuedAt: { type: "string", maxLength: 64 },
    issuerRole: OPAQUE_ID_PROPERTY,
    configurerRoles: { type: "array", minItems: 1, maxItems: 16, items: OPAQUE_ID_PROPERTY },
    categories: {
      type: "object",
      maxProperties: 16,
      additionalProperties: CATEGORY_SELECTION_SCHEMA
    }
  }
);

export const RECORDING_GOVERNANCE_OPERATION_DEFINITIONS: readonly any[] = Object.freeze([
  protocolOperation({
    id: "recording_governance.policy.get",
    feature: "recording_governance",
    label: "读取录制策略",
    description: "Read the tenant's published recording policy with sink custody and pending-obligation truth.",
    targetMethod: "handleRecordingGovernancePolicyGet",
    method: "GET",
    path: "/api/recording-governance/v1/policy",
    query: [
      { name: "tenantId", aliases: ["tenant-id", "tenantId"] }
    ],
    scopes: ["recording:read"],
    readOnly: true,
    inputSchema: schema([], {
      tenantId: TENANT_ID_PROPERTY
    }),
    aspects: ["recording-governance", "security-authorization"]
  }),
  protocolOperation({
    id: "recording_governance.sink.health",
    feature: "recording_governance",
    label: "录制汇集健康",
    description: "Report enterprise-local recording sink availability, capacity budgets and journal integrity.",
    targetMethod: "handleRecordingGovernanceSinkHealth",
    method: "GET",
    path: "/api/recording-governance/v1/sink/health",
    query: [
      { name: "tenantId", aliases: ["tenant-id", "tenantId"] },
      { name: "integrity", aliases: ["integrity"] }
    ],
    coerce: { integrity: "boolean" },
    scopes: ["recording:read"],
    readOnly: true,
    inputSchema: schema([], {
      tenantId: TENANT_ID_PROPERTY,
      integrity: { type: "boolean" }
    }),
    aspects: ["recording-governance", "security-authorization"]
  }),
  protocolOperation({
    id: "recording_governance.policy.publish",
    feature: "recording_governance",
    label: "发布录制策略修订",
    description: "Publish a strictly advanced recording policy revision under the caller's configurer role.",
    targetMethod: "handleRecordingGovernancePolicyPublish",
    method: "POST",
    path: "/api/recording-governance/v1/policy",
    scopes: ["recording:admin"],
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "recording:admin",
    inputSchema: schema(["expectedRevision", "policy"], {
      expectedRevision: { type: "integer", minimum: 1 },
      tenantId: TENANT_ID_PROPERTY,
      policy: RECORDING_POLICY_SCHEMA
    }),
    aspects: ["recording-governance", "security-authorization"]
  })
]);

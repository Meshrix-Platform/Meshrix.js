import { getJson, postJson } from "@meshrix/ui-console/bridge-http";

export type RecordingCategorySelection = {
  obligation: "optional" | "required_before_effect";
  sinkRef: string;
  fieldAllow: string[];
  fieldRedact: string[];
  eventAllow: string[];
  readerRoles: string[];
  configurerRoles: string[];
  retention: {
    maxAgeSeconds: number;
    maxRecords: number;
    maxContentBytes: number;
    maxIndexBytes: number;
  };
  capacity: {
    maxBufferedRecords: number;
    maxRecordBytes: number;
  };
};

export type RecordingPolicy = {
  schemaVersion: string;
  kind: string;
  policyId: string;
  policyRevision: number;
  issuedAt: string;
  issuerRole: string;
  configurerRoles: string[];
  categories: Record<string, RecordingCategorySelection>;
};

export type RecordingSinkDescriptor = {
  sinkId: string;
  custody: string;
  durable: boolean;
  budgets: {
    maxRecordBytes: number;
    maxContentBytes: number;
    maxIndexBytes: number;
    maxBufferedRecords: number;
    maxPendingWrites: number;
  };
};

export type RecordingSinkState = {
  sinkRef: string;
  available: boolean;
  bufferedRecords: number;
  pendingWrites: number;
  contentBytesRemaining: number;
  indexBytesRemaining: number;
};

export type RecordingPendingObligation = {
  operationRef: string;
  category: string;
  obligation: string;
  policyRevision: number;
  reason: string;
  createdAt: string;
};

export type RecordingAuthority = {
  custody: string;
  durable: boolean;
  decryptionAuthority: string;
  decryptionAuthorityNote: string;
};

export type RecordingGovernanceSnapshot = {
  tenantId: string;
  sink: RecordingSinkDescriptor;
  authority: RecordingAuthority;
  policy: RecordingPolicy;
  sinkState: RecordingSinkState;
  pendingObligations: RecordingPendingObligation[];
};

export type RecordingGovernanceSnapshotResponse = {
  snapshot: RecordingGovernanceSnapshot;
};

export type RecordingSinkIntegrity = {
  intact?: boolean;
  journalEntries?: number;
  recordsChecked?: number;
  artifactsChecked?: number;
  divergences?: string[];
  error?: string;
};

export type RecordingSinkHealth = {
  tenantId: string;
  sink: RecordingSinkDescriptor;
  authority: RecordingAuthority;
  state: RecordingSinkState;
  policyRevision: number;
  integrity?: RecordingSinkIntegrity;
};

export type RecordingSinkHealthResponse = {
  health: RecordingSinkHealth;
};

export type RecordingPolicyPublishResponse = {
  published: {
    tenantId: string;
    policy: RecordingPolicy;
    sinkState: RecordingSinkState;
    pendingObligations: RecordingPendingObligation[];
  };
};

export function getRecordingGovernanceSnapshot(): Promise<RecordingGovernanceSnapshotResponse> {
  return getJson<RecordingGovernanceSnapshotResponse>("/api/recording-governance/v1/policy");
}

export function getRecordingSinkHealth(integrity = false): Promise<RecordingSinkHealthResponse> {
  const query = integrity ? "?integrity=true" : "";
  return getJson<RecordingSinkHealthResponse>(`/api/recording-governance/v1/sink/health${query}`);
}

export function publishRecordingPolicy(input: {
  expectedRevision: number;
  policy: RecordingPolicy;
}): Promise<RecordingPolicyPublishResponse> {
  return postJson<RecordingPolicyPublishResponse>("/api/recording-governance/v1/policy", input, {
    safetyConfirm: true,
  });
}

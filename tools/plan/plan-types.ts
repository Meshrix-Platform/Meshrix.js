export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonRecord;
export interface JsonRecord { [key: string]: JsonValue | undefined }

export type PlanProfile = "enterprise-single-node";
export type CheckpointStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";
export type CheckpointPlatform = "any" | "macos" | "windows" | "linux";

export interface ManifestPlan extends JsonRecord {
  directory: string;
  checkpoints: string;
  status?: string;
  source_files?: string[];
}

export interface FinalValidationBinding extends JsonRecord {
  node_id: string;
  profiles: readonly PlanProfile[];
}

export interface ParentIntegrationBinding extends JsonRecord {
  child_final_node_id: string;
  parent_node_id: string;
  profiles: readonly PlanProfile[];
}

export interface PrerequisiteReceiptBinding extends JsonRecord {
  plan: string;
  node_id: string;
  kind: "contract" | "final_validation";
  profiles: readonly PlanProfile[];
}

export interface DependencyMapPlan extends JsonRecord {
  directory: string;
  parent: string | null;
  children: string[];
  final_validations: FinalValidationBinding[];
  parent_integrations: ParentIntegrationBinding[];
  prerequisite_receipts: PrerequisiteReceiptBinding[];
  accepted_final_receipts: Record<string, JsonRecord | null>;
  parent_contract_node_id?: string | null;
}

export interface DependencyMap extends JsonRecord {
  schema_version: number;
  plans: DependencyMapPlan[];
}

export interface CheckpointCommit extends JsonRecord {
  repository: string;
  message?: string;
  delivered?: string;
}

export interface AcceptanceCriterion extends JsonRecord {
  checked: boolean;
  text: string;
  evidence_refs: JsonRecord[];
}

export interface FinalCheckpointNode extends CheckpointNode {
  role: "final_validation";
  status: "completed";
  candidate_digest: string;
  requirements: string[];
  acceptance_criteria: AcceptanceCriterion[];
  commit: CheckpointCommit & { delivered: string };
}

export interface CheckpointRegression extends JsonRecord {
  mode?: string;
  scope?: "focused" | "full";
  paths?: string[];
  commands?: string[];
  criteria?: number[];
}

export interface CheckpointNode extends JsonRecord {
  id: string;
  title?: string;
  goal?: string;
  description?: string;
  status: CheckpointStatus;
  role: string;
  platform: CheckpointPlatform;
  prerequisites: string[];
  next: string[];
  commit: CheckpointCommit;
  regression?: CheckpointRegression;
  acceptance?: string;
  acceptance_criteria?: AcceptanceCriterion[];
}

export interface PlanFinalReceipt extends JsonRecord {
  schema_version: string;
  kind?: string;
  plan: string;
  final_node_id: string;
  node_id?: string;
  parent_contract_node_id: string | null;
  parent_integration_node_id: string | null;
  status: string;
  role: string;
  platform: string;
  profiles: readonly PlanProfile[];
  privacy_safe: boolean;
  receipt_digest: string;
  checkpoint_digest: string;
  candidate_digest: string;
  evidence_set_digest: string;
  prerequisite_receipt_set_digest: string;
  command_dag_digest: string;
  owned_reports_inventory_digest: string;
  repository_revision: string;
  repository_tree_digest: string;
  source_revision: string;
  requirements: string[];
  evidence_refs: JsonRecord[];
  prerequisite_receipts: JsonRecord[];
  proof_anchor?: PlanReceiptProofAnchor | null;
}

export interface PlanReceiptProofAnchor extends JsonRecord {
  provider: string;
  verified: boolean;
  receipt_digest: string;
  ledger_event_id: string;
  envelope_id: string;
  fact_id?: string;
}

export type CheckpointsByDirectory = Map<string, CheckpointNode[]> | Record<string, CheckpointNode[]>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function isCheckpointStatus(value: unknown): value is CheckpointStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "blocked" || value === "skipped";
}

export function isCheckpointPlatform(value: unknown): value is CheckpointPlatform {
  return value === "any" || value === "macos" || value === "windows" || value === "linux";
}

export function isCheckpointNode(value: unknown): value is CheckpointNode {
  return isJsonRecord(value) &&
    typeof value.id === "string" &&
    isCheckpointStatus(value.status) &&
    typeof value.role === "string" &&
    isCheckpointPlatform(value.platform) &&
    isStringArray(value.prerequisites) &&
    isStringArray(value.next) &&
    isJsonRecord(value.commit) &&
    typeof value.commit.repository === "string";
}

export function isFinalCheckpointNode(value: unknown): value is FinalCheckpointNode {
  return isCheckpointNode(value) &&
    value.role === "final_validation" &&
    value.status === "completed" &&
    typeof value.candidate_digest === "string" &&
    isStringArray(value.requirements) &&
    Array.isArray(value.acceptance_criteria) &&
    value.acceptance_criteria.every((criterion) =>
      isJsonRecord(criterion) &&
      typeof criterion.checked === "boolean" &&
      typeof criterion.text === "string" &&
      Array.isArray(criterion.evidence_refs)
    ) &&
    typeof value.commit.delivered === "string";
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonRecord(value) && Object.values(value).every(isJsonValue);
}

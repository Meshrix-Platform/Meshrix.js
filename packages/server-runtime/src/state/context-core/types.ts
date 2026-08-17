export type RuntimeRecord = Record<string, unknown>;

export interface BudgetPolicy {
  fixedMemoryRatio: number;
  operatorGuidanceRatio: number;
  referenceRatio: number;
  historyRatio: number;
  recentTurnRatio: number;
  toolStateRatio: number;
}

export interface RankingWeights {
  queryRelevance: number;
  recency: number;
  evidenceConfidence: number;
  humanExpertBoost: number;
  toolFreshness: number;
  hierarchyLevel: number;
}

export interface PlacementPolicy {
  criticalEvidenceHeadCount: number;
  evidenceTailChecklist: boolean;
  repeatTaskInTail: boolean;
}

export interface ModelCompressionPolicy {
  enabled: boolean;
  alias: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  fallback: string;
}

export interface CompressionPolicy {
  enabled: boolean;
  mode: string;
  threshold: number;
  targetRatio: number;
  protectLastNTurns: number;
  summaryMaxTokens: number;
  strategy: string;
}

export interface CompactionPolicy extends RuntimeRecord {
  enabled: boolean;
  strategy: { id: string; params: RuntimeRecord };
  summaryReserveTokens: number;
  reservedBufferTokens: number;
  warningBufferTokens: number;
  hardBufferTokens: number;
  hardThresholdRatio: number;
  recentMessageProtectionCount: number;
  recentTurnProtectionCount: number;
  maxConsecutiveFailures: number;
  ptlRetryLimit: number;
  ptlHeadTrimRatio: number;
  modelMaxInputTokens: number;
  modelMaxOutputTokens: number;
  deterministicTargetRatio: number;
  reinjectionBudgetTokens: number;
  maxToolResultTokens: number;
  maxAttachmentTokens: number;
  allowAttachmentDehydration: boolean;
  persistSessionMemory: boolean;
  persistBoundaries: boolean;
  microCompaction: boolean;
}

export interface ContextProfile extends RuntimeRecord {
  profileId: string;
  label: string;
  modelAlias: string;
  contextWindowTokens: number;
  outputReserveTokens: number;
  toolReserveTokens: number;
  fixedMemoryBudget: number;
  referenceBudget: number;
  historyBudget: number;
  recentTurnBudget: number;
  budgetPolicy: BudgetPolicy;
  rankingWeights: RankingWeights;
  protectedEvidenceFields: string[];
  placementPolicy: PlacementPolicy;
  modelCompression: ModelCompressionPolicy;
  compactionPolicy: CompactionPolicy;
  compression: CompressionPolicy;
}

export interface ContextBudgets {
  usableTokens: number;
  fixedMemory: number;
  expertGuidance: number;
  reference: number;
  history: number;
  recentTurns: number;
  toolState: number;
}

export interface EvidenceSource extends RuntimeRecord {
  evidenceId?: unknown;
  id?: unknown;
  ref?: unknown;
  evidence_id?: unknown;
  original?: EvidenceSource;
  context?: RuntimeRecord;
  payload?: RuntimeRecord;
  evidence?: EvidenceSource;
}

export interface ScoreBreakdown extends Record<string, number> {
  queryRelevance: number;
  recency: number;
  evidenceConfidence: number;
  humanExpertBoost: number;
  toolFreshness: number;
  hierarchyLevel: number;
}

export interface NormalizedEvidence extends RuntimeRecord {
  evidenceId: string;
  title: string;
  sourceLocator: unknown;
  snippet: string;
  protectedFacts: RuntimeRecord;
  confidence: number;
  humanConfirmed: boolean;
  hierarchyLevel: unknown;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  original?: EvidenceSource;
  protectedEvidence?: boolean;
  protectionReason?: string;
}

export interface ExpertGuidance extends RuntimeRecord {
  guidanceId: string;
  query: string;
  label: string;
  instruction: string;
  reason: string;
  evidenceRefs: string[];
  createdAt: unknown;
}

export interface MemoryBlock extends RuntimeRecord {
  blockId: string;
  label: string;
  content: string;
}

export interface BudgetDrop<T> {
  item: T;
  tokens: number;
  reason: "budget_exceeded";
}

export interface BudgetSelection<T> {
  selected: T[];
  dropped: BudgetDrop<T>[];
  usedTokens: number;
  droppedCount: number;
}

export interface RecentTurnSelection<T> extends BudgetSelection<T> {
  protectedCount: number;
  protectedBudgetOverrun: boolean;
}

export interface EvidenceSelection extends BudgetSelection<NormalizedEvidence> {
  protectedEvidenceIds: string[];
  protectedEvidenceCount: number;
  protectedEvidenceBudgetOverrun: boolean;
}

export interface ContextStorageOptions {
  profilesPath: string;
  buildRecordsPath: string;
  evaluationRunsPath: string;
  protocolVersion: string;
  normalizeProfiles(profiles: unknown): ContextProfile[];
}

export interface ContextStorage {
  readProfiles(): Promise<ContextProfile[]>;
  writeProfiles(profiles: unknown): Promise<ContextProfile[]>;
  listProfiles(): Promise<{
    protocolVersion: string;
    profiles: ContextProfile[];
    path: string;
  }>;
  saveProfiles(input?: RuntimeRecord): Promise<{
    protocolVersion: string;
    profiles: ContextProfile[];
    path: string;
  }>;
  listBuildRecords(
    input?: RuntimeRecord,
  ): Promise<{ protocolVersion: string; path: string; records: unknown[] }>;
  writeBuildRecord<T>(record: T): Promise<T>;
  appendEvaluationRun<T>(run: T): Promise<T>;
}

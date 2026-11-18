export type SourceFile = {
  id: string;
  name: string;
  path: string;
  kind: "text" | "pdf" | "docx" | "document" | "image" | "email";
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
  sourceCollectedAt?: string;
  text?: string;
  mediaType?: string;
  imageDataUrl?: string;
  imageBuffer?: unknown;
  rawObjectId?: string;
  originalFileName?: string;
  originalRelativePath?: string;
  rawObjectSha256?: string;
  rawObjectByteSize?: number;
  sourceProcessorId?: string;
  documentMetadata?: Record<string, unknown>;
};

export type EmailParticipant = {
  id: string;
  name: string;
  address: string;
  domain: string;
  organization: string;
  department: string;
  relation: "internal" | "external" | "unknown";
};

export type EmailMessageStatus = "active" | "watch" | "closed" | "report";

export type EmailMessage = {
  id: string;
  sourceId: string;
  sourceName: string;
  rawObjectId?: string;
  rawObjectSha256?: string;
  subject: string;
  normalizedSubject: string;
  from: EmailParticipant | null;
  to: EmailParticipant[];
  cc: EmailParticipant[];
  bcc: EmailParticipant[];
  sentAt: string;
  excerpt: string;
  body: string;
  keywords: string[];
  chunkIds: string[];
  messageIdHeader: string;
  inReplyTo: string;
  references: string[];
  previousMessageIds: string[];
  conversationKey: string;
  threadId: string;
  transactionId: string;
  participantIds: string[];
  timeWeight: number;
  freshness: "current" | "aging" | "historical";
  status: EmailMessageStatus;
  formalUseAllowed: boolean;
};

export type EmailThreadStatus = "active" | "watch" | "closed" | "stale";

export type EmailThread = {
  id: string;
  subject: string;
  normalizedSubject: string;
  summary: string;
  messageIds: string[];
  participantIds: string[];
  senderIds: string[];
  startedAt: string;
  latestActivityAt: string;
  keywords: string[];
  status: EmailThreadStatus;
  cadence: "weekly" | "monthly" | "irregular" | "unknown";
  categories: string[];
  pendingSignals: string[];
  transactionId: string;
  timeWeight: number;
  freshness: "current" | "aging" | "historical";
  formalUseAllowed: boolean;
};

export type EmailTransactionStatus = "active" | "watch" | "closed" | "stale";

export type TransactionLifecycleStage = "new" | "matched" | "recovered";

export type TransactionLifecycle = {
  stage: TransactionLifecycleStage;
  previousState: "" | "active" | "interrupted" | "archived";
  nextState: "active" | "interrupted" | "archived";
  matchScore: number;
  matchReasons: string[];
  matchedBatchId: string;
  matchedTransactionId: string;
  pulledEventCount: number;
  pulledBatchCount: number;
  pulledTransactionCount: number;
};

export type EmailTransaction = {
  id: string;
  title: string;
  normalizedSubject: string;
  summary: string;
  status: EmailTransactionStatus;
  startedAt: string;
  latestActivityAt: string;
  threadIds: string[];
  messageIds: string[];
  participantIds: string[];
  timelineEventIds: string[];
  keywords: string[];
  decisions: string[];
  pendingItems: string[];
  cadence: "weekly" | "monthly" | "irregular" | "unknown";
  categories: string[];
  sourceDepartments: string[];
  sourceSpread: number;
  timeWeight: number;
  freshness: "current" | "aging" | "historical";
  formalUseAllowed: boolean;
  lineageId?: string;
  lifecycle?: TransactionLifecycle;
};

export type TimelineEventType =
  | "email"
  | "report"
  | "follow-up"
  | "decision"
  | "risk"
  | "handoff";

export type TimelineEvent = {
  id: string;
  timestamp: string;
  title: string;
  summary: string;
  type: TimelineEventType;
  source: string;
  messageId: string;
  threadId: string;
  transactionId: string;
  participantIds: string[];
  timeWeight: number;
  freshness: "current" | "aging" | "historical";
  lineageId?: string;
  timelinePhase?: "current" | "history";
  originBatchId?: string;
  originTransactionId?: string;
};

export type PersonRole =
  | "coordinator"
  | "driver"
  | "approver"
  | "specialist"
  | "observer";

export type PersonProfile = {
  id: string;
  name: string;
  primaryEmail: string;
  aliases: string[];
  organization: string;
  primaryDepartment: string;
  departments: string[];
  relation: "internal" | "external" | "mixed" | "unknown";
  role: PersonRole;
  sentCount: number;
  receivedCount: number;
  ccCount: number;
  bccCount: number;
  transactionCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  topTopics: string[];
  topCounterparties: string[];
  summary: string;
  timeWeight: number;
  freshness: "current" | "aging" | "historical";
  formalUseAllowed: boolean;
};

export type SystemNetworkNode = {
  id: string;
  kind: "transaction" | "thread" | "person";
  label: string;
  summary: string;
  timeWeight: number;
};

export type SystemNetworkEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  relation: "drives" | "participates" | "collaborates" | "relates-to";
  weight: number;
  evidenceIds: string[];
};

export type SystemNetwork = {
  nodes: SystemNetworkNode[];
  edges: SystemNetworkEdge[];
};

export type TransactionAssociationRelation =
  | "same-topic"
  | "same-people"
  | "same-department"
  | "same-cadence"
  | "continuation";

export type TransactionAssociation = {
  id: string;
  leftTransactionId: string;
  rightTransactionId: string;
  leftTitle: string;
  rightTitle: string;
  relationTypes: TransactionAssociationRelation[];
  strength: number;
  summary: string;
  evidenceMessageIds: string[];
  sharedParticipants: string[];
  sharedKeywords: string[];
  sharedDepartments: string[];
  timeGapDays: number;
};

export type TransactionAssociationSummary = {
  totalCount: number;
  strongCount: number;
  continuationCount: number;
  crossDepartmentCount: number;
};

export type TransactionAssociationCollection = {
  summary: TransactionAssociationSummary;
  items: TransactionAssociation[];
};

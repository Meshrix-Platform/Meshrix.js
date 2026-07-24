import type {
  EmailMessage,
  EmailThread,
  EmailTransaction,
  SystemNetwork,
  PersonProfile,
  SourceFile,
  TimelineEvent,
  TransactionAssociationCollection,
} from "./entities";

export type SplitOverview = {
  emailCount: number;
  threadCount: number;
  transactionCount: number;
  peopleCount: number;
  timelineCount: number;
  currentCount: number;
  agingCount: number;
  historicalCount: number;
};

export type SplitLifecycleSummary = {
  newCount: number;
  matchedCount: number;
  recoveredCount: number;
  pulledEventCount: number;
  pulledBatchCount: number;
  pulledTransactionCount: number;
  activeLineageCount: number;
  interruptedLineageCount: number;
  archivedLineageCount: number;
};

export type SplitResult = {
  generatedAt: string;
  overview: SplitOverview;
  emails: EmailMessage[];
  threads: EmailThread[];
  transactions: EmailTransaction[];
  people: PersonProfile[];
  timeline: TimelineEvent[];
  network: SystemNetwork;
  associations: TransactionAssociationCollection;
  lifecycle?: SplitLifecycleSummary;
  warnings: string[];
  sourceFiles: SourceFile[];
};

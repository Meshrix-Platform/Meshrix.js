export declare const SERVICE_COLLABORATION_SCHEMA_VERSION: "v0.0.1:service-collaboration:wire-1";
export declare const SERVICE_COLLABORATION_REPORT_SCHEMA_VERSION: "v0.0.1:service-collaboration:report-1";
export declare const SERVICE_COLLABORATION_PROTOCOL_VERSION: "2026-07-28";
export declare const SERVICE_COLLABORATION_CORE_STATE_GENERATION: "meshrix-core-state-1";
export declare const SERVICE_COLLABORATION_PROFILE: "service-collaboration";
export declare const SERVICE_COLLABORATION_FALLBACK_PATH: "ordinary-mcp";
export declare const SERVICE_COLLABORATION_SUBSCRIBE_METHOD: "subscriptions/listen";
export declare const SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD: "notifications/resources/updated";
export declare const SERVICE_COLLABORATION_FALLBACK_METHODS: readonly ["tools/call", "resources/read", "resources/list"];
export declare const SERVICE_COLLABORATION_CACHE_SCOPES: readonly ["public", "private"];
export declare const SERVICE_COLLABORATION_DELTA_ORDERING: "cursor-indexed-monotonic";
export declare const SERVICE_COLLABORATION_CONFLICT_CODES: readonly string[];
export declare const SERVICE_COLLABORATION_KINDS: readonly string[];
export declare const SERVICE_COLLABORATION_LOOKUP_FACTS: readonly string[];
export declare const SERVICE_COLLABORATION_LIMITS: Readonly<Record<string, number>>;
export declare const SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED: false;
export declare const SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT: false;
export declare const SERVICE_COLLABORATION_SILENT_UNCERTAIN_RETRY: false;

export declare function parseCollaborationMessage(value: unknown): Record<string, any> | null;
export declare function encodeCollaborationMessage(value: unknown): string;
export declare function decodeCollaborationMessage(value: unknown): Record<string, any> | null;
export declare function createServiceCollaborationPeer(peerId?: string): {
  peerId: string;
  encode(value: unknown): string;
  decode(value: unknown): Record<string, any> | null;
  validate(value: unknown): Record<string, any> | null;
};
export declare function agreeServiceCollaborationPeers(
  left: { encode(value: unknown): string; decode(value: unknown): Record<string, any> | null },
  right: { encode(value: unknown): string; decode(value: unknown): Record<string, any> | null },
  message: unknown
): Record<string, any> | null;
export declare function assertCommitTurn(value: unknown): true;
export declare function assertObserveCacheHit(value: unknown): "no-model-visible-remote-read" | "remote-read-allowed";
export declare function assertOneCoreStateGeneration(value: unknown): true;
export declare function assertProtocolFallback(value: unknown): true;
export declare function assertEffectCommandFamily(value: unknown): true;
export declare function effectRetryAllowed(value: unknown): boolean;
export declare function lookupFactIsAuthority(factName: unknown): false;
export declare function requiredCacheScopeFor(kind: unknown): "public" | "private";
export declare function orderDeltas(value: unknown): readonly Record<string, any>[] | null;
export declare function rebaseOperations(localOperations?: unknown, remoteOperations?: unknown): {
  rebasedOperations: readonly Record<string, any>[];
  conflicts: readonly Record<string, any>[];
};
export declare function selectProtocolPath(supportsCollaboration?: boolean): {
  profile: string;
  methods: readonly string[];
  coreStateGeneration: typeof SERVICE_COLLABORATION_CORE_STATE_GENERATION;
  fallback: Record<string, any>;
};
export declare function rejectUnknownRequiredFields(value: unknown): boolean;
export declare function rejectSecondCoreGeneration(value: unknown): boolean;
export declare function containsForbiddenKeys(value: unknown): boolean;

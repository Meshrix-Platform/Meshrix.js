/**
 * Public, protocol-neutral contracts for the Meshrix gateway.
 *
 * This module intentionally contains no network, storage, or platform imports.
 * Values crossing the boundary are unknown until a protocol/schema adapter has
 * validated them.
 */

export const GATEWAY_PROTOCOL_VERSION = "2026-07-28" as const;
export const GATEWAY_CONTRACT_VERSION = "v0.0.1:meshrix:gateway-contract-1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type EffectClass = "read" | "safe_write" | "destructive" | "unknown";
export type EffectOutcome = "not_started" | "succeeded" | "failed" | "unknown" | "cancelled";
export type InvocationState =
  | "received"
  | "routed"
  | "prepared"
  | "queued"
  | "admitted"
  | "consuming"
  | "settled"
  | "denied"
  | "cancelled";

export interface TraceContext {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
}

export interface AuthenticatedContext {
  readonly tenant: string;
  readonly principal: string;
  readonly grant: Readonly<Record<string, unknown>>;
  readonly authGeneration: string;
  /** Current credential material generation used for stateful-context binding. */
  readonly credentialGeneration?: string;
  readonly trace?: TraceContext;
  /** Platform-owned request facts that are never sourced from wire payloads. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Invocation {
  readonly routeRef: string;
  readonly method: string;
  readonly params: unknown;
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  readonly contextHandle?: string;
  readonly requestState?: string;
  /** MRTR responses keyed by the input-request name, not an ordered list. */
  readonly inputResponses?: Readonly<Record<string, unknown>>;
  readonly operationKey?: string;
}

export interface RouteSnapshot {
  readonly logicalRoute: string;
  readonly upstreamIdentity: string;
  readonly endpointIdentity: string;
  readonly protocolVersion: string;
  readonly schemaDigest: string;
  readonly policyRef: string;
  readonly revision: string;
  readonly effectClass: EffectClass;
  readonly operation?: string;
  readonly upstreamName?: string;
  readonly upstreamUri?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuthoritySnapshot {
  readonly decisionRef: string;
  readonly grantRevision: string;
  readonly policyRevision: string;
  readonly target: string;
  readonly effectClass: EffectClass;
  readonly approvalRef?: string;
  readonly approvalRevision?: string;
  readonly expiresAt: number;
}

export interface PreparedInvocation {
  readonly invocation: Invocation;
  readonly route: RouteSnapshot;
  readonly authority: AuthoritySnapshot;
  readonly inputDigest: string;
}

export interface ExecutionPermit {
  readonly id: string;
  readonly audience: string;
  readonly target: string;
  readonly tenant: string;
  readonly principal: string;
  readonly inputDigest: string;
  readonly routeRevision: string;
  readonly routeRef?: string;
  readonly grantRevision: string;
  readonly policyRevision: string;
  readonly operationKey?: string;
  readonly expiresAt: number;
  readonly state: "issued" | "consumed" | "outcome_unknown" | "expired";
}

export interface ContinuationPayload {
  /** Random authenticated identity; token spelling must never be its replay identity. */
  readonly tokenId?: string;
  /** In-memory replay profiles bind one-time tokens to the issuing process epoch. */
  readonly issuerEpoch?: string;
  readonly generation: number;
  readonly tenant: string;
  readonly principal: string;
  readonly grantRevision: string;
  readonly routeRef: string;
  readonly endpointIdentity: string;
  readonly routeRevision: string;
  readonly method: string;
  readonly params: unknown;
  readonly paramsDigest: string;
  readonly contextHandle?: string;
  readonly upstreamState: { readonly present: boolean; readonly value?: string };
  readonly effectClass: EffectClass;
  readonly oneTime: boolean;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ContinuationCodec {
  seal(payload: ContinuationPayload): string;
  open(state: string, now?: number): ContinuationPayload;
  claim?(state: string, payload: ContinuationPayload): void | Promise<void>;
  settle?(state: string, outcome: "consumed" | "outcome_unknown"): void | Promise<void>;
  release?(state: string): void | Promise<void>;
}

export interface CompleteResult {
  readonly kind: "complete";
  readonly value: unknown;
  readonly isError?: boolean;
  readonly requestState?: string;
  /**
   * How far the effect got. Absent on an ordinary upstream result because the result
   * itself is the evidence; present when the kernel answered without executing — an
   * escalated approval reports `not_started`.
   */
  readonly effectOutcome?: EffectOutcome;
}

export interface InputRequiredResult {
  readonly kind: "input_required";
  readonly inputRequests?: readonly Record<string, unknown>[] | Readonly<Record<string, unknown>>;
  readonly requestState?: string;
  readonly upstreamState?: { readonly present: boolean; readonly value?: string };
}

export interface NegotiatedExtensionResult {
  readonly kind: "negotiated_extension";
  readonly extension: string;
  readonly value: unknown;
  readonly requestState?: string;
}

export type UpstreamResult = CompleteResult | InputRequiredResult | NegotiatedExtensionResult;

/**
 * Closed public failure vocabulary.
 *
 * A failure projected from a thrown error may use only these codes, and its
 * public message and status come from this table. Internal exception text,
 * arbitrary codes, peer text and peer data are never forwarded across the
 * protocol boundary.
 */
export const GATEWAY_PUBLIC_FAILURES = Object.freeze({
  operation_cancelled: { message: "The operation was cancelled.", status: 499 },
  gateway_closing: { message: "The gateway is not accepting requests.", status: 503 },
  admission_queue_full: { message: "The upstream admission queue is full.", status: 429 },
  admission_queue_deadline: { message: "The request expired while waiting for upstream capacity.", status: 429 },
  admission_queue_deadline_invalid: { message: "The request queue deadline is invalid.", status: 400 },
  admission_upstream_capacity: { message: "Upstream admission capacity is exhausted.", status: 429 },
  continuation_invalid: { message: "Continuation state is invalid.", status: 409 },
  continuation_expired: { message: "Continuation has expired.", status: 410 },
  continuation_in_progress: { message: "Continuation is already in progress.", status: 409 },
  continuation_replayed: { message: "Continuation has already been used.", status: 409 },
  continuation_outcome_unknown: { message: "The continuation outcome is unknown and cannot be replayed.", status: 409 },
  continuation_capacity: { message: "The continuation replay ledger is full.", status: 503 },
  final_protected_sink_permit_revoked: { message: "Final protected sink authority was revoked.", status: 403 },
  governed_execution_permit_unknown_or_replayed: { message: "The execution permit is unknown or already consumed.", status: 409 },
  api_key_concurrency_limit_reached: { message: "API Key concurrency limit reached.", status: 429 },
  api_key_rate_limited: { message: "API Key rate limit reached.", status: 429 },
  api_key_use_limit_reached: { message: "API Key use limit reached.", status: 429 },
  api_key_inactive: { message: "API Key is inactive.", status: 410 },
  api_key_policy_denied: { message: "API Key policy denied the operation.", status: 403 },
  workspace_binding_invalid: { message: "The workspace binding is invalid.", status: 403 },
  context_unknown: { message: "The business context is unknown or expired.", status: 410 },
  context_lost: { message: "The business context is no longer recoverable.", status: 410 },
  context_expired: { message: "The business context is no longer recoverable.", status: 410 },
  context_closed: { message: "The business context is no longer recoverable.", status: 410 },
  context_capacity_exceeded: { message: "Business context capacity is exhausted.", status: 429 },
  permit_port_missing: { message: "An authoritative execution permit is unavailable.", status: 503 }
} as const);

export type GatewayPublicFailureCode = keyof typeof GATEWAY_PUBLIC_FAILURES;

/** The closed set of facts a public failure may carry in `details`. */
export interface GatewayFailureDetails {
  readonly receiptId?: string;
  /** Bounded numeric JSON-RPC error code declared by the upstream peer. */
  readonly errorCode?: number;
  readonly phase?: "input" | "output";
}

export interface GatewayFailure {
  readonly kind: "failure";
  readonly origin:
    | "transport"
    | "protocol"
    | "peer"
    | "policy"
    | "schema"
    | "admission"
    | "continuation"
    | "configuration"
    | "lifecycle";
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly effectOutcome: EffectOutcome;
  readonly details?: GatewayFailureDetails;
}

export type GatewayOutcome = UpstreamResult | GatewayFailure;

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly authority?: AuthoritySnapshot;
  readonly reasonCode?: string;
  readonly message?: string;
}

export interface GatewayPolicyPort {
  readonly revision?: string;
  decide(input: {
    readonly context: AuthenticatedContext;
    readonly invocation: Invocation;
    readonly route: RouteSnapshot;
  }): PolicyDecision | Promise<PolicyDecision>;
  revalidate?(input: {
    readonly context: AuthenticatedContext;
    readonly invocation: Invocation;
    readonly route: RouteSnapshot;
    readonly authority: AuthoritySnapshot;
  }): PolicyDecision | Promise<PolicyDecision>;
}

/** Fresh authoritative facts, resolved after admission and again before a protected access. */
export interface CurrentAuthorityPort {
  read(input: { readonly context: AuthenticatedContext; readonly route: RouteSnapshot }): Promise<AuthenticatedContext>;
}

/**
 * The platform's approval/pending-operation mechanism, reached through the kernel.
 *
 * A policy that requires an approval the authenticated context does not carry is not a
 * denial: it is an escalation. The kernel hands the escalation to this port, which is
 * responsible for recording the platform's pending approval and answering with the
 * platform's own pending result. The port is approval-only by contract — it may not
 * execute the effect it escalates, because the kernel has issued no permit for it.
 * Returning `undefined` means the escalation is not available and the kernel keeps the
 * denial.
 */
export interface ApprovalEscalation {
  /** The platform's pending-approval result, returned to the caller verbatim. */
  readonly value: unknown;
  /** The effect outcome of the escalated invocation: a pending approval never ran it. */
  readonly effectOutcome: EffectOutcome;
  readonly pendingOperationId?: string;
  readonly approvalRef?: string;
  readonly approvalRevision?: string;
}

export interface GatewayApprovalPort {
  escalate(input: {
    readonly context: AuthenticatedContext;
    readonly invocation: Invocation;
    readonly route: RouteSnapshot;
    readonly reasonCode: string;
    readonly message: string;
  }): ApprovalEscalation | undefined | Promise<ApprovalEscalation | undefined>;
}

export interface PermitAuthorityPort {
  issue(input: {
    readonly context: AuthenticatedContext;
    readonly prepared: PreparedInvocation;
    readonly audience: string;
  }): ExecutionPermit | Promise<ExecutionPermit>;
  consume(input: {
    readonly permit: ExecutionPermit;
    readonly context: AuthenticatedContext;
    readonly prepared: PreparedInvocation;
  }): ExecutionPermit | Promise<ExecutionPermit>;
  markOutcomeUnknown?(permit: ExecutionPermit): ExecutionPermit | Promise<ExecutionPermit>;
  /** Persist the server-owned effect boundary without extending the client permit or MCP request shape. */
  transition?(permit: ExecutionPermit, phase: "dispatch_started" | "not_started" | "succeeded" | "failed"): void | Promise<void>;
  lookup?(input: { readonly receiptId: string; readonly context: AuthenticatedContext }): ExecutionPermit | undefined | Promise<ExecutionPermit | undefined>;
  stats?(): Readonly<Record<string, unknown>>;
}

export interface CredentialProvider {
  resolve(input: {
    readonly binding: string;
    readonly audience: string;
    readonly context: AuthenticatedContext;
  }): Promise<unknown>;
}

export interface UpstreamRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
  readonly protocolVersion: string;
  readonly requestState?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly trace?: TraceContext;
}

export interface UpstreamResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface UpstreamPort {
  invoke(input: {
    readonly context?: AuthenticatedContext;
    readonly request: UpstreamRequest;
    readonly route: RouteSnapshot;
    /** Exact server-owned permit for internal effect evidence; never serialized onto MCP wire. */
    readonly permit?: ExecutionPermit;
    readonly credential?: unknown;
    readonly signal?: AbortSignal;
  }): Promise<UpstreamResponse | UpstreamResult>;
  close?(): Promise<void>;
}

export interface CatalogDescriptor {
  readonly kind: "tool" | "resource" | "resource_template" | "prompt";
  readonly publicName?: string;
  readonly publicUri?: string;
  readonly upstreamName?: string;
  readonly upstreamUri?: string;
  readonly route: RouteSnapshot;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly description?: string;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CatalogPage {
  readonly revision: string;
  readonly items: readonly CatalogDescriptor[];
  readonly nextCursor?: string;
}

export interface CatalogQuery {
  readonly kind?: CatalogDescriptor["kind"];
  readonly cursor?: string;
  readonly limit?: number;
  readonly search?: string;
}

export interface CatalogPort {
  publish(descriptors: readonly CatalogDescriptor[]): string;
  page(context: AuthenticatedContext, query?: CatalogQuery): CatalogPage;
  resolve(routeRef: string): RouteSnapshot | undefined;
  descriptor(routeRef: string): CatalogDescriptor | undefined;
}

export interface SubscriptionEvent {
  readonly type:
    | "tools/list_changed"
    | "resources/list_changed"
    | "prompts/list_changed"
    | "resource/updated"
    | "gateway/state_changed";
  readonly revision: string;
  readonly payload?: unknown;
}

export interface Subscription {
  readonly id: string;
  readonly events: AsyncIterable<SubscriptionEvent>;
  close(): void;
}

export interface ResourcePort {
  read(input: {
    readonly context: AuthenticatedContext;
    readonly route: RouteSnapshot;
    readonly uri: string;
    readonly requestState?: string;
    readonly inputResponses?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface PromptPort {
  get(input: {
    readonly context: AuthenticatedContext;
    readonly route: RouteSnapshot;
    readonly name: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly requestState?: string;
    readonly inputResponses?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
  complete?(input: {
    readonly context: AuthenticatedContext;
    readonly route: RouteSnapshot;
    readonly argument: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface LifecycleResource {
  readonly owned?: boolean;
  start?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface GatewayStats {
  readonly started: boolean;
  readonly closing: boolean;
  readonly activeInvocations: number;
  readonly catalogRevision: string;
  readonly admission: Readonly<Record<string, unknown>>;
  readonly controllers?: number;
  readonly contexts?: Readonly<{ readonly activeContexts: number; readonly retainedTombstones: number }>;
  readonly catalogRetention?: Readonly<{ readonly routes: number; readonly schemaWorkers: Readonly<{ readonly workers: number; readonly active: number; readonly queued: number; readonly deadlineTimers: number }> }>;
  readonly subscriptions?: Readonly<{ readonly streams: number; readonly queuedEvents: number; readonly waitingReaders: number }>;
  readonly permits?: Readonly<Record<string, unknown>>;
}

export interface Gateway {
  start(): Promise<void>;
  close(options?: { readonly drainDeadline?: number }): Promise<void>;
  invoke(context: AuthenticatedContext, invocation: Invocation): Promise<GatewayOutcome>;
  continue(context: AuthenticatedContext, requestState: string, inputResponses?: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<GatewayOutcome>;
  receiptStatus?(context: AuthenticatedContext, receiptId: string): Promise<GatewayFailure | { readonly receiptId: string; readonly state: ExecutionPermit["state"]; readonly expiresAt: number }>;
  catalog(context: AuthenticatedContext, query?: CatalogQuery): CatalogPage;
  subscribe(context: AuthenticatedContext, kinds?: readonly SubscriptionEvent["type"][]): Subscription;
  stats(): GatewayStats;
  publishCatalog?(descriptors: readonly CatalogDescriptor[]): string;
  readResource?(context: AuthenticatedContext, uri: string, signal?: AbortSignal, requestState?: string, inputResponses?: Readonly<Record<string, unknown>>): Promise<GatewayOutcome>;
  getPrompt?(context: AuthenticatedContext, name: string, args?: Readonly<Record<string, unknown>>, signal?: AbortSignal, requestState?: string, inputResponses?: Readonly<Record<string, unknown>>): Promise<GatewayOutcome>;
  completePrompt?(context: AuthenticatedContext, argument: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<GatewayOutcome>;
}

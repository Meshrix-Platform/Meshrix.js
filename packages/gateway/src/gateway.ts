import { randomUUID } from "node:crypto";
import type {
  AuthenticatedContext,
  AuthoritySnapshot,
  CatalogDescriptor,
  CatalogPage,
  CatalogQuery,
  ContinuationCodec,
  CredentialProvider,
  ExecutionPermit,
  Gateway,
  GatewayApprovalPort,
  GatewayFailure,
  GatewayOutcome,
  GatewayPolicyPort,
  GatewayStats,
  Invocation,
  PermitAuthorityPort,
  PreparedInvocation,
  PromptPort,
  ResourcePort,
  RouteSnapshot,
  Subscription,
  SubscriptionEvent,
  UpstreamPort,
  UpstreamResponse
} from "@meshrix/contracts/gateway";
import { CatalogStore } from "./catalog/index.ts";
import { createContinuationCodec, continuationParamsDigest, EncryptedContinuationCodec } from "./continuations/index.ts";
import { UpstreamAdmissionController, createUpstreamAdmission } from "./admission/index.ts";
import { SubscriptionHub, createSubscriptionHub } from "./subscriptions/index.ts";
import { BusinessContextStore, createBusinessContextStore, type BusinessContext } from "./context/index.ts";
import { decodeUpstreamResult, failure, inputRequired, isGatewayFailure, isUpstreamResult, type UpstreamResult } from "./results/index.ts";
import { GatewaySchemaError } from "./schema/index.ts";
import { createId, digest, deepFreeze, isPlainRecord, throwIfAborted } from "./utils.ts";

export interface GatewayLifecycleResource {
  readonly owned?: boolean;
  start?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface GatewayOptions {
  readonly catalog?: CatalogStore;
  readonly descriptors?: readonly CatalogDescriptor[];
  readonly policy?: GatewayPolicyPort;
  readonly permits?: PermitAuthorityPort;
  readonly approval?: GatewayApprovalPort;
  readonly continuation?: ContinuationCodec;
  readonly continuationKey?: Uint8Array | string;
  readonly upstream?: UpstreamPort;
  readonly ownedUpstream?: boolean;
  readonly credentialProvider?: CredentialProvider;
  readonly resources?: ResourcePort;
  readonly prompts?: PromptPort;
  readonly admission?: UpstreamAdmissionController;
  readonly ownedAdmission?: boolean;
  readonly admissionOptions?: { readonly maxInFlight?: number; readonly queueSize?: number; readonly defaultQueueDeadlineMs?: number };
  readonly lifecycleResources?: readonly GatewayLifecycleResource[];
  readonly now?: () => number;
  readonly serverInfo?: Readonly<Record<string, unknown>>;
  /**
   * Caller-supplied keys that carry platform policy rather than operation input. The
   * owning platform strips them before it validates and executes, so the kernel must not
   * assert them against the route's closed operation schema; the invocation still carries
   * them through to the sink untouched.
   */
  readonly inputEnvelopeKeys?: readonly string[];
  readonly contextStore?: BusinessContextStore;
  readonly contextOptions?: {
    readonly maxActive?: number;
    readonly maxActivePerSubjectUpstream?: number;
    readonly maxTombstones?: number;
    readonly tombstoneRetentionMs?: number;
  };
}

type GatewayContextFacts = AuthenticatedContext & {
  readonly credentialGeneration?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};
type InvocationSinkInput = Parameters<UpstreamPort["invoke"]>[0] & { readonly context?: AuthenticatedContext };
type InvocationSink = (input: InvocationSinkInput) => Promise<unknown>;

export interface GatewayKernel extends Gateway {
  readonly catalogStore: CatalogStore;
  readonly contextStore: BusinessContextStore;
  publishCatalog(descriptors: readonly CatalogDescriptor[]): string;
  readResource(context: AuthenticatedContext, uri: string, signal?: AbortSignal): Promise<GatewayOutcome>;
  getPrompt(context: AuthenticatedContext, name: string, args?: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<GatewayOutcome>;
  completePrompt(context: AuthenticatedContext, argument: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<GatewayOutcome>;
  createContext(input: { readonly tenant: string; readonly principal: string; readonly grantRevision: string; readonly credentialGeneration: string; readonly routeRef: string }): BusinessContext;
  publishEvent(context: AuthenticatedContext, event: Omit<SubscriptionEvent, "revision"> & { readonly revision?: string }): void;
}

class KernelPolicy implements GatewayPolicyPort {
  readonly revision = "gateway-policy-1";
  readonly #now: () => number;

  constructor(now: () => number) { this.#now = now; }

  decide(input: { readonly context: AuthenticatedContext; readonly invocation: Invocation; readonly route: RouteSnapshot }) {
    const grant = input.context.grant;
    if (grant.revoked === true) return { allowed: false, reasonCode: "grant_revoked", message: "The current grant has been revoked." };
    if (typeof grant.expiresAt === "number" && grant.expiresAt <= this.#now()) return { allowed: false, reasonCode: "grant_expired", message: "The current grant has expired." };
    const routeRefs = Array.isArray(grant.routes) ? grant.routes.filter((value): value is string => typeof value === "string") : [];
    if (routeRefs.length > 0 && !routeRefs.includes(input.route.logicalRoute)) return { allowed: false, reasonCode: "route_not_granted", message: "The current grant does not include the route." };
    const methods = Array.isArray(grant.methods) ? grant.methods.filter((value): value is string => typeof value === "string") : [];
    if (methods.length > 0 && !methods.includes(input.invocation.method)) return { allowed: false, reasonCode: "method_not_granted", message: "The current grant does not include the method." };
    if (input.route.effectClass === "unknown") return { allowed: false, reasonCode: "effect_class_unknown", message: "The route effect class is not classified." };
    if (input.route.effectClass === "destructive" && grant.approved !== true && typeof grant.approvalRef !== "string") return { allowed: false, reasonCode: "approval_required", message: "This effect requires explicit approval." };
    const now = this.#now();
    const authority: AuthoritySnapshot = Object.freeze({
      decisionRef: `decision_${randomUUID()}`,
      grantRevision: String(grant.revision ?? input.context.authGeneration),
      policyRevision: this.revision,
      target: input.route.endpointIdentity,
      effectClass: input.route.effectClass,
      ...(typeof grant.approvalRef === "string" ? { approvalRef: grant.approvalRef } : {}),
      ...(typeof grant.approvalRevision === "string" ? { approvalRevision: grant.approvalRevision } : {}),
      expiresAt: Math.min(typeof grant.expiresAt === "number" && grant.expiresAt > now ? grant.expiresAt : now + 15_000, now + 60_000)
    });
    return { allowed: true, authority };
  }

  revalidate(input: { readonly context: AuthenticatedContext; readonly invocation: Invocation; readonly route: RouteSnapshot; readonly authority: AuthoritySnapshot }) {
    const result = this.decide(input);
    if (!result.allowed) return result;
    if (result.authority?.target !== input.authority.target || result.authority.policyRevision !== input.authority.policyRevision) return { allowed: false, reasonCode: "authority_changed", message: "Current authority changed." };
    return result;
  }
}

class KernelPermitAuthority implements PermitAuthorityPort {
  readonly #now: () => number;
  readonly #permits = new Map<string, ExecutionPermit>();

  constructor(now: () => number) { this.#now = now; }

  issue(input: { readonly context: AuthenticatedContext; readonly prepared: PreparedInvocation; readonly audience: string }): ExecutionPermit {
    const permit = this.#newPermit(input.context, input.prepared, input.audience);
    this.#permits.set(permit.id, permit);
    return permit;
  }

  consume(input: { readonly permit: ExecutionPermit; readonly context: AuthenticatedContext; readonly prepared: PreparedInvocation }): ExecutionPermit {
    const current = this.#permits.get(input.permit.id);
    if (!current || current.state !== "issued") throw Object.assign(new Error("Execution permit is unknown or already consumed."), { code: "permit_replayed", status: 403 });
    if (current.expiresAt <= this.#now()) throw Object.assign(new Error("Execution permit expired."), { code: "permit_expired", status: 403 });
    if (current.tenant !== input.context.tenant || current.principal !== input.context.principal || current.target !== input.prepared.route.endpointIdentity || current.routeRevision !== input.prepared.route.revision || current.inputDigest !== input.prepared.inputDigest) throw Object.assign(new Error("Execution permit binding mismatch."), { code: "permit_binding_mismatch", status: 403 });
    const consumed = Object.freeze({ ...current, state: "consumed" as const });
    this.#permits.set(current.id, consumed);
    return consumed;
  }

  markOutcomeUnknown(permit: ExecutionPermit): ExecutionPermit {
    const current = this.#permits.get(permit.id);
    if (!current) throw Object.assign(new Error("Execution permit is unknown."), { code: "permit_unknown", status: 403 });
    const updated = Object.freeze({ ...current, state: "outcome_unknown" as const });
    this.#permits.set(updated.id, updated);
    return updated;
  }

  #newPermit(context: AuthenticatedContext, prepared: PreparedInvocation, audience: string): ExecutionPermit {
    return Object.freeze({
      id: createId("permit"),
      audience,
      target: prepared.route.endpointIdentity,
      tenant: context.tenant,
      principal: context.principal,
      inputDigest: prepared.inputDigest,
      routeRevision: prepared.route.revision,
      grantRevision: prepared.authority.grantRevision,
      policyRevision: prepared.authority.policyRevision,
      ...(prepared.invocation.operationKey ? { operationKey: prepared.invocation.operationKey } : {}),
      expiresAt: Math.min(prepared.authority.expiresAt, this.#now() + 60_000),
      state: "issued" as const
    });
  }
}

function safeContext(context: AuthenticatedContext): boolean {
  return Boolean(context && typeof context.tenant === "string" && context.tenant.trim() && typeof context.principal === "string" && context.principal.trim() && typeof context.authGeneration === "string" && context.authGeneration.trim() && isPlainRecord(context.grant));
}

function contextFailure(): GatewayFailure {
  return failure({ origin: "policy", code: "authenticated_context_required", message: "A trusted authenticated context is required.", status: 401, effectOutcome: "not_started" });
}

function failureFromError(error: unknown, origin: GatewayFailure["origin"], effectOutcome: GatewayFailure["effectOutcome"]): GatewayFailure {
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string" && candidate.code ? candidate.code : "gateway_operation_failed";
  const statusValue = Number(candidate?.status ?? candidate?.statusCode ?? 500);
  return failure({ origin, code, message: typeof candidate?.message === "string" ? candidate.message : "Gateway operation failed.", status: Number.isSafeInteger(statusValue) && statusValue >= 400 ? statusValue : 500, effectOutcome });
}

function isUnknownEffectError(error: unknown): boolean {
  const value = error as { sent?: unknown; effectOutcome?: unknown };
  return value?.sent === true || value?.effectOutcome === "unknown";
}

function normalizePortResult(value: unknown): UpstreamResult | GatewayFailure {
  if (isGatewayFailure(value) || isUpstreamResult(value)) return value;
  return Object.freeze({ kind: "complete", value });
}

function currentGrantRevision(context: AuthenticatedContext): string {
  return String(context.grant.revision ?? context.authGeneration);
}

function currentCredentialGeneration(context: AuthenticatedContext): string {
  const facts = context as GatewayContextFacts;
  return String(facts.credentialGeneration ?? facts.metadata?.credentialGeneration ?? context.grant.credentialGeneration ?? context.authGeneration);
}

function schemaFailure(error: unknown, phase: "input" | "output", effectOutcome: GatewayFailure["effectOutcome"]): GatewayFailure {
  if (error instanceof GatewaySchemaError) {
    return failure({
      origin: "schema",
      code: error.code,
      message: error.message,
      status: phase === "input" ? 400 : 502,
      effectOutcome,
      details: Object.freeze({ phase, ...error.details })
    });
  }
  return failureFromError(error, "schema", effectOutcome);
}

function schemaInputValue(invocation: Invocation, envelopeKeys: ReadonlySet<string>): unknown {
  const value = invocation.method === "tools/call" && isPlainRecord(invocation.params) && Object.hasOwn(invocation.params, "arguments")
    ? invocation.params.arguments
    : invocation.params;
  if (envelopeKeys.size === 0 || !isPlainRecord(value)) return value;
  const entries = Object.entries(value).filter(([key]) => !envelopeKeys.has(key));
  return entries.length === Object.keys(value).length ? value : Object.fromEntries(entries);
}

function responseStatus(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "status")) return undefined;
  const status = Number((value as { status?: unknown }).status);
  return Number.isSafeInteger(status) ? status : undefined;
}

function isFatalUpstreamStatus(status: number | undefined): boolean {
  return status === 404 || (status !== undefined && status >= 500);
}

function responseBody(response: UpstreamResponse): unknown {
  if (isPlainRecord(response.body) && Object.hasOwn(response.body, "error")) {
    const error = response.body.error;
    return failure({ origin: "peer", code: "upstream_jsonrpc_error", message: "Upstream returned a JSON-RPC error.", status: response.status >= 400 ? response.status : 502, effectOutcome: "failed", details: isPlainRecord(error) ? { errorCode: error.code, errorData: error.data } : undefined });
  }
  if (isPlainRecord(response.body) && Object.hasOwn(response.body, "result")) return response.body.result;
  return response.body;
}

class GatewayKernelImpl implements GatewayKernel {
  readonly catalogStore: CatalogStore;
  readonly #policy: GatewayPolicyPort;
  readonly #permits: PermitAuthorityPort;
  readonly #continuation?: ContinuationCodec;
  readonly #upstream?: UpstreamPort;
  readonly #ownsUpstream: boolean;
  readonly #credentialProvider?: CredentialProvider;
  readonly #resources?: ResourcePort;
  readonly #prompts?: PromptPort;
  readonly #admission: UpstreamAdmissionController;
  readonly #ownsAdmission: boolean;
  readonly #contextStore: BusinessContextStore;
  readonly #approval?: GatewayApprovalPort;
  readonly #inputEnvelopeKeys: ReadonlySet<string>;
  readonly #hub: SubscriptionHub;
  readonly #lifecycle: readonly GatewayLifecycleResource[];
  readonly #now: () => number;
  readonly #active = new Set<Promise<GatewayOutcome>>();
  readonly #controllers = new Set<AbortController>();
  readonly #serverInfo: Readonly<Record<string, unknown>>;
  #started = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #invocationId = 0;

  constructor(options: GatewayOptions) {
    this.#now = options.now ?? Date.now;
    this.catalogStore = options.catalog ?? new CatalogStore();
    if (options.descriptors && options.descriptors.length > 0) this.catalogStore.publish(options.descriptors);
    this.#policy = options.policy ?? new KernelPolicy(this.#now);
    this.#permits = options.permits ?? new KernelPermitAuthority(this.#now);
    this.#continuation = options.continuation ?? (options.continuationKey ? createContinuationCodec({ key: options.continuationKey, now: this.#now }) : undefined);
    this.#upstream = options.upstream;
    this.#ownsUpstream = options.ownedUpstream === true;
    this.#credentialProvider = options.credentialProvider;
    this.#resources = options.resources;
    this.#prompts = options.prompts;
    this.#admission = options.admission ?? createUpstreamAdmission(options.admissionOptions);
    this.#ownsAdmission = options.admission === undefined || options.ownedAdmission === true;
    this.#contextStore = options.contextStore ?? createBusinessContextStore({ now: this.#now, ...options.contextOptions });
    this.#approval = options.approval;
    this.#inputEnvelopeKeys = new Set(options.inputEnvelopeKeys ?? []);
    this.#hub = createSubscriptionHub();
    this.#lifecycle = Object.freeze([...(options.lifecycleResources ?? [])]);
    this.#serverInfo = Object.freeze({ name: "meshrix-gateway", version: "0.1.0-alpha.1", ...(options.serverInfo ?? {}) });
  }

  get contextStore(): BusinessContextStore { return this.#contextStore; }

  async start(): Promise<void> {
    if (this.#started && !this.#closing) return;
    if (this.#closing) throw new Error("Gateway is closing.");
    const started: GatewayLifecycleResource[] = [];
    try {
      for (const resource of this.#lifecycle) {
        if (resource.owned === false || !resource.start) continue;
        await resource.start();
        started.push(resource);
      }
      this.#started = true;
    } catch (error) {
      for (const resource of started.reverse()) await resource.close?.();
      throw error;
    }
  }

  close(options: { readonly drainDeadline?: number } = {}): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    if (this.#ownsAdmission) this.#admission.close();
    this.#hub.close();
    const deadline = options.drainDeadline === undefined ? undefined : this.#now() + Math.max(0, options.drainDeadline);
    this.#closePromise = (async (): Promise<void> => {
      if (this.#active.size > 0) {
        const active = Promise.allSettled([...this.#active]).then(() => undefined);
        if (deadline === undefined) await active;
        else {
          const remaining = Math.max(0, deadline - this.#now());
          await Promise.race([active, new Promise<void>((resolve) => setTimeout(resolve, remaining))]);
          if (this.#active.size > 0) for (const controller of this.#controllers) controller.abort();
        }
      }
      if (this.#ownsUpstream) await this.#upstream?.close?.();
      for (const resource of [...this.#lifecycle].reverse()) {
        if (resource.owned === false) continue;
        await resource.close?.();
      }
      this.#started = false;
    })();
    return this.#closePromise;
  }

  publishCatalog(descriptors: readonly CatalogDescriptor[]): string {
    const revision = this.catalogStore.publish(descriptors);
    return revision;
  }

  publishEvent(context: AuthenticatedContext, event: Omit<SubscriptionEvent, "revision"> & { readonly revision?: string }): void {
    this.#hub.publish(context, { ...event, revision: event.revision ?? this.catalogStore.snapshot().revision });
  }

  invoke(context: AuthenticatedContext, invocation: Invocation): Promise<GatewayOutcome> {
    if (invocation.requestState) return this.continue(context, invocation.requestState, invocation.inputResponses);
    const task = this.#invokeInternal(context, invocation);
    this.#active.add(task);
    return task.finally(() => this.#active.delete(task));
  }

  async continue(context: AuthenticatedContext, requestState: string, inputResponses: readonly Record<string, unknown>[] = []): Promise<GatewayOutcome> {
    if (!safeContext(context)) return contextFailure();
    if (!this.#continuation) return failure({ origin: "continuation", code: "continuation_unavailable", message: "This gateway profile does not provide continuation state.", status: 501, effectOutcome: "not_started" });
    let payload;
    try { payload = this.#continuation.open(requestState, this.#now()); } catch (error) { return failureFromError(error, "continuation", "not_started"); }
    if (payload.tenant !== context.tenant || payload.principal !== context.principal || payload.grantRevision !== currentGrantRevision(context)) {
      const codec = this.#continuation as EncryptedContinuationCodec | undefined;
      codec?.release(requestState);
      return failure({ origin: "continuation", code: "continuation_subject_mismatch", message: "Continuation is not bound to the authenticated context.", status: 403, effectOutcome: "not_started" });
    }
    const params = isPlainRecord(payload.params)
      ? { ...payload.params, ...(inputResponses.length > 0 ? { inputResponses: inputResponses.map((response) => ({ ...response })) } : {}) }
      : payload.params;
    const invocation: Invocation = Object.freeze({ routeRef: payload.routeRef, method: payload.method, params, signal: undefined });
    const task = this.#invokeInternal(context, invocation, { present: payload.upstreamState.present, ...(payload.upstreamState.present ? { value: payload.upstreamState.value ?? "" } : {}) }, requestState, payload.endpointIdentity, payload.routeRevision, payload.generation);
    this.#active.add(task);
    const outcome = await task.finally(() => this.#active.delete(task));
    const codec = this.#continuation as EncryptedContinuationCodec | undefined;
    if (codec?.state(requestState) === "executing") codec.settle(requestState, outcome.kind === "failure" && outcome.effectOutcome === "unknown" ? "outcome_unknown" : "consumed");
    return outcome;
  }

  catalog(context: AuthenticatedContext, query: CatalogQuery = {}): CatalogPage {
    if (!safeContext(context)) throw Object.assign(new Error(contextFailure().message), { code: "authenticated_context_required", status: 401 });
    return this.catalogStore.page(context, query);
  }

  subscribe(context: AuthenticatedContext, kinds: readonly SubscriptionEvent["type"][] = []): Subscription {
    if (!safeContext(context)) throw Object.assign(new Error(contextFailure().message), { code: "authenticated_context_required", status: 401 });
    return this.#hub.subscribe(context, kinds);
  }

  async readResource(context: AuthenticatedContext, uri: string, signal?: AbortSignal): Promise<GatewayOutcome> {
    const descriptor = this.#findDescriptor(context, "resource", (item) => item.publicUri === uri || item.upstreamUri === uri);
    if (!descriptor) return failure({ origin: "protocol", code: "resource_not_found", message: "Resource is not published.", status: 404, effectOutcome: "not_started" });
    if (this.#resources) {
      return this.#invokeInternal(
        context,
        { routeRef: descriptor.route.logicalRoute, method: "resources/read", params: { uri: descriptor.upstreamUri ?? uri }, signal },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async ({ context: sinkContext, route, signal: sinkSignal }) => normalizePortResult(await this.#resources!.read({ context: sinkContext!, route, uri: descriptor.upstreamUri ?? uri, signal: sinkSignal }))
      );
    }
    return this.invoke(context, { routeRef: descriptor.route.logicalRoute, method: "resources/read", params: { uri: descriptor.upstreamUri ?? uri }, signal });
  }

  async getPrompt(context: AuthenticatedContext, name: string, args: Readonly<Record<string, unknown>> = {}, signal?: AbortSignal): Promise<GatewayOutcome> {
    const descriptor = this.#findDescriptor(context, "prompt", (item) => item.publicName === name || item.upstreamName === name);
    if (!descriptor) return failure({ origin: "protocol", code: "prompt_not_found", message: "Prompt is not published.", status: 404, effectOutcome: "not_started" });
    if (this.#prompts) {
      return this.#invokeInternal(
        context,
        { routeRef: descriptor.route.logicalRoute, method: "prompts/get", params: { name: descriptor.upstreamName ?? name, arguments: { ...args } }, signal },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async ({ context: sinkContext, route, signal: sinkSignal }) => normalizePortResult(await this.#prompts!.get({ context: sinkContext!, route, name: descriptor.upstreamName ?? name, arguments: args, signal: sinkSignal }))
      );
    }
    return this.invoke(context, { routeRef: descriptor.route.logicalRoute, method: "prompts/get", params: { name: descriptor.upstreamName ?? name, arguments: { ...args } }, signal });
  }

  async completePrompt(context: AuthenticatedContext, argument: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<GatewayOutcome> {
    const name = typeof argument.name === "string" ? argument.name : "";
    const descriptor = this.#findDescriptor(context, "prompt", (item) => item.publicName === name || item.upstreamName === name);
    if (!descriptor || !this.#prompts?.complete) return failure({ origin: "protocol", code: "prompt_completion_unsupported", message: "Prompt completion is not available for this route.", status: 501, effectOutcome: "not_started" });
    return this.#invokeInternal(
      context,
      { routeRef: descriptor.route.logicalRoute, method: "completion/complete", params: { ...argument }, signal },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async ({ context: sinkContext, route, signal: sinkSignal }) => normalizePortResult(await this.#prompts!.complete!({ context: sinkContext!, route, argument, signal: sinkSignal }))
    );
  }

  stats(): GatewayStats {
    return Object.freeze({ started: this.#started, closing: this.#closing, activeInvocations: this.#active.size, catalogRevision: this.catalogStore.snapshot().revision, admission: this.#admission.stats() });
  }

  createContext(input: { readonly tenant: string; readonly principal: string; readonly grantRevision: string; readonly credentialGeneration: string; readonly routeRef: string }): BusinessContext {
    return this.#contextStore.create(input);
  }

  get serverInfo(): Readonly<Record<string, unknown>> { return this.#serverInfo; }

  /**
   * A policy that requires an approval the context does not carry escalates instead of
   * refusing: the platform records its own pending approval and answers for the call.
   * Nothing is executed here — no permit is issued, because the port may not run the
   * effect. When the port cannot escalate, the denial stands unchanged.
   */
  async #escalateApproval(context: AuthenticatedContext, invocation: Invocation, route: RouteSnapshot, decision: { readonly reasonCode?: string; readonly message?: string }): Promise<GatewayOutcome | undefined> {
    if (decision.reasonCode !== "approval_required" || !this.#approval) return undefined;
    let escalation;
    try {
      escalation = await this.#approval.escalate({
        context,
        invocation,
        route,
        reasonCode: decision.reasonCode,
        message: decision.message ?? "This effect requires an explicit approval."
      });
    } catch (error) {
      return failureFromError(error, "policy", "not_started");
    }
    if (!escalation) return undefined;
    return { kind: "complete", value: escalation.value, effectOutcome: escalation.effectOutcome };
  }

  async #invokeInternal(context: AuthenticatedContext, invocation: Invocation, upstreamState?: { readonly present: boolean; readonly value?: string }, continuationToken?: string, expectedEndpoint?: string, expectedRevision?: string, continuationGeneration?: number, sink?: InvocationSink): Promise<GatewayOutcome> {
    if (!safeContext(context)) return contextFailure();
    if (!this.#started) return failure({ origin: "lifecycle", code: "gateway_not_started", message: "Gateway must be started before invocation.", status: 503, effectOutcome: "not_started" });
    if (this.#closing) return failure({ origin: "lifecycle", code: "gateway_closing", message: "Gateway is closing.", status: 503, effectOutcome: "not_started" });
    const controller = new AbortController();
    this.#controllers.add(controller);
    const signal = invocation.signal;
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      throwIfAborted(signal);
      if (invocation.contextHandle) {
        try {
          const businessContext = this.#contextStore.get(invocation.contextHandle);
          if (
            businessContext.tenant !== context.tenant ||
            businessContext.principal !== context.principal ||
            businessContext.routeRef !== invocation.routeRef ||
            businessContext.grantRevision !== currentGrantRevision(context) ||
            businessContext.credentialGeneration !== currentCredentialGeneration(context)
          ) {
            return failure({ origin: "continuation", code: "context_binding_mismatch", message: "The business context is not bound to this request.", status: 403, effectOutcome: "not_started" });
          }
        } catch (error) {
          return failureFromError(error, "continuation", "not_started");
        }
      }
      const route = this.catalogStore.resolve(invocation.routeRef);
      if (!route) return failure({ origin: "protocol", code: "route_not_found", message: "Gateway route is not published.", status: 404, effectOutcome: "not_started" });
      if (expectedEndpoint && expectedEndpoint !== route.endpointIdentity || expectedRevision && expectedRevision !== route.revision) return failure({ origin: "continuation", code: "continuation_route_changed", message: "Continuation target no longer matches its original route.", status: 409, effectOutcome: "not_started" });
      const routeSchemas = this.catalogStore.schema(route.logicalRoute);
      if (routeSchemas?.input) {
        try { routeSchemas.input.assertValid(schemaInputValue(invocation, this.#inputEnvelopeKeys)); }
        catch (error) { return schemaFailure(error, "input", "not_started"); }
      }
      const decision = await this.#policy.decide({ context, invocation, route });
      if (!decision.allowed || !decision.authority) {
        const escalated = await this.#escalateApproval(context, invocation, route, decision);
        if (escalated) return escalated;
        return failure({ origin: "policy", code: decision.reasonCode ?? "policy_denied", message: decision.message ?? "Gateway policy denied the invocation.", status: 403, effectOutcome: "not_started" });
      }
      const prepared: PreparedInvocation = Object.freeze({ invocation: Object.freeze({ ...invocation, signal: controller.signal }), route, authority: decision.authority, inputDigest: digest({ route: route.logicalRoute, revision: route.revision, method: invocation.method, params: invocation.params }) });
      const permit = await this.#permits.issue({ context, prepared, audience: route.endpointIdentity });
      const result = await this.#admission.run(route.upstreamIdentity, async () => {
        throwIfAborted(controller.signal);
        const current = this.#policy.revalidate ? await this.#policy.revalidate({ context, invocation: prepared.invocation, route, authority: prepared.authority }) : await this.#policy.decide({ context, invocation: prepared.invocation, route });
        if (!current.allowed) return failure({ origin: "policy", code: current.reasonCode ?? "policy_changed", message: current.message ?? "Gateway policy denied the invocation after admission.", status: 403, effectOutcome: "not_started" });
        let consumed;
        try { consumed = await this.#permits.consume({ permit, context, prepared }); }
        catch (error) { return failureFromError(error, "policy", "not_started"); }
        const invokeSink: InvocationSink | undefined = sink ?? (this.#upstream
          ? async (input: InvocationSinkInput) => this.#upstream!.invoke(input)
          : undefined);
        if (!invokeSink) return failure({ origin: "configuration", code: "upstream_port_missing", message: "No upstream port is configured for this gateway.", status: 503, effectOutcome: "not_started" });
        let credential: unknown;
        try {
          const binding = isPlainRecord(route.metadata) && typeof route.metadata.credentialBinding === "string" ? route.metadata.credentialBinding : undefined;
          if (binding && this.#credentialProvider) credential = await this.#credentialProvider.resolve({ binding, audience: route.endpointIdentity, context });
        } catch (error) { return failureFromError(error, "policy", "not_started"); }
        const request: import("@meshrix/contracts/gateway").UpstreamRequest = {
          id: `gw-${++this.#invocationId}`,
          method: invocation.method,
          params: invocation.params,
          protocolVersion: route.protocolVersion,
          ...(upstreamState?.present ? { requestState: upstreamState.value ?? "" } : {}),
          headers: Object.freeze({ "Mcp-Method": invocation.method, "Mcp-Protocol-Version": route.protocolVersion, ...(route.upstreamName ? { "Mcp-Name": route.upstreamName } : {}) }),
          trace: context.trace
        };
        try {
          const response = await invokeSink({ context, request, route, credential, signal: controller.signal });
          if (response && typeof response === "object" && "status" in response && Number(response.status) === 404) {
            if (invocation.contextHandle) {
              try { this.#contextStore.markLost(invocation.contextHandle, "upstream_404"); } catch { /* stale handles remain terminal */ }
            }
            return failure({ origin: "peer", code: "upstream_context_lost", message: "The upstream no longer recognizes the stateful context.", status: 410, effectOutcome: "failed" });
          }
          const upstreamResponse = response && typeof response === "object" && "status" in response ? response as UpstreamResponse : undefined;
          if (upstreamResponse && upstreamResponse.status >= 400 && !(isPlainRecord(upstreamResponse.body) && Object.hasOwn(upstreamResponse.body, "error"))) {
            if (invocation.contextHandle && isFatalUpstreamStatus(responseStatus(response))) {
              try { this.#contextStore.markLost(invocation.contextHandle, `upstream_http_${upstreamResponse.status}`); } catch { /* stale handles remain terminal */ }
            }
            await this.#permits.markOutcomeUnknown?.(consumed);
            return failure({ origin: "peer", code: `upstream_http_${upstreamResponse.status}`, message: "Upstream returned an HTTP failure.", status: 502, effectOutcome: "unknown" });
          }
          const decoded = "kind" in (response as object) && (response as { kind?: unknown }).kind !== undefined
            ? decodeUpstreamResult(response)
            : decodeUpstreamResult(response && typeof response === "object" && "status" in response ? responseBody(response as UpstreamResponse) : response, { legacy: route.protocolVersion !== "2026-07-28" });
          if (decoded.kind === "failure") {
            if (invocation.contextHandle && (isFatalUpstreamStatus(responseStatus(response)) || decoded.origin === "protocol" || decoded.origin === "transport")) {
              try { this.#contextStore.markLost(invocation.contextHandle, decoded.code); } catch { /* stale handles remain terminal */ }
            }
            return decoded;
          }
          if (decoded.kind === "input_required") {
            if (!this.#continuation) return failure({ origin: "continuation", code: "continuation_unavailable", message: "The upstream requested input but this gateway profile has no continuation codec.", status: 501, effectOutcome: "not_started" });
            const rawState = decoded.upstreamState !== undefined
              ? { present: decoded.upstreamState.present, ...(decoded.upstreamState.present ? { value: decoded.upstreamState.value ?? "" } : {}) }
              : Object.hasOwn(decoded, "requestState") && decoded.requestState !== undefined
                ? { present: true, value: decoded.requestState }
                : { present: false as const };
            const token = this.#continuation.seal({ generation: continuationGeneration === undefined ? 1 : continuationGeneration + 1, tenant: context.tenant, principal: context.principal, grantRevision: String(context.grant.revision ?? context.authGeneration), routeRef: route.logicalRoute, endpointIdentity: route.endpointIdentity, routeRevision: route.revision, method: invocation.method, params: invocation.params, paramsDigest: continuationParamsDigest(invocation.params), upstreamState: rawState, effectClass: route.effectClass, oneTime: route.effectClass !== "read", issuedAt: this.#now(), expiresAt: this.#now() + 5 * 60_000 });
            return inputRequired(decoded.inputRequests, token);
          }
          if (routeSchemas?.output) {
            try { routeSchemas.output.assertValid(decoded.value); }
            catch (error) {
              const outcome = route.effectClass === "read" ? "failed" : "unknown" as const;
              if (outcome === "unknown") await this.#permits.markOutcomeUnknown?.(consumed);
              return schemaFailure(error, "output", outcome);
            }
          }
          return decoded;
        } catch (error) {
          if (invocation.contextHandle && !(error instanceof Error && error.name === "AbortError")) {
            try { this.#contextStore.markLost(invocation.contextHandle, "upstream_fatal"); } catch { /* stale handles remain terminal */ }
          }
          const unknown = route.effectClass !== "read" && isUnknownEffectError(error);
          if (unknown) { await this.#permits.markOutcomeUnknown?.(consumed); return failureFromError(error, "transport", "unknown"); }
          return failureFromError(error, "transport", route.effectClass === "read" ? "failed" : "not_started");
        }
      }, { signal: controller.signal, deadline: invocation.deadline });
      return result;
    } catch (error) {
      return failureFromError(error, error instanceof Error && error.name === "AbortError" ? "admission" : "protocol", error instanceof Error && error.name === "AbortError" ? "cancelled" : "not_started");
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.#controllers.delete(controller);
    }
  }

  #findDescriptor(context: AuthenticatedContext, kind: CatalogDescriptor["kind"], predicate: (descriptor: CatalogDescriptor) => boolean): CatalogDescriptor | undefined {
    const page = this.catalogStore.page(context, { kind, limit: 100 });
    return page.items.find(predicate);
  }

}

export function createGateway(options: GatewayOptions = {}): GatewayKernel {
  return new GatewayKernelImpl(options);
}

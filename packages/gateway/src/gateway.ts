import type {
  AuthenticatedContext,
  AuthoritySnapshot,
  CatalogDescriptor,
  CatalogPage,
  CatalogQuery,
  ContinuationCodec,
  CurrentAuthorityPort,
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
import { complete, decodeUpstreamResult, failure, inputRequired, isGatewayFailure, isUpstreamResult, type UpstreamResult } from "./results/index.ts";
import { GatewaySchemaError } from "./schema/index.ts";
import { digest, deepFreeze, isPlainRecord, throwIfAborted } from "./utils.ts";

export interface GatewayLifecycleResource {
  readonly owned?: boolean;
  start?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface GatewayOptions {
  readonly catalog?: CatalogStore;
  readonly descriptors?: readonly CatalogDescriptor[];
  readonly policy?: GatewayPolicyPort;
  readonly currentAuthority?: CurrentAuthorityPort;
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
  receiptStatus(context: AuthenticatedContext, receiptId: string): Promise<GatewayFailure | { readonly receiptId: string; readonly state: ExecutionPermit["state"]; readonly expiresAt: number }>;
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

function continuationBusinessParams(params: unknown): unknown {
  if (!isPlainRecord(params)) return params;
  const { requestState: _requestState, inputResponses: _inputResponses, ...business } = params;
  if (isPlainRecord(business._meta)) {
    const meta = Object.fromEntries(Object.entries(business._meta).filter(([key]) => !key.startsWith("io.modelcontextprotocol/")));
    if (Object.keys(meta).length > 0) business._meta = meta;
    else delete business._meta;
  }
  return business;
}

/** Bounded RFC6570 simple/fragment-free template projection for resource URI positions only. */
function templateResourceUri(publicTemplate: string, upstreamTemplate: string, requestedUri: string): string | undefined {
  if (requestedUri.length > 4096 || publicTemplate.length > 4096 || upstreamTemplate.length > 4096) return undefined;
  const authority = publicTemplate.indexOf("://");
  const authorityEnd = authority < 0 ? -1 : publicTemplate.indexOf("/", authority + 3);
  const firstVariable = publicTemplate.indexOf("{");
  if (firstVariable < 0 || authorityEnd < 0 || firstVariable < authorityEnd) return undefined;
  const tokens = [...publicTemplate.matchAll(/\{(\+?)([A-Za-z][A-Za-z0-9_]*)\}/gu)];
  if (tokens.length === 0 || tokens.length > 16) return undefined;
  const captures = new Map<string, string>();
  let cursor = 0;
  let previousEnd = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const literal = publicTemplate.slice(previousEnd, token.index);
    if (!requestedUri.startsWith(literal, cursor)) return undefined;
    cursor += literal.length;
    const end = token.index + token[0].length;
    const nextLiteral = publicTemplate.slice(end, tokens[index + 1]?.index ?? publicTemplate.length);
    const boundary = nextLiteral ? requestedUri.indexOf(nextLiteral, cursor) : requestedUri.length;
    if (boundary <= cursor || boundary - cursor > 1024) return undefined;
    const captured = requestedUri.slice(cursor, boundary);
    if (!token[1] && /[/?#]/u.test(captured)) return undefined;
    try { decodeURIComponent(captured); } catch { return undefined; }
    if (captures.has(token[2]) && captures.get(token[2]) !== captured) return undefined;
    captures.set(token[2], captured);
    cursor = boundary;
    previousEnd = end;
  }
  if (!requestedUri.startsWith(publicTemplate.slice(previousEnd), cursor) || cursor + publicTemplate.slice(previousEnd).length !== requestedUri.length) return undefined;
  const mapped = upstreamTemplate.replace(/\{\+?([A-Za-z][A-Za-z0-9_]*)\}/gu, (_match, name: string) => captures.get(name) ?? "");
  if (mapped.includes("{") || mapped.includes("}")) return undefined;
  const upstreamAuthority = upstreamTemplate.indexOf("://");
  const upstreamAuthorityEnd = upstreamAuthority < 0 ? -1 : upstreamTemplate.indexOf("/", upstreamAuthority + 3);
  if (upstreamAuthorityEnd < 0 || upstreamTemplate.indexOf("{") < upstreamAuthorityEnd) return undefined;
  return mapped;
}

function publicResourceUris(outcome: GatewayOutcome, upstreamUri: string, publicUri: string): GatewayOutcome {
  if (outcome.kind !== "complete" || upstreamUri === publicUri || !isPlainRecord(outcome.value) || !Array.isArray(outcome.value.contents)) return outcome;
  const value = { ...outcome.value, contents: outcome.value.contents.map((item: unknown) => isPlainRecord(item) && item.uri === upstreamUri ? { ...item, uri: publicUri } : item) };
  return complete(value, { isError: outcome.isError, requestState: outcome.requestState });
}

function responseStatus(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "status")) return undefined;
  const status = Number((value as { status?: unknown }).status);
  return Number.isSafeInteger(status) ? status : undefined;
}

function isFatalUpstreamStatus(status: number | undefined): boolean {
  return status === 404 || (status !== undefined && status >= 500);
}

function safePeerData(value: unknown, depth = 0): unknown {
  if (depth > 4) return undefined;
  if (typeof value === "string") return value.length <= 1024 && !/(bearer\s+|-----BEGIN|\/Users\/|[A-Za-z]:\\Users\\)/iu.test(value) ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.length <= 32 ? value.map((item) => safePeerData(item, depth + 1)) : undefined;
  if (!isPlainRecord(value) || Object.keys(value).length > 32) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(password|secret|token|credential|authorization|cookie|stack|ciphertext)/iu.test(key))
    .map(([key, entry]) => [key, safePeerData(entry, depth + 1)])
    .filter(([, entry]) => entry !== undefined));
}

function withReceipt(outcome: GatewayFailure, permit: ExecutionPermit): GatewayFailure {
  return failure({ ...outcome, details: { ...outcome.details, receiptId: permit.id } });
}

function responseBody(response: UpstreamResponse): unknown {
  if (isPlainRecord(response.body) && Object.hasOwn(response.body, "error")) {
    const error = response.body.error;
    const peerCode = isPlainRecord(error) && Number.isSafeInteger(error.code) && Number(error.code) >= -2_147_483_648 && Number(error.code) <= 2_147_483_647 ? error.code : undefined;
    const data = isPlainRecord(error) ? safePeerData(error.data) : undefined;
    const message = isPlainRecord(error) ? safePeerData(error.message) : undefined;
    return failure({ origin: "peer", code: "upstream_jsonrpc_error", message: typeof message === "string" ? message : "Upstream returned a JSON-RPC error.", status: response.status >= 400 ? response.status : 502, effectOutcome: "failed", details: { ...(peerCode === undefined ? {} : { errorCode: peerCode }), ...(data === undefined ? {} : { errorData: data }) } });
  }
  if (isPlainRecord(response.body) && Object.hasOwn(response.body, "result")) return response.body.result;
  return response.body;
}

class GatewayKernelImpl implements GatewayKernel {
  readonly catalogStore: CatalogStore;
  readonly #policy: GatewayPolicyPort;
  readonly #currentAuthority?: CurrentAuthorityPort;
  readonly #permits: PermitAuthorityPort;
  readonly #continuation?: ContinuationCodec;
  readonly #upstream?: UpstreamPort;
  readonly #ownsUpstream: boolean;
  readonly #ownsCatalog: boolean;
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
    this.catalogStore = options.catalog ?? new CatalogStore({ isolated: true });
    this.#ownsCatalog = options.catalog === undefined;
    if (options.descriptors && options.descriptors.length > 0) this.catalogStore.publish(options.descriptors);
    this.#policy = options.policy ?? Object.freeze({ decide: () => ({ allowed: false, reasonCode: "policy_port_missing", message: "An authoritative policy port is required." }) });
    this.#currentAuthority = options.currentAuthority;
    this.#permits = options.permits ?? Object.freeze({
      issue: () => { throw Object.assign(new Error("An authoritative permit port is required."), { code: "permit_port_missing", status: 503 }); },
      consume: () => { throw Object.assign(new Error("An authoritative permit port is required."), { code: "permit_port_missing", status: 503 }); }
    });
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
      const errors: unknown[] = [];
      if (this.#active.size > 0) {
        const active = Promise.allSettled([...this.#active]).then(() => undefined);
        if (deadline === undefined) await active;
        else {
          const remaining = Math.max(0, deadline - this.#now());
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([active, new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); })]); }
          finally { if (timer) clearTimeout(timer); }
          if (this.#active.size > 0) {
            for (const controller of this.#controllers) controller.abort();
            await Promise.allSettled([...this.#active]);
          }
        }
      }
      if (this.#ownsUpstream) try { await this.#upstream?.close?.(); } catch (error) { errors.push(error); }
      if (this.#ownsCatalog) try { await this.catalogStore.close(); } catch (error) { errors.push(error); }
      for (const resource of [...this.#lifecycle].reverse()) {
        if (resource.owned === false) continue;
        try { await resource.close?.(); } catch (error) { errors.push(error); }
      }
      this.#started = false;
      if (errors.length > 0) throw new AggregateError(errors, "Gateway cleanup failed.");
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
    if (invocation.requestState !== undefined) return this.#continueBound(context, invocation.requestState, invocation.inputResponses, invocation.signal, invocation);
    return this.#track(this.#invokeInternal(context, invocation));
  }

  #track(task: Promise<GatewayOutcome>): Promise<GatewayOutcome> {
    this.#active.add(task);
    return task.finally(() => this.#active.delete(task));
  }

  async receiptStatus(context: AuthenticatedContext, receiptId: string): Promise<GatewayFailure | { readonly receiptId: string; readonly state: ExecutionPermit["state"]; readonly expiresAt: number }> {
    if (!this.#started || this.#closing) return failure({ origin: "lifecycle", code: "gateway_not_started", message: "Gateway is not available.", status: 503, effectOutcome: "not_started" });
    if (!safeContext(context) || typeof receiptId !== "string" || receiptId.length > 128 || !receiptId) return failure({ origin: "policy", code: "receipt_forbidden", message: "Receipt is not available to this subject.", status: 403, effectOutcome: "not_started" });
    if (!this.#permits.lookup) return failure({ origin: "configuration", code: "receipt_unavailable", message: "Receipt inspection is not supported by this permit authority.", status: 501, effectOutcome: "not_started" });
    const permit = await this.#permits.lookup({ context, receiptId });
    if (!permit || !permit.routeRef) return failure({ origin: "policy", code: "receipt_not_found", message: "Receipt is not available to this subject.", status: 404, effectOutcome: "not_started" });
    const route = this.catalogStore.resolve(permit.routeRef);
    if (!route || route.revision !== permit.routeRevision || route.endpointIdentity !== permit.target) return failure({ origin: "policy", code: "receipt_target_changed", message: "Receipt target is no longer current.", status: 409, effectOutcome: "not_started" });
    if (this.#currentAuthority) {
      try {
        const current = await this.#currentAuthority.read({ context, route });
        if (!safeContext(current) || current.tenant !== permit.tenant || current.principal !== permit.principal || current.grant.revoked === true || currentGrantRevision(current) !== permit.grantRevision) return failure({ origin: "policy", code: "receipt_forbidden", message: "Receipt is not available to this subject.", status: 403, effectOutcome: "not_started" });
      } catch { return failure({ origin: "policy", code: "receipt_forbidden", message: "Receipt is not available to this subject.", status: 403, effectOutcome: "not_started" }); }
    }
    return Object.freeze({ receiptId, state: permit.state, expiresAt: permit.expiresAt });
  }

  continue(context: AuthenticatedContext, requestState: string, inputResponses: Readonly<Record<string, unknown>> = {}, signal?: AbortSignal): Promise<GatewayOutcome> {
    return this.#continueBound(context, requestState, inputResponses, signal);
  }

  async #continueBound(context: AuthenticatedContext, requestState: string, inputResponses: Readonly<Record<string, unknown>> = {}, signal?: AbortSignal, requested?: Invocation, sink?: InvocationSink): Promise<GatewayOutcome> {
    if (!safeContext(context)) return contextFailure();
    if (!this.#continuation) return failure({ origin: "continuation", code: "continuation_unavailable", message: "This gateway profile does not provide continuation state.", status: 501, effectOutcome: "not_started" });
    let payload;
    try { payload = this.#continuation.open(requestState, this.#now()); } catch (error) { return failureFromError(error, "continuation", "not_started"); }
    if (payload.tenant !== context.tenant || payload.principal !== context.principal || payload.grantRevision !== currentGrantRevision(context)) {
      return failure({ origin: "continuation", code: "continuation_subject_mismatch", message: "Continuation is not bound to the authenticated context.", status: 403, effectOutcome: "not_started" });
    }
    if (requested && (requested.routeRef !== payload.routeRef || requested.method !== payload.method ||
      continuationParamsDigest(continuationBusinessParams(requested.params)) !== payload.paramsDigest || requested.contextHandle !== payload.contextHandle)) {
      return failure({ origin: "continuation", code: "continuation_request_mismatch", message: "Continuation does not match the original request.", status: 403, effectOutcome: "not_started" });
    }
    if (!isPlainRecord(inputResponses)) return failure({ origin: "continuation", code: "continuation_responses_invalid", message: "InputResponses must be a keyed object.", status: 400, effectOutcome: "not_started" });
    try { await this.#continuation.claim?.(requestState, payload); } catch (error) { return failureFromError(error, "continuation", "not_started"); }
    const params = isPlainRecord(payload.params)
      ? { ...payload.params, ...(Object.keys(inputResponses).length > 0 ? { inputResponses: structuredClone(inputResponses) } : {}) }
      : payload.params;
    const invocation: Invocation = Object.freeze({ routeRef: payload.routeRef, method: payload.method, params, signal, ...(payload.contextHandle ? { contextHandle: payload.contextHandle } : {}), inputResponses });
    const task = this.#invokeInternal(context, invocation, { present: payload.upstreamState.present, ...(payload.upstreamState.present ? { value: payload.upstreamState.value ?? "" } : {}) }, requestState, payload.endpointIdentity, payload.routeRevision, payload.generation, sink);
    const outcome = await this.#track(task);
    if (payload.oneTime) {
      try {
        if (outcome.kind === "failure" && outcome.effectOutcome === "not_started") await this.#continuation.release?.(requestState);
        else await this.#continuation.settle?.(requestState, outcome.kind === "failure" && outcome.effectOutcome === "unknown" ? "outcome_unknown" : "consumed");
      } catch {
        return failure({ origin: "continuation", code: "continuation_settlement_failed", message: "Continuation outcome could not be recorded safely.", status: 503, effectOutcome: outcome.kind === "failure" && outcome.effectOutcome === "not_started" ? "not_started" : "unknown" });
      }
    }
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

  async readResource(context: AuthenticatedContext, uri: string, signal?: AbortSignal, requestState?: string, inputResponses?: Readonly<Record<string, unknown>>): Promise<GatewayOutcome> {
    const direct = this.#findDescriptor(context, "resource", (item) => item.publicUri === uri || item.upstreamUri === uri);
    const template = direct ? undefined : this.#findDescriptor(context, "resource_template", (item) => !!item.publicUri && !!item.upstreamUri && templateResourceUri(item.publicUri, item.upstreamUri, uri) !== undefined);
    const descriptor = direct ?? template;
    if (!descriptor) return failure({ origin: "protocol", code: "resource_not_found", message: "Resource is not published.", status: 404, effectOutcome: "not_started" });
    const upstreamUri = template ? templateResourceUri(template.publicUri!, template.upstreamUri!, uri)! : descriptor.upstreamUri ?? uri;
    const invocation: Invocation = { routeRef: descriptor.route.logicalRoute, method: "resources/read", params: { uri: upstreamUri }, signal, ...(requestState !== undefined ? { requestState } : {}), ...(inputResponses ? { inputResponses } : {}) };
    if (this.#resources) {
      const sink: InvocationSink = async ({ context: sinkContext, route, signal: sinkSignal, request }) => normalizePortResult(await this.#resources!.read({ context: sinkContext!, route, uri: upstreamUri, ...(request.requestState !== undefined ? { requestState: request.requestState } : {}), ...(inputResponses ? { inputResponses } : {}), signal: sinkSignal }));
      if (requestState !== undefined) return publicResourceUris(await this.#continueBound(context, requestState, inputResponses, signal, invocation, sink), upstreamUri, uri);
      return publicResourceUris(await this.#track(this.#invokeInternal(
        context, invocation,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sink
      )), upstreamUri, uri);
    }
    return publicResourceUris(await this.invoke(context, invocation), upstreamUri, uri);
  }

  async getPrompt(context: AuthenticatedContext, name: string, args: Readonly<Record<string, unknown>> = {}, signal?: AbortSignal, requestState?: string, inputResponses?: Readonly<Record<string, unknown>>): Promise<GatewayOutcome> {
    const descriptor = this.#findDescriptor(context, "prompt", (item) => item.publicName === name || item.upstreamName === name);
    if (!descriptor) return failure({ origin: "protocol", code: "prompt_not_found", message: "Prompt is not published.", status: 404, effectOutcome: "not_started" });
    const invocation: Invocation = { routeRef: descriptor.route.logicalRoute, method: "prompts/get", params: { name: descriptor.upstreamName ?? name, arguments: { ...args } }, signal, ...(requestState !== undefined ? { requestState } : {}), ...(inputResponses ? { inputResponses } : {}) };
    if (this.#prompts) {
      const sink: InvocationSink = async ({ context: sinkContext, route, signal: sinkSignal, request }) => normalizePortResult(await this.#prompts!.get({ context: sinkContext!, route, name: descriptor.upstreamName ?? name, arguments: args, ...(request.requestState !== undefined ? { requestState: request.requestState } : {}), ...(inputResponses ? { inputResponses } : {}), signal: sinkSignal }));
      if (requestState !== undefined) return this.#continueBound(context, requestState, inputResponses, signal, invocation, sink);
      return this.#track(this.#invokeInternal(
        context, invocation,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sink
      ));
    }
    return this.invoke(context, invocation);
  }

  async completePrompt(context: AuthenticatedContext, argument: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<GatewayOutcome> {
    const name = typeof argument.name === "string" ? argument.name : "";
    const descriptor = this.#findDescriptor(context, "prompt", (item) => item.publicName === name || item.upstreamName === name);
    if (!descriptor || !this.#prompts?.complete) return failure({ origin: "protocol", code: "prompt_completion_unsupported", message: "Prompt completion is not available for this route.", status: 501, effectOutcome: "not_started" });
    return this.#track(this.#invokeInternal(
      context,
      { routeRef: descriptor.route.logicalRoute, method: "completion/complete", params: { ...argument }, signal },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async ({ context: sinkContext, route, signal: sinkSignal }) => normalizePortResult(await this.#prompts!.complete!({ context: sinkContext!, route, argument, signal: sinkSignal }))
    ));
  }

  stats(): GatewayStats {
    return Object.freeze({ started: this.#started, closing: this.#closing, activeInvocations: this.#active.size, controllers: this.#controllers.size,
      catalogRevision: this.catalogStore.snapshot().revision, catalogRetention: this.catalogStore.retentionStats(),
      contexts: this.#contextStore.retentionBudget(), subscriptions: this.#hub.stats(), permits: this.#permits.stats?.() ?? {}, admission: this.#admission.stats() });
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
        try { await routeSchemas.input.assertValid(schemaInputValue(invocation, this.#inputEnvelopeKeys), controller.signal); }
        catch (error) { return schemaFailure(error, "input", "not_started"); }
      }
      const decision = await this.#policy.decide({ context, invocation, route });
      if (!decision.allowed || !decision.authority) {
        const escalated = await this.#escalateApproval(context, invocation, route, decision);
        if (escalated) return escalated;
        return failure({ origin: "policy", code: decision.reasonCode ?? "policy_denied", message: decision.message ?? "Gateway policy denied the invocation.", status: 403, effectOutcome: "not_started" });
      }
      const prepared: PreparedInvocation = Object.freeze({ invocation: Object.freeze({ ...invocation, signal: controller.signal }), route, authority: decision.authority, inputDigest: digest({ route: route.logicalRoute, revision: route.revision, method: invocation.method, params: invocation.params }) });
      const result = await this.#admission.run(route.upstreamIdentity, async () => {
        throwIfAborted(controller.signal);
        const liveRoute = this.catalogStore.resolve(route.logicalRoute);
        if (!liveRoute || liveRoute.revision !== route.revision || liveRoute.endpointIdentity !== route.endpointIdentity) return failure({ origin: "policy", code: "route_changed", message: "The target changed during admission.", status: 409, effectOutcome: "not_started" });
        const liveContext = this.#currentAuthority ? await this.#currentAuthority.read({ context, route }) : context;
        if (!safeContext(liveContext) || liveContext.tenant !== context.tenant || liveContext.principal !== context.principal || currentGrantRevision(liveContext) !== prepared.authority.grantRevision || currentCredentialGeneration(liveContext) !== currentCredentialGeneration(context)) return failure({ origin: "policy", code: "authority_changed", message: "The current authorization has changed.", status: 403, effectOutcome: "not_started" });
        const current = this.#policy.revalidate ? await this.#policy.revalidate({ context: liveContext, invocation: prepared.invocation, route, authority: prepared.authority }) : await this.#policy.decide({ context: liveContext, invocation: prepared.invocation, route });
        if (!current.allowed) return failure({ origin: "policy", code: current.reasonCode ?? "policy_changed", message: current.message ?? "Gateway policy denied the invocation after admission.", status: 403, effectOutcome: "not_started" });
        const invokeSink: InvocationSink | undefined = sink ?? (this.#upstream
          ? async (input: InvocationSinkInput) => this.#upstream!.invoke(input)
          : undefined);
        if (!invokeSink) return failure({ origin: "configuration", code: "upstream_port_missing", message: "No upstream port is configured for this gateway.", status: 503, effectOutcome: "not_started" });
        const permit = await this.#permits.issue({ context: liveContext, prepared, audience: route.endpointIdentity });
        let consumed;
        try { consumed = await this.#permits.consume({ permit, context: liveContext, prepared }); }
        catch (error) { return failureFromError(error, "policy", "not_started"); }
        let credential: unknown;
        try {
          const binding = isPlainRecord(route.metadata) && typeof route.metadata.credentialBinding === "string" ? route.metadata.credentialBinding : undefined;
          if (binding && !this.#credentialProvider) return failure({ origin: "configuration", code: "credential_provider_missing", message: "Required credential provider is unavailable.", status: 503, effectOutcome: "not_started" });
          if (binding) credential = await this.#credentialProvider!.resolve({ binding, audience: route.endpointIdentity, context: liveContext });
        } catch (error) { return failureFromError(error, "policy", "not_started"); }
        const finalRoute = this.catalogStore.resolve(route.logicalRoute);
        const finalContext = this.#currentAuthority ? await this.#currentAuthority.read({ context: liveContext, route }) : liveContext;
        if (!finalRoute || finalRoute.revision !== route.revision || finalRoute.endpointIdentity !== route.endpointIdentity || !safeContext(finalContext) || finalContext.tenant !== context.tenant || finalContext.principal !== context.principal || currentGrantRevision(finalContext) !== prepared.authority.grantRevision || currentCredentialGeneration(finalContext) !== currentCredentialGeneration(liveContext)) return failure({ origin: "policy", code: "authority_changed", message: "The target or authorization changed before dispatch.", status: 403, effectOutcome: "not_started" });
        const finalDecision = this.#policy.revalidate ? await this.#policy.revalidate({ context: finalContext, invocation: prepared.invocation, route, authority: prepared.authority }) : await this.#policy.decide({ context: finalContext, invocation: prepared.invocation, route });
        if (!finalDecision.allowed) return failure({ origin: "policy", code: finalDecision.reasonCode ?? "policy_changed", message: "Current authorization was revoked before dispatch.", status: 403, effectOutcome: "not_started" });
        const request: import("@meshrix/contracts/gateway").UpstreamRequest = {
          id: `gw-${++this.#invocationId}`,
          method: invocation.method,
          params: invocation.params,
          protocolVersion: route.protocolVersion,
          ...(upstreamState?.present ? { requestState: upstreamState.value ?? "" } : {}),
          headers: Object.freeze({ "Mcp-Method": invocation.method, "Mcp-Protocol-Version": route.protocolVersion, ...(route.upstreamName ? { "Mcp-Name": route.upstreamName } : {}) }),
          trace: finalContext.trace
        };
        try {
          const response = await invokeSink({ context: finalContext, request, route, credential, signal: controller.signal });
          if (response && typeof response === "object" && "status" in response && Number(response.status) === 404) {
            if (invocation.contextHandle) {
              try { this.#contextStore.markLost(invocation.contextHandle, "upstream_404"); } catch { /* stale handles remain terminal */ }
            }
            if (route.effectClass !== "read") await this.#permits.markOutcomeUnknown?.(consumed);
            const lost = failure({ origin: "peer", code: "upstream_context_lost", message: "The upstream no longer recognizes the stateful context.", status: 410, effectOutcome: route.effectClass === "read" ? "failed" : "unknown" });
            return route.effectClass === "read" ? lost : withReceipt(lost, consumed);
          }
          const upstreamResponse = response && typeof response === "object" && "status" in response ? response as UpstreamResponse : undefined;
          if (upstreamResponse && upstreamResponse.status >= 400 && !(isPlainRecord(upstreamResponse.body) && Object.hasOwn(upstreamResponse.body, "error"))) {
            if (invocation.contextHandle && isFatalUpstreamStatus(responseStatus(response))) {
              try { this.#contextStore.markLost(invocation.contextHandle, `upstream_http_${upstreamResponse.status}`); } catch { /* stale handles remain terminal */ }
            }
            if (route.effectClass !== "read") await this.#permits.markOutcomeUnknown?.(consumed);
            const failedHttp = failure({ origin: "peer", code: `upstream_http_${upstreamResponse.status}`, message: "Upstream returned an HTTP failure.", status: 502, effectOutcome: route.effectClass === "read" ? "failed" : "unknown" });
            return route.effectClass === "read" ? failedHttp : withReceipt(failedHttp, consumed);
          }
          const wireBody = upstreamResponse ? responseBody(upstreamResponse) : response;
          const decoded = upstreamResponse && isGatewayFailure(wireBody)
            ? wireBody
            : !upstreamResponse && isUpstreamResult(response)
              ? response
              : decodeUpstreamResult(wireBody, { legacy: route.protocolVersion !== "2026-07-28" });
          if (decoded.kind === "failure") {
            if (upstreamResponse && isGatewayFailure(wireBody) && route.effectClass !== "read") {
              await this.#permits.markOutcomeUnknown?.(consumed);
              return withReceipt(failure({ ...decoded, effectOutcome: "unknown" }), consumed);
            }
            if (invocation.contextHandle && (isFatalUpstreamStatus(responseStatus(response)) || decoded.origin === "protocol" || decoded.origin === "transport")) {
              try { this.#contextStore.markLost(invocation.contextHandle, decoded.code); } catch { /* stale handles remain terminal */ }
            }
            if (decoded.effectOutcome === "unknown" && route.effectClass !== "read") {
              await this.#permits.markOutcomeUnknown?.(consumed);
              return withReceipt(decoded, consumed);
            }
            return decoded;
          }
          if (decoded.kind === "input_required") {
            if (!this.#continuation) {
              if (route.effectClass !== "read") await this.#permits.markOutcomeUnknown?.(consumed);
              const unavailable = failure({ origin: "continuation", code: "continuation_unavailable", message: "The upstream requested input but this gateway profile has no continuation codec.", status: 501, effectOutcome: route.effectClass === "read" ? "failed" : "unknown" });
              return route.effectClass === "read" ? unavailable : withReceipt(unavailable, consumed);
            }
            const rawState = decoded.upstreamState !== undefined
              ? { present: decoded.upstreamState.present, ...(decoded.upstreamState.present ? { value: decoded.upstreamState.value ?? "" } : {}) }
              : Object.hasOwn(decoded, "requestState") && decoded.requestState !== undefined
                ? { present: true, value: decoded.requestState }
                : { present: false as const };
            const originalParams = continuationBusinessParams(invocation.params);
            const token = this.#continuation.seal({ generation: continuationGeneration === undefined ? 1 : continuationGeneration + 1, tenant: context.tenant, principal: context.principal, grantRevision: String(context.grant.revision ?? context.authGeneration), routeRef: route.logicalRoute, endpointIdentity: route.endpointIdentity, routeRevision: route.revision, method: invocation.method, params: originalParams, paramsDigest: continuationParamsDigest(originalParams), ...(invocation.contextHandle ? { contextHandle: invocation.contextHandle } : {}), upstreamState: rawState, effectClass: route.effectClass, oneTime: route.effectClass !== "read", issuedAt: this.#now(), expiresAt: this.#now() + 5 * 60_000 });
            return inputRequired(decoded.inputRequests, token);
          }
          if (routeSchemas?.output) {
            try { await routeSchemas.output.assertValid(isPlainRecord(decoded.value) && Object.hasOwn(decoded.value, "structuredContent") ? decoded.value.structuredContent : decoded.value, controller.signal); }
            catch (error) {
              const outcome = route.effectClass === "read" ? "failed" : "unknown" as const;
              if (outcome === "unknown") await this.#permits.markOutcomeUnknown?.(consumed);
              const rejected = schemaFailure(error, "output", outcome);
              return outcome === "unknown" ? withReceipt(rejected, consumed) : rejected;
            }
          }
          return decoded;
        } catch (error) {
          if (invocation.contextHandle && !(error instanceof Error && error.name === "AbortError")) {
            try { this.#contextStore.markLost(invocation.contextHandle, "upstream_fatal"); } catch { /* stale handles remain terminal */ }
          }
          // Once the final sink is entered, a write may have reached the peer before a
          // timeout, disconnect, decode error, or local abort becomes observable.
          const unknown = route.effectClass !== "read";
          if (unknown) { await this.#permits.markOutcomeUnknown?.(consumed); return withReceipt(failureFromError(error, "transport", "unknown"), consumed); }
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
    return this.catalogStore.findVisible(context, kind, predicate);
  }

}

export function createGateway(options: GatewayOptions = {}): GatewayKernel {
  return new GatewayKernelImpl(options);
}

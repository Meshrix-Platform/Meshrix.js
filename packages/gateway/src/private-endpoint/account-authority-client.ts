import { createHash, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";
import {
  ACCOUNT_API_ROUTES,
  accountDeviceAuthorityTranscript,
  canonicalAccountActionTarget,
  isAccountStepUpPermitId,
  type AccountActionTarget,
  type AccountAuthorityBinding,
  type AccountDeviceAuthorityProof,
  type AccountDeviceCurrentBindingResponse,
  type AccountDeviceManagedRouteResponse,
  type AccountManagedRouteBinding,
  type AccountPendingPairing,
  type AccountStepUpInspectionResult,
  type AccountStepUpPurpose,
  type AccountStepUpConsumeResult
} from "@meshrix/contracts/account";
import type {
  EndpointAccountPairingAuthority,
  EndpointPairingProofPort
} from "./account-pairing.ts";

function endpointConfigError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

async function readBoundedResponseText(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    await body.cancel().catch(() => undefined);
    throw endpointConfigError("account_authority_response_invalid", "Account authority returned an oversized response.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw endpointConfigError("account_authority_response_invalid", "Account authority returned an oversized response.");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface AccountEndpointClientOptions {
  readonly origin: string | URL;
  readonly tenantId: string;
  readonly routeId: string;
  readonly deviceId: string;
  /** Ed25519 key registered for this exact route endpoint or Entry device. */
  readonly signingKey: KeyObject;
  readonly fetch?: typeof fetch;
  readonly nonceFactory?: () => string;
}

/** Signed, fail-closed HTTP adapter for endpoint-owned account authority calls. */
export class AccountEndpointAuthorityClient implements EndpointAccountPairingAuthority, EndpointPairingProofPort {
  readonly #origin: URL;
  readonly #tenantId: string;
  readonly #routeId: string;
  readonly #deviceId: string;
  readonly #signingKey: KeyObject;
  readonly #fetch: typeof fetch;
  readonly #nonceFactory: () => string;

  constructor(options: AccountEndpointClientOptions) {
    this.#origin = normalizeOrigin(options.origin);
    this.#tenantId = options.tenantId;
    this.#routeId = options.routeId;
    this.#deviceId = options.deviceId;
    this.#signingKey = options.signingKey;
    this.#fetch = options.fetch ?? fetch;
    this.#nonceFactory = options.nonceFactory ?? (() => randomBytes(24).toString("base64url"));
  }

  async currentBinding(accountId: string, peerDeviceId: string): Promise<AccountAuthorityBinding | null> {
    const proof = this.#proof({ purpose: "current_binding", peerDeviceId });
    const value = await this.#post(ACCOUNT_API_ROUTES.deviceCurrentBinding, { peerDeviceId, proof });
    if (!isCurrentBinding(value) || value.account.accountId !== accountId) return null;
    return value.account;
  }

  async currentDeviceAuthorization(peerDeviceId: string): Promise<AccountDeviceCurrentBindingResponse> {
    const proof = this.#proof({ purpose: "current_binding", peerDeviceId });
    const value = await this.#post(ACCOUNT_API_ROUTES.deviceCurrentBinding, { peerDeviceId, proof });
    if (!isCurrentBinding(value)) {
      throw endpointConfigError("account_authority_response_invalid", "Account authority returned an invalid current-binding response.");
    }
    return value;
  }

  /** Prove this endpoint key and retrieve its current canonical route owner. */
  async managedRoute(): Promise<AccountManagedRouteBinding | null> {
    const proof = this.#proof({ purpose: "managed_route" });
    const value = await this.#post(ACCOUNT_API_ROUTES.deviceManagedRoute, { proof }) as AccountDeviceManagedRouteResponse;
    return isManagedRoute(value?.managedRoute) ? value.managedRoute : null;
  }

  async inspectPendingPairing(input: { readonly bootstrapId: string }): Promise<AccountPendingPairing | null> {
    const proof = this.#proof({ purpose: "inspect_pairing", bootstrapId: input.bootstrapId });
    const value = await this.#post(ACCOUNT_API_ROUTES.devicePendingPairingInspect, { bootstrapId: input.bootstrapId, proof });
    return value === null || isPendingPairing(value) ? value : null;
  }

  async inspect(input: { readonly bootstrapId: string }): Promise<unknown> {
    return this.inspectPendingPairing(input);
  }

  async publishPairingTarget(input: { readonly bootstrapId: string; readonly target: AccountActionTarget }): Promise<AccountPendingPairing | null> {
    const proof = this.#proof({
      purpose: "publish_pairing_target",
      bootstrapId: input.bootstrapId,
      targetDigest: targetDigest(input.target)
    });
    const value = await this.#post(ACCOUNT_API_ROUTES.devicePairingTargetPublish, { ...input, proof });
    return value === null || isPendingPairing(value) ? value : null;
  }

  async publishTarget(input: { readonly bootstrapId: string; readonly target: AccountActionTarget }): Promise<unknown> {
    return this.publishPairingTarget(input);
  }

  async inspectStepUpPermit(input: {
    readonly account: AccountAuthorityBinding;
    readonly permitId: string;
    readonly purpose: AccountStepUpPurpose;
    readonly target: AccountActionTarget;
    readonly bootstrapId?: string;
  }): Promise<AccountStepUpInspectionResult> {
    if (!isAccountStepUpPermitId(input.permitId)) return { valid: false, reason: "permit_missing" };
    const proof = this.#proof({
      purpose: "inspect_step_up",
      ...(input.bootstrapId ? { bootstrapId: input.bootstrapId } : {}),
      permitId: input.permitId,
      targetDigest: targetDigest(input.target)
    });
    const value = await this.#post(ACCOUNT_API_ROUTES.deviceStepUpInspect, { ...input, proof });
    if (!isStepUpInspection(value)) {
      throw endpointConfigError("account_authority_response_invalid", "Account authority returned an invalid step-up decision.");
    }
    return value;
  }

  async inspectPermit(input: Parameters<EndpointPairingProofPort["inspectPermit"]>[0]): Promise<AccountStepUpInspectionResult> {
    return this.inspectStepUpPermit(input);
  }

  async consumeStepUpPermit(input: {
    readonly account: AccountAuthorityBinding;
    readonly permitId: string;
    readonly purpose: AccountStepUpPurpose;
    readonly target: AccountActionTarget;
    readonly bootstrapId?: string;
    readonly operationId: string;
  }): Promise<AccountStepUpConsumeResult> {
    if (!isAccountStepUpPermitId(input.permitId)) return { consumed: false, reason: "permit_missing" };
    const proof = this.#proof({
      purpose: "consume_step_up",
      ...(input.bootstrapId ? { bootstrapId: input.bootstrapId } : {}),
      permitId: input.permitId,
      operationId: input.operationId,
      targetDigest: targetDigest(input.target)
    });
    const value = await this.#post(ACCOUNT_API_ROUTES.deviceStepUpConsume, { ...input, proof });
    return isStepUpConsume(value) ? value : { consumed: false, reason: "permit_missing" };
  }

  async consumePermit(input: Parameters<EndpointPairingProofPort["consumePermit"]>[0]): Promise<{ readonly consumed: boolean; readonly replayed?: boolean }> {
    const result = await this.consumeStepUpPermit(input);
    return result.consumed ? { consumed: true, replayed: result.replayed } : { consumed: false };
  }

  async completePairing(input: {
    readonly account: AccountAuthorityBinding;
    readonly bootstrapId: string;
    readonly operationId: string;
    readonly target: AccountActionTarget;
  }): Promise<{ readonly completed: boolean; readonly relayAdmissionActive: boolean }> {
    const proof = this.#proof({
      purpose: "complete_pairing",
      bootstrapId: input.bootstrapId,
      operationId: input.operationId,
      targetDigest: targetDigest(input.target)
    });
    const value = await this.#post(ACCOUNT_API_ROUTES.devicePairingComplete, { ...input, proof });
    if (!isRecord(value) || typeof value.completed !== "boolean" || typeof value.relayAdmissionActive !== "boolean") {
      return { completed: false, relayAdmissionActive: false };
    }
    return { completed: value.completed, relayAdmissionActive: value.relayAdmissionActive };
  }

  async complete(input: Parameters<EndpointPairingProofPort["complete"]>[0]): Promise<{ readonly completed: boolean; readonly relayAdmissionActive: boolean }> {
    return this.completePairing(input);
  }

  /** Sign a narrowly scoped proof for endpoint ownership claim completion. */
  signClaimProof(input: {
    readonly claimId: string;
    readonly permitId: string;
    readonly operationId: string;
    readonly endpointPinRef: string;
    readonly target: AccountActionTarget;
  }): AccountDeviceAuthorityProof {
    if (!isAccountStepUpPermitId(input.permitId)) {
      throw endpointConfigError("account_authority_permit_invalid", "The step-up permit does not match the account authority format.");
    }
    return this.#proof({
      purpose: "claim_endpoint",
      claimId: input.claimId,
      permitId: input.permitId,
      operationId: input.operationId,
      endpointPinRef: input.endpointPinRef,
      targetDigest: targetDigest(input.target)
    });
  }

  #proof(input: {
    readonly purpose: AccountDeviceAuthorityProof["purpose"];
    readonly bootstrapId?: string;
    readonly endpointPinRef?: string;
    readonly claimId?: string;
    readonly permitId?: string;
    readonly operationId?: string;
    readonly peerDeviceId?: string;
    readonly targetDigest?: string;
    readonly requestDigest?: string;
  }): AccountDeviceAuthorityProof {
    const unsigned = Object.freeze({
      purpose: input.purpose,
      tenantId: this.#tenantId,
      routeId: this.#routeId,
      deviceId: this.#deviceId,
      nonce: this.#nonceFactory(),
      ...(input.bootstrapId ? { bootstrapId: input.bootstrapId } : {}),
      ...(input.endpointPinRef ? { endpointPinRef: input.endpointPinRef } : {}),
      ...(input.claimId ? { claimId: input.claimId } : {}),
      ...(input.permitId ? { permitId: input.permitId } : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.peerDeviceId ? { peerDeviceId: input.peerDeviceId } : {}),
      ...(input.requestDigest ? { requestDigest: input.requestDigest } : {}),
      ...(input.targetDigest ? { targetDigest: input.targetDigest } : {})
    });
    return Object.freeze({
      ...unsigned,
      signature: cryptoSign(null, Buffer.from(accountDeviceAuthorityTranscript(unsigned), "utf8"), this.#signingKey).toString("base64url")
    });
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#origin), {
        method: "POST",
        redirect: "error",
        headers: { accept: "application/json", "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(body)
      });
    } catch {
      throw endpointConfigError("account_authority_unavailable", "Account authority could not be reached.");
    }
    const text = await readBoundedResponseText(response);
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw endpointConfigError("account_authority_response_invalid", "Account authority returned an invalid response."); }
    if (!response.ok) {
      const code = isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" ? value.error.code : "account_authority_refused";
      throw endpointConfigError(code, "Account authority refused the endpoint request.");
    }
    return value;
  }
}

export type AccountDeviceAuthorizationDecision =
  | { readonly state: "current"; readonly response: AccountDeviceCurrentBindingResponse }
  | { readonly state: "revoked" }
  | { readonly state: "unavailable" }
  | { readonly state: "denied" };

/**
 * Role-neutral current-grant check for one exact personal route. The local
 * device key signs the request; the authority checks the counterpart based on
 * whether that key is the route endpoint or a currently enrolled Entry.
 */
export class AccountDeviceAuthorizationClient {
  readonly #tenantId: string;
  readonly #routeId: string;
  readonly #deviceId: string;
  readonly #authority: AccountEndpointAuthorityClient;

  constructor(options: AccountEndpointClientOptions) {
    this.#tenantId = options.tenantId;
    this.#routeId = options.routeId;
    this.#deviceId = options.deviceId;
    this.#authority = new AccountEndpointAuthorityClient(options);
  }

  async check(input: {
    readonly peerDeviceId: string;
    readonly binding: AccountAuthorityBinding;
    /** Exact Entry grants retained by the local pairing authority. */
    readonly authorizedTargets: readonly AccountActionTarget[];
    readonly scope?: string;
  }): Promise<AccountDeviceAuthorizationDecision> {
    if (input.authorizedTargets.length === 0
      || input.authorizedTargets.some((target) => target.tenantId !== this.#tenantId || target.routeId !== this.#routeId)) {
      return { state: "revoked" };
    }
    let response: AccountDeviceCurrentBindingResponse;
    try {
      response = await this.#authority.currentDeviceAuthorization(input.peerDeviceId);
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
      if (code === "not_found") return { state: "revoked" };
      if (code === "forbidden") return { state: "denied" };
      return { state: "unavailable" };
    }
    if (!response || response.account.accountId !== input.binding.accountId || response.account.authEpoch !== input.binding.authEpoch
      || !response.target || !input.authorizedTargets.some((target) => canonicalAccountActionTarget(target) === canonicalAccountActionTarget(response.target!))) {
      return { state: "revoked" };
    }
    const authorizedScopes = new Set(input.authorizedTargets.flatMap((target) => target.scopes));
    const currentScopes = new Set(response.authorizedScopes);
    if (currentScopes.size !== response.authorizedScopes.length || [...currentScopes].some((scope) => !authorizedScopes.has(scope))
      || response.target.scopes.some((scope) => !currentScopes.has(scope))
      || (input.scope !== undefined && !currentScopes.has(input.scope))) return { state: "revoked" };
    return Object.freeze({ state: "current", response });
  }
}

function normalizeOrigin(value: string | URL): URL {
  const origin = value instanceof URL ? new URL(value.toString()) : new URL(value);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw endpointConfigError("account_authority_origin_invalid", "Account authority origin must be an HTTPS origin without a path or credentials.");
  }
  return origin;
}

function targetDigest(target: AccountActionTarget): string {
  return createHash("sha256").update(canonicalAccountActionTarget(target), "utf8").digest("base64url");
}

function isCurrentBinding(value: unknown): value is AccountDeviceCurrentBindingResponse {
  if (!isRecord(value) || !isBinding(value.account) || !(value.target === null || isTarget(value.target))
    || !Array.isArray(value.authorizedScopes) || !value.authorizedScopes.every((scope) => typeof scope === "string")) return false;
  return value.target === null || value.target.deviceId.length > 0;
}

function isPendingPairing(value: unknown): value is AccountPendingPairing {
  return isRecord(value) && typeof value.bootstrapId === "string" && isBinding(value.account)
    && typeof value.tenantId === "string" && typeof value.routeId === "string"
    && typeof value.entryDeviceId === "string" && typeof value.entryDevicePublicKey === "string"
    && typeof value.endpointDeviceId === "string" && typeof value.endpointPinRef === "string"
    && (value.target === null || isTarget(value.target)) && typeof value.expiresAt === "string";
}

function isStepUpInspection(value: unknown): value is AccountStepUpInspectionResult {
  if (!isRecord(value) || typeof value.valid !== "boolean") return false;
  return value.valid ? isRecord(value.permit) && isAccountStepUpPermitId(value.permit.permitId) : typeof value.reason === "string";
}

function isStepUpConsume(value: unknown): value is AccountStepUpConsumeResult {
  return isRecord(value) && (value.consumed === true && typeof value.replayed === "boolean"
    || value.consumed === false && typeof value.reason === "string");
}

function isBinding(value: unknown): value is AccountAuthorityBinding {
  return isRecord(value) && typeof value.accountId === "string" && Number.isSafeInteger(value.authEpoch) && Number(value.authEpoch) > 0;
}

function isManagedRoute(value: unknown): value is AccountManagedRouteBinding {
  return isRecord(value) && typeof value.accountId === "string" && value.accountId.length > 0
    && typeof value.tenantId === "string" && typeof value.routeId === "string"
    && Number.isSafeInteger(value.authEpoch) && Number(value.authEpoch) > 0
    && typeof value.endpointDeviceId === "string" && typeof value.endpointPublicKey === "string"
    && typeof value.endpointPinRef === "string" && typeof value.vaultId === "string";
}

function isTarget(value: unknown): value is AccountActionTarget {
  return isRecord(value) && typeof value.tenantId === "string" && typeof value.routeId === "string"
    && typeof value.deviceId === "string" && typeof value.devicePublicKey === "string"
    && typeof value.grantRef === "string" && Array.isArray(value.scopes) && value.scopes.every((scope) => typeof scope === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

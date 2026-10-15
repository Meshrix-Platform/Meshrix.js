import { createHash, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";
import {
  ACCOUNT_API_ROUTES,
  accountDesktopSessionTranscript,
  isAccountStepUpPermitId,
  type AccountActionTarget,
  type AccountAuthorityBinding,
  type AccountDesktopPairingBootstrapRequest,
  type AccountDesktopPairingBootstrapResponse,
  type AccountDeviceRevokeRequest,
  type AccountDeviceRevokeResponse,
  type AccountDesktopSessionProof,
  type AccountDesktopTransactionCreateRequest,
  type AccountDesktopTransactionCreateResponse,
  type AccountDesktopTransactionPollResponse,
  type AccountDesktopVaultWriterRotationCompleteRequest,
  type AccountDesktopVaultWriterRotationCompleteResponse,
  type AccountDesktopVaultWriterRotationPrepareRequest,
  type AccountDesktopVaultWriterRotationPrepareResponse
} from "@meshrix/contracts/account";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { entryError } from "@meshrix/entry";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface DesktopAccountTransaction {
  readonly transactionId: string;
  readonly verifier: string;
  readonly browserUrl: string;
  readonly purpose: "login" | "step_up";
  readonly target: AccountActionTarget | null;
}

export interface DesktopAccountClientOptions {
  readonly origin: string;
  readonly fetch?: typeof fetch;
}

type DesktopStepUpRequestBody = {
  readonly purpose: "step_up";
  readonly verifierDigest: string;
  readonly clientPublicKey: string;
  readonly target: AccountActionTarget;
} & (
  | { readonly actionPurpose: "pair_device"; readonly bootstrapId: string; readonly claimId?: never }
  | { readonly actionPurpose: "pair_device"; readonly bootstrapId?: never; readonly claimId: string }
  | { readonly actionPurpose: "grant_access"; readonly bootstrapId?: never; readonly claimId?: never }
);

/**
 * Main-process HTTP client for the account worker's installed-Entry handoff.
 * Browser cookies never cross into this client. The only browser URL accepted
 * is the configured HTTPS origin's `/account` page with one opaque transaction
 * id; PKCE verifiers and completion material stay in trusted main custody.
 */
export class DesktopAccountClient {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(options: DesktopAccountClientOptions) {
    this.#origin = normalizeAccountOrigin(options.origin);
    this.#fetch = options.fetch ?? fetch;
  }

  async createTransaction(input: {
    readonly purpose: "login" | "step_up";
    readonly clientPublicKey: string;
    readonly target?: AccountActionTarget;
    readonly actionPurpose?: "pair_device" | "grant_access";
    readonly bootstrapId?: string;
    readonly claimId?: string;
    readonly desktopAuth?: {
      readonly account: AccountAuthorityBinding;
      readonly credential: string;
      readonly privateKey: KeyObject;
    };
  }): Promise<DesktopAccountTransaction> {
    if ((input.purpose === "step_up") !== (input.target !== undefined)
      || (input.purpose === "step_up") !== (input.actionPurpose !== undefined)
      || (input.bootstrapId !== undefined && !OPAQUE_ID.test(input.bootstrapId))
      || (input.claimId !== undefined && !OPAQUE_ID.test(input.claimId))
      || (input.actionPurpose === "pair_device" && ((input.bootstrapId !== undefined) === (input.claimId !== undefined)))
      || (input.actionPurpose === "grant_access" && (input.bootstrapId !== undefined || input.claimId !== undefined))) {
      throw entryError("account_transaction_invalid", "An action target is required only for a step-up transaction.");
    }
    const verifier = randomBytes(32).toString("base64url");
    let request: AccountDesktopTransactionCreateRequest;
    if (input.purpose === "login") {
      request = {
        purpose: "login",
        verifierDigest: digest(verifier),
        clientPublicKey: input.clientPublicKey,
        target: null
      };
    } else {
      if (!input.desktopAuth) {
        throw entryError("account_login_required", "A current OS-custodied account session is required for this authorization.");
      }
      const sharedBody = {
        purpose: "step_up" as const,
        verifierDigest: digest(verifier),
        clientPublicKey: input.clientPublicKey,
        target: input.target!
      };
      const requestBody: DesktopStepUpRequestBody = input.actionPurpose === "pair_device"
        ? input.bootstrapId !== undefined
          ? { ...sharedBody, actionPurpose: "pair_device", bootstrapId: input.bootstrapId }
          : { ...sharedBody, actionPurpose: "pair_device", claimId: input.claimId! }
        : { ...sharedBody, actionPurpose: "grant_access" };
      request = {
        ...requestBody,
        desktopProof: signDesktopAccountProof({
          pathname: ACCOUNT_API_ROUTES.desktopTransaction,
          account: input.desktopAuth.account,
          credential: input.desktopAuth.credential,
          clientPublicKey: input.clientPublicKey,
          privateKey: input.desktopAuth.privateKey,
          body: requestBody
        })
      };
    }
    const response = await this.#request<AccountDesktopTransactionCreateResponse>(
      ACCOUNT_API_ROUTES.desktopTransaction,
      { method: "POST", body: request }
    );
    if (!OPAQUE_ID.test(response.transactionId)) {
      throw entryError("account_transaction_invalid", "The account worker returned an invalid transaction reference.");
    }
    const browserUrl = validateAccountBrowserUrl(response.browserUrl, this.#origin, response.transactionId);
    return Object.freeze({
      transactionId: response.transactionId,
      verifier,
      browserUrl,
      purpose: input.purpose,
      target: input.target ?? null
    });
  }

  async pollTransaction(transactionId: string, verifier: string): Promise<AccountDesktopTransactionPollResponse> {
    if (!OPAQUE_ID.test(transactionId) || !validVerifier(verifier)) {
      throw entryError("account_transaction_invalid", "The account transaction reference is invalid.");
    }
    const route = ACCOUNT_API_ROUTES.desktopTransactionPoll.replace("{transactionId}", encodeURIComponent(transactionId));
    const response = await this.#request<AccountDesktopTransactionPollResponse>(route, {
      method: "POST",
      body: { verifier }
    });
    if (!isPollResponse(response)) {
      throw entryError("account_transaction_invalid", "The account worker returned an invalid transaction result.");
    }
    return response;
  }

  async acknowledgeTransaction(transactionId: string, verifier: string): Promise<void> {
    if (!OPAQUE_ID.test(transactionId) || !validVerifier(verifier)) {
      throw entryError("account_transaction_invalid", "The account transaction reference is invalid.");
    }
    const route = ACCOUNT_API_ROUTES.desktopTransactionAcknowledge.replace("{transactionId}", encodeURIComponent(transactionId));
    await this.#request<Record<string, unknown>>(route, { method: "POST", body: { verifier } });
  }

  async createPairingBootstrap(request: AccountDesktopPairingBootstrapRequest): Promise<AccountDesktopPairingBootstrapResponse> {
    if (request.mode !== "personal") {
      throw entryError("team_not_available", "Account-managed teams require an available paid team subscription.");
    }
    const response = await this.#request<AccountDesktopPairingBootstrapResponse>(
      ACCOUNT_API_ROUTES.desktopPairingBootstrap,
      { method: "POST", body: request }
    );
    if (!OPAQUE_ID.test(response.bootstrapId)
      || !OPAQUE_ID.test(response.account.accountId)
      || !Number.isSafeInteger(response.account.authEpoch)
      || response.account.authEpoch < 1
      || response.tenantId !== request.tenantId
      || response.routeId !== request.routeId
      || response.entryDeviceId !== request.entryDeviceId
      || response.endpointPinRef !== request.endpointPinRef
      || response.role !== "entry"
      || response.mode !== request.mode
      || !OPAQUE_ID.test(response.endpointDeviceId)
      || !Number.isSafeInteger(response.admissionGeneration)
      || response.admissionGeneration < 1
      || !Number.isSafeInteger(response.revocationRevision)
      || response.revocationRevision < 0
      || typeof response.relayAdmission !== "string"
      || response.relayAdmission.length < 32
      || response.relayAdmission.length > 8192
      || !Number.isFinite(Date.parse(response.expiresAt))
      || Date.parse(response.expiresAt) <= Date.now()) {
      throw entryError("account_bootstrap_invalid", "The account worker returned an invalid pairing bootstrap.");
    }
    return response;
  }

  async revokeDevice(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly routeId: string;
    readonly deviceId: string;
    readonly account: AccountAuthorityBinding;
    readonly credential: string;
    readonly clientPublicKey: string;
    readonly privateKey: KeyObject;
  }): Promise<AccountDeviceRevokeResponse> {
    const body = {
      operationId: input.operationId,
      tenantId: input.tenantId,
      routeId: input.routeId,
      deviceId: input.deviceId
    };
    const request: AccountDeviceRevokeRequest = {
      ...body,
      desktopProof: signDesktopAccountProof({
        pathname: ACCOUNT_API_ROUTES.deviceRevoke,
        account: input.account,
        credential: input.credential,
        clientPublicKey: input.clientPublicKey,
        privateKey: input.privateKey,
        body
      })
    };
    const response = await this.#request<AccountDeviceRevokeResponse>(ACCOUNT_API_ROUTES.deviceRevoke, {
      method: "POST",
      body: request
    });
    if (!isPlainObject(response)
      || response.authorityRevoked !== true
      || response.operationId !== input.operationId
      || (response.target !== "route" && response.target !== "device")
      || response.tenantId !== input.tenantId
      || response.routeId !== input.routeId
      || response.deviceId !== input.deviceId
      || (response.enforcement !== "pending" && response.enforcement !== "complete")) {
      throw entryError("account_device_revoke_invalid", "The account service returned a receipt for a different device revoke operation.");
    }
    return response;
  }

  async prepareVaultWriterRotation(request: AccountDesktopVaultWriterRotationPrepareRequest): Promise<AccountDesktopVaultWriterRotationPrepareResponse> {
    const response = await this.#request<AccountDesktopVaultWriterRotationPrepareResponse>(
      ACCOUNT_API_ROUTES.desktopVaultWriterRotationPrepare,
      { method: "POST", body: request }
    );
    if (!isPlainObject(response)
      || response.operationId !== request.operationId
      || !isValidAccountBinding(response.account)
      || !isActionTarget(response.target)
      || typeof response.expiresAt !== "string"
      || !Number.isFinite(Date.parse(response.expiresAt))) {
      throw entryError("account_vault_rotation_invalid", "The account worker returned an invalid vault writer target.");
    }
    return response;
  }

  async completeVaultWriterRotation(request: AccountDesktopVaultWriterRotationCompleteRequest): Promise<AccountDesktopVaultWriterRotationCompleteResponse> {
    const response = await this.#request<AccountDesktopVaultWriterRotationCompleteResponse>(
      ACCOUNT_API_ROUTES.desktopVaultWriterRotationComplete,
      { method: "POST", body: request }
    );
    if (!isPlainObject(response)
      || (response.state !== "pending" && response.state !== "complete")
      || !isValidAccountBinding(response.account)
      || response.operationId !== request.operationId
      || typeof response.vaultId !== "string"
      || !Number.isSafeInteger(response.generation)
      || Number(response.generation) < 1) {
      throw entryError("account_vault_rotation_invalid", "The account worker returned an invalid vault writer completion.");
    }
    return response;
  }

  accountPageUrl(): string {
    return new URL("/account", this.#origin).toString();
  }

  #url(route: string): string {
    return new URL(route, this.#origin).toString();
  }

  async #request<T>(route: string, input: { readonly method: "POST"; readonly body: unknown }): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url(route), {
        method: input.method,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "content-type": "application/json"
        },
        body: JSON.stringify(input.body)
      });
    } catch (error) {
      throw entryError("account_service_unreachable", "The account service could not be reached.", { cause: error });
    }
    const body = await readResponseJson(response);
    if (!response.ok) {
      const code = isPlainObject(body) && isPlainObject(body.error) && typeof body.error.code === "string"
        ? body.error.code
        : `http_${response.status}`;
      throw entryError("account_request_refused", `The account service refused the request (${safeErrorCode(code)}).`);
    }
    if (!isPlainObject(body)) {
      throw entryError("account_response_invalid", "The account service returned an invalid response.");
    }
    return body as T;
  }
}

export function normalizeAccountOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw entryError("account_origin_invalid", "The account authentication origin is not a valid HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw entryError("account_origin_invalid", "The account authentication origin must be a bare HTTPS origin.");
  }
  return url.origin;
}

export function validateAccountBrowserUrl(value: string, origin: string, transactionId: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw entryError("account_browser_url_invalid", "The account service returned an invalid browser URL.");
  }
  const expected = normalizeAccountOrigin(origin);
  const entries = [...url.searchParams.entries()];
  if (url.origin !== expected
    || url.pathname !== "/account"
    || url.username
    || url.password
    || url.hash
    || entries.length !== 1
    || entries[0]?.[0] !== "transactionId"
    || entries[0]?.[1] !== transactionId) {
    throw entryError("account_browser_url_invalid", "The account service returned a browser URL outside the configured account transaction.");
  }
  return url.toString();
}

export function accountDesktopProofDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("base64url");
}

export function signDesktopAccountProof(input: {
  readonly pathname: string;
  readonly account: AccountAuthorityBinding;
  readonly credential: string;
  readonly clientPublicKey: string;
  readonly privateKey: KeyObject;
  readonly body: unknown;
  readonly nonce?: string;
}): AccountDesktopSessionProof {
  const nonce = input.nonce ?? `desktop.${randomBytes(24).toString("base64url")}`;
  const bodyDigest = accountDesktopProofDigest(input.body);
  const credentialDigest = createHash("sha256").update(input.credential, "utf8").digest("base64url");
  const transcript = accountDesktopSessionTranscript({
    method: "POST",
    pathname: input.pathname,
    account: input.account,
    clientPublicKey: input.clientPublicKey,
    credentialDigest,
    nonce,
    bodyDigest
  });
  return {
    credential: input.credential,
    clientPublicKey: input.clientPublicKey,
    nonce,
    bodyDigest,
    signature: cryptoSign(null, Buffer.from(transcript, "utf8"), input.privateKey).toString("base64url")
  };
}

export function signDesktopPairingBootstrap(input: {
  readonly account: AccountAuthorityBinding;
  readonly credential: string;
  readonly clientPublicKey: string;
  readonly privateKey: KeyObject;
  readonly body: Omit<AccountDesktopPairingBootstrapRequest, "proof">;
  readonly nonce?: string;
}): AccountDesktopPairingBootstrapRequest {
  const nonce = input.nonce ?? `desktop.${randomBytes(24).toString("base64url")}`;
  const bodyDigest = accountDesktopProofDigest(input.body);
  const credentialDigest = createHash("sha256").update(input.credential, "utf8").digest("base64url");
  const transcript = accountDesktopSessionTranscript({
    method: "POST",
    pathname: ACCOUNT_API_ROUTES.desktopPairingBootstrap,
    account: input.account,
    clientPublicKey: input.clientPublicKey,
    credentialDigest,
    nonce,
    bodyDigest
  });
  const signature = cryptoSign(null, Buffer.from(transcript, "utf8"), input.privateKey).toString("base64url");
  return {
    ...input.body,
    proof: {
      credential: input.credential,
      clientPublicKey: input.clientPublicKey,
      nonce,
      bodyDigest,
      signature
    }
  };
}

function digest(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function validVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9_-]{40,64}$/u.test(verifier);
}

function isPollResponse(value: unknown): value is AccountDesktopTransactionPollResponse {
  if (!isPlainObject(value)) return false;
  if (value.state === "pending" || value.state === "expired" || value.state === "consumed") return true;
  if (value.state !== "complete" || !isPlainObject(value.account)
    || typeof value.account.accountId !== "string"
    || !OPAQUE_ID.test(value.account.accountId)
    || !Number.isSafeInteger(value.account.authEpoch)
    || Number(value.account.authEpoch) < 1) return false;
  if (value.purpose === "login") {
    return typeof value.deviceSessionCredential === "string"
      && value.deviceSessionCredential.length >= 32
      && value.permitId === null
      && value.target === null;
  }
  return value.purpose === "step_up"
    && (value.actionPurpose === "pair_device" || value.actionPurpose === "grant_access")
    && value.deviceSessionCredential === null
    && isAccountStepUpPermitId(value.permitId)
    && isActionTarget(value.target);
}

function isActionTarget(value: unknown): value is AccountActionTarget {
  return isPlainObject(value)
    && typeof value.tenantId === "string"
    && typeof value.routeId === "string"
    && typeof value.deviceId === "string"
    && typeof value.devicePublicKey === "string"
    && typeof value.grantRef === "string"
    && Array.isArray(value.scopes)
    && value.scopes.every((scope) => typeof scope === "string");
}

function isValidAccountBinding(value: unknown): value is AccountAuthorityBinding {
  return isPlainObject(value)
    && typeof value.accountId === "string"
    && OPAQUE_ID.test(value.accountId)
    && Number.isSafeInteger(value.authEpoch)
    && Number(value.authEpoch) > 0;
}

async function readResponseJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw entryError("account_response_oversize", "The account service response exceeded the size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw entryError("account_response_invalid", "The account service returned an empty response.");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    byteLength += next.value.byteLength;
    if (byteLength > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw entryError("account_response_oversize", "The account service response exceeded the size limit.");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw entryError("account_response_invalid", "The account service returned invalid JSON.");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeErrorCode(value: string): string {
  return /^[a-z0-9_:-]{1,64}$/iu.test(value) ? value : "unknown";
}

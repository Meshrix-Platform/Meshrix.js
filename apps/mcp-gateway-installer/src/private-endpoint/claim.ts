import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, X509Certificate, type KeyObject } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  ACCOUNT_API_ROUTES,
  accountDeviceAuthorityTranscript,
  accountDesktopSessionTranscript,
  canonicalAccountActionTarget,
  isAccountStepUpPermitId,
  type AccountActionTarget,
  type AccountAuthorityBinding,
  type AccountDesktopProofTranscriptInput,
  type AccountDesktopSessionProof,
  type AccountDesktopTransactionPollResponse,
  type AccountEndpointOwnershipClaimCompleteResponse,
  type AccountEndpointOwnershipClaimPrepareResponse
} from "@meshrix/contracts/account";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { AccountEndpointAuthorityClient, createEndpointIdentityStore, createFileEndpointIdentityDurablePort } from "@meshrix/gateway/private-endpoint";
import { endpointConfigError, loadPrivateEndpointConfig } from "./config.ts";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const AUTHORITY_ID = /^[A-Za-z0-9_-]{12,160}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;

export interface ClaimManagedEndpointOptions {
  readonly configPath: string;
  /** Required for an unclaimed profile; an existing managed profile supplies its own origin. */
  readonly authorityOrigin?: string;
  /** Opens the token-free `/account?transactionId=...` browser URL. */
  readonly openBrowser?: (url: string) => Promise<void>;
  /** Called for browser handoff and non-sensitive progress. */
  readonly onProgress?: (progress: ClaimManagedEndpointProgress) => void;
  /** User cancellation stops local polling; it does not expire server state. */
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly pollIntervalMs?: number;
}

export interface ClaimManagedEndpointProgress {
  readonly stage: "browser_login" | "browser_step_up" | "claimed";
  readonly browserUrl?: string;
  readonly accountId?: string;
  readonly routeId?: string;
  readonly endpointDeviceId?: string;
}

export interface ClaimManagedEndpointResult {
  readonly outcome: "claimed";
  readonly configPath: string;
  readonly accountId: string;
  readonly authEpoch: number;
  readonly tenantId: string;
  readonly routeId: string;
  readonly endpointDeviceId: string;
  readonly vaultId: string;
}

interface DesktopTransaction {
  readonly transactionId: string;
  readonly verifier: string;
  readonly browserUrl: string;
}

interface PendingClaimState {
  readonly schemaVersion: 1;
  readonly phase: "prepared" | "ready";
  readonly account: AccountAuthorityBinding;
  readonly claim: AccountEndpointOwnershipClaimPrepareResponse;
  readonly endpointPinRef: string;
  readonly mode: "personal" | "enterprise";
  readonly endpointDeviceId: string;
  readonly endpointPublicKey: string;
  readonly permitId?: string;
  readonly operationId?: string;
}

/**
 * Claim an existing endpoint route for the account currently authenticated in
 * the browser. Browser cookies and the account session credential stay outside
 * the browser process; local signing material is kept in memory until the
 * claim has completed and is then persisted in owner-only files.
 */
export async function claimManagedEndpoint(input: ClaimManagedEndpointOptions): Promise<ClaimManagedEndpointResult> {
  const configPath = resolve(input.configPath);
  const loaded = await loadPrivateEndpointConfig(configPath);
  const rawText = await readFile(configPath, "utf8").catch(() => {
    throw endpointConfigError("private_endpoint_config_unreadable", "Private endpoint configuration could not be read.");
  });
  let rawConfig: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(rawText);
    if (!isRecord(value)) throw new Error("invalid");
    rawConfig = value;
  } catch {
    throw endpointConfigError("private_endpoint_config_invalid", "Private endpoint configuration is malformed.");
  }

  if (!loaded.adminListen || !loaded.adminToken) {
    throw endpointConfigError("private_endpoint_claim_admin_required", "Configure a loopback admin listener and its bearer token before claiming this endpoint.");
  }
  const origin = normalizedOrigin(input.authorityOrigin ?? loaded.account?.origin);
  if (loaded.account && loaded.account.origin !== origin) {
    throw endpointConfigError("private_endpoint_claim_origin_conflict", "A managed endpoint cannot be claimed against a different account authority.");
  }
  const relay = asRecord(rawConfig.relay);
  const endpoint = asRecord(rawConfig.endpoint);
  const innerTls = asRecord(rawConfig.innerTls);
  if (!relay || !endpoint || !innerTls) {
    throw endpointConfigError("private_endpoint_config_invalid", "Private endpoint configuration lacks claimable identity material.");
  }

  const tlsCertificate = new X509Certificate(loaded.innerTls.cert);
  const actualPin = createHash("sha256").update(tlsCertificate.publicKey.export({ format: "der", type: "spki" })).digest("base64url");
  if (loaded.account && loaded.account.endpointPinRef !== actualPin) {
    throw endpointConfigError("private_endpoint_claim_pin_conflict", "The configured managed endpoint pin does not match the current inner-TLS certificate.");
  }
  const endpointPinRef = actualPin;
  const endpointDeviceId = loaded.admission.deviceId;
  const configuredTenantId = loaded.admission.tenantId;
  const routeId = loaded.admission.routeId;
  if (loaded.admission.mode !== "personal") {
    throw endpointConfigError("team_not_available", "Account-managed teams require an available paid team subscription; personal accounts can claim only their own personal endpoints.");
  }
  const mode = "personal" as const;
  const secretsDir = join(dirname(configPath), ".meshrix-private-endpoint-secrets");
  const secretStem = createHash("sha256").update(`${configuredTenantId}\n${routeId}\n${endpointDeviceId}`).digest("hex").slice(0, 24);
  const relayCredentialFile = join(secretsDir, `relay-${secretStem}.token`);
  const accountKeyFile = join(secretsDir, `device-${secretStem}.pem`);
  const pendingClaimFile = join(secretsDir, `claim-${secretStem}.json`);
  const endpointSigningKey = loaded.account
    ? createPrivateKey(loaded.account.signingKey)
    : await loadOrCreateAccountKey(accountKeyFile);
  if (endpointSigningKey.asymmetricKeyType !== "ed25519") {
    throw endpointConfigError("private_endpoint_account_key_invalid", "The endpoint account signing key must be Ed25519.");
  }
  const endpointPublicKeyObject = createPublicKey(endpointSigningKey);
  const endpointPublicSpki = endpointPublicKeyObject.export({ format: "der", type: "spki" });
  const endpointPublicKey = endpointPublicSpki.subarray(-32).toString("base64url");
  const newEndpointKey = !loaded.account;

  const desktopKeys = generateKeyPairSync("ed25519");
  const desktopPublicKeyObject = desktopKeys.publicKey;
  const desktopPublicSpki = desktopPublicKeyObject.export({ format: "der", type: "spki" });
  const desktopPublicKey = desktopPublicSpki.subarray(-32).toString("base64url");
  const fetchImpl = input.fetch ?? fetch;
  const signal = input.signal;
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 30_000) {
    throw endpointConfigError("private_endpoint_claim_poll_invalid", "Claim polling interval must be between 100ms and 30s.");
  }
  const client = new AccountHttpClient(origin, fetchImpl, signal);

  const loginTransactionData = makeLoginTransaction(desktopPublicKey);
  const loginTransaction = await client.createTransaction(loginTransactionData.body, loginTransactionData.verifier);
  await handoff(input, "browser_login", loginTransaction.browserUrl);
  const login = await pollTransaction(client, loginTransaction, signal, pollIntervalMs);
  if (login.state !== "complete" || login.purpose !== "login") {
    throw endpointConfigError("private_endpoint_claim_login_failed", "Account browser sign-in did not complete.");
  }
  const account = login.account;
  await client.acknowledgeTransaction(loginTransaction);

  let pending = await readPendingClaim(pendingClaimFile);
  if (pending && (!sameBinding(pending.account, account)
    || pending.endpointPinRef !== endpointPinRef || pending.mode !== mode
    || pending.endpointDeviceId !== endpointDeviceId || pending.endpointPublicKey !== endpointPublicKey)) {
    await rm(pendingClaimFile, { force: true });
    pending = null;
  }

  let prepared: AccountEndpointOwnershipClaimPrepareResponse;
  let permitId: string;
  let operationId: string;
  if (pending?.phase === "ready" && pending.permitId && pending.operationId) {
    // A prior claim request may have committed remotely while its response or
    // local config write was interrupted. Retry the exact same authority
    // operation under the freshly authenticated account session.
    prepared = pending.claim;
    permitId = pending.permitId;
    operationId = pending.operationId;
  } else {
    if (pending?.phase === "prepared") {
      prepared = pending.claim;
    } else {
      const prepareBody = Object.freeze({ routeId, endpointDeviceId, endpointPublicKey, endpointPinRef, mode });
      const preparePath = ACCOUNT_API_ROUTES.deviceEndpointClaimPrepare;
      const prepareRequest = {
        ...prepareBody,
        desktopProof: signDesktopProof({
          pathname: preparePath,
          account,
          credential: login.deviceSessionCredential,
          clientPublicKey: desktopPublicKey,
          privateKey: desktopKeys.privateKey,
          body: prepareBody
        })
      };
      prepared = await client.post<AccountEndpointOwnershipClaimPrepareResponse>(preparePath, prepareRequest);
      validatePreparedClaim(prepared, { account, routeId, endpointDeviceId, endpointPublicKey });
      pending = Object.freeze({
        schemaVersion: 1,
        phase: "prepared",
        account,
        claim: prepared,
        endpointPinRef,
        mode,
        endpointDeviceId,
        endpointPublicKey
      });
      await writeOwnerOnly(pendingClaimFile, `${JSON.stringify(pending)}\n`);
    }
    validatePreparedClaim(prepared, { account, routeId, endpointDeviceId, endpointPublicKey });
    const stepUpTransaction = await createStepUpTransaction({
      client,
      account,
      credential: login.deviceSessionCredential,
      desktopPublicKey,
      desktopPrivateKey: desktopKeys.privateKey,
      claimId: prepared.claimId,
      target: prepared.target,
      pollIntervalMs,
      signal,
      input
    });
    if (stepUpTransaction.account.accountId !== account.accountId || stepUpTransaction.account.authEpoch !== account.authEpoch
      || !sameTarget(stepUpTransaction.target, prepared.target)) {
      throw endpointConfigError("private_endpoint_claim_step_up_mismatch", "The verified factor was not bound to this exact endpoint claim.");
    }
    permitId = stepUpTransaction.permitId;
    operationId = randomBytes(32).toString("base64url");
    pending = Object.freeze({ ...pending!, phase: "ready", permitId, operationId });
    // Persist the operation identity before the irreversible authority call
    // so an ambiguous response can be retried without creating a new claim.
    await writeOwnerOnly(pendingClaimFile, `${JSON.stringify(pending)}\n`);
  }

  validatePreparedClaim(prepared, { account, routeId, endpointDeviceId, endpointPublicKey });
  // The account authority assigns the personal namespace. Every subsequent
  // proof, route lookup and persisted endpoint uses this exact prepared tuple.
  const tenantId = prepared.target.tenantId;
  const endpointProof = signEndpointClaimProof({
    tenantId,
    routeId,
    endpointDeviceId,
    endpointPinRef,
    claimId: prepared.claimId,
    permitId,
    operationId,
    target: prepared.target,
    privateKey: endpointSigningKey
  });
  const completeBody = Object.freeze({ claimId: prepared.claimId, permitId, operationId, endpointProof });
  const completePath = ACCOUNT_API_ROUTES.deviceEndpointClaimComplete;
  const completeRequest = {
    ...completeBody,
    desktopProof: signDesktopProof({
      pathname: completePath,
      account,
      credential: login.deviceSessionCredential,
      clientPublicKey: desktopPublicKey,
      privateKey: desktopKeys.privateKey,
      body: completeBody
    })
  };
  const completed = await client.post<AccountEndpointOwnershipClaimCompleteResponse>(completePath, completeRequest);
  validateCompletedClaim(completed, prepared, { endpointPinRef, mode, endpointDeviceId, endpointPublicKey });

  // The completion response carries relay admission material. Confirm the
  // durable current route through the endpoint-key proof before restoring the
  // local endpoint after recovery or persisting its new admission.
  const routeClient = new AccountEndpointAuthorityClient({
    origin,
    tenantId,
    routeId,
    deviceId: endpointDeviceId,
    signingKey: endpointSigningKey,
    fetch: fetchImpl
  });
  const managedRoute = await routeClient.managedRoute();
  if (!managedRoute || managedRoute.accountId !== completed.account.accountId
    || managedRoute.authEpoch !== completed.account.authEpoch
    || managedRoute.tenantId !== tenantId || managedRoute.routeId !== routeId
    || managedRoute.endpointDeviceId !== endpointDeviceId
    || managedRoute.endpointPublicKey !== endpointPublicKey
    || managedRoute.endpointPinRef !== endpointPinRef || managedRoute.vaultId !== completed.vaultId) {
    throw endpointConfigError("account_endpoint_claim_not_current", "The completed endpoint claim is not current at the account authority.");
  }
  const identity = createEndpointIdentityStore(createFileEndpointIdentityDurablePort(
    join(dirname(configPath), ".meshrix-private-endpoint-state.json")
  ));
  const localEndpoint = identity.device(endpointDeviceId);
  if (!localEndpoint) {
    identity.enroll({ deviceId: endpointDeviceId, routeId, tenantId, trustBinding: loaded.trustBinding });
  } else if (localEndpoint.role !== "endpoint" || localEndpoint.routeId !== routeId || localEndpoint.tenantId !== tenantId
    || localEndpoint.pairedIdentityKey !== String(loaded.trustBinding.pairedIdentityKey)
    || localEndpoint.pairedIdentityFingerprint !== String(loaded.trustBinding.pairedIdentityFingerprint)) {
    throw endpointConfigError("private_endpoint_identity_conflict", "Persisted endpoint trust does not match the claimed profile.");
  }
  identity.activateAccountEndpointClaim({
    deviceId: endpointDeviceId,
    account: { accountId: managedRoute.accountId, authEpoch: managedRoute.authEpoch },
    admissionGeneration: completed.admissionGeneration,
    revocationRevision: completed.revocationRevision
  });

  await writeOwnerOnly(relayCredentialFile, `${completed.relayAdmission}\n`);

  const relativeSecret = (file: string) => relative(dirname(configPath), file).split(sep).join("/");
  const recovery = asRecord(rawConfig.recovery) ?? {};
  const updatedConfig: Record<string, unknown> = {
    ...rawConfig,
    relay: { ...relay, credential: `file:${relativeSecret(relayCredentialFile)}` },
    endpoint: {
      ...endpoint,
      tenantId,
      routeId,
      mode: completed.mode,
      admissionGeneration: completed.admissionGeneration,
      revocationRevision: completed.revocationRevision
    },
    // The account's current recovery code is the recovery authority. Legacy
    // local possession-only roots must not survive as an alternate account
    // permission path; their key files are preserved as user-owned files.
    recovery: Object.fromEntries(Object.entries(recovery).filter(([key]) => key !== "signingKey").concat([["authorities", []]])),
    ...(loaded.adminTokenFile && asRecord(rawConfig.admin)?.token === undefined
      ? { admin: { ...asRecord(rawConfig.admin), token: `file:${relativeSecret(loaded.adminTokenFile)}` } }
      : {}),
    account: {
      origin,
      signingKey: loaded.account ? String(asRecord(rawConfig.account)?.signingKey ?? "") : `file:${relativeSecret(accountKeyFile)}`,
      endpointPinRef,
      endpointSpkiPin: endpointPinRef,
      vaultId: completed.vaultId
    }
  };
  await writeConfigAtomically(configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`);
  await rm(pendingClaimFile, { force: true });

  input.onProgress?.({ stage: "claimed", accountId: account.accountId, routeId, endpointDeviceId });
  return Object.freeze({
    outcome: "claimed",
    configPath,
    accountId: account.accountId,
    authEpoch: account.authEpoch,
    tenantId,
    routeId,
    endpointDeviceId,
    vaultId: completed.vaultId
  });
}

async function createStepUpTransaction(input: {
  readonly client: AccountHttpClient;
  readonly account: AccountAuthorityBinding;
  readonly credential: string;
  readonly desktopPublicKey: string;
  readonly desktopPrivateKey: KeyObject;
  readonly claimId: string;
  readonly target: AccountActionTarget;
  readonly pollIntervalMs: number;
  readonly signal?: AbortSignal;
  readonly input: ClaimManagedEndpointOptions;
}): Promise<Extract<AccountDesktopTransactionPollResponse, { state: "complete"; purpose: "step_up" }>> {
  const verifier = randomBytes(32).toString("base64url");
  const unsigned = Object.freeze({
    purpose: "step_up" as const,
    actionPurpose: "pair_device" as const,
    verifierDigest: sha256(verifier),
    clientPublicKey: input.desktopPublicKey,
    target: input.target,
    claimId: input.claimId
  });
  const body = {
    ...unsigned,
    desktopProof: signDesktopProof({
      pathname: ACCOUNT_API_ROUTES.desktopTransaction,
      account: input.account,
      credential: input.credential,
      clientPublicKey: input.desktopPublicKey,
      privateKey: input.desktopPrivateKey,
      body: unsigned
    })
  };
  const transaction = await input.client.createTransaction(body, verifier);
  await handoff(input.input, "browser_step_up", transaction.browserUrl);
  const result = await pollTransaction(input.client, transaction, input.signal, input.pollIntervalMs);
  if (result.state !== "complete" || result.purpose !== "step_up" || result.actionPurpose !== "pair_device") {
    throw endpointConfigError("private_endpoint_claim_step_up_failed", "Fresh Passkey or Authenticator verification did not complete for this claim.");
  }
  await input.client.acknowledgeTransaction(transaction);
  return result;
}

function makeLoginTransaction(clientPublicKey: string): { readonly body: Record<string, unknown>; readonly verifier: string } {
  const verifier = randomBytes(32).toString("base64url");
  return Object.freeze({
    verifier,
    body: Object.freeze({ purpose: "login", verifierDigest: sha256(verifier), clientPublicKey, target: null })
  });
}

async function handoff(input: ClaimManagedEndpointOptions, stage: "browser_login" | "browser_step_up", browserUrl: string): Promise<void> {
  if (input.signal?.aborted) throw abortedError();
  if (input.openBrowser) {
    await input.openBrowser(browserUrl);
  } else if (input.onProgress) {
    input.onProgress({ stage, browserUrl });
  } else {
    throw endpointConfigError("private_endpoint_claim_browser_required", "Provide a browser opener or progress handler to complete account verification.");
  }
}

async function pollTransaction(
  client: AccountHttpClient,
  transaction: DesktopTransaction,
  signal: AbortSignal | undefined,
  intervalMs: number
): Promise<AccountDesktopTransactionPollResponse> {
  const path = ACCOUNT_API_ROUTES.desktopTransactionPoll.replace("{transactionId}", encodeURIComponent(transaction.transactionId));
  for (;;) {
    if (signal?.aborted) throw abortedError();
    const value = validatePollResponse(await client.post<AccountDesktopTransactionPollResponse>(path, { verifier: transaction.verifier }));
    if (value.state !== "pending") return value;
    await waitForNextPoll(intervalMs, signal);
  }
}

function waitForNextPoll(intervalMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedError());
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    }, intervalMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectPromise(abortedError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

class AccountHttpClient {
  readonly #origin: URL;
  readonly #fetch: typeof fetch;
  readonly #signal?: AbortSignal;

  constructor(origin: string, fetchImpl: typeof fetch, signal?: AbortSignal) {
    this.#origin = new URL(origin);
    this.#fetch = fetchImpl;
    this.#signal = signal;
  }

  async createTransaction(body: unknown, verifier: string): Promise<DesktopTransaction> {
    const result = await this.post<{ transactionId: string; browserUrl: string }>(ACCOUNT_API_ROUTES.desktopTransaction, body);
    if (!AUTHORITY_ID.test(result.transactionId) || verifier.length < 32 || verifier.length > 256) {
      throw endpointConfigError("account_transaction_invalid", "Account authority returned an invalid browser transaction.");
    }
    return Object.freeze({ transactionId: result.transactionId, verifier, browserUrl: validateBrowserUrl(result.browserUrl, this.#origin, result.transactionId) });
  }

  async acknowledgeTransaction(transaction: DesktopTransaction): Promise<void> {
    const path = ACCOUNT_API_ROUTES.desktopTransactionAcknowledge.replace("{transactionId}", encodeURIComponent(transaction.transactionId));
    await this.post(path, { verifier: transaction.verifier });
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#origin), {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        ...(this.#signal ? { signal: this.#signal } : {}),
        headers: { accept: "application/json", "cache-control": "no-store", "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch {
      if (this.#signal?.aborted) throw abortedError();
      throw endpointConfigError("account_authority_unavailable", "Account authority could not be reached.");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw endpointConfigError("account_authority_response_invalid", "Account authority returned an oversized response.");
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw endpointConfigError("account_authority_response_invalid", "Account authority returned an invalid response."); }
    if (!response.ok) {
      const code = isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" ? value.error.code : "account_authority_refused";
      throw endpointConfigError(code, "Account authority refused the endpoint request.");
    }
    return value as T;
  }
}

function signDesktopProof(input: {
  readonly pathname: string;
  readonly account: AccountAuthorityBinding;
  readonly credential: string;
  readonly clientPublicKey: string;
  readonly privateKey: KeyObject;
  readonly body: unknown;
}): AccountDesktopSessionProof {
  const nonce = `desktop.${randomBytes(24).toString("base64url")}`;
  const bodyDigest = sha256(canonicalJson(input.body));
  const credentialDigest = sha256(input.credential);
  const transcript: AccountDesktopProofTranscriptInput = {
    method: "POST",
    pathname: input.pathname,
    account: input.account,
    clientPublicKey: input.clientPublicKey,
    credentialDigest,
    nonce,
    bodyDigest
  };
  return Object.freeze({
    credential: input.credential,
    clientPublicKey: input.clientPublicKey,
    nonce,
    bodyDigest,
    signature: cryptoSign(null, Buffer.from(accountDesktopSessionTranscript(transcript), "utf8"), input.privateKey).toString("base64url")
  });
}

function signEndpointClaimProof(input: {
  readonly tenantId: string;
  readonly routeId: string;
  readonly endpointDeviceId: string;
  readonly endpointPinRef: string;
  readonly claimId: string;
  readonly permitId: string;
  readonly operationId: string;
  readonly target: AccountActionTarget;
  readonly privateKey: KeyObject;
}): Record<string, unknown> {
  const unsigned = Object.freeze({
    purpose: "claim_endpoint" as const,
    tenantId: input.tenantId,
    routeId: input.routeId,
    deviceId: input.endpointDeviceId,
    nonce: `claim.${randomBytes(24).toString("base64url")}`,
    endpointPinRef: input.endpointPinRef,
    claimId: input.claimId,
    permitId: input.permitId,
    operationId: input.operationId,
    targetDigest: sha256(canonicalAccountActionTarget(input.target))
  });
  return Object.freeze({
    ...unsigned,
    signature: cryptoSign(null, Buffer.from(accountDeviceAuthorityTranscript(unsigned), "utf8"), input.privateKey).toString("base64url")
  });
}

function validatePreparedClaim(value: AccountEndpointOwnershipClaimPrepareResponse, expected: {
  readonly account: AccountAuthorityBinding;
  readonly routeId: string;
  readonly endpointDeviceId: string;
  readonly endpointPublicKey: string;
}): void {
  if (!isRecord(value) || !AUTHORITY_ID.test(value.claimId) || !sameBinding(value.account, expected.account)
    || !OPAQUE_ID.test(value.vaultId) || !isTarget(value.target)
    || !OPAQUE_ID.test(value.target.tenantId) || value.target.routeId !== expected.routeId
    || value.target.deviceId !== expected.endpointDeviceId || value.target.devicePublicKey !== expected.endpointPublicKey
    || !OPAQUE_ID.test(value.target.grantRef) || value.target.scopes.length === 0
    || new Set(value.target.scopes).size !== value.target.scopes.length
    || value.target.vaultWriterRotation !== undefined
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
    throw endpointConfigError("account_endpoint_claim_invalid", "Account authority returned a claim target that does not match this endpoint.");
  }
}

function validateCompletedClaim(value: AccountEndpointOwnershipClaimCompleteResponse, prepared: AccountEndpointOwnershipClaimPrepareResponse, expected: {
  readonly endpointPinRef: string;
  readonly mode: "personal" | "enterprise";
  readonly endpointDeviceId: string;
  readonly endpointPublicKey: string;
}): void {
  if (!isRecord(value) || value.claimed !== true || !sameBinding(value.account, prepared.account)
    || value.tenantId !== prepared.target.tenantId || value.routeId !== prepared.target.routeId
    || value.endpointDeviceId !== expected.endpointDeviceId || value.endpointPublicKey !== expected.endpointPublicKey
    || value.endpointPinRef !== expected.endpointPinRef || value.vaultId !== prepared.vaultId
    || value.mode !== expected.mode
    || typeof value.relayAdmission !== "string" || value.relayAdmission.length < 32 || value.relayAdmission.length > 8192 || /\s/u.test(value.relayAdmission)
    || !Number.isSafeInteger(value.admissionGeneration) || value.admissionGeneration < 1
    || !Number.isSafeInteger(value.revocationRevision) || value.revocationRevision < 0) {
    throw endpointConfigError("account_endpoint_claim_invalid", "Account authority returned an invalid endpoint claim result.");
  }
}

function validateBrowserUrl(value: string, origin: URL, transactionId: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw endpointConfigError("account_transaction_invalid", "Account authority returned an invalid browser URL."); }
  const entries = [...url.searchParams.entries()];
  if (url.origin !== origin.origin || url.pathname !== "/account" || url.username || url.password || url.hash
    || entries.length !== 1 || entries[0]?.[0] !== "transactionId" || entries[0]?.[1] !== transactionId) {
    throw endpointConfigError("account_transaction_invalid", "Account authority returned a browser URL outside the configured account transaction.");
  }
  return url.toString();
}

function normalizedOrigin(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw endpointConfigError("account_authority_origin_invalid", "Provide a bare HTTPS account authority origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw endpointConfigError("account_authority_origin_invalid", "Account authority origin must be a bare HTTPS origin.");
  }
  return url.origin;
}

function validatePollResponse(value: AccountDesktopTransactionPollResponse): AccountDesktopTransactionPollResponse {
  if (!isRecord(value)) {
    throw endpointConfigError("account_transaction_invalid", "Account authority returned an invalid transaction result.");
  }
  if (value.state === "pending" || value.state === "expired" || value.state === "consumed") return value;
  if (value.state === "complete" && value.purpose === "login"
    && isBinding(value.account) && typeof value.deviceSessionCredential === "string"
    && value.deviceSessionCredential.length >= 32 && value.deviceSessionCredential.length <= 256
    && value.permitId === null && value.target === null) return value;
  if (value.state === "complete" && value.purpose === "step_up" && value.actionPurpose === "pair_device"
    && isBinding(value.account) && isAccountStepUpPermitId(value.permitId)
    && (value.deviceSessionCredential === null) && isTarget(value.target)) return value;
  throw endpointConfigError("account_transaction_invalid", "Account authority returned an invalid transaction result.");
}

function isTarget(value: unknown): value is AccountActionTarget {
  return isRecord(value) && typeof value.tenantId === "string" && typeof value.routeId === "string"
    && typeof value.deviceId === "string" && typeof value.devicePublicKey === "string"
    && typeof value.grantRef === "string" && Array.isArray(value.scopes)
    && value.scopes.every((scope) => typeof scope === "string");
}

function sameTarget(left: AccountActionTarget, right: AccountActionTarget): boolean {
  return canonicalAccountActionTarget(left) === canonicalAccountActionTarget(right);
}

function sameBinding(left: AccountAuthorityBinding, right: AccountAuthorityBinding): boolean {
  return left?.accountId === right.accountId && left?.authEpoch === right.authEpoch;
}

function isBinding(value: unknown): value is AccountAuthorityBinding {
  return isRecord(value) && typeof value.accountId === "string" && value.accountId.length > 0
    && Number.isSafeInteger(value.authEpoch) && Number(value.authEpoch) > 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

async function loadOrCreateAccountKey(path: string): Promise<KeyObject> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  try {
    const key = parseAccountPrivateKey(await readFile(path, "utf8"));
    await chmod(path, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = generateKeyPairSync("ed25519").privateKey;
  const handle = await open(path, "wx", 0o600).catch(async (error: unknown) => {
    // A concurrent claim process may have created the stable key after our
    // initial read; reuse it instead of replacing the endpoint identity.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw endpointConfigError("private_endpoint_account_key_write_failed", "The endpoint account key could not be persisted.");
  });
  if (!handle) {
    const existing = parseAccountPrivateKey(await readFile(path, "utf8"));
    await chmod(path, 0o600);
    return existing;
  }
  try {
    await handle.writeFile(key.export({ format: "pem", type: "pkcs8" }).toString(), { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  return key;
}

function parseAccountPrivateKey(material: string): KeyObject {
  try {
    const key = createPrivateKey(material);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw endpointConfigError("private_endpoint_account_key_invalid", "The persisted endpoint account key is not a usable Ed25519 private key.");
  }
}

async function readPendingClaim(path: string): Promise<PendingClaimState | null> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw endpointConfigError("private_endpoint_claim_state_unreadable", "The pending endpoint claim state could not be read.");
  }
  if (Buffer.byteLength(raw, "utf8") > 128 * 1024) {
    throw endpointConfigError("private_endpoint_claim_state_invalid", "The pending endpoint claim state is invalid.");
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw endpointConfigError("private_endpoint_claim_state_invalid", "The pending endpoint claim state is invalid."); }
  if (!isRecord(value)) {
    throw endpointConfigError("private_endpoint_claim_state_invalid", "The pending endpoint claim state is invalid.");
  }
  const claim = value.claim;
  if (value.schemaVersion !== 1 || (value.phase !== "prepared" && value.phase !== "ready")
    || !isBinding(value.account) || !isRecord(claim) || typeof claim.claimId !== "string" || !AUTHORITY_ID.test(claim.claimId)
    || !isBinding(claim.account) || !sameBinding(value.account, claim.account)
    || typeof claim.vaultId !== "string" || !OPAQUE_ID.test(claim.vaultId)
    || !isTarget(claim.target) || typeof claim.expiresAt !== "string" || !Number.isFinite(Date.parse(claim.expiresAt))
    || typeof value.endpointPinRef !== "string" || !value.endpointPinRef
    || (value.mode !== "personal" && value.mode !== "enterprise")
    || typeof value.endpointDeviceId !== "string" || !OPAQUE_ID.test(value.endpointDeviceId)
    || typeof value.endpointPublicKey !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.endpointPublicKey)) {
    throw endpointConfigError("private_endpoint_claim_state_invalid", "The pending endpoint claim state is invalid.");
  }
  if (value.phase === "ready" && (!isAccountStepUpPermitId(value.permitId)
    || typeof value.operationId !== "string" || !AUTHORITY_ID.test(value.operationId))) {
    throw endpointConfigError("private_endpoint_claim_state_invalid", "The pending endpoint claim operation is invalid.");
  }
  return value as unknown as PendingClaimState;
}

function abortedError(): Error & { code: string } {
  return endpointConfigError("private_endpoint_claim_cancelled", "Endpoint claim was cancelled by the operator.");
}

async function writeOwnerOnly(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path).catch(async (error: unknown) => {
    await rm(temporary, { force: true });
    throw error;
  });
  await chmod(path, 0o600);
}

async function writeConfigAtomically(path: string, value: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path).catch(async (error: unknown) => {
    await rm(temporary, { force: true });
    throw endpointConfigError("private_endpoint_config_write_failed", error instanceof Error ? error.message : "Could not write account claim configuration.");
  });
  await chmod(path, 0o600);
}

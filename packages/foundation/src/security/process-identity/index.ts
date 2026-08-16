import crypto from "node:crypto";
import fs from "node:fs";
import { createCapabilityBindingGuard } from "../authorization/capability-binding-guard.ts";
import { createOpaqueCapabilityKeyProvider } from "../authorization/opaque-capability-key.ts";
import {
  DEFAULT_ALIAS,
  DEFAULT_NONCE_TTL_MS,
  DEFAULT_PROCESS_IDENTITY_CAPABILITIES,
  MAX_NONCE_CACHE,
  PROCESS_IDENTITY_PROTOCOL_VERSION,
  PROCESS_IDENTITY_RETIRED_STATE_RESET,
  asObject,
  bodySha256Hex,
  capabilityKeyFromHeaders,
  canonicalProcessIdentityRequest,
  clientBindingContext,
  clientFingerprintFromHeaders,
  clientFingerprintMatches,
  createClientIdentityPackage,
  createRecord,
  deny,
  headerValue,
  normalizeClientFingerprint,
  normalizeClientInput,
  normalizeClientRecord,
  normalizeState,
  nowIso,
  openState,
  operationRequiredCapabilities,
  parseTimestampMs,
  pathWithQueryFromUrl,
  processIdentityStatePath,
  publicKeyFromInput,
  publicServerIdentity,
  readRecord,
  requestIsLoopback,
  resolveDataDir,
  safeAlias,
  sha256Hex,
  sha256TextBase64Url,
  signStableObject,
  stableJson,
  stateRoot,
  text,
  timingSafeTextEqual,
  writeRecord,
  type ProcessIdentityObject
} from "./process-identity-core.ts";

const MAX_RETIRED_OWNER_PROCESS_BINDING_GENERATIONS = 4096;
import {
  createProcessIdentityRevocationReceipt,
  verifyProcessIdentityRevocationReceiptSignature
} from "./process-identity-revocation-receipt.ts";

export {
  PROCESS_IDENTITY_PROTOCOL_VERSION,
  CLIENT_IDENTITY_PACKAGE_VERSION,
  PROCESS_IDENTITY_CANONICAL_REQUEST_VERSION,
  CLIENT_FINGERPRINT_VERSION,
  DEFAULT_PROCESS_IDENTITY_CAPABILITIES,
  processIdentityStatePath,
  verifyClientIdentityPackageSignature,
  canonicalProcessIdentityRequest,
  generateProcessIdentityClientKeyPair,
  createProcessIdentityRequestHeaders
} from "./process-identity-core.ts";
export {
  PROCESS_IDENTITY_REVOCATION_RECEIPT_VERSION,
  verifyProcessIdentityRevocationReceiptSignature
} from "./process-identity-revocation-receipt.ts";

export type CapabilityKeyProvider = ReturnType<typeof createOpaqueCapabilityKeyProvider>;
export type CapabilityBindingGuard = ReturnType<typeof createCapabilityBindingGuard>;

export interface ProcessIdentityServiceOptions {
  dataDir?: unknown;
  alias?: unknown;
  claimToken?: unknown;
  claimTokenFile?: unknown;
  capabilityKeyProvider?: CapabilityKeyProvider | null;
  capabilityBindingGuard?: CapabilityBindingGuard | null;
  maxTimestampSkewMs?: unknown;
  nonceTtlMs?: unknown;
  maxNonceCache?: unknown;
}

interface ProcessIdentityState extends ProcessIdentityObject {
  serverIdentity: ProcessIdentityObject;
  clients: ProcessIdentityObject[];
  ownerProcessBindings: ProcessIdentityObject[];
  retiredOwnerProcessBindingGenerations: ProcessIdentityObject[];
  usedNonces: ProcessIdentityObject[];
}

export interface ProcessIdentityRequest {
  headers?: Record<string, unknown>;
  __meshrixProcessIdentity?: unknown;
}

export interface BootstrapClaimOptions {
  request?: ProcessIdentityRequest | null;
  input?: unknown;
}

export interface VerifySignedRequestOptions {
  request?: ProcessIdentityRequest | null;
  requestBody?: unknown;
  url?: URL | null;
  method?: unknown;
  operation?: ProcessIdentityObject;
}

export interface RevalidateVerifiedRequestOptions {
  verification?: unknown;
  operation?: ProcessIdentityObject;
}

export interface AuthenticatedRequestOptions {
  request?: ProcessIdentityRequest | null;
  input?: unknown;
}

interface OwnerProcessBindingContext {
  tenant: string;
  subject: string;
  target: string;
  device: string;
  process: string;
  workspace: string;
  correlation: string;
}

interface OwnerProcessBindingDecision {
  ok: true;
  ownerId: string;
  ownerGenerationDigest: string;
  context: OwnerProcessBindingContext;
  contextDigest: string;
}

export interface ProcessIdentityDecision extends ProcessIdentityObject {
  ok: boolean;
}

export interface ProcessIdentityService {
  readonly protocolVersion: typeof PROCESS_IDENTITY_PROTOCOL_VERSION;
  readonly capabilityKeyProvider: CapabilityKeyProvider;
  readonly capabilityBindingGuard: CapabilityBindingGuard;
  bootstrapClaim(options?: BootstrapClaimOptions): Promise<ProcessIdentityDecision>;
  verifySignedRequest(options?: VerifySignedRequestOptions): Promise<ProcessIdentityDecision>;
  revalidateVerifiedRequest(options?: RevalidateVerifiedRequestOptions): Promise<ProcessIdentityDecision>;
  rotateClientIdentityPackage(options?: AuthenticatedRequestOptions): Promise<ProcessIdentityDecision>;
  revokeClientIdentityPackage(options?: AuthenticatedRequestOptions): Promise<ProcessIdentityDecision>;
  verifyClientIdentityRevocationReceipt(options?: Record<string, unknown>): Promise<ProcessIdentityDecision>;
  issueOwnerProcessBinding(input?: Record<string, unknown>): Promise<ProcessIdentityDecision>;
  inspectOwnerProcessBinding(input?: Record<string, unknown>): Promise<ProcessIdentityDecision>;
  revokeOwnerProcessBinding(input?: Record<string, unknown>): Promise<ProcessIdentityDecision>;
  revokeOwnerProcessBindings(input?: Record<string, unknown>): Promise<ProcessIdentityDecision>;
  verifyOwnerProcessBindingsRevoked(input?: Record<string, unknown>): Promise<ProcessIdentityDecision>;
  describe(): Promise<ProcessIdentityDecision>;
  close(): void;
}

function isProcessIdentityState(value: ProcessIdentityObject): value is ProcessIdentityState {
  return Boolean(value.serverIdentity) &&
    Array.isArray(value.clients) &&
    Array.isArray(value.ownerProcessBindings) &&
    Array.isArray(value.retiredOwnerProcessBindingGenerations) &&
    Array.isArray(value.usedNonces);
}

function normalizedProcessIdentityState(value: ProcessIdentityObject): ProcessIdentityState {
  const normalized = normalizeState(value);
  if (!isProcessIdentityState(normalized)) {
    throw new Error("Normalized process identity state is incomplete.");
  }
  return normalized;
}

function errorDetails(error: unknown): { status: number; reasonCode: string; message: string } {
  const source = asObject(error, null);
  return {
    status: Number(source?.status || 400),
    reasonCode: text(source?.reasonCode) || "bootstrap_claim_invalid",
    message: error instanceof Error ? error.message : text(source?.message)
  };
}

export function createProcessIdentityService({
  dataDir = "",
  alias = DEFAULT_ALIAS,
  claimToken = "",
  claimTokenFile = "",
  capabilityKeyProvider = null,
  capabilityBindingGuard = null,
  maxTimestampSkewMs = DEFAULT_NONCE_TTL_MS,
  nonceTtlMs = DEFAULT_NONCE_TTL_MS,
  maxNonceCache = MAX_NONCE_CACHE
}: ProcessIdentityServiceOptions = {}): ProcessIdentityService {
  const resolvedAlias = safeAlias(alias);
  const resolvedDataDir = resolveDataDir(dataDir);
  const resolvedCapabilityKeyProvider = capabilityKeyProvider || createOpaqueCapabilityKeyProvider({
    dataDir: resolvedDataDir,
    alias: `${resolvedAlias}-capabilities`
  });
  const resolvedBindingGuard = capabilityBindingGuard || createCapabilityBindingGuard({
    dataDir: resolvedDataDir,
    alias: `${resolvedAlias}-bindings`
  });
  let loaded = false;
  let record: ProcessIdentityObject | null = null;
  let state: ProcessIdentityState;
  let mutationQueue: Promise<unknown> = Promise.resolve();
  const configuredMaxNonceCache = Number(maxNonceCache);
  const resolvedMaxNonceCache = Number.isSafeInteger(configuredMaxNonceCache) && configuredMaxNonceCache > 0
    ? configuredMaxNonceCache
    : MAX_NONCE_CACHE;

  async function load(): Promise<ProcessIdentityObject> {
    if (loaded) {
      return state;
    }
    record = await readRecord({ dataDir: resolvedDataDir, alias: resolvedAlias });
    state = normalizedProcessIdentityState(openState(record));
    loaded = true;
    if (state[PROCESS_IDENTITY_RETIRED_STATE_RESET] || !record.sealingKeyBase64 || !record.sealedState) {
      await save();
    } else if (!fs.existsSync(processIdentityStatePath({ dataDir: resolvedDataDir, alias: resolvedAlias }))) {
      await writeRecord({ dataDir: resolvedDataDir, alias: resolvedAlias }, record);
    }
    return state;
  }

  async function save(): Promise<ProcessIdentityObject> {
    state = normalizedProcessIdentityState({
      ...state,
      alias: resolvedAlias,
      updatedAt: nowIso()
    });
    record = createRecord({
      alias: resolvedAlias,
      state,
      sealingKeyBase64: record?.sealingKeyBase64
    });
    await writeRecord({ dataDir: resolvedDataDir, alias: resolvedAlias }, record);
    loaded = true;
    return state;
  }

  function enqueueMutation<T>(action: () => Promise<T> | T): Promise<T> {
    const run = mutationQueue.catch(()  => {}).then(async ()  => {
      await load();
      return action();
    });
    mutationQueue = run.then(()  => undefined, ()  => undefined);
    return run;
  }

  async function expectedClaimToken()  {
    const direct = text(claimToken || process.env.MESHRIX_PROCESS_IDENTITY_CLAIM_TOKEN);
    if (direct) {
      return direct;
    }
    const filePath = text(claimTokenFile || process.env.MESHRIX_PROCESS_IDENTITY_CLAIM_TOKEN_FILE);
    if (!filePath) {
      return "";
    }
    return text(await fs.promises.readFile(filePath, "utf8"));
  }

  function findActiveClient({ clientId = "", packageId = "", processKeyId = "" }: Record<string, unknown> = {})  {
    return (state.clients || []).find((client)  =>
      client.status === "valid" &&
      client.clientId === text(clientId) &&
      client.packageId === text(packageId) &&
      client.processKeyId === text(processKeyId)
    ) || null;
  }

  async function bootstrapClaim({ request = null, input = {} }: BootstrapClaimOptions = {})  {
    return enqueueMutation(async ()  => {
      const source = asObject(input);
      if (!requestIsLoopback(request)) {
        return deny(403, "bootstrap_claim_loopback_required", "Process identity bootstrap claim is restricted to loopback clients.");
      }
      const expected = await expectedClaimToken();
      if (!expected) {
        return deny(503, "bootstrap_claim_token_unconfigured", "Process identity bootstrap claim token is not configured.");
      }
      const provided = text(source.claimToken || source.claim_token || headerValue(request?.headers || {}, "x-meshrix-claim-token"));
      if (!provided || !timingSafeTextEqual(provided, expected)) {
        return deny(401, "bootstrap_claim_token_invalid", "Process identity bootstrap claim token is invalid.");
      }
      if (state.claimed === true || state.clients.some((client)  => client.status === "valid")) {
        return deny(409, "bootstrap_claim_already_consumed", "Process identity bootstrap claim has already been consumed.");
      }
      let normalizedClient;
      try {
        normalizedClient = normalizeClientInput(source);
      } catch (error) {
        const details = errorDetails(error);
        return deny(details.status, details.reasonCode, details.message);
      }
      const timestamp = nowIso();
      const packageId = text(source.packageId) || `cidpkg_${crypto.randomUUID()}`;
      const identityGeneration = 1;
      const credentialId = `procid_${packageId}`;
      const issued = await resolvedCapabilityKeyProvider.issue({
        credentialId,
        capabilities: normalizedClient.capabilities,
        issuedAt: timestamp,
        metadata: {
          component: "process-identity",
          packageId,
          clientId: normalizedClient.clientId,
          processKeyId: normalizedClient.processKeyId,
          clientFingerprintHash: normalizedClient.clientFingerprint.fingerprintHash
        }
      });
      const client = normalizeClientRecord({
        packageId,
        clientId: normalizedClient.clientId,
        installationId: normalizedClient.installationId,
        serverId: state.serverIdentity.serverId,
        serverTrustPin: state.serverIdentity.serverTrustPin,
        processKeyId: normalizedClient.processKeyId,
        processPublicKeyPem: normalizedClient.processPublicKeyPem,
        processPublicKeySpkiBase64: normalizedClient.processPublicKeySpkiBase64,
        processPublicKeyHash: normalizedClient.processPublicKeyHash,
        clientFingerprint: normalizedClient.clientFingerprint,
        defaultIdentityHash: normalizedClient.defaultIdentityHash,
        identityGeneration,
        capabilityCredentialId: issued.credentialId,
        capabilities: normalizedClient.capabilities,
        status: "valid",
        issuedAt: timestamp,
        expiresAt: text(source.expiresAt)
      });
      const binding = await resolvedBindingGuard.bindCapabilityKey({
        capabilityKey: issued.capabilityKey,
        credentialId: text(client.capabilityCredentialId),
        context: clientBindingContext(client),
        expiresAt: text(client.expiresAt)
      });
      state = {
        ...state,
        claimed: true,
        claimedAt: timestamp,
        claimCount: Number(state.claimCount || 0) + 1,
        clients: [client],
        usedNonces: []
      };
      await save();
      return {
        ok: true,
        status: 200,
        protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
        serverIdentity: publicServerIdentity(state.serverIdentity),
        binding,
        clientIdentityPackage: createClientIdentityPackage({
          state,
          client,
          capabilityKey: issued.capabilityKey,
          nonce: source.nonce
        })
      };
    });
  }

  async function recordNonce({ nonce = "", packageId = "", timestampMs = 0 }: Record<string, unknown> = {})  {
    const nonceHash = sha256TextBase64Url(`${packageId}\0${nonce}`);
    const now = Date.now();
    const freshNonces = (state.usedNonces || [])
      .filter((item)  => parseTimestampMs(item.expiresAt) > now);
    if (freshNonces.some((item)  => item.nonceHash === nonceHash)) {
      return { ok: false, reasonCode: "process_identity_nonce_replay" };
    }
    if (freshNonces.length >= resolvedMaxNonceCache) {
      return { ok: false, reasonCode: "process_identity_nonce_capacity_exhausted" };
    }
    freshNonces.push({
      nonceHash,
      packageId: text(packageId),
      seenAt: nowIso(),
      expiresAt: new Date(Math.max(now, Number(timestampMs)) + Math.max(1, Number(nonceTtlMs || DEFAULT_NONCE_TTL_MS))).toISOString()
    });
    state = {
      ...state,
      usedNonces: freshNonces
    };
    await save();
    return { ok: true };
  }

  async function verifySignedRequest({
    request = null,
    requestBody = Buffer.alloc(0),
    url = new URL("/", "http://127.0.0.1"),
    method = "GET",
    operation = {}
  }: VerifySignedRequestOptions = {})  {
    await mutationQueue.catch(()  => {});
    await load();
    if (operation?.processIdentity?.required !== true) {
      return { ok: true, applicable: false, reasonCode: "process_identity_not_required" };
    }
    const headers = request?.headers || {};
    const clientId = headerValue(headers, "x-meshrix-client-id");
    const packageId = headerValue(headers, "x-meshrix-identity-package-id");
    const processKeyId = headerValue(headers, "x-meshrix-process-key-id");
    const timestamp = headerValue(headers, "x-meshrix-timestamp");
    const nonce = headerValue(headers, "x-meshrix-nonce");
    const bodyHash = headerValue(headers, "x-meshrix-body-sha256").toLowerCase();
    const signature = headerValue(headers, "x-meshrix-signature");
    const capabilityKey = capabilityKeyFromHeaders(headers);
    if (!clientId || !packageId || !processKeyId || !timestamp || !nonce || !bodyHash || !signature || !capabilityKey) {
      return deny(401, "process_identity_headers_missing", "Process identity signature headers are required.");
    }
    if (bodyHash !== bodySha256Hex(requestBody)) {
      return deny(401, "process_identity_body_hash_mismatch", "Process identity body hash mismatch.");
    }
    const timestampMs = parseTimestampMs(timestamp);
    if (!timestampMs || Math.abs(Date.now() - timestampMs) > Math.max(1000, Number(maxTimestampSkewMs || DEFAULT_NONCE_TTL_MS))) {
      return deny(401, "process_identity_timestamp_invalid", "Process identity timestamp is outside the accepted window.");
    }
    const client = findActiveClient({ clientId, packageId, processKeyId });
    if (!client) {
      return deny(401, "process_identity_package_unknown", "Process identity package is not active.");
    }
    const expectedFingerprint = normalizeClientFingerprint(client.clientFingerprint, { required: false });
    let requestFingerprint;
    try {
      requestFingerprint = clientFingerprintFromHeaders(headers);
    } catch {
      return deny(401, "process_identity_client_fingerprint_mismatch", "Process identity client fingerprint hash is invalid.");
    }
    if (expectedFingerprint.fingerprintId) {
      if (!requestFingerprint.fingerprintId || !requestFingerprint.machineInstanceId || !requestFingerprint.appInstanceId || !requestFingerprint.runtimeInstanceId) {
        return deny(401, "process_identity_client_fingerprint_missing", "Process identity client fingerprint headers are required.");
      }
      if (!clientFingerprintMatches(expectedFingerprint, requestFingerprint)) {
        return deny(401, "process_identity_client_fingerprint_mismatch", "Process identity client fingerprint does not match the signed package.");
      }
    }
    const canonical = canonicalProcessIdentityRequest({
      method,
      pathWithQuery: pathWithQueryFromUrl(url),
      bodySha256: bodyHash,
      timestamp,
      nonce,
      clientId,
      packageId,
      processKeyId,
      clientFingerprint: requestFingerprint
    });
    const signatureOk = crypto.verify(
      null,
      Buffer.from(canonical, "utf8"),
      crypto.createPublicKey(text(client.processPublicKeyPem)),
      Buffer.from(signature, "base64url")
    );
    if (!signatureOk) {
      return deny(401, "process_identity_signature_invalid", "Process identity request signature is invalid.");
    }
    const requiredCapabilities = operationRequiredCapabilities(operation);
    const capabilityDecision = await resolvedCapabilityKeyProvider.verify({
      capabilityKey,
      requiredCapabilities,
      includeRecordDetails: true
    });
    if (!capabilityDecision.ok) {
      return deny(403, capabilityDecision.reasonCode || "process_identity_capability_denied", "Process identity capability key is not authorized.");
    }
    const bindingDecision = await resolvedBindingGuard.verifyCapabilityKeyBinding({
      capabilityKey,
      credentialId: client.capabilityCredentialId,
      context: clientBindingContext(client)
    });
    const requireBinding = operation.processIdentity?.requireBinding !== false;
    if (!bindingDecision.ok || (requireBinding && bindingDecision.applicable === false)) {
      return deny(
        403,
        bindingDecision.reasonCode || "process_identity_binding_denied",
        "Process identity capability binding is not authorized."
      );
    }
    return enqueueMutation(async ()  => {
      const nonceDecision = await recordNonce({ nonce, packageId, timestampMs });
      if (!nonceDecision.ok) {
        return deny(
          nonceDecision.reasonCode === "process_identity_nonce_capacity_exhausted" ? 503 : 401,
          nonceDecision.reasonCode,
          nonceDecision.reasonCode === "process_identity_nonce_capacity_exhausted"
            ? "Process identity replay protection is temporarily at capacity."
            : "Process identity request nonce was already used."
        );
      }
      const actor: Record<string, unknown> = {
        type: "process-client",
        userId: client.clientId,
        subjectId: client.clientId,
        username: client.clientId,
        roleId: "process-identity",
        grantId: client.packageId,
        clientId: client.clientId,
        packageId: client.packageId,
        processKeyId: client.processKeyId,
        clientFingerprint: client.clientFingerprint,
        scopes: [],
        capabilities: requiredCapabilities
      };
      return {
        ok: true,
        applicable: true,
        reasonCode: "process_identity_verified",
        client,
        capabilityKey,
        requiredCapabilities,
        capabilityDecision,
        bindingDecision,
        actor,
        authSession: { user: actor }
      };
    });
  }

  async function revalidateVerifiedRequest({
    verification = null,
    operation = {}
  }: RevalidateVerifiedRequestOptions = {})  {
    await mutationQueue.catch(()  => {});
    await load();
    const verified = asObject(verification, null);
    if (
      verified?.ok !== true ||
      !verified.client ||
      !verified.capabilityKey
    ) {
      return deny(
        401,
        "process_identity_verification_required",
        "Current process identity verification is required."
      );
    }
    const verifiedClient = asObject(verified.client);
    const current = findActiveClient({
      clientId: verifiedClient.clientId,
      packageId: verifiedClient.packageId,
      processKeyId: verifiedClient.processKeyId
    });
    if (!current) {
      return deny(
        403,
        "process_identity_package_not_active",
        "Process identity package is no longer active."
      );
    }
    const requiredCapabilities = operationRequiredCapabilities(operation);
    const capabilityDecision = await resolvedCapabilityKeyProvider.verify({
      capabilityKey: text(verified.capabilityKey),
      requiredCapabilities,
      includeRecordDetails: true
    });
    if (!capabilityDecision.ok) {
      return deny(
        403,
        capabilityDecision.reasonCode || "process_identity_capability_denied",
        "Process identity capability key is no longer authorized."
      );
    }
    const bindingDecision = await resolvedBindingGuard.verifyCapabilityKeyBinding({
      capabilityKey: text(verified.capabilityKey),
      credentialId: text(current.capabilityCredentialId),
      context: clientBindingContext(current)
    });
    const requireBinding = operation.processIdentity?.requireBinding !== false;
    if (!bindingDecision.ok || (requireBinding && bindingDecision.applicable === false)) {
      return deny(
        403,
        bindingDecision.reasonCode || "process_identity_binding_denied",
        "Process identity capability binding is no longer authorized."
      );
    }
    return {
      ok: true,
      applicable: true,
      reasonCode: "process_identity_current",
      client: current,
      capabilityKey: text(verified.capabilityKey),
      requiredCapabilities,
      capabilityDecision,
      bindingDecision,
      actor: verified.actor,
      authSession: verified.authSession
    };
  }

  async function rotateClientIdentityPackage({ request = null, input = {} }: AuthenticatedRequestOptions = {})  {
    const verification = asObject(request?.__meshrixProcessIdentity, null);
    if (!verification?.ok || !verification.client || !verification.capabilityKey) {
      return deny(401, "process_identity_verification_required", "Current process identity verification is required.");
    }
    const verifiedClient = asObject(verification.client);
    return enqueueMutation(async ()  => {
      const source = asObject(input);
      const current = findActiveClient({
        clientId: verifiedClient.clientId,
        packageId: verifiedClient.packageId,
        processKeyId: verifiedClient.processKeyId
      });
      if (!current) {
        return deny(409, "process_identity_package_not_active", "Current process identity package is no longer active.");
      }
      const key = source.processPublicKeyPem || source.processPublicKeySpkiBase64 || source.publicKeyPem || source.publicKeySpkiBase64
        ? publicKeyFromInput(source)
        : {
            processKeyId: current.processKeyId,
            processPublicKeyPem: current.processPublicKeyPem,
            processPublicKeySpkiBase64: current.processPublicKeySpkiBase64,
            processPublicKeyHash: current.processPublicKeyHash
          };
      const timestamp = nowIso();
      const packageId = text(source.packageId) || `cidpkg_${crypto.randomUUID()}`;
      const credentialId = `procid_${packageId}`;
      const capabilities = Array.isArray(current.capabilities) && current.capabilities.length
        ? [...current.capabilities]
        : [...DEFAULT_PROCESS_IDENTITY_CAPABILITIES];
      const rotated = await resolvedCapabilityKeyProvider.rotateCapabilityKey({
        capabilityKey: text(verification.capabilityKey),
        capabilities,
        credentialId,
        reason: text(source.reason) || "process_identity_package_rotated",
        metadata: {
          component: "process-identity",
          packageId,
          clientId: current.clientId,
          processKeyId: key.processKeyId
        }
      });
      if (!rotated.ok) {
        return deny(403, rotated.reasonCode || "process_identity_rotation_denied", "Process identity capability key rotation failed.");
      }
      await resolvedBindingGuard.invalidateCapabilityKeyBinding({
        capabilityKey: text(verification.capabilityKey),
        credentialId: text(current.capabilityCredentialId),
        reason: "process_identity_package_rotated"
      });
      const nextClient = normalizeClientRecord({
        ...current,
        packageId,
        processKeyId: key.processKeyId,
        processPublicKeyPem: key.processPublicKeyPem,
        processPublicKeySpkiBase64: key.processPublicKeySpkiBase64,
        processPublicKeyHash: key.processPublicKeyHash,
        identityGeneration: Number(current.identityGeneration || 1) + 1,
        capabilityCredentialId: rotated.credentialId,
        capabilities,
        status: "valid",
        issuedAt: timestamp,
        expiresAt: text(source.expiresAt || current.expiresAt),
        rotatedAt: "",
        revokedAt: "",
        revocationReason: ""
      });
      await resolvedBindingGuard.bindCapabilityKey({
        capabilityKey: rotated.capabilityKey,
        credentialId: text(nextClient.capabilityCredentialId),
        context: clientBindingContext(nextClient),
        expiresAt: text(nextClient.expiresAt)
      });
      state = {
        ...state,
        clients: [
          ...state.clients.map((client)  => client.packageId === current.packageId
            ? normalizeClientRecord({ ...client, status: "rotated", rotatedAt: timestamp })
            : client),
          nextClient
        ]
      };
      await save();
      return {
        ok: true,
        status: 200,
        protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
        serverIdentity: publicServerIdentity(state.serverIdentity),
        clientIdentityPackage: createClientIdentityPackage({
          state,
          client: nextClient,
          capabilityKey: rotated.capabilityKey,
          nonce: source.nonce
        })
      };
    });
  }

  async function revokeClientIdentityPackage({ request = null, input = {} }: AuthenticatedRequestOptions = {})  {
    const verification = asObject(request?.__meshrixProcessIdentity, null);
    if (!verification?.ok || !verification.client || !verification.capabilityKey) {
      return deny(401, "process_identity_verification_required", "Current process identity verification is required.");
    }
    const verifiedClient = asObject(verification.client);
    return enqueueMutation(async ()  => {
      const source = asObject(input);
      const timestamp = nowIso();
      const reason = text(source.reason) || "process_identity_package_revoked";
      const endpoint = text(source.revocationEndpoint || source.endpoint) || "/api/process-identity/package/revoke";
      const ownerSubjectRef = text(source.ownerSubjectRef);
      const ownerArtifactId = text(source.ownerArtifactId);
      const ownerArtifactDigestSha256 = text(source.ownerArtifactDigestSha256);
      await resolvedCapabilityKeyProvider.invalidate({
        capabilityKey: text(verification.capabilityKey),
        reason
      });
      await resolvedBindingGuard.invalidateCapabilityKeyBinding({
        capabilityKey: text(verification.capabilityKey),
        credentialId: text(verifiedClient.capabilityCredentialId),
        reason
      });
      const revokedClientBase = normalizeClientRecord({
        ...verifiedClient,
        status: "revoked",
        revokedAt: timestamp,
        revocationReason: reason,
        revocationEndpoint: endpoint,
        ownerSubjectRef,
        ownerArtifactId,
        ownerArtifactDigestSha256
      });
      const revocationReceipt = createProcessIdentityRevocationReceipt({
        state,
        client: revokedClientBase,
        revokedAt: timestamp,
        reason,
        endpoint,
        ownerSubjectRef,
        ownerArtifactId,
        ownerArtifactDigestSha256
      });
      const revokedClient = normalizeClientRecord({
        ...revokedClientBase,
        revocationReceiptDigestSha256: revocationReceipt.receiptDigestSha256
      });
      state = {
        ...state,
        clients: state.clients.map((client)  => client.packageId === verifiedClient.packageId
          ? revokedClient
          : client)
      };
      await save();
      return {
        ok: true,
        status: 200,
        protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
        packageId: verifiedClient.packageId,
        revokedAt: timestamp,
        reason,
        revocationReceipt
      };
    });
  }

  async function verifyClientIdentityRevocationReceipt({ receipt = null, expected = {} }: Record<string, unknown> = {})  {
    await mutationQueue.catch(()  => {});
    await load();
    const signatureDecision = verifyProcessIdentityRevocationReceiptSignature({
      receipt: asObject(receipt, null),
      serverIdentity: state.serverIdentity,
      expected: asObject(expected)
    });
    if (!signatureDecision.ok) {
      return deny(
        400,
        signatureDecision.reasonCode || "process_identity_revocation_receipt_invalid",
        "Process identity revocation receipt signature or binding is invalid."
      );
    }
    const payload = asObject(signatureDecision.payload);
    const client = (state.clients || []).find((candidate)  =>
      candidate.packageId === payload.packageId &&
      candidate.clientId === payload.clientId &&
      candidate.processKeyId === payload.processKeyId
    );
    if (!client) {
      return deny(404, "process_identity_revocation_receipt_client_not_found", "Process identity revocation receipt client is not recorded.");
    }
    if (client.status !== "revoked") {
      return deny(409, "process_identity_revocation_receipt_client_not_revoked", "Process identity package is not revoked.");
    }
    if (text(client.revocationReceiptDigestSha256) !== signatureDecision.receiptDigestSha256) {
      return deny(409, "process_identity_revocation_receipt_not_recorded", "Process identity revocation receipt is not recorded for this client.");
    }
    return {
      ok: true,
      status: 200,
      reasonCode: "process_identity_revocation_receipt_verified",
      receiptDigestSha256: signatureDecision.receiptDigestSha256,
      client: {
        packageId: client.packageId,
        clientId: client.clientId,
        processKeyId: client.processKeyId,
        status: client.status,
        revokedAt: client.revokedAt,
        revocationReason: client.revocationReason
      }
    };
  }

  function ownerProcessBindingContext(input: Record<string, unknown> = {}): OwnerProcessBindingContext | null {
    const identity = asObject(input.identityContext);
    const targetRef = text(input.targetRef);
    if (!text(identity.tenant) || !text(identity.subject) || !targetRef || (text(identity.target) && text(identity.target) !== targetRef)) {
      return null;
    }
    return {
      tenant: text(identity.tenant),
      subject: text(identity.subject),
      target: targetRef,
      device: text(identity.device),
      process: text(identity.process),
      workspace: text(identity.workspace),
      correlation: text(identity.correlation)
    };
  }

  function ownerProcessBindingDecision(
    input: Record<string, unknown> = {},
    binding: ProcessIdentityObject | null = null
  ): OwnerProcessBindingDecision | ReturnType<typeof deny> {
    const ownerId = text(input.ownerId);
    const ownerGenerationDigest = text(input.ownerGenerationDigest);
    const context = ownerProcessBindingContext(input);
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !/^[a-f0-9]{64}$/u.test(ownerGenerationDigest) || !context) {
      return deny(400, "owner_process_binding_context_invalid", "Owner process binding context is invalid.");
    }
    const contextDigest = sha256Hex(stableJson(context));
    if (binding && (
      text(binding.ownerId) !== ownerId ||
      text(binding.ownerGenerationDigest) !== ownerGenerationDigest ||
      text(binding.contextDigest) !== contextDigest
    )) {
      return deny(403, "owner_process_binding_mismatch", "Owner process binding does not match.");
    }
    return { ok: true, ownerId, ownerGenerationDigest, context, contextDigest };
  }

  async function issueOwnerProcessBinding(input: Record<string, unknown> = {})  {
    return enqueueMutation(async ()  => {
      const decision = ownerProcessBindingDecision(input);
      if (!decision.ok || !("ownerId" in decision)) return decision;
      if ((state.retiredOwnerProcessBindingGenerations || []).some((entry)  => entry.ownerId === decision.ownerId &&
          entry.ownerGenerationDigest === decision.ownerGenerationDigest)) {
        return deny(409, "owner_process_binding_generation_retired", "Owner process binding generation is retired.");
      }
      const key = text(input.idempotencyKey);
      if (!key || key.length > 256) return deny(400, "owner_process_binding_idempotency_invalid", "Owner process binding idempotency key is invalid.");
      const idempotencyKeyDigest = sha256Hex(stableJson([decision.ownerId, decision.ownerGenerationDigest, key]));
      const existing = (state.ownerProcessBindings || []).find((binding)  => binding.idempotencyKeyDigest === idempotencyKeyDigest);
      if (existing) {
        if (existing.contextDigest !== decision.contextDigest || existing.targetRef !== decision.context.target) {
          return deny(409, "owner_process_binding_idempotency_conflict", "Owner process binding idempotency key conflicts with an existing binding.");
        }
        return { ok: true, ...existing };
      }
      const issuedAt = nowIso();
      const processIdentityRef = `procbind_${sha256Hex(`${decision.contextDigest}\0${idempotencyKeyDigest}`).slice(0, 32)}`;
      const binding: Record<string, unknown> = {
        processIdentityRef,
        ownerId: decision.ownerId,
        ownerGenerationDigest: decision.ownerGenerationDigest,
        bindingRef: `binding_${sha256Hex(`${processIdentityRef}\0${decision.contextDigest}`).slice(0, 32)}`,
        targetRef: decision.context.target,
        contextDigest: decision.contextDigest,
        idempotencyKeyDigest,
        status: "valid",
        issuedAt,
        expiresAt: text(input.deadline),
        revokedAt: "",
        receiptDigest: ""
      };
      const previousState = state;
      const previousRecord = record;
      state = { ...state, ownerProcessBindings: [...(state.ownerProcessBindings || []), binding] };
      try {
        await save();
      } catch (error) {
        state = previousState;
        record = previousRecord;
        loaded = true;
        throw error;
      }
      return { ok: true, ...binding };
    });
  }

  async function inspectOwnerProcessBinding(input: Record<string, unknown> = {})  {
    await mutationQueue.catch(()  => {});
    await load();
    const binding = (state.ownerProcessBindings || []).find((candidate)  => candidate.processIdentityRef === text(input.processIdentityRef));
    if (!binding) return deny(404, "owner_process_binding_not_found", "Owner process binding was not found.");
    const decision = ownerProcessBindingDecision({ ...input, targetRef: binding.targetRef }, binding);
    return decision.ok ? { ok: true, ...binding } : decision;
  }

  async function revokeOwnerProcessBinding(input: Record<string, unknown> = {})  {
    return enqueueMutation(async ()  => {
      const processIdentityRef = text(input.processIdentityRef);
      const binding = (state.ownerProcessBindings || []).find((candidate)  => candidate.processIdentityRef === processIdentityRef);
      if (!binding) return deny(404, "owner_process_binding_not_found", "Owner process binding was not found.");
      const decision = ownerProcessBindingDecision({ ...input, targetRef: binding.targetRef }, binding);
      if (!decision.ok || !("ownerId" in decision)) return decision;
      if (binding.status === "revoked") return { ok: true, ...binding };
      const revokedAt = nowIso();
      const payload: Record<string, unknown> = {
        receiptKind: "owner-process-binding-revocation",
        ownerId: binding.ownerId,
        ownerGenerationDigest: binding.ownerGenerationDigest,
        status: "revoked",
        processIdentityRef,
        bindingRef: binding.bindingRef,
        targetRef: binding.targetRef,
        contextDigest: binding.contextDigest,
        revokedAt,
        serverId: state.serverIdentity.serverId,
        serverKeyId: state.serverIdentity.serverKeyId
      };
      const receiptDigest = sha256Hex(stableJson(payload));
      const receipt: Record<string, unknown> = {
        ...payload,
        receiptDigest,
        signature: {
          algorithm: "ed25519",
          keyId: state.serverIdentity.serverKeyId,
          payloadDigest: `sha256:${receiptDigest}`,
          value: signStableObject(text(state.serverIdentity.privateKeyPem), payload)
        }
      };
      const next: Record<string, unknown> = { ...binding, status: "revoked", revokedAt, receiptDigest };
      const previousState = state;
      const previousRecord = record;
      state = {
        ...state,
        ownerProcessBindings: state.ownerProcessBindings.map((candidate)  => candidate.processIdentityRef === processIdentityRef ? next : candidate)
      };
      try {
        await save();
      } catch (error) {
        state = previousState;
        record = previousRecord;
        loaded = true;
        throw error;
      }
      return { ok: true, ...next, revocationReceipt: receipt };
    });
  }

  async function revokeOwnerProcessBindings(input: Record<string, unknown> = {})  {
    return enqueueMutation(async ()  => {
      const ownerId = text(input.ownerId);
      const ownerGenerationDigest = text(input.ownerGenerationDigest);
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !/^[a-f0-9]{64}$/u.test(ownerGenerationDigest)) return deny(400, "owner_process_binding_owner_invalid", "Owner process binding owner is invalid.");
      const revokedAt = nowIso();
      const retiredGenerations = state.retiredOwnerProcessBindingGenerations || [];
      const alreadyRetired = retiredGenerations.some((entry)  => entry.ownerId === ownerId &&
        entry.ownerGenerationDigest === ownerGenerationDigest);
      if (!alreadyRetired && retiredGenerations.length >= MAX_RETIRED_OWNER_PROCESS_BINDING_GENERATIONS) {
        return deny(507, "owner_process_binding_retirement_capacity_exceeded", "Owner process binding retirement capacity is full.");
      }
      let revokedCount = 0;
      const nextBindings = (state.ownerProcessBindings || []).map((binding)  => {
        if (binding.ownerId !== ownerId || binding.ownerGenerationDigest !== ownerGenerationDigest || binding.status === "revoked") return binding;
        revokedCount += 1;
        const receiptDigest = sha256Hex(stableJson({
          receiptKind: "owner-process-bindings-revocation",
          ownerId,
          ownerGenerationDigest,
          processIdentityRef: binding.processIdentityRef,
          bindingRef: binding.bindingRef,
          targetRef: binding.targetRef,
          contextDigest: binding.contextDigest,
          revokedAt
        }));
        return { ...binding, status: "revoked", revokedAt, receiptDigest };
      });
      if (revokedCount > 0 || !alreadyRetired) {
        const previousState = state;
        const previousRecord = record;
        state = {
          ...state,
          ownerProcessBindings: nextBindings,
          retiredOwnerProcessBindingGenerations: alreadyRetired
            ? retiredGenerations
            : [...retiredGenerations, { ownerId, ownerGenerationDigest, retiredAt: revokedAt }]
        };
        try {
          await save();
        } catch (error) {
          state = previousState;
          record = previousRecord;
          loaded = true;
          throw error;
        }
      }
      const remainingCount = nextBindings.filter((binding)  => binding.ownerId === ownerId && binding.ownerGenerationDigest === ownerGenerationDigest && binding.status !== "revoked").length;
      return { ok: remainingCount === 0, ownerId, ownerGenerationDigest, revokedCount, remainingCount };
    });
  }

  async function verifyOwnerProcessBindingsRevoked(input: Record<string, unknown> = {})  {
    await mutationQueue.catch(()  => {});
    await load();
    const ownerId = text(input.ownerId);
    const ownerGenerationDigest = text(input.ownerGenerationDigest);
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !/^[a-f0-9]{64}$/u.test(ownerGenerationDigest)) return deny(400, "owner_process_binding_owner_invalid", "Owner process binding owner is invalid.");
    const remainingCount = (state.ownerProcessBindings || []).filter((binding)  => binding.ownerId === ownerId && binding.ownerGenerationDigest === ownerGenerationDigest && binding.status !== "revoked").length;
    return { ok: remainingCount === 0, ownerId, ownerGenerationDigest, remainingCount };
  }

  async function describe()  {
    await mutationQueue.catch(()  => {});
    await load();
    return {
      ok: true,
      protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
      alias: resolvedAlias,
      stateRoot: stateRoot(state),
      serverIdentity: publicServerIdentity(state.serverIdentity),
      claimed: state.claimed === true,
      claimCount: Number(state.claimCount || 0),
      activeClientCount: state.clients.filter((client)  => client.status === "valid").length,
      clientCount: state.clients.length,
      statePath: processIdentityStatePath({ dataDir: resolvedDataDir, alias: resolvedAlias })
    };
  }

  return Object.freeze({
    protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
    bootstrapClaim,
    verifySignedRequest,
    revalidateVerifiedRequest,
    rotateClientIdentityPackage,
    revokeClientIdentityPackage,
    verifyClientIdentityRevocationReceipt,
    issueOwnerProcessBinding,
    inspectOwnerProcessBinding,
    revokeOwnerProcessBinding,
    revokeOwnerProcessBindings,
    verifyOwnerProcessBindingsRevoked,
    describe,
    capabilityKeyProvider: resolvedCapabilityKeyProvider,
    capabilityBindingGuard: resolvedBindingGuard,
    close()  {
      resolvedCapabilityKeyProvider.close?.();
      resolvedBindingGuard.close?.();
    }
  });
}

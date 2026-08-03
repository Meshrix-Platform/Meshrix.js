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
  asArray,
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
  uniqueStrings,
  writeRecord
} from "./process-identity-core.ts";

const MAX_RETIRED_OWNER_PROCESS_BINDING_GENERATIONS: any = 4096;
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
}: Record<string, any> = {}) : any {
  const resolvedAlias: any = safeAlias(alias);
  const resolvedDataDir: any = resolveDataDir(dataDir);
  const resolvedCapabilityKeyProvider: any = capabilityKeyProvider || createOpaqueCapabilityKeyProvider({
    dataDir: resolvedDataDir,
    alias: `${resolvedAlias}-capabilities`
  });
  const resolvedBindingGuard: any = capabilityBindingGuard || createCapabilityBindingGuard({
    dataDir: resolvedDataDir,
    alias: `${resolvedAlias}-bindings`
  });
  let loaded: any = false;
  let record: any = null;
  let state: any = null;
  let mutationQueue: any = Promise.resolve();
  const configuredMaxNonceCache: any = Number(maxNonceCache);
  const resolvedMaxNonceCache: any = Number.isSafeInteger(configuredMaxNonceCache) && configuredMaxNonceCache > 0
    ? configuredMaxNonceCache
    : MAX_NONCE_CACHE;

  async function load() : Promise<any> {
    if (loaded) {
      return state;
    }
    record = await readRecord({ dataDir: resolvedDataDir, alias: resolvedAlias });
    state = openState(record);
    loaded = true;
    if (state[PROCESS_IDENTITY_RETIRED_STATE_RESET] || !record.sealingKeyBase64 || !record.sealedState) {
      await save();
    } else if (!fs.existsSync(processIdentityStatePath({ dataDir: resolvedDataDir, alias: resolvedAlias }))) {
      await writeRecord({ dataDir: resolvedDataDir, alias: resolvedAlias }, record);
    }
    return state;
  }

  async function save() : Promise<any> {
    state = normalizeState({
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

  function enqueueMutation(action?: any) : any {
    const run: any = mutationQueue.catch(() : any => {}).then(async () : Promise<any> => {
      await load();
      return action();
    });
    mutationQueue = run.then(() : any => undefined, () : any => undefined);
    return run;
  }

  async function expectedClaimToken() : Promise<any> {
    const direct: any = text(claimToken || process.env.MESHRIX_PROCESS_IDENTITY_CLAIM_TOKEN);
    if (direct) {
      return direct;
    }
    const filePath: any = text(claimTokenFile || process.env.MESHRIX_PROCESS_IDENTITY_CLAIM_TOKEN_FILE);
    if (!filePath) {
      return "";
    }
    return text(await fs.promises.readFile(filePath, "utf8"));
  }

  function findActiveClient({ clientId = "", packageId = "", processKeyId = "" }: Record<string, any> = {}) : any {
    return (state.clients || []).find((client?: any) : any =>
      client.status === "valid" &&
      client.clientId === text(clientId) &&
      client.packageId === text(packageId) &&
      client.processKeyId === text(processKeyId)
    ) || null;
  }

  async function bootstrapClaim({ request = null, input = {} }: Record<string, any> = {}) : Promise<any> {
    return enqueueMutation(async () : Promise<any> => {
      const source: any = asObject(input);
      if (!requestIsLoopback(request)) {
        return deny(403, "bootstrap_claim_loopback_required", "Process identity bootstrap claim is restricted to loopback clients.");
      }
      const expected: any = await expectedClaimToken();
      if (!expected) {
        return deny(503, "bootstrap_claim_token_unconfigured", "Process identity bootstrap claim token is not configured.");
      }
      const provided: any = text(source.claimToken || source.claim_token || headerValue(request?.headers || {}, "x-meshrix-claim-token"));
      if (!provided || !timingSafeTextEqual(provided, expected)) {
        return deny(401, "bootstrap_claim_token_invalid", "Process identity bootstrap claim token is invalid.");
      }
      if (state.claimed === true || state.clients.some((client?: any) : any => client.status === "valid")) {
        return deny(409, "bootstrap_claim_already_consumed", "Process identity bootstrap claim has already been consumed.");
      }
      let normalizedClient: any;
      try {
        normalizedClient = normalizeClientInput(source);
      } catch (error: any) {
        return deny(error.status || 400, error.reasonCode || "bootstrap_claim_invalid", error.message);
      }
      const timestamp: any = nowIso();
      const packageId: any = text(source.packageId) || `cidpkg_${crypto.randomUUID()}`;
      const identityGeneration: any = 1;
      const credentialId: any = `procid_${packageId}`;
      const issued: any = await resolvedCapabilityKeyProvider.issue({
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
      const client: any = normalizeClientRecord({
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
      const binding: any = await resolvedBindingGuard.bindCapabilityKey({
        capabilityKey: issued.capabilityKey,
        credentialId: client.capabilityCredentialId,
        context: clientBindingContext(client),
        expiresAt: client.expiresAt
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

  async function recordNonce({ nonce = "", packageId = "", timestampMs = 0 }: Record<string, any> = {}) : Promise<any> {
    const nonceHash: any = sha256TextBase64Url(`${packageId}\0${nonce}`);
    const now: any = Date.now();
    const freshNonces: any = (state.usedNonces || [])
      .filter((item?: any) : any => parseTimestampMs(item.expiresAt) > now);
    if (freshNonces.some((item?: any) : any => item.nonceHash === nonceHash)) {
      return { ok: false, reasonCode: "process_identity_nonce_replay" };
    }
    if (freshNonces.length >= resolvedMaxNonceCache) {
      return { ok: false, reasonCode: "process_identity_nonce_capacity_exhausted" };
    }
    freshNonces.push({
      nonceHash,
      packageId,
      seenAt: nowIso(),
      expiresAt: new Date(Math.max(now, timestampMs) + Math.max(1, Number(nonceTtlMs || DEFAULT_NONCE_TTL_MS))).toISOString()
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
  }: Record<string, any> = {}) : Promise<any> {
    await mutationQueue.catch(() : any => {});
    await load();
    if (operation?.processIdentity?.required !== true) {
      return { ok: true, applicable: false, reasonCode: "process_identity_not_required" };
    }
    const headers: any = request?.headers || {};
    const clientId: any = headerValue(headers, "x-meshrix-client-id");
    const packageId: any = headerValue(headers, "x-meshrix-identity-package-id");
    const processKeyId: any = headerValue(headers, "x-meshrix-process-key-id");
    const timestamp: any = headerValue(headers, "x-meshrix-timestamp");
    const nonce: any = headerValue(headers, "x-meshrix-nonce");
    const bodyHash: any = headerValue(headers, "x-meshrix-body-sha256").toLowerCase();
    const signature: any = headerValue(headers, "x-meshrix-signature");
    const capabilityKey: any = capabilityKeyFromHeaders(headers);
    if (!clientId || !packageId || !processKeyId || !timestamp || !nonce || !bodyHash || !signature || !capabilityKey) {
      return deny(401, "process_identity_headers_missing", "Process identity signature headers are required.");
    }
    if (bodyHash !== bodySha256Hex(requestBody)) {
      return deny(401, "process_identity_body_hash_mismatch", "Process identity body hash mismatch.");
    }
    const timestampMs: any = parseTimestampMs(timestamp);
    if (!timestampMs || Math.abs(Date.now() - timestampMs) > Math.max(1000, Number(maxTimestampSkewMs || DEFAULT_NONCE_TTL_MS))) {
      return deny(401, "process_identity_timestamp_invalid", "Process identity timestamp is outside the accepted window.");
    }
    const client: any = findActiveClient({ clientId, packageId, processKeyId });
    if (!client) {
      return deny(401, "process_identity_package_unknown", "Process identity package is not active.");
    }
    const expectedFingerprint: any = normalizeClientFingerprint(client.clientFingerprint, { required: false });
    let requestFingerprint: any;
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
    const canonical: any = canonicalProcessIdentityRequest({
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
    const signatureOk: any = crypto.verify(
      null,
      Buffer.from(canonical, "utf8"),
      crypto.createPublicKey(client.processPublicKeyPem),
      Buffer.from(signature, "base64url")
    );
    if (!signatureOk) {
      return deny(401, "process_identity_signature_invalid", "Process identity request signature is invalid.");
    }
    const requiredCapabilities: any = operationRequiredCapabilities(operation);
    const capabilityDecision: any = await resolvedCapabilityKeyProvider.verify({
      capabilityKey,
      requiredCapabilities,
      includeRecordDetails: true
    });
    if (!capabilityDecision.ok) {
      return deny(403, capabilityDecision.reasonCode || "process_identity_capability_denied", "Process identity capability key is not authorized.");
    }
    const bindingDecision: any = await resolvedBindingGuard.verifyCapabilityKeyBinding({
      capabilityKey,
      credentialId: client.capabilityCredentialId,
      context: clientBindingContext(client)
    });
    const requireBinding: any = operation.processIdentity?.requireBinding !== false;
    if (!bindingDecision.ok || (requireBinding && bindingDecision.applicable === false)) {
      return deny(
        403,
        bindingDecision.reasonCode || "process_identity_binding_denied",
        "Process identity capability binding is not authorized."
      );
    }
    return enqueueMutation(async () : Promise<any> => {
      const nonceDecision: any = await recordNonce({ nonce, packageId, timestampMs });
      if (!nonceDecision.ok) {
        return deny(
          nonceDecision.reasonCode === "process_identity_nonce_capacity_exhausted" ? 503 : 401,
          nonceDecision.reasonCode,
          nonceDecision.reasonCode === "process_identity_nonce_capacity_exhausted"
            ? "Process identity replay protection is temporarily at capacity."
            : "Process identity request nonce was already used."
        );
      }
      const actor: Record<string, any> = {
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
  }: Record<string, any> = {}) : Promise<any> {
    await mutationQueue.catch(() : any => {});
    await load();
    if (
      verification?.ok !== true ||
      !verification.client ||
      !verification.capabilityKey
    ) {
      return deny(
        401,
        "process_identity_verification_required",
        "Current process identity verification is required."
      );
    }
    const current: any = findActiveClient({
      clientId: verification.client.clientId,
      packageId: verification.client.packageId,
      processKeyId: verification.client.processKeyId
    });
    if (!current) {
      return deny(
        403,
        "process_identity_package_not_active",
        "Process identity package is no longer active."
      );
    }
    const requiredCapabilities: any = operationRequiredCapabilities(operation);
    const capabilityDecision: any = await resolvedCapabilityKeyProvider.verify({
      capabilityKey: verification.capabilityKey,
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
    const bindingDecision: any = await resolvedBindingGuard.verifyCapabilityKeyBinding({
      capabilityKey: verification.capabilityKey,
      credentialId: current.capabilityCredentialId,
      context: clientBindingContext(current)
    });
    const requireBinding: any = operation.processIdentity?.requireBinding !== false;
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
      capabilityKey: verification.capabilityKey,
      requiredCapabilities,
      capabilityDecision,
      bindingDecision,
      actor: verification.actor,
      authSession: verification.authSession
    };
  }

  async function rotateClientIdentityPackage({ request = null, input = {} }: Record<string, any> = {}) : Promise<any> {
    const verification: any = request?.__meshrixProcessIdentity;
    if (!verification?.ok || !verification.client || !verification.capabilityKey) {
      return deny(401, "process_identity_verification_required", "Current process identity verification is required.");
    }
    return enqueueMutation(async () : Promise<any> => {
      const source: any = asObject(input);
      const current: any = findActiveClient({
        clientId: verification.client.clientId,
        packageId: verification.client.packageId,
        processKeyId: verification.client.processKeyId
      });
      if (!current) {
        return deny(409, "process_identity_package_not_active", "Current process identity package is no longer active.");
      }
      const key: any = source.processPublicKeyPem || source.processPublicKeySpkiBase64 || source.publicKeyPem || source.publicKeySpkiBase64
        ? publicKeyFromInput(source)
        : {
            processKeyId: current.processKeyId,
            processPublicKeyPem: current.processPublicKeyPem,
            processPublicKeySpkiBase64: current.processPublicKeySpkiBase64,
            processPublicKeyHash: current.processPublicKeyHash
          };
      const timestamp: any = nowIso();
      const packageId: any = text(source.packageId) || `cidpkg_${crypto.randomUUID()}`;
      const credentialId: any = `procid_${packageId}`;
      const capabilities: any = current.capabilities.length ? current.capabilities : DEFAULT_PROCESS_IDENTITY_CAPABILITIES;
      const rotated: any = await resolvedCapabilityKeyProvider.rotateCapabilityKey({
        capabilityKey: verification.capabilityKey,
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
        capabilityKey: verification.capabilityKey,
        credentialId: current.capabilityCredentialId,
        reason: "process_identity_package_rotated"
      });
      const nextClient: any = normalizeClientRecord({
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
        credentialId: nextClient.capabilityCredentialId,
        context: clientBindingContext(nextClient),
        expiresAt: nextClient.expiresAt
      });
      state = {
        ...state,
        clients: [
          ...state.clients.map((client?: any) : any => client.packageId === current.packageId
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

  async function revokeClientIdentityPackage({ request = null, input = {} }: Record<string, any> = {}) : Promise<any> {
    const verification: any = request?.__meshrixProcessIdentity;
    if (!verification?.ok || !verification.client || !verification.capabilityKey) {
      return deny(401, "process_identity_verification_required", "Current process identity verification is required.");
    }
    return enqueueMutation(async () : Promise<any> => {
      const source: any = asObject(input);
      const timestamp: any = nowIso();
      const reason: any = text(source.reason) || "process_identity_package_revoked";
      const endpoint: any = text(source.revocationEndpoint || source.endpoint) || "/api/process-identity/package/revoke";
      const ownerSubjectRef: any = text(source.ownerSubjectRef);
      const ownerArtifactId: any = text(source.ownerArtifactId);
      const ownerArtifactDigestSha256: any = text(source.ownerArtifactDigestSha256);
      await resolvedCapabilityKeyProvider.invalidate({
        capabilityKey: verification.capabilityKey,
        reason
      });
      await resolvedBindingGuard.invalidateCapabilityKeyBinding({
        capabilityKey: verification.capabilityKey,
        credentialId: verification.client.capabilityCredentialId,
        reason
      });
      const revokedClientBase: any = normalizeClientRecord({
        ...verification.client,
        status: "revoked",
        revokedAt: timestamp,
        revocationReason: reason,
        revocationEndpoint: endpoint,
        ownerSubjectRef,
        ownerArtifactId,
        ownerArtifactDigestSha256
      });
      const revocationReceipt: any = createProcessIdentityRevocationReceipt({
        state,
        client: revokedClientBase,
        revokedAt: timestamp,
        reason,
        endpoint,
        ownerSubjectRef,
        ownerArtifactId,
        ownerArtifactDigestSha256
      });
      const revokedClient: any = normalizeClientRecord({
        ...revokedClientBase,
        revocationReceiptDigestSha256: revocationReceipt.receiptDigestSha256
      });
      state = {
        ...state,
        clients: state.clients.map((client?: any) : any => client.packageId === verification.client.packageId
          ? revokedClient
          : client)
      };
      await save();
      return {
        ok: true,
        status: 200,
        protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
        packageId: verification.client.packageId,
        revokedAt: timestamp,
        reason,
        revocationReceipt
      };
    });
  }

  async function verifyClientIdentityRevocationReceipt({ receipt = null, expected = {} }: Record<string, any> = {}) : Promise<any> {
    await mutationQueue.catch(() : any => {});
    await load();
    const signatureDecision: any = verifyProcessIdentityRevocationReceiptSignature({
      receipt,
      serverIdentity: state.serverIdentity,
      expected
    });
    if (!signatureDecision.ok) {
      return deny(
        400,
        signatureDecision.reasonCode || "process_identity_revocation_receipt_invalid",
        "Process identity revocation receipt signature or binding is invalid."
      );
    }
    const payload: any = signatureDecision.payload || {};
    const client: any = (state.clients || []).find((candidate?: any) : any =>
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

  function ownerProcessBindingContext(input: Record<string, any> = {}) : any {
    const identity: any = asObject(input.identityContext);
    const targetRef: any = text(input.targetRef);
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

  function ownerProcessBindingDecision(input: Record<string, any> = {}, binding: any = null) : any {
    const ownerId: any = text(input.ownerId);
    const ownerGenerationDigest: any = text(input.ownerGenerationDigest);
    const context: any = ownerProcessBindingContext(input);
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !/^[a-f0-9]{64}$/u.test(ownerGenerationDigest) || !context) {
      return deny(400, "owner_process_binding_context_invalid", "Owner process binding context is invalid.");
    }
    const contextDigest: any = sha256Hex(stableJson(context));
    if (binding && (binding.ownerId !== ownerId || binding.ownerGenerationDigest !== ownerGenerationDigest || binding.contextDigest !== contextDigest)) {
      return deny(403, "owner_process_binding_mismatch", "Owner process binding does not match.");
    }
    return { ok: true, ownerId, ownerGenerationDigest, context, contextDigest };
  }

  async function issueOwnerProcessBinding(input: Record<string, any> = {}) : Promise<any> {
    return enqueueMutation(async () : Promise<any> => {
      const decision: any = ownerProcessBindingDecision(input);
      if (!decision.ok) return decision;
      if ((state.retiredOwnerProcessBindingGenerations || []).some((entry?: any) : any => entry.ownerId === decision.ownerId &&
          entry.ownerGenerationDigest === decision.ownerGenerationDigest)) {
        return deny(409, "owner_process_binding_generation_retired", "Owner process binding generation is retired.");
      }
      const key: any = text(input.idempotencyKey);
      if (!key || key.length > 256) return deny(400, "owner_process_binding_idempotency_invalid", "Owner process binding idempotency key is invalid.");
      const idempotencyKeyDigest: any = sha256Hex(stableJson([decision.ownerId, decision.ownerGenerationDigest, key]));
      const existing: any = (state.ownerProcessBindings || []).find((binding?: any) : any => binding.idempotencyKeyDigest === idempotencyKeyDigest);
      if (existing) {
        if (existing.contextDigest !== decision.contextDigest || existing.targetRef !== decision.context.target) {
          return deny(409, "owner_process_binding_idempotency_conflict", "Owner process binding idempotency key conflicts with an existing binding.");
        }
        return { ok: true, ...existing };
      }
      const issuedAt: any = nowIso();
      const processIdentityRef: any = `procbind_${sha256Hex(`${decision.contextDigest}\0${idempotencyKeyDigest}`).slice(0, 32)}`;
      const binding: Record<string, any> = {
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
      const previousState: any = state;
      const previousRecord: any = record;
      state = { ...state, ownerProcessBindings: [...(state.ownerProcessBindings || []), binding] };
      try {
        await save();
      } catch (error: any) {
        state = previousState;
        record = previousRecord;
        loaded = true;
        throw error;
      }
      return { ok: true, ...binding };
    });
  }

  async function inspectOwnerProcessBinding(input: Record<string, any> = {}) : Promise<any> {
    await mutationQueue.catch(() : any => {});
    await load();
    const binding: any = (state.ownerProcessBindings || []).find((candidate?: any) : any => candidate.processIdentityRef === text(input.processIdentityRef));
    if (!binding) return deny(404, "owner_process_binding_not_found", "Owner process binding was not found.");
    const decision: any = ownerProcessBindingDecision({ ...input, targetRef: binding.targetRef }, binding);
    return decision.ok ? { ok: true, ...binding } : decision;
  }

  async function revokeOwnerProcessBinding(input: Record<string, any> = {}) : Promise<any> {
    return enqueueMutation(async () : Promise<any> => {
      const processIdentityRef: any = text(input.processIdentityRef);
      const binding: any = (state.ownerProcessBindings || []).find((candidate?: any) : any => candidate.processIdentityRef === processIdentityRef);
      if (!binding) return deny(404, "owner_process_binding_not_found", "Owner process binding was not found.");
      const decision: any = ownerProcessBindingDecision({ ...input, targetRef: binding.targetRef }, binding);
      if (!decision.ok) return decision;
      if (binding.status === "revoked") return { ok: true, ...binding };
      const revokedAt: any = nowIso();
      const payload: Record<string, any> = {
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
      const receiptDigest: any = sha256Hex(stableJson(payload));
      const receipt: Record<string, any> = {
        ...payload,
        receiptDigest,
        signature: {
          algorithm: "ed25519",
          keyId: state.serverIdentity.serverKeyId,
          payloadDigest: `sha256:${receiptDigest}`,
          value: signStableObject(state.serverIdentity.privateKeyPem, payload)
        }
      };
      const next: Record<string, any> = { ...binding, status: "revoked", revokedAt, receiptDigest };
      const previousState: any = state;
      const previousRecord: any = record;
      state = {
        ...state,
        ownerProcessBindings: state.ownerProcessBindings.map((candidate?: any) : any => candidate.processIdentityRef === processIdentityRef ? next : candidate)
      };
      try {
        await save();
      } catch (error: any) {
        state = previousState;
        record = previousRecord;
        loaded = true;
        throw error;
      }
      return { ok: true, ...next, revocationReceipt: receipt };
    });
  }

  async function revokeOwnerProcessBindings(input: Record<string, any> = {}) : Promise<any> {
    return enqueueMutation(async () : Promise<any> => {
      const ownerId: any = text(input.ownerId);
      const ownerGenerationDigest: any = text(input.ownerGenerationDigest);
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !/^[a-f0-9]{64}$/u.test(ownerGenerationDigest)) return deny(400, "owner_process_binding_owner_invalid", "Owner process binding owner is invalid.");
      const revokedAt: any = nowIso();
      const retiredGenerations: any = state.retiredOwnerProcessBindingGenerations || [];
      const alreadyRetired: any = retiredGenerations.some((entry?: any) : any => entry.ownerId === ownerId &&
        entry.ownerGenerationDigest === ownerGenerationDigest);
      if (!alreadyRetired && retiredGenerations.length >= MAX_RETIRED_OWNER_PROCESS_BINDING_GENERATIONS) {
        return deny(507, "owner_process_binding_retirement_capacity_exceeded", "Owner process binding retirement capacity is full.");
      }
      let revokedCount: any = 0;
      const nextBindings: any = (state.ownerProcessBindings || []).map((binding?: any) : any => {
        if (binding.ownerId !== ownerId || binding.ownerGenerationDigest !== ownerGenerationDigest || binding.status === "revoked") return binding;
        revokedCount += 1;
        const receiptDigest: any = sha256Hex(stableJson({
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
        const previousState: any = state;
        const previousRecord: any = record;
        state = {
          ...state,
          ownerProcessBindings: nextBindings,
          retiredOwnerProcessBindingGenerations: alreadyRetired
            ? retiredGenerations
            : [...retiredGenerations, { ownerId, ownerGenerationDigest, retiredAt: revokedAt }]
        };
        try {
          await save();
        } catch (error: any) {
          state = previousState;
          record = previousRecord;
          loaded = true;
          throw error;
        }
      }
      const remainingCount: any = nextBindings.filter((binding?: any) : any => binding.ownerId === ownerId && binding.ownerGenerationDigest === ownerGenerationDigest && binding.status !== "revoked").length;
      return { ok: remainingCount === 0, ownerId, ownerGenerationDigest, revokedCount, remainingCount };
    });
  }

  async function verifyOwnerProcessBindingsRevoked(input: Record<string, any> = {}) : Promise<any> {
    await mutationQueue.catch(() : any => {});
    await load();
    const ownerId: any = text(input.ownerId);
    const ownerGenerationDigest: any = text(input.ownerGenerationDigest);
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !/^[a-f0-9]{64}$/u.test(ownerGenerationDigest)) return deny(400, "owner_process_binding_owner_invalid", "Owner process binding owner is invalid.");
    const remainingCount: any = (state.ownerProcessBindings || []).filter((binding?: any) : any => binding.ownerId === ownerId && binding.ownerGenerationDigest === ownerGenerationDigest && binding.status !== "revoked").length;
    return { ok: remainingCount === 0, ownerId, ownerGenerationDigest, remainingCount };
  }

  async function describe() : Promise<any> {
    await mutationQueue.catch(() : any => {});
    await load();
    return {
      ok: true,
      protocolVersion: PROCESS_IDENTITY_PROTOCOL_VERSION,
      alias: resolvedAlias,
      stateRoot: stateRoot(state),
      serverIdentity: publicServerIdentity(state.serverIdentity),
      claimed: state.claimed === true,
      claimCount: Number(state.claimCount || 0),
      activeClientCount: state.clients.filter((client?: any) : any => client.status === "valid").length,
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
    close() : any {
      resolvedCapabilityKeyProvider.close?.();
      resolvedBindingGuard.close?.();
    }
  });
}

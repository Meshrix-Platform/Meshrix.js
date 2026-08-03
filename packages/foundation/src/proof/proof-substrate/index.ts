import {
  createHash,
  createHmac,
  createPublicKey,
  randomUUID,
  sign as signWithKey,
  timingSafeEqual,
  verify as verifyWithKey
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalDecode,
  cidForBytes,
  createRepairPlanner,
  createVerificationFailure,
  PACTIUM_PACKAGE_VERSION,
  PACTIUM_PROTOCOL,
  PACTIUM_SCHEMA_VERSION,
  PACTIUM_TRUST_POLICIES,
  protocolHash,
  verifyProofBundle,
  verifyProofEnvelope
} from "pactium";
import { serverToken } from "#meshrix/client-strings";
import {
  normalizeMeshrixPactiumRuntime,
  resolveMeshrixPactiumDataDir
} from "../../checkpoint/tree/pactium-substrate-preflight.ts";
import { toPactiumCanonicalSafeValue } from "../../checkpoint/tree/pactium-canonical-safe.ts";

export const OPERATION_PROOF_SUBSTRATE_PROTOCOL_VERSION: any = "v0.0.1:operation:proof-substrate-2";
export const OPERATION_PROOF_SUBSTRATE_PROTOCOL: any = PACTIUM_PROTOCOL;
export const OPERATION_PROOF_SUBSTRATE_PROVIDER: any = "pactium.operation-proof-substrate";
export const OPERATION_PROOF_SIGNER_SECRET_FILE_ENV: any =
  "MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE";
export const OPERATION_PROOF_SUBSTRATE_MODES: Readonly<Record<string, any>> = Object.freeze({
  PACTIUM: "pactium"
});

const DEFAULT_EVIDENCE_POLICY: any = "development";
const SIGNER_SECRET_PATTERN: any = /^[0-9a-f]{64}$/u;
const MESHRIX_ASPECT_PROTOCOL: any = "pactium.v0.3.meshrix-aspect";
const MESHRIX_POLICY_EXTENSION: any = "meshrix.policy";
const MESHRIX_WORKSPACE_EFFECT_EXTENSION: any = "meshrix.workspaceEffect";
const MESHRIX_SIGNATURE_EXTENSION: any = "meshrix.signature";
const MESHRIX_CRITICAL_EXTENSIONS: readonly any[] = Object.freeze([
  MESHRIX_POLICY_EXTENSION,
  MESHRIX_WORKSPACE_EFFECT_EXTENSION
]);
const MESHRIX_SUPPORTED_CRITICAL_EXTENSIONS: readonly any[] = Object.freeze([
  ...MESHRIX_CRITICAL_EXTENSIONS,
  MESHRIX_SIGNATURE_EXTENSION
]);

function nowIso() : any {
  return new Date().toISOString();
}

function text(value?: any, fallback: any = "") : any {
  const normalized: any = String(value ?? "").trim();
  return normalized || fallback;
}

function asObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

function hmac(secret?: any, value?: any) : any {
  return createHmac("sha256", secret)
    .update(String(value || ""))
    .digest("hex");
}

function publicKeyFromPrivateKey(privateKey?: any) : any {
  if (!privateKey) return "";
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" });
}

export function createMeshrixSigner({
  signerId = "meshrix-local",
  secret = "meshrix-development-signer",
  algorithm = "",
  privateKey = "",
  publicKey = ""
}: Record<string, any> = {}) : any {
  const resolvedAlgorithm: any = text(algorithm, privateKey || publicKey ? "ed25519" : "hmac-sha256");
  if (resolvedAlgorithm === "ed25519") {
    const verifierPublicKey: any = publicKey || publicKeyFromPrivateKey(privateKey);
    return Object.freeze({
      protocol: MESHRIX_ASPECT_PROTOCOL,
      signerId,
      algorithm: "ed25519",
      publicKey: verifierPublicKey,
      async sign(message?: any) : Promise<any> {
        if (!privateKey) {
          throw new Error("Ed25519 Meshrix signer requires a privateKey for signing.");
        }
        return `ed25519:${signWithKey(
          null,
          Buffer.from(String(message || "")),
          privateKey
        ).toString("base64")}`;
      },
      async verify(message?: any, signature?: any) : Promise<any> {
        if (!verifierPublicKey || !String(signature || "").startsWith("ed25519:")) {
          return false;
        }
        return verifyWithKey(
          null,
          Buffer.from(String(message || "")),
          verifierPublicKey,
          Buffer.from(String(signature).slice("ed25519:".length), "base64")
        );
      },
      close() : any {
        // Key ownership remains with the injected asymmetric signer config.
      }
    });
  }
  if (resolvedAlgorithm !== "hmac-sha256") {
    throw new Error(`Unsupported Meshrix signer algorithm: ${resolvedAlgorithm}`);
  }
  const retainedSecret: any = Buffer.isBuffer(secret)
    ? Buffer.from(secret)
    : Buffer.from(String(secret || ""), "utf8");
  let closed: any = false;
  const assertOpen: any = () : any => {
    if (closed) throw new Error("Meshrix signer is closed.");
  };
  return Object.freeze({
    protocol: MESHRIX_ASPECT_PROTOCOL,
    signerId,
    algorithm: "hmac-sha256",
    async sign(message?: any) : Promise<any> {
      assertOpen();
      return `hmac-sha256:${hmac(retainedSecret, message)}`;
    },
    async verify(message?: any, signature?: any) : Promise<any> {
      assertOpen();
      const expected: any = Buffer.from(`hmac-sha256:${hmac(retainedSecret, message)}`);
      const actual: any = Buffer.from(String(signature || ""));
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
    close() : any {
      if (closed) return;
      closed = true;
      retainedSecret.fill(0);
    }
  });
}

export function createMeshrixSignerKeyRing({
  active,
  verification = []
}: Record<string, any> = {}) : any {
  if (!active || typeof active.sign !== "function" || typeof active.verify !== "function") {
    throw proofConfigurationError(
      "operation_proof_signer_keyring_active_required",
      "Meshrix operation-proof signer key ring requires one active signer."
    );
  }
  const all: any[] = [active, ...asArray(verification)];
  const byIdentity: any = new Map<any, any>();
  for (const signer of all) {
    const signerId: any = text(signer?.signerId);
    const algorithm: any = text(signer?.algorithm);
    const identity: any = `${signerId}\0${algorithm}`;
    if (
      !signerId ||
      !algorithm ||
      typeof signer?.verify !== "function" ||
      byIdentity.has(identity)
    ) {
      throw proofConfigurationError(
        "operation_proof_signer_keyring_invalid",
        "Meshrix operation-proof signer key ring contains an invalid or duplicate verifier."
      );
    }
    byIdentity.set(identity, signer);
  }
  let closed: any = false;
  const assertOpen: any = () : any => {
    if (closed) {
      throw proofConfigurationError(
        "operation_proof_signer_keyring_closed",
        "Meshrix operation-proof signer key ring is closed."
      );
    }
  };
  return Object.freeze({
    protocol: MESHRIX_ASPECT_PROTOCOL,
    signerId: active.signerId,
    algorithm: active.algorithm,
    verificationKeyCount: byIdentity.size,
    async sign(message?: any) : Promise<any> {
      assertOpen();
      return active.sign(message);
    },
    async verify(message?: any, signature?: any) : Promise<any> {
      assertOpen();
      return active.verify(message, signature);
    },
    async verifyFor({ signerId = "", algorithm = "", message = "", signature = "" }: Record<string, any> = {}) : Promise<any> {
      assertOpen();
      const signer: any = byIdentity.get(`${text(signerId)}\0${text(algorithm)}`);
      return signer ? signer.verify(message, signature) : false;
    },
    close() : any {
      if (closed) return;
      closed = true;
      for (const signer of new Set<any>(all)) signer?.close?.();
      byIdentity.clear();
    }
  });
}

function cleanValue(value?: any) : any {
  return toPactiumCanonicalSafeValue(value);
}

function normalizeMode(value: any = "") : any {
  const mode: any = text(value).toLowerCase();
  if (!mode || mode === OPERATION_PROOF_SUBSTRATE_MODES.PACTIUM) {
    return OPERATION_PROOF_SUBSTRATE_MODES.PACTIUM;
  }
  throw new Error("Operation Proof Substrate only supports Pactium-backed mode.");
}

function env(name?: any) : any {
  return text(process.env[name]);
}

function proofConfigurationError(code?: any, message?: any) : any {
  return Object.assign(new Error(message), { code });
}

function pathIsWithin(parent?: any, child?: any) : any {
  const relative: any = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function signerSecretFromExternalFile({ dataDir = "", signerSecretFile = "" }: Record<string, any> = {}) : any {
  const configuredPath: any = text(signerSecretFile);
  if (!configuredPath || !path.isAbsolute(configuredPath)) {
    throw proofConfigurationError(
      "operation_proof_signer_secret_file_required",
      "Meshrix operation-proof signer secret file is not configured.",
    );
  }
  let stat: any;
  let keyRealPath: any = "";
  let dataRealPath: any = path.resolve(dataDir);
  try {
    stat = fs.lstatSync(configuredPath);
    keyRealPath = fs.realpathSync(configuredPath);
    try {
      dataRealPath = fs.realpathSync(path.resolve(dataDir));
    } catch {
      // A fresh governed data directory may not exist before startup.
    }
  } catch {
    throw proofConfigurationError(
      "operation_proof_signer_secret_file_unavailable",
      "Meshrix operation-proof signer secret file is unavailable.",
    );
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 256 ||
    pathIsWithin(dataRealPath, keyRealPath)
  ) {
    throw proofConfigurationError(
      "operation_proof_signer_custody_invalid",
      "Meshrix operation-proof signer secret custody is invalid.",
    );
  }
  let bytes: any;
  try {
    bytes = fs.readFileSync(keyRealPath);
    const encoded: any = bytes.toString("utf8").trim();
    if (
      !SIGNER_SECRET_PATTERN.test(encoded) ||
      !(
        bytes.length === 64 ||
        (bytes.length === 65 && bytes[64] === 0x0a)
      )
    ) {
      throw proofConfigurationError(
        "operation_proof_signer_secret_invalid",
        "Meshrix operation-proof signer secret is invalid.",
      );
    }
    return encoded;
  } catch (error: any) {
    if (String(error?.code || "").startsWith("operation_proof_signer_")) {
      throw error;
    }
    throw proofConfigurationError(
      "operation_proof_signer_secret_file_unavailable",
      "Meshrix operation-proof signer secret file is unavailable.",
    );
  } finally {
    bytes?.fill(0);
  }
}

function runtimeOperationProofOptions(runtimeOptions: Record<string, any> = {}) : any {
  return asObject(runtimeOptions.operationProof || runtimeOptions.operationProofSubstrate || runtimeOptions.pactiumProof);
}

function resolveMode({ mode = "", runtimeOptions = {} }: Record<string, any> = {}) : any {
  const options: any = runtimeOperationProofOptions(runtimeOptions);
  return normalizeMode(mode || options.mode || env("MESHRIX_OPERATION_PROOF_MODE"));
}

function resolveEvidencePolicy({ evidencePolicy = "", runtimeOptions = {} }: Record<string, any> = {}) : any {
  const options: any = runtimeOperationProofOptions(runtimeOptions);
  return text(
    evidencePolicy ||
    options.evidencePolicy ||
    env("MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY") ||
    DEFAULT_EVIDENCE_POLICY,
    DEFAULT_EVIDENCE_POLICY
  );
}

function resolveSignerSecret({
  signerSecret = "",
  runtimeOptions = {},
  dataDir = "",
}: Record<string, any> = {}) : any {
  const options: any = runtimeOperationProofOptions(runtimeOptions);
  const directSecret: any = text(
    signerSecret ||
    options.signerSecret
  );
  const signerSecretFile: any = text(
    options.signerSecretFile ||
    env(OPERATION_PROOF_SIGNER_SECRET_FILE_ENV)
  );
  if (directSecret && signerSecretFile) {
    throw proofConfigurationError(
      "operation_proof_signer_custody_ambiguous",
      "Meshrix operation-proof signer secret custody is ambiguous.",
    );
  }
  return directSecret || (
    signerSecretFile
      ? signerSecretFromExternalFile({ dataDir, signerSecretFile })
      : ""
  );
}

function signerConfigured({ signer = null, signerSecret = "", evidencePolicy = "" }: Record<string, any> = {}) : any {
  if (evidencePolicy !== "production") return true;
  if (signer === false) return false;
  return Boolean(signer) || text(signerSecret) !== "";
}

function normalizeWorkspaceId(input: Record<string, any> = {}) : any {
  return text(
    input.workspaceId ||
    input.workspace ||
    input.scope ||
    input.ownerId ||
    input.input?.workspaceId ||
    input.input?.workspace ||
    input.input?.ownerId,
    "default"
  );
}

function normalizeOperationId(input: Record<string, any> = {}) : any {
  return text(input.operationId || input.operation?.id || input.id, "operation.unknown");
}

function normalizeIdempotencyKey(input: Record<string, any> = {}) : any {
  return text(
    input.idempotencyKey ||
    input["idempotency-key"] ||
    input.requestId ||
    input.traceId ||
    randomUUID()
  );
}

function entryIdFromEnvelope(input: Record<string, any> = {}, envelope?: any) : any {
  return text(envelope?.factRef?.ledgerEventId) || serverToken(
    "operation_proof",
    normalizeWorkspaceId(input),
    normalizeOperationId(input),
    normalizeIdempotencyKey(input),
    nowIso(),
    randomUUID()
  );
}

function normalizeEntry(input: Record<string, any> = {}, envelope?: any) : any {
  const at: any = text(input.createdAt, nowIso());
  const ledgerEventId: any = entryIdFromEnvelope(input, envelope);
  const storedInput: any = asObject(input.input);
  const storedSubject: any = asObject(input.subject);
  const storedRisk: any = asObject(input.risk);
  const storedPolicy: any = asObject(input.policyDecision || input.policyEvidence);
  return {
    protocol: PACTIUM_PROTOCOL,
    schema: PACTIUM_SCHEMA_VERSION,
    protocolVersion: OPERATION_PROOF_SUBSTRATE_PROTOCOL_VERSION,
    pactiumPackageVersion: PACTIUM_PACKAGE_VERSION,
    provider: OPERATION_PROOF_SUBSTRATE_PROVIDER,
    ledgerEventId,
    operationId: normalizeOperationId(input),
    workspaceId: normalizeWorkspaceId(input),
    semantic: text(input.semantic),
    status: "started",
    outcomeKind: "",
    assetRef: text(input.assetRef),
    targetKind: text(input.targetKind),
    targetRef: asObject(input.targetRef),
    subjectDigest: text(storedSubject.subjectDigest) || protocolHash("meshrix.subject", cleanValue(storedSubject)),
    riskDigest: text(storedRisk.riskDigest) || protocolHash("meshrix.risk", cleanValue(storedRisk)),
    idempotencyKey: normalizeIdempotencyKey(input),
    inputDigest: text(storedInput.inputDigest) || protocolHash("meshrix.operation-input", cleanValue(storedInput)),
    policyDigest: text(storedPolicy.policyDigest) || protocolHash(
      "meshrix.policy-evidence",
      cleanValue(storedPolicy)
    ),
    warnings: asArray(input.warnings).map((warning?: any) : any => cleanValue(warning)),
    receiptRefs: [],
    createdAt: at,
    updatedAt: at,
    completedAt: "",
    failedAt: "",
    error: "",
    proof: {
      mode: OPERATION_PROOF_SUBSTRATE_MODES.PACTIUM,
      lifecycle: "two-stage",
      aspect: MESHRIX_ASPECT_PROTOCOL,
      productionVerifiable: false
    },
    pactium: {
      intentId: text(envelope?.factId),
      intentEnvelopeId: text(envelope?.envelopeId),
      intentLedgerEventId: text(envelope?.factRef?.ledgerEventId),
      intentLedgerIndex: Number(envelope?.factRef?.ledgerIndex ?? -1),
      ledgerHead: envelope?.ledgerHead || null
    }
  };
}

function normalizeReceiptEntry(input: Record<string, any> = {}, envelope?: any) : any {
  const at: any = text(input.createdAt, nowIso());
  return {
    protocol: PACTIUM_PROTOCOL,
    schema: PACTIUM_SCHEMA_VERSION,
    protocolVersion: OPERATION_PROOF_SUBSTRATE_PROTOCOL_VERSION,
    pactiumPackageVersion: PACTIUM_PACKAGE_VERSION,
    provider: OPERATION_PROOF_SUBSTRATE_PROVIDER,
    ledgerEventId: text(envelope?.factRef?.ledgerEventId),
    operationId: normalizeOperationId(input),
    workspaceId: normalizeWorkspaceId(input),
    semantic: text(input.semantic),
    status: text(input.status, "succeeded"),
    outcomeKind: text(input.outcomeKind, input.status || "succeeded"),
    idempotencyKey: normalizeIdempotencyKey(input),
    changeDigest: text(input.changeDigest),
    resultDigest: text(input.resultHash || input.resultDigest),
    createdAt: at,
    updatedAt: at,
    completedAt: at,
    failedAt: ["failed", "denied"].includes(text(input.status)) ? at : "",
    error: ["failed", "denied"].includes(text(input.status)) ? text(input.error) : "",
    replayed: envelope?.replayed === true,
    disposition: text(envelope?.disposition, "recorded"),
    proof: {
      mode: OPERATION_PROOF_SUBSTRATE_MODES.PACTIUM,
      lifecycle: "single-terminal",
      profile: text(input.profile, "receipt"),
      aspect: MESHRIX_ASPECT_PROTOCOL,
      terminal: true
    },
    pactium: {
      receiptId: text(envelope?.factId || envelope?.receiptId),
      receiptEnvelopeId: text(envelope?.envelopeId),
      receiptLedgerEventId: text(envelope?.factRef?.ledgerEventId),
      receiptLedgerIndex: Number(envelope?.factRef?.ledgerIndex ?? -1),
      ledgerHead: envelope?.ledgerHead || null
    }
  };
}

function mergeCompletion(entry?: any, patch: Record<string, any> = {}, envelope?: any, failed: any = false) : any {
  const at: any = text(
    patch.completedAt || patch.createdAt,
    nowIso()
  );
  const status: any = text(patch.status, failed ? "failed" : "succeeded");
  return {
    ...entry,
    ledgerEventId: text(
      envelope?.factRef?.ledgerEventId,
      entry.ledgerEventId
    ),
    status,
    outcomeKind: text(patch.outcomeKind, status),
    assetRef: text(patch.assetRef, entry.assetRef || ""),
    receiptRefs: asArray(patch.receiptRefs).length > 0 ? asArray(patch.receiptRefs) : asArray(entry.receiptRefs),
    auditId: text(patch.auditId, entry.auditId || ""),
    warnings: [
      ...asArray(entry.warnings),
      ...asArray(patch.warnings).map((warning?: any) : any => cleanValue(warning))
    ],
    error: failed || status === "failed" || status === "denied"
      ? text(patch.error, entry.error || (status === "denied" ? "operation denied" : "operation failed"))
      : text(patch.error, ""),
    updatedAt: at,
    completedAt: failed ? (entry.completedAt || "") : at,
    failedAt: failed ? at : "",
    proof: {
      ...asObject(entry.proof),
      terminal: true
    },
    pactium: {
      ...asObject(entry.pactium),
      outcomeId: text(envelope?.factId),
      outcomeEnvelopeId: text(envelope?.envelopeId),
      outcomeLedgerEventId: text(envelope?.factRef?.ledgerEventId),
      outcomeLedgerIndex: Number(envelope?.factRef?.ledgerIndex ?? -1),
      ledgerHead: envelope?.ledgerHead || entry.pactium?.ledgerHead || null
    }
  };
}

function locatorEnvelope(factId?: any, locator: Record<string, any> = {}) : any {
  return {
    factId: text(factId),
    envelopeId: text(locator.envelopeId),
    factRef: {
      ledgerEventId: text(locator.ledgerEventId),
      ledgerIndex: Number(locator.ledgerIndex ?? -1),
      factCid: text(locator.factCid)
    }
  };
}

function outcomeEvidenceProjection(outcome: Record<string, any> = {}) : any {
  const source: any = asObject(outcome);
  const hostEvidenceRefs: any = asArray(source.hostEvidenceRefs)
    .map((value?: any) : any => text(value))
    .filter(Boolean);
  const auditRef: any = hostEvidenceRefs.find((value?: any) : any =>
    value.startsWith("audit:")
  ) || "";
  return {
    auditId: auditRef.slice("audit:".length),
    receiptRefs: hostEvidenceRefs.filter((value?: any) : any =>
      !value.startsWith("audit:")
    )
  };
}

async function readLedgerEntryByEventId(core?: any, ledgerEventId?: any) : Promise<any> {
  const eventId: any = text(ledgerEventId);
  if (!eventId) return null;
  const pointer: any = await core.readProtocolObject("ledger-event", eventId, null);
  if (!Number.isInteger(Number(pointer?.index))) return null;
  return core.readLedgerLeaf(Number(pointer.index));
}

async function projectLedgerEntry(core?: any, ledgerEntry?: any) : Promise<any> {
  const fact: any = asObject(ledgerEntry?.fact, null);
  if (!fact) return null;
  if (fact.factType === "operation.receipt") {
    const locator: any = await core.lookupReceipt(fact.receiptId);
    return normalizeReceiptEntry(fact, locatorEnvelope(fact.receiptId, locator));
  }
  if (fact.factType === "operation.intent") {
    const intentLocator: any = await core.lookupOpenIntent(fact.intentId);
    const entry: any = normalizeEntry(fact, locatorEnvelope(fact.intentId, intentLocator));
    const outcomeLocator: any = await core.lookupOutcome(fact.intentId);
    const evidence: any = outcomeEvidenceProjection(
      outcomeLocator.outcome
    );
    return outcomeLocator.exists && outcomeLocator.outcome
      ? mergeCompletion(
          entry,
          {
            status: outcomeLocator.outcome.status,
            outcomeKind: outcomeLocator.outcome.status,
            completedAt: outcomeLocator.outcome.createdAt,
            auditId: evidence.auditId,
            receiptRefs: evidence.receiptRefs
          },
          locatorEnvelope(outcomeLocator.outcome.outcomeId, outcomeLocator),
          outcomeLocator.outcome.status === "failed"
        )
      : entry;
  }
  if (fact.factType === "operation.outcome") {
    const intentLocator: any = await core.lookupOpenIntent(fact.intentId);
    const outcomeLocator: any = await core.lookupOutcome(fact.intentId);
    const intentLedgerEntry: any = await readLedgerEntryByEventId(
      core,
      intentLocator.ledgerEventId
    );
    const intentFact: any = asObject(intentLedgerEntry?.fact, null);
    if (
      intentFact &&
      intentFact.factType === "operation.intent"
    ) {
      const evidence: any = outcomeEvidenceProjection(fact);
      return mergeCompletion(
        normalizeEntry(
          intentFact,
          locatorEnvelope(intentFact.intentId, intentLocator)
        ),
        {
          status: fact.status,
          outcomeKind: fact.status,
          completedAt: fact.createdAt,
          auditId: evidence.auditId,
          receiptRefs: evidence.receiptRefs
        },
        locatorEnvelope(fact.outcomeId, outcomeLocator),
        fact.status === "failed"
      );
    }
    const at: any = text(fact.createdAt, nowIso());
    return {
      protocol: PACTIUM_PROTOCOL,
      schema: PACTIUM_SCHEMA_VERSION,
      protocolVersion: OPERATION_PROOF_SUBSTRATE_PROTOCOL_VERSION,
      provider: OPERATION_PROOF_SUBSTRATE_PROVIDER,
      ledgerEventId: text(outcomeLocator.ledgerEventId || ledgerEntry?.eventId),
      operationId: text(fact.operationId),
      workspaceId: text(fact.workspaceId, "default"),
      status: text(fact.status, "succeeded"),
      outcomeKind: text(fact.status, "succeeded"),
      createdAt: at,
      updatedAt: at,
      completedAt: at,
      proof: { mode: OPERATION_PROOF_SUBSTRATE_MODES.PACTIUM, lifecycle: "two-stage", terminal: true },
      pactium: {
        intentId: text(fact.intentId),
        outcomeId: text(fact.outcomeId),
        outcomeEnvelopeId: text(outcomeLocator.envelopeId),
        outcomeLedgerEventId: text(outcomeLocator.ledgerEventId),
        outcomeLedgerIndex: Number(outcomeLocator.ledgerIndex ?? -1)
      }
    };
  }
  return null;
}

async function loadProjectedEntry(core?: any, ledgerEventId?: any) : Promise<any> {
  return projectLedgerEntry(core, await readLedgerEntryByEventId(core, ledgerEventId));
}

function outcomeStatus({ status = "", failed = false, denied = false }: Record<string, any> = {}) : any {
  if (denied) return "denied";
  if (failed) return "failed";
  return text(status, "succeeded");
}

function buildPolicyEvidence(input: Record<string, any> = {}) : any {
  return cleanValue({
    operationId: normalizeOperationId(input),
    workspaceId: normalizeWorkspaceId(input),
    subject: asObject(input.subject),
    policyDecision: asObject(input.policyDecision || input.policyEvidence),
    risk: asObject(input.risk),
    traceId: input.traceId || "",
    requestId: input.requestId || ""
  });
}

function buildWorkspaceEffectEvidence(input: Record<string, any> = {}) : any {
  return cleanValue({
    operationId: normalizeOperationId(input),
    workspaceId: normalizeWorkspaceId(input),
    result: asObject(input.result || input.output),
    assetRef: input.assetRef || "",
    receiptRefs: asArray(input.receiptRefs),
    auditId: input.auditId || "",
    status: input.status || ""
  });
}

function envelopeIdForEntry(entry: Record<string, any> = {}, kind: any = "outcome") : any {
  if (kind === "intent") {
    return text(entry.pactium?.intentEnvelopeId);
  }
  return text(
    entry.pactium?.receiptEnvelopeId ||
    entry.pactium?.outcomeEnvelopeId ||
    entry.pactium?.intentEnvelopeId
  );
}

function receiptResultFor(input: Record<string, any> = {}, status: any = "succeeded") : any {
  return cleanValue({
    outcomeKind: text(input.outcomeKind, status),
    statusCode: Number(input.statusCode || 0),
    auditId: text(input.auditId),
    receiptRefs: asArray(input.receiptRefs).map(String).filter(Boolean).slice(0, 64),
    errorDigest: input.error ? protocolHash("meshrix.operation-error", text(input.error)) : "",
    ...(input.commitment === undefined ? {} : { commitment: cleanValue(input.commitment) })
  });
}

function canExportProofBundle({ actor = null }: Record<string, any> = {}) : any {
  if (!actor) return false;
  if (actor.type === "system" || actor.system === true) return true;
  const scopes: any = new Set<any>(asArray(actor.scopes || actor.user?.scopes).map(String));
  return scopes.has("proof:export") || scopes.has("runtime:admin") || scopes.has("console:admin");
}

function decodeBundleVarint(bytes?: any, offset: any = 0) : any {
  let value: any = 0;
  let shift: any = 0;
  let cursor: any = offset;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("Bundle varint offset is invalid.");
  }
  while (cursor < bytes.length) {
    const byte: any = bytes[cursor];
    value += (byte & 0x7f) * (2 ** shift);
    cursor += 1;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw new Error("Bundle varint exceeds the safe integer range.");
      return { value, nextOffset: cursor };
    }
    shift += 7;
    if (shift > 49) throw new Error("Bundle varint is too large.");
  }
  throw new Error("Bundle varint is truncated.");
}

function createPortableBundleBlockResolver(bundle?: any, options: Record<string, any> = {}) : any {
  if (!bundle?.binaryBase64 || !Array.isArray(bundle?.index)) return null;
  const maxHeaderSize: any = Number(options.maxHeaderSize || 16 * 1024);
  const maxBlockSize: any = Number(options.maxBlockSize || 64 * 1024 * 1024);
  const bytes: any = Buffer.from(String(bundle.binaryBase64), "base64");
  const index: any = new Map<any, any>();
  const cache: any = new Map<any, any>();
  for (const item of bundle.index) {
    const cid: any = text(item?.cid);
    if (!cid || index.has(cid)) continue;
    index.set(cid, asObject(item));
  }

  return Object.freeze({
    get(cid?: any) : any {
      const key: any = text(cid);
      if (!key || !index.has(key)) return null;
      if (cache.has(key)) return cache.get(key);
      const item: any = index.get(key);
      let block: any = null;
      try {
        const offset: any = Number(item.offset);
        const recordLength: any = Number(item.recordLength);
        const headerLength: any = Number(item.headerLength);
        const payloadLength: any = Number(item.byteLength);
        if (
          !Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(recordLength) || recordLength <= 0 ||
          !Number.isSafeInteger(headerLength) || headerLength < 0 || headerLength > maxHeaderSize ||
          !Number.isSafeInteger(payloadLength) || payloadLength < 0 || payloadLength > maxBlockSize
        ) {
          throw new Error("Bundle index bounds are invalid.");
        }
        const decoded: any = decodeBundleVarint(bytes, offset);
        if (decoded.value !== recordLength || recordLength !== headerLength + payloadLength) {
          throw new Error("Bundle record length is invalid.");
        }
        const payloadStart: any = decoded.nextOffset + headerLength;
        const payloadEnd: any = payloadStart + payloadLength;
        if (payloadEnd > bytes.length) throw new Error("Bundle record exceeds the binary payload.");
        const header: any = asObject(canonicalDecode(bytes.subarray(decoded.nextOffset, payloadStart)));
        if (
          header.cid !== key ||
          header.payloadHash !== item.payloadHash ||
          Number(header.byteLength) !== payloadLength
        ) {
          throw new Error("Bundle record header does not match its index entry.");
        }
        const payloadBytes: any = bytes.subarray(payloadStart, payloadEnd);
        const payloadHash: any = `sha256:${createHash("sha256").update(payloadBytes).digest("hex")}`;
        if (payloadHash !== item.payloadHash || cidForBytes(payloadBytes) !== key) {
          throw new Error("Bundle record payload does not match its content address.");
        }
        block = {
          protocol: header.protocol,
          cid: key,
          codec: header.codec,
          kind: header.kind,
          refs: asArray(header.refs),
          byteLength: payloadLength,
          payloadHash,
          payloadBase64: payloadBytes.toString("base64"),
          bytes: payloadBytes
        };
      } catch {
        block = null;
      }
      cache.set(key, block);
      return block;
    }
  });
}

function indexExtensionsByName(extensions?: any) : any {
  const index: any = new Map<any, any>();
  for (const extension of asArray(extensions)) {
    const name: any = text(extension?.name);
    if (!name) continue;
    if (!index.has(name)) index.set(name, []);
    index.get(name).push(extension);
  }
  return index;
}

async function resolveMaterialBlock({ core, cid, bundleResolver }: Record<string, any>) : Promise<any> {
  return bundleResolver?.get(cid) || core.resolveBlock(cid);
}

function materializeMeshrixEvidenceExtension({ name, evidence, metadata = {} }: Record<string, any>) : any {
  const normalizedEvidence: any = cleanValue(evidence || {});
  return {
    name,
    critical: true,
    value: {
      protocol: MESHRIX_ASPECT_PROTOCOL,
      evidenceType: name,
      evidenceVersion: "v2",
      evidence: normalizedEvidence,
      evidenceHash: protocolHash("meshrix.critical-evidence", normalizedEvidence),
      metadata: cleanValue(asObject(metadata))
    },
    metadata: {
      evidenceHash: protocolHash("meshrix.critical-evidence", normalizedEvidence)
    }
  };
}

function meshrixMeshEvidenceExtensions({ input = {}, entry = null, phase = "outcome" }: Record<string, any>) : any {
  const rawPolicyEvidence: any = input.policyEvidence ||
    input.policyDecision ||
    (entry?.policyDigest ? { policyDigest: entry.policyDigest } : null) ||
    buildPolicyEvidence({ ...asObject(entry), ...input });
  const policyEvidence: any = cleanValue({
    evidenceType: "policy-digest",
    operationId: normalizeOperationId(input),
    workspaceId: normalizeWorkspaceId(input),
    decision: text(rawPolicyEvidence?.decision || rawPolicyEvidence?.status),
    reasonCode: text(rawPolicyEvidence?.reasonCode || rawPolicyEvidence?.reason),
    policyDigest: protocolHash("meshrix.policy-evidence", cleanValue(rawPolicyEvidence))
  });
  const rawWorkspaceEffectEvidence: any = input.workspaceEffectEvidence ||
    input.effectEvidence ||
    input.workspaceEffect ||
    buildWorkspaceEffectEvidence({
      ...asObject(entry),
      ...input,
      status: input.status || entry?.status || ""
    });
  const workspaceEffectEvidence: any = cleanValue({
    evidenceType: "workspace-effect-digest",
    operationId: normalizeOperationId(input),
    workspaceId: normalizeWorkspaceId(input),
    status: text(input.status || entry?.status),
    receiptRefs: asArray(input.receiptRefs).map(String).filter(Boolean).slice(0, 64),
    effectDigest: protocolHash("meshrix.workspace-effect-evidence", cleanValue(rawWorkspaceEffectEvidence))
  });
  const policyExtension: any = materializeMeshrixEvidenceExtension({
      name: MESHRIX_POLICY_EXTENSION,
      evidence: policyEvidence,
      metadata: {
        workspaceId: normalizeWorkspaceId(input)
      }
    });
  if (phase === "intent") return [policyExtension];
  return [
    policyExtension,
    materializeMeshrixEvidenceExtension({
      name: MESHRIX_WORKSPACE_EFFECT_EXTENSION,
      evidence: workspaceEffectEvidence,
      metadata: {
        workspaceId: normalizeWorkspaceId(input)
      }
    })
  ];
}

function meshrixMeshEnvelopeSigningHash(envelope?: any) : any {
  return protocolHash("proof.envelope.signing", {
    ...asObject(envelope),
    envelopeId: undefined,
    replayed: false,
    disposition: undefined,
    extensions: asArray(envelope?.extensions).filter(
      (extension?: any) : any => extension?.name !== MESHRIX_SIGNATURE_EXTENSION
    )
  });
}

function finalizeMeshrixEnvelopeExtensions(signer?: any) : any {
  if (!signer) return null;
  return async (envelope?: any) : Promise<any> => {
    const signedEnvelopeHash: any = meshrixMeshEnvelopeSigningHash(envelope);
    const signature: any = await signer.sign(signedEnvelopeHash);
    return [{
      name: MESHRIX_SIGNATURE_EXTENSION,
      critical: false,
      value: {
        protocol: MESHRIX_ASPECT_PROTOCOL,
        signerId: signer.signerId || "meshrix-signer",
        algorithm: signer.algorithm || "hmac-sha256",
        signedEnvelopeHash,
        signature
      }
    }];
  };
}

function createMeshrixAspect({
  pactium: core,
  storage,
  evidencePolicy = "production",
  signer = null,
  signerSecret = ""
}: Record<string, any> = {}) : any {
  if (!core || !storage) {
    throw new Error("Meshrix proof aspect requires Pactium core and storage ports.");
  }
  const hasExplicitSignerSecret: any = text(signerSecret) !== "";
  const resolvedSigner: any = signer === false
    ? null
    : signer || (hasExplicitSignerSecret || evidencePolicy !== "production"
      ? createMeshrixSigner({ secret: signerSecret || "meshrix-development-signer" })
      : null);
  const ownsSigner: any = !signer && Boolean(resolvedSigner);
  const genericRepairPlanner: any = createRepairPlanner();

  function assertProductionReady() : any {
    if (evidencePolicy === "production" && !resolvedSigner) {
      throw new Error("Meshrix production evidence policy requires an explicit signer or signerSecret.");
    }
  }

  async function recordWorkspaceOperation(input: Record<string, any> = {}) : Promise<any> {
    const workspaceId: any = text(input.workspaceId || input.scope, "default");
    const policyEvidence: any = input.policyEvidence ?? input.policy;
    const effectEvidence: any = input.workspaceEffectEvidence ?? input.effectEvidence ?? input.workspaceEffect;
    if (evidencePolicy === "production" && !policyEvidence) {
      throw new Error("Meshrix production evidence policy requires policy evidence.");
    }
    if (evidencePolicy === "production" && !effectEvidence) {
      throw new Error("Meshrix production evidence policy requires workspace effect evidence.");
    }
    assertProductionReady();
    const compactInput: Record<string, any> = {
      ...input,
      workspaceId,
      policyEvidence: policyEvidence || { missing: true, policy: "opportunistic" },
      workspaceEffectEvidence: effectEvidence || { missing: true, policy: "opportunistic" }
    };
    const intentEvidenceExtensions: any = meshrixMeshEvidenceExtensions({ input: compactInput, phase: "intent" });
    const outcomeEvidenceExtensions: any = meshrixMeshEvidenceExtensions({ input: compactInput, phase: "outcome" });
    const batch: any = await core.recordOperations([{
      operationId: normalizeOperationId(input),
      workspaceId,
      idempotencyKey: normalizeIdempotencyKey(input),
      outcomeIdempotencyKey: text(input.outcomeIdempotencyKey),
      status: outcomeStatus(input),
      input: {
        inputDigest: protocolHash("meshrix.operation-input", cleanValue(input.input ?? input.payload ?? {}))
      },
      subject: {
        subjectDigest: protocolHash("meshrix.subject", cleanValue(asObject(input.subject)))
      },
      result: {
        resultDigest: protocolHash("meshrix.operation-result", cleanValue(input.result ?? input.output ?? {}))
      },
      causalityRefs: asArray(input.causalityRefs),
      hostEvidenceRefs: asArray(input.hostEvidenceRefs),
      proofOptions: input.proofOptions,
      nonce: input.nonce,
      outcomeNonce: input.outcomeNonce,
      appendCondition: input.appendCondition,
      intentAppendCondition: input.intentAppendCondition,
      outcomeAppendCondition: input.outcomeAppendCondition || input.outcome?.appendCondition,
      returnIntentReplay: input.returnIntentReplay === true,
      extensions: [...intentEvidenceExtensions, ...asArray(input.intentExtensions)],
      outcomeExtensions: [...outcomeEvidenceExtensions, ...asArray(input.outcomeExtensions || input.extensions)],
      finalizeEnvelopeExtensions: finalizeMeshrixEnvelopeExtensions(resolvedSigner),
      stateMutations: input.stateMutations || input.state?.mutations || []
    }]);
    return batch.envelopes[0];
  }

  async function verifyMeshrixEnvelope(envelope?: any, options: Record<string, any> = {}) : Promise<any> {
    const bundleResolver: any = createPortableBundleBlockResolver(options.bundle, options);
    const decodedMaterial: any = new Map<any, any>();
    async function resolveDecodedMaterial(cid?: any) : Promise<any> {
      const key: any = text(cid);
      if (!key) return { block: null, value: null };
      if (decodedMaterial.has(key)) return decodedMaterial.get(key);
      const block: any = await resolveMaterialBlock({ core, cid: key, bundleResolver });
      let value: any = null;
      try {
        value = block
          ? canonicalDecode(block.bytes || Buffer.from(String(block.payloadBase64 || ""), "base64"))
          : null;
      } catch {
        value = null;
      }
      const result: Record<string, any> = { block, value };
      decodedMaterial.set(key, result);
      return result;
    }

    const effectiveTrustPolicy: any = evidencePolicy === "production"
      ? PACTIUM_TRUST_POLICIES.trustedManifestRequired
      : options.trustPolicy || PACTIUM_TRUST_POLICIES.selfCarriedManifest;
    const coreResult: any = options.coreEnvelopeResult || await verifyProofEnvelope(envelope, ({
      storage: { getBlock: (cid?: any) : any => core.resolveBlock(cid) },
      bundle: options.bundle || null,
      supportedCriticalExtensions: [...MESHRIX_SUPPORTED_CRITICAL_EXTENSIONS],
      proofVerifiers: options.proofVerifiers || {},
      requireAllProofs: options.requireAllProofs !== false,
      verifierManifest: options.verifierManifest || null,
      trustedManifest: options.trustedManifest || null,
      ledgerHeadSignatures: options.ledgerHeadSignatures || [],
      trustPolicy: effectiveTrustPolicy,
      requireFullStateMutationProofs: options.requireFullStateMutationProofs === true,
      maxProofLeafEntries: Number(options.maxProofLeafEntries || 0),
      maxProofBytes: Number(options.maxProofBytes || 0),
      failOnProofSizeWarning: options.failOnProofSizeWarning === true
    } as any));
    const failures: any[] = [...asArray(coreResult.failures)];
    const extensions: any = asArray(envelope?.extensions);
    const extensionIndex: any = indexExtensionsByName(extensions);
    const criticalNames: any = new Set<any>(asArray(envelope?.criticalExtensions).map(String));

    const requiredCriticalExtensions: any = envelope?.envelopeKind === "operation-intent"
      ? [MESHRIX_POLICY_EXTENSION]
      : MESHRIX_CRITICAL_EXTENSIONS;
    for (const required of requiredCriticalExtensions) {
      const extension: any = extensionIndex.get(required)?.[0] || null;
      if (!extension) {
        failures.push(createVerificationFailure({
          layer: "meshrix",
          code: `missing_${required.replace(/\W+/gu, "_")}`,
          message: `Meshrix Proof Envelope is missing required critical extension ${required}.`,
          evidenceRef: envelope?.envelopeId || "",
          repairable: evidencePolicy !== "production"
        }));
      } else if (extension.critical !== true || !criticalNames.has(required)) {
        failures.push(createVerificationFailure({
          layer: "meshrix",
          code: "noncritical_required_extension",
          message: `Meshrix required extension ${required} must be critical and listed in criticalExtensions.`,
          evidenceRef: envelope?.envelopeId || "",
          repairable: true
        }));
      }
    }

    for (const name of [MESHRIX_POLICY_EXTENSION, MESHRIX_WORKSPACE_EFFECT_EXTENSION]) {
      for (const extension of asArray(extensionIndex.get(name))) {
        const { value } = await resolveDecodedMaterial(extension.valueRef);
        const evidence: any = asObject(value?.evidence, null);
        const evidenceHash: any = text(value?.evidenceHash || extension.metadata?.evidenceHash);
        const expectedEvidenceHash: any = evidence
          ? protocolHash("meshrix.critical-evidence", cleanValue(evidence))
          : "";
        if (value?.protocol !== MESHRIX_ASPECT_PROTOCOL || value?.evidenceVersion !== "v2" ||
            value?.evidenceType !== name || !evidence || !evidenceHash) {
          failures.push(createVerificationFailure({
            layer: "meshrix.evidence",
            code: "malformed_evidence",
            evidenceRef: extension.valueRef,
            repairable: true
          }));
        } else if (evidenceHash !== expectedEvidenceHash) {
          failures.push(createVerificationFailure({
            layer: "meshrix.evidence",
            code: "bad_evidence_hash",
            evidenceRef: extension.valueRef
          }));
        }
      }
    }

    const signatureExtension: any = extensionIndex.get(MESHRIX_SIGNATURE_EXTENSION)?.[0] || null;
    if (evidencePolicy === "production" && !resolvedSigner) {
      failures.push(createVerificationFailure({
        layer: "meshrix.signing",
        code: "missing_signature_verifier",
        message: "Meshrix production verification requires an explicit signer or signerSecret.",
        evidenceRef: envelope?.envelopeId || "",
        repairable: true
      }));
    }
    if (!signatureExtension) {
      failures.push(createVerificationFailure({
        layer: "meshrix.signing",
        code: "missing_signature",
        message: "Meshrix signing is enabled by default and no signature extension was found.",
        evidenceRef: envelope?.envelopeId || "",
        repairable: evidencePolicy !== "production"
      }));
    } else {
      const { value } = await resolveDecodedMaterial(signatureExtension.valueRef);
      if (!value) {
        failures.push(createVerificationFailure({
          layer: "meshrix.signing",
          code: "missing_signature_material",
          evidenceRef: signatureExtension.valueRef,
          repairable: true
        }));
      } else if (value.signedEnvelopeHash !== meshrixMeshEnvelopeSigningHash(envelope)) {
        failures.push(createVerificationFailure({
          layer: "meshrix.signing",
          code: "bad_signed_envelope_hash",
          evidenceRef: signatureExtension.valueRef
        }));
      } else if (
        resolvedSigner &&
        typeof resolvedSigner.verifyFor !== "function" &&
        value.signerId !== (resolvedSigner.signerId || "meshrix-signer")
      ) {
        failures.push(createVerificationFailure({
          layer: "meshrix.signing",
          code: "bad_signature_signer",
          evidenceRef: signatureExtension.valueRef
        }));
      } else if (
        resolvedSigner &&
        typeof resolvedSigner.verifyFor !== "function" &&
        value.algorithm !== (resolvedSigner.algorithm || "hmac-sha256")
      ) {
        failures.push(createVerificationFailure({
          layer: "meshrix.signing",
          code: "bad_signature_algorithm",
          evidenceRef: signatureExtension.valueRef
        }));
      } else if (!resolvedSigner) {
        failures.push(createVerificationFailure({
          layer: "meshrix.signing",
          code: "signature_verifier_unconfigured",
          message: "Meshrix signature material cannot be verified without an explicit signer or signerSecret.",
          evidenceRef: signatureExtension.valueRef,
          repairable: true
        }));
      } else if (!(await (
        typeof resolvedSigner.verifyFor === "function"
          ? resolvedSigner.verifyFor({
              signerId: value.signerId,
              algorithm: value.algorithm,
              message: value.signedEnvelopeHash,
              signature: value.signature
            })
          : resolvedSigner.verify(value.signedEnvelopeHash, value.signature)
      ))) {
        failures.push(createVerificationFailure({
          layer: "meshrix.signing",
          code: "bad_signature",
          evidenceRef: signatureExtension.valueRef
        }));
      }
    }

    if (evidencePolicy === "production" && !options.trustedManifest) {
      failures.push(createVerificationFailure({
        layer: "meshrix.trust",
        code: "untrusted_verification",
        message: "Meshrix production verification requires a caller-supplied trusted manifest.",
        evidenceRef: envelope?.envelopeId || "",
        repairable: true
      }));
    }

    return {
      protocol: PACTIUM_PROTOCOL,
      aspect: MESHRIX_ASPECT_PROTOCOL,
      envelopeId: envelope?.envelopeId || "",
      ok: failures.filter((failure?: any) : any => failure.severity !== "warning").length === 0,
      proofStructurallyValid: coreResult.proofStructurallyValid,
      ledgerHeadSignatureValid: coreResult.ledgerHeadSignatureValid,
      ledgerHeadTrusted: coreResult.ledgerHeadTrusted,
      trustedSignatureValid: coreResult.trustedSignatureValid,
      trustPolicy: coreResult.trustPolicy,
      failures,
      checked: [
        ...asArray(coreResult.checked),
        "meshrix-critical-policy-extension",
        ...(requiredCriticalExtensions.includes(MESHRIX_WORKSPACE_EFFECT_EXTENSION)
          ? ["meshrix-critical-workspace-effect-extension"]
          : []),
        "meshrix-signature",
        "meshrix-workspace-projection"
      ]
    };
  }

  async function verifyMeshrixBundle(bundle?: any, options: Record<string, any> = {}) : Promise<any> {
    const supportedCriticalExtensions: any[] = [
      ...new Set<any>([
        ...MESHRIX_SUPPORTED_CRITICAL_EXTENSIONS,
        ...asArray(options.supportedCriticalExtensions)
      ])
    ];
    const trustPolicy: any = evidencePolicy === "production"
      ? PACTIUM_TRUST_POLICIES.trustedManifestRequired
      : options.trustPolicy || PACTIUM_TRUST_POLICIES.selfCarriedManifest;
    const bundleResult: any = await verifyProofBundle(bundle, {
      ...options,
      trustPolicy,
      supportedCriticalExtensions
    });
    const envelopeResult: any = await verifyMeshrixEnvelope(bundle?.envelope || {}, {
      ...options,
      trustPolicy,
      bundle,
      coreEnvelopeResult: bundleResult.envelope
    });
    return {
      protocol: PACTIUM_PROTOCOL,
      aspect: MESHRIX_ASPECT_PROTOCOL,
      ok: bundleResult.ok && envelopeResult.ok,
      failures: [...asArray(bundleResult.failures), ...asArray(envelopeResult.failures)],
      bundle: bundleResult,
      envelope: envelopeResult
    };
  }

  function planRepair(failures: any = []) : any {
    const plan: any = genericRepairPlanner.plan(failures);
    return {
      ...plan,
      tasks: asArray(plan.tasks).map((task?: any, index?: any) : any => {
        const failure: any = asArray(failures)[index] || {};
        return String(failure.layer || "").startsWith("meshrix") ||
          String(failure.code || "").startsWith("missing_meshrix_")
          ? { ...task, action: "request-host-evidence" }
          : task;
      })
    };
  }

  return Object.freeze({
    protocol: MESHRIX_ASPECT_PROTOCOL,
    core,
    evidencePolicy,
    workspaceProjectionDefault: true,
    criticalExtensions: MESHRIX_CRITICAL_EXTENSIONS,
    supportedCriticalExtensions: MESHRIX_SUPPORTED_CRITICAL_EXTENSIONS,
    signer: resolvedSigner,
    assertProductionReady,
    recordWorkspaceOperation,
    recordOperation: recordWorkspaceOperation,
    verifyMeshrixEnvelope,
    verifyEnvelope: verifyMeshrixEnvelope,
    verifyMeshrixBundle,
    verifyBundle: verifyMeshrixBundle,
    planRepair,
    close() : any {
      if (ownsSigner) resolvedSigner?.close?.();
    },
    getWorkspaceProjection: core.getWorkspaceProjection,
    proveWorkspaceMembership: core.proveWorkspaceMembership,
    exportProofBundle: core.exportProofBundle
  });
}

export function createOperationProofSubstrate({
  userDataPath = "",
  dataDir = "",
  pactiumRuntime = null,
  runtimeOptions = {},
  mode = "",
  evidencePolicy = "",
  signer = null,
  signerSecret = ""
}: Record<string, any> = {}) : any {
  const resolvedDataDir: any = resolveMeshrixPactiumDataDir(userDataPath || dataDir);
  const resolvedMode: any = resolveMode({ mode, runtimeOptions });
  const resolvedEvidencePolicy: any = resolveEvidencePolicy({ evidencePolicy, runtimeOptions });
  const resolvedSignerSecret: any = resolveSignerSecret({
    signerSecret,
    runtimeOptions,
    dataDir: resolvedDataDir,
  });
  if (!signerConfigured({
    signer,
    signerSecret: resolvedSignerSecret,
    evidencePolicy: resolvedEvidencePolicy,
  })) {
    throw proofConfigurationError(
      "operation_proof_signer_required",
      "Meshrix production operation-proof evidence requires a configured signer.",
    );
  }
  const ownsPactiumRuntime: any = !pactiumRuntime;
  const runtime: any = normalizeMeshrixPactiumRuntime({
    userDataPath: resolvedDataDir,
    dataDir: resolvedDataDir,
    pactiumRuntime
  });
  const core: any = runtime.core;
  const storage: any = runtime.storage;
  const aspect: any = createMeshrixAspect({
    pactium: core,
    storage,
    evidencePolicy: resolvedEvidencePolicy,
    signer,
    signerSecret: resolvedSignerSecret
  });
  const productionVerifiable: any = Boolean(resolvedEvidencePolicy === "production" && signerConfigured({
    signer,
    signerSecret: resolvedSignerSecret,
    evidencePolicy: resolvedEvidencePolicy
  }));
  const defaultVerificationTrustPolicy: any = resolvedEvidencePolicy === "production"
    ? PACTIUM_TRUST_POLICIES.trustedManifestRequired
    : PACTIUM_TRUST_POLICIES.selfCarriedManifest;

  async function beginLifecycle(input: Record<string, any> = {}) : Promise<any> {
    aspect.assertProductionReady();
    const operationId: any = normalizeOperationId(input);
    const workspaceId: any = normalizeWorkspaceId(input);
    const idempotencyKey: any = normalizeIdempotencyKey(input);
    const evidenceExtensions: any = meshrixMeshEvidenceExtensions({
      input: {
        ...input,
        operationId,
        workspaceId,
        idempotencyKey
      },
      phase: "intent"
    });
    const envelope: any = await core.beginOperationIntent({
      operationId,
      workspaceId,
      idempotencyKey,
      input: {
        inputDigest: protocolHash("meshrix.operation-input", cleanValue(input.input ?? input.payload ?? {}))
      },
      subject: {
        subjectDigest: protocolHash("meshrix.subject", cleanValue(asObject(input.subject)))
      },
      causalityRefs: asArray(input.causalityRefs),
      appendCondition: input.appendCondition,
      proofOptions: input.proofOptions,
      extensions: [
        ...evidenceExtensions,
        ...asArray(input.extensions)
      ],
      finalizeEnvelopeExtensions: finalizeMeshrixEnvelopeExtensions(aspect.signer)
    });
    if (envelope.replayed) {
      const existing: any = await loadProjectedEntry(core, envelope.factRef?.ledgerEventId);
      if (existing) {
        existing.proof = {
          ...asObject(existing.proof),
          mode: resolvedMode,
          evidencePolicy: resolvedEvidencePolicy,
          productionVerifiable
        };
        return { ...existing, replayed: true };
      }
    }
    const entry: any = normalizeEntry({
      ...input,
      operationId,
      workspaceId,
      idempotencyKey
    }, envelope);
    entry.proof = {
      ...entry.proof,
      mode: resolvedMode,
      evidencePolicy: resolvedEvidencePolicy,
      productionVerifiable
    };
    return entry;
  }

  async function finishLifecycle(input: Record<string, any> = {}) : Promise<any> {
    aspect.assertProductionReady();
    const ledgerEventId: any = text(input.ledgerEventId || input.entry?.ledgerEventId);
    const entry: any = input.entry?.ledgerEventId ? input.entry : await loadProjectedEntry(core, ledgerEventId);
    if (!entry) {
      throw new Error("operation proof entry missing");
    }
    if (!entry.pactium?.intentId) {
      throw new Error("operation proof intent missing");
    }
    const status: any = outcomeStatus(input);
    const evidenceExtensions: any = meshrixMeshEvidenceExtensions({
      input: {
        ...input,
        status
      },
      entry,
      phase: "outcome"
    });
    const envelope: any = await core.appendOperationOutcome({
      intentId: entry.pactium.intentId,
      status,
      outcomeIdempotencyKey: input.outcomeIdempotencyKey || input.idempotencyKey || `${entry.idempotencyKey}:outcome`,
      result: cleanValue({
        resultDigest: protocolHash("meshrix.operation-result", cleanValue(input.result ?? input.output ?? {})),
        assetRefDigest: protocolHash("meshrix.asset-ref", text(input.assetRef, entry.assetRef || "")),
        receiptSetDigest: protocolHash("meshrix.receipt-set", asArray(input.receiptRefs).map(String)),
        auditDigest: protocolHash("meshrix.audit-ref", text(input.auditId)),
        errorDigest: input.error ? protocolHash("meshrix.operation-error", text(input.error)) : "",
        outcomeKind: text(input.outcomeKind, status)
      }),
      hostEvidenceRefs: [
        ...asArray(input.receiptRefs),
        ...(text(input.auditId)
          ? [`audit:${text(input.auditId)}`]
          : [])
      ],
      causalityRefs: asArray(input.causalityRefs),
      appendCondition: input.appendCondition,
      proofOptions: input.proofOptions,
      stateMutations: asArray(input.stateMutations || input.state?.mutations),
      extensions: [
        ...evidenceExtensions,
        ...asArray(input.extensions)
      ],
      finalizeEnvelopeExtensions: finalizeMeshrixEnvelopeExtensions(aspect.signer)
    });
    if (envelope.replayed === true) {
      const existing: any = await loadProjectedEntry(
        core,
        entry.pactium?.intentLedgerEventId ||
          entry.ledgerEventId
      );
      const durableEntry: any = existing || entry;
      const canonicalEntry: Record<string, any> = {
        ...durableEntry,
        proof: {
          ...asObject(durableEntry.proof),
          ...asObject(entry.proof),
          mode: resolvedMode,
          evidencePolicy: resolvedEvidencePolicy,
          productionVerifiable
        }
      };
      return {
        ...mergeCompletion(
          canonicalEntry,
          {
            ...input,
            status,
            completedAt:
              canonicalEntry.completedAt ||
              entry.completedAt
          },
          envelope,
          input.failed === true || status === "failed"
        ),
        replayed: true
      };
    }
    return mergeCompletion(entry, { ...input, status }, envelope, input.failed === true || status === "failed");
  }

  async function recordReceipt(input: Record<string, any> = {}) : Promise<any> {
    aspect.assertProductionReady();
    const operationId: any = normalizeOperationId(input);
    const workspaceId: any = normalizeWorkspaceId(input);
    const profile: any = text(input.profile, "receipt");
    const status: any = outcomeStatus(input);
    const evidenceExtensions: any = meshrixMeshEvidenceExtensions({
      input: { ...input, operationId, workspaceId, status },
      phase: "receipt"
    });
    const receiptResult: any = receiptResultFor(input, status);
    const envelope: any = await core.recordOperationReceipt({
      operationId,
      workspaceId,
      profile,
      changeKey: text(input.changeKey || input.changeProjection, operationId),
      changeDigest: text(input.changeDigest),
      idempotencyKey: normalizeIdempotencyKey(input),
      status,
      subject: {
        subjectDigest: protocolHash("meshrix.subject", cleanValue(asObject(input.subject)))
      },
      result: receiptResult,
      extensions: [...evidenceExtensions, ...asArray(input.extensions)],
      finalizeEnvelopeExtensions: finalizeMeshrixEnvelopeExtensions(aspect.signer)
    });
    if (envelope.disposition === "unchanged") {
      return {
        protocol: PACTIUM_PROTOCOL,
        schema: PACTIUM_SCHEMA_VERSION,
        protocolVersion: OPERATION_PROOF_SUBSTRATE_PROTOCOL_VERSION,
        provider: OPERATION_PROOF_SUBSTRATE_PROVIDER,
        operationId,
        workspaceId,
        status,
        disposition: "unchanged",
        replayed: false,
        ledgerEventId: "",
        proof: { profile, lifecycle: "single-terminal", terminal: true },
        pactium: {
          receiptId: text(envelope.receiptId),
          receiptEnvelopeId: text(envelope.envelopeId)
        }
      };
    }
    const entry: any = normalizeReceiptEntry({
      ...input,
      operationId,
      workspaceId,
      profile,
      status,
      resultDigest: protocolHash("operation.receipt.result", receiptResult)
    }, envelope);
    entry.proof = {
      ...entry.proof,
      mode: resolvedMode,
      evidencePolicy: resolvedEvidencePolicy,
      productionVerifiable
    };
    return entry;
  }

  async function exportProofBundleForEntry(input: Record<string, any> = {}) : Promise<any> {
    const actor: any = input.actor || { type: "system" };
    if (!canExportProofBundle({ actor })) {
      throw new Error("Proof Bundle Export requires proof:export, runtime:admin, console:admin, or system actor.");
    }
    const entry: any = input.entry || await loadProjectedEntry(core, input.ledgerEventId);
    if (!entry) {
      throw new Error("operation proof entry missing");
    }
    const envelopeId: any = text(input.envelopeId) || envelopeIdForEntry(entry, input.kind || "outcome");
    if (!envelopeId) {
      throw new Error("operation proof envelope missing");
    }
    return core.exportProofBundle(envelopeId, input.options || {});
  }

  async function verifyReceipt(input: Record<string, any> = {}) : Promise<any> {
    const bundle: any = input.bundle || await exportProofBundleForEntry({
      ...input,
      actor: input.actor || { type: "system" }
    });
    const result: any = await aspect.verifyBundle(bundle, {
      requireAllProofs: input.requireAllProofs !== false,
      trustPolicy: defaultVerificationTrustPolicy,
      ...(input.options || {})
    });
    return {
      ...result,
      provider: OPERATION_PROOF_SUBSTRATE_PROVIDER,
      mode: resolvedMode,
      productionVerifiable
    };
  }

  return Object.freeze({
    protocol: PACTIUM_PROTOCOL,
    schema: PACTIUM_SCHEMA_VERSION,
    protocolVersion: OPERATION_PROOF_SUBSTRATE_PROTOCOL_VERSION,
    provider: OPERATION_PROOF_SUBSTRATE_PROVIDER,
    providerProtocolVersion: PACTIUM_PROTOCOL,
    providerPackageVersion: PACTIUM_PACKAGE_VERSION,
    aspectProtocolVersion: MESHRIX_ASPECT_PROTOCOL,
    dataDir: resolvedDataDir,
    mode: resolvedMode,
    evidencePolicy: resolvedEvidencePolicy,
    productionVerifiable,
    pactiumRuntime: runtime,
    aspect,
    beginLifecycle,
    finishLifecycle,
    recordReceipt,
    denyLifecycle(input: Record<string, any> = {}) : any {
      return finishLifecycle({ ...input, status: "denied", denied: true });
    },
    recordWorkspaceOperation(input: Record<string, any> = {}) : any {
      return aspect.recordWorkspaceOperation({
        ...input,
        workspaceId: normalizeWorkspaceId(input),
        policyEvidence: input.policyEvidence || buildPolicyEvidence(input),
        workspaceEffectEvidence: input.workspaceEffectEvidence || buildWorkspaceEffectEvidence(input)
      });
    },
    async recordAcceptanceEvidence({ reportDigests = [], evidenceContext = {}, releaseId = "", actor = { type: "system" } }: Record<string, any> = {}) : Promise<any> {
      if (!releaseId) {
        throw new Error("releaseId is required for acceptance evidence anchoring");
      }
      if (!Array.isArray(reportDigests) || reportDigests.length === 0) {
        throw new Error("reportDigests must be a non-empty array");
      }
      const workspaceId: any = `release:${String(releaseId)}`;
      const operationId: any = `acceptance.anchor.${String(releaseId)}`;
      const commitment: any = cleanValue({
        kind: "acceptance-evidence",
        releaseId: String(releaseId),
        reportDigests: reportDigests.map((digest?: any) : any => ({
          path: String(digest.path || ""),
          schemaVersion: String(digest.schemaVersion || ""),
          contentHash: String(digest.contentHash || "")
        })).sort((left?: any, right?: any) : any => left.path.localeCompare(right.path)),
        evidenceContext: cleanValue(asObject(evidenceContext))
      });
      const entry: any = await recordReceipt({
        profile: "receipt",
        operationId,
        workspaceId,
        idempotencyKey: operationId,
        subject: cleanValue(asObject(actor)),
        status: "succeeded",
        commitment
      });
      return {
        ledgerEventId: text(entry?.ledgerEventId),
        envelopeId: text(entry?.pactium?.receiptEnvelopeId),
        factId: text(entry?.pactium?.receiptId),
        workspaceId,
        recordedAt: text(entry?.createdAt),
        resultDigest: text(entry?.resultDigest)
      };
    },
    async recordPlanReceiptEvidence({ plan = "", receiptDigest = "", context = {}, actor = { type: "system" } }: Record<string, any> = {}) : Promise<any> {
      const normalizedPlan: any = text(plan);
      const normalizedDigest: any = text(receiptDigest);
      if (!normalizedPlan || !/^([a-f0-9]{64})$/u.test(normalizedDigest)) {
        throw new Error("plan and sha256 receiptDigest are required for Plan receipt anchoring");
      }
      const workspaceId: any = `plan-receipt:${normalizedPlan}`;
      const operationId: any = `plan.receipt.anchor.${normalizedDigest}`;
      const commitment: any = cleanValue({
        kind: "plan-final-receipt",
        plan: normalizedPlan,
        receiptDigest: normalizedDigest,
        context: cleanValue(asObject(context))
      });
      const entry: any = await recordReceipt({
        profile: "receipt",
        operationId,
        workspaceId,
        idempotencyKey: operationId,
        subject: cleanValue(asObject(actor)),
        status: "succeeded",
        commitment
      });
      return {
        ledgerEventId: text(entry?.ledgerEventId),
        envelopeId: text(entry?.pactium?.receiptEnvelopeId),
        factId: text(entry?.pactium?.receiptId),
        workspaceId,
        recordedAt: text(entry?.createdAt),
        resultDigest: text(entry?.resultDigest)
      };
    },
    async verifyReceiptCommitment({ ledgerEventId = "", commitment = {} }: Record<string, any> = {}) : Promise<any> {
      const entry: any = await loadProjectedEntry(core, ledgerEventId);
      if (!entry || !entry.resultDigest) {
        return { ok: false, reason: "receipt-commitment-unavailable" };
      }
      const expectedResultDigest: any = protocolHash(
        "operation.receipt.result",
        receiptResultFor({ commitment }, "succeeded")
      );
      const ok: any = entry.resultDigest === expectedResultDigest;
      return {
        ok,
        reason: ok ? "verified-receipt-commitment" : "receipt-commitment-mismatch",
        ledgerEventId: text(entry.ledgerEventId)
      };
    },
    verifyReceipt,
    async verifyEnvelope(envelope?: any, options: Record<string, any> = {}) : Promise<any> {
      return aspect.verifyEnvelope(envelope, {
        trustPolicy: defaultVerificationTrustPolicy,
        ...options
      });
    },
    async verifyBundle(bundle?: any, options: Record<string, any> = {}) : Promise<any> {
      return aspect.verifyBundle(bundle, {
        trustPolicy: defaultVerificationTrustPolicy,
        ...options
      });
    },
    exportProofBundle: exportProofBundleForEntry,
    getWorkspaceProjection(workspaceId: any = "default") : any {
      return core.getWorkspaceProjection(workspaceId);
    },
    proveWorkspaceMembership(input: Record<string, any> = {}) : any {
      return core.proveWorkspaceMembership(input);
    },
    planRecovery(input: Record<string, any> = {}) : any {
      return core.planRecovery(input);
    },
    async doctor() : Promise<any> {
      const pactiumDoctor: any = await core.doctor();
      return {
        ...pactiumDoctor,
        protocolVersion: OPERATION_PROOF_SUBSTRATE_PROTOCOL_VERSION,
        provider: OPERATION_PROOF_SUBSTRATE_PROVIDER,
        mode: resolvedMode,
        evidencePolicy: resolvedEvidencePolicy,
        productionVerifiable,
        signingConfigured: Boolean(aspect?.signer),
        verificationAvailable: true
      };
    },
    health() : any {
      return {
        ok: true,
        protocolVersion: OPERATION_PROOF_SUBSTRATE_PROTOCOL_VERSION,
        provider: OPERATION_PROOF_SUBSTRATE_PROVIDER,
        mode: resolvedMode,
        evidencePolicy: resolvedEvidencePolicy,
        productionVerifiable,
        signingConfigured: Boolean(aspect?.signer),
        pactiumPackageVersion: PACTIUM_PACKAGE_VERSION,
        dataDir: resolvedDataDir
      };
    },
    listCapabilities() : any {
      return {
        protocolVersion: OPERATION_PROOF_SUBSTRATE_PROTOCOL_VERSION,
        provider: OPERATION_PROOF_SUBSTRATE_PROVIDER,
        mode: resolvedMode,
        capabilities: [
          {
            id: "operation-proof-lifecycle",
            kind: "profiled-lifecycle",
            operations: ["beginLifecycle", "finishLifecycle", "recordReceipt", "denyLifecycle"]
          },
          {
            id: "receipt-verification-export",
            kind: "proof-facade",
            operations: [
              "verifyReceipt",
              "verifyReceiptCommitment",
              "verifyEnvelope",
              "verifyBundle",
              "exportProofBundle",
              "getReceipt",
              "listReceipts"
            ]
          },
          {
            id: "workspace-proof-projection",
            kind: "projection",
            operations: ["getWorkspaceProjection", "proveWorkspaceMembership"]
          },
          {
            id: "proof-recovery",
            kind: "maintenance",
            operations: ["planRecovery", "doctor", "health"]
          },
          {
            id: "meshrix-aspect-record",
            kind: "pactium-meshrix-aspect",
            operations: ["recordWorkspaceOperation", "recordAcceptanceEvidence"]
          }
        ]
      };
    },
    getReceipt(ledgerEventId?: any) : any {
      return loadProjectedEntry(core, ledgerEventId);
    },
    async listReceipts({ limit = 100 }: Record<string, any> = {}) : Promise<any> {
      const normalizedLimit: any = Math.max(1, Math.min(Number(limit || 100), 10000));
      const head: any = await core.readLedgerHead();
      const entries: any[] = [];
      for (let index: any = Number(head?.size || 0) - 1; index >= 0 && entries.length < normalizedLimit; index -= 1) {
        const ledgerEntry: any = await core.readLedgerLeaf(index);
        if (!["operation.outcome", "operation.receipt"].includes(text(ledgerEntry?.fact?.factType))) continue;
        const projected: any = await projectLedgerEntry(core, ledgerEntry);
        if (projected) entries.push(projected);
      }
      return entries;
    },
    async close() : Promise<any> {
      let failure: any = null;
      try {
        aspect.close?.();
      } catch (error: any) {
        failure = error;
      }
      if (ownsPactiumRuntime) {
        try {
          await (runtime.close?.() || Promise.resolve());
        } catch (error: any) {
          failure ||= error;
        }
      }
      if (failure) throw failure;
    }
  });
}

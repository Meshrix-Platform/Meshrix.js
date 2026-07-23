import {
  createHash,
  createHmac,
  createPublicKey,
  randomUUID,
  sign as signWithKey,
  timingSafeEqual,
  verify as verifyWithKey
} from "node:crypto";
import {
  canonicalDecode,
  cidForBytes,
  createRepairPlanner,
  createVerificationFailure,
  envelopeSigningHash,
  PACTIUM_PACKAGE_VERSION,
  PACTIUM_PROTOCOL,
  PACTIUM_SCHEMA_VERSION,
  PACTIUM_TRUST_POLICIES,
  protocolHash,
  verifyProofBundle,
  verifyProofEnvelope
} from "pactium";
import { serverToken } from "#lico/client-strings";
import {
  normalizeLicoPactiumRuntime,
  resolveLicoPactiumDataDir
} from "../../checkpoint/tree/pactium-substrate-preflight.mjs";
import { toPactiumCanonicalSafeValue } from "../../checkpoint/tree/pactium-canonical-safe.mjs";

export const OPERATION_PROOF_SUBSTRATE_PROTOCOL_VERSION = "v0.0.1:operation:proof-substrate-2";
export const OPERATION_PROOF_SUBSTRATE_PROTOCOL = PACTIUM_PROTOCOL;
export const OPERATION_PROOF_SUBSTRATE_PROVIDER = "pactium.operation-proof-substrate";
export const OPERATION_PROOF_SUBSTRATE_MODES = Object.freeze({
  PACTIUM: "pactium"
});

const DEFAULT_EVIDENCE_POLICY = "development";
const LICOMESH_ASPECT_PROTOCOL = "pactium.v0.3.licomesh-aspect";
const LICOMESH_POLICY_EXTENSION = "licomesh.policy";
const LICOMESH_WORKSPACE_EFFECT_EXTENSION = "licomesh.workspaceEffect";
const LICOMESH_SIGNATURE_EXTENSION = "licomesh.signature";
const LICOMESH_CRITICAL_EXTENSIONS = Object.freeze([
  LICOMESH_POLICY_EXTENSION,
  LICOMESH_WORKSPACE_EFFECT_EXTENSION
]);
const LICOMESH_SUPPORTED_CRITICAL_EXTENSIONS = Object.freeze([
  ...LICOMESH_CRITICAL_EXTENSIONS,
  LICOMESH_SIGNATURE_EXTENSION
]);

function nowIso() {
  return new Date().toISOString();
}

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hmac(secret, value) {
  return createHmac("sha256", String(secret || ""))
    .update(String(value || ""))
    .digest("hex");
}

function publicKeyFromPrivateKey(privateKey) {
  if (!privateKey) return "";
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" });
}

function createLicoMeshSigner({
  signerId = "licomesh-local",
  secret = "licomesh-development-signer",
  algorithm = "",
  privateKey = "",
  publicKey = ""
} = {}) {
  const resolvedAlgorithm = text(algorithm, privateKey || publicKey ? "ed25519" : "hmac-sha256");
  if (resolvedAlgorithm === "ed25519") {
    const verifierPublicKey = publicKey || publicKeyFromPrivateKey(privateKey);
    return Object.freeze({
      protocol: LICOMESH_ASPECT_PROTOCOL,
      signerId,
      algorithm: "ed25519",
      publicKey: verifierPublicKey,
      async sign(message) {
        if (!privateKey) {
          throw new Error("Ed25519 LicoMesh signer requires a privateKey for signing.");
        }
        return `ed25519:${signWithKey(
          null,
          Buffer.from(String(message || "")),
          privateKey
        ).toString("base64")}`;
      },
      async verify(message, signature) {
        if (!verifierPublicKey || !String(signature || "").startsWith("ed25519:")) {
          return false;
        }
        return verifyWithKey(
          null,
          Buffer.from(String(message || "")),
          verifierPublicKey,
          Buffer.from(String(signature).slice("ed25519:".length), "base64")
        );
      }
    });
  }
  if (resolvedAlgorithm !== "hmac-sha256") {
    throw new Error(`Unsupported LicoMesh signer algorithm: ${resolvedAlgorithm}`);
  }
  return Object.freeze({
    protocol: LICOMESH_ASPECT_PROTOCOL,
    signerId,
    algorithm: "hmac-sha256",
    async sign(message) {
      return `hmac-sha256:${hmac(secret, message)}`;
    },
    async verify(message, signature) {
      const expected = Buffer.from(`hmac-sha256:${hmac(secret, message)}`);
      const actual = Buffer.from(String(signature || ""));
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    }
  });
}

function cleanValue(value) {
  return toPactiumCanonicalSafeValue(value);
}

function normalizeMode(value = "") {
  const mode = text(value).toLowerCase();
  if (!mode || mode === OPERATION_PROOF_SUBSTRATE_MODES.PACTIUM) {
    return OPERATION_PROOF_SUBSTRATE_MODES.PACTIUM;
  }
  throw new Error("Operation Proof Substrate only supports Pactium-backed mode.");
}

function env(name) {
  return text(process.env[name]);
}

function runtimeOperationProofOptions(runtimeOptions = {}) {
  return asObject(runtimeOptions.operationProof || runtimeOptions.operationProofSubstrate || runtimeOptions.pactiumProof);
}

function resolveMode({ mode = "", runtimeOptions = {} } = {}) {
  const options = runtimeOperationProofOptions(runtimeOptions);
  return normalizeMode(mode || options.mode || env("LICO_OPERATION_PROOF_MODE"));
}

function resolveEvidencePolicy({ evidencePolicy = "", runtimeOptions = {} } = {}) {
  const options = runtimeOperationProofOptions(runtimeOptions);
  return text(
    evidencePolicy ||
    options.evidencePolicy ||
    env("LICO_OPERATION_PROOF_EVIDENCE_POLICY") ||
    DEFAULT_EVIDENCE_POLICY,
    DEFAULT_EVIDENCE_POLICY
  );
}

function resolveSignerSecret({ signerSecret = "", runtimeOptions = {} } = {}) {
  const options = runtimeOperationProofOptions(runtimeOptions);
  return text(
    signerSecret ||
    options.signerSecret ||
    env("LICO_OPERATION_PROOF_SIGNER_SECRET")
  );
}

function signerConfigured({ signer = null, signerSecret = "", evidencePolicy = "" } = {}) {
  return Boolean(signer) || text(signerSecret) !== "" || evidencePolicy !== "production";
}

function normalizeWorkspaceId(input = {}) {
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

function normalizeOperationId(input = {}) {
  return text(input.operationId || input.operation?.id || input.id, "operation.unknown");
}

function normalizeIdempotencyKey(input = {}) {
  return text(
    input.idempotencyKey ||
    input["idempotency-key"] ||
    input.requestId ||
    input.traceId ||
    randomUUID()
  );
}

function entryIdFromEnvelope(input = {}, envelope) {
  return text(envelope?.factRef?.ledgerEventId) || serverToken(
    "operation_proof",
    normalizeWorkspaceId(input),
    normalizeOperationId(input),
    normalizeIdempotencyKey(input),
    nowIso(),
    randomUUID()
  );
}

function normalizeEntry(input = {}, envelope) {
  const at = nowIso();
  const ledgerEventId = entryIdFromEnvelope(input, envelope);
  const storedInput = asObject(input.input);
  const storedSubject = asObject(input.subject);
  const storedRisk = asObject(input.risk);
  const storedPolicy = asObject(input.policyDecision || input.policyEvidence);
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
    subjectDigest: text(storedSubject.subjectDigest) || protocolHash("licomesh.subject", cleanValue(storedSubject)),
    riskDigest: text(storedRisk.riskDigest) || protocolHash("licomesh.risk", cleanValue(storedRisk)),
    idempotencyKey: normalizeIdempotencyKey(input),
    inputDigest: text(storedInput.inputDigest) || protocolHash("licomesh.operation-input", cleanValue(storedInput)),
    policyDigest: text(storedPolicy.policyDigest) || protocolHash(
      "licomesh.policy-evidence",
      cleanValue(storedPolicy)
    ),
    warnings: asArray(input.warnings).map((warning) => cleanValue(warning)),
    receiptRefs: [],
    createdAt: at,
    updatedAt: at,
    completedAt: "",
    failedAt: "",
    error: "",
    proof: {
      mode: OPERATION_PROOF_SUBSTRATE_MODES.PACTIUM,
      lifecycle: "two-stage",
      aspect: LICOMESH_ASPECT_PROTOCOL,
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

function normalizeReceiptEntry(input = {}, envelope) {
  const at = nowIso();
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
      aspect: LICOMESH_ASPECT_PROTOCOL,
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

function mergeCompletion(entry, patch = {}, envelope, failed = false) {
  const at = nowIso();
  const status = text(patch.status, failed ? "failed" : "succeeded");
  return {
    ...entry,
    status,
    outcomeKind: text(patch.outcomeKind, status),
    assetRef: text(patch.assetRef, entry.assetRef || ""),
    receiptRefs: asArray(patch.receiptRefs).length > 0 ? asArray(patch.receiptRefs) : asArray(entry.receiptRefs),
    auditId: text(patch.auditId, entry.auditId || ""),
    warnings: [
      ...asArray(entry.warnings),
      ...asArray(patch.warnings).map((warning) => cleanValue(warning))
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

function locatorEnvelope(factId, locator = {}) {
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

async function readLedgerEntryByEventId(core, ledgerEventId) {
  const eventId = text(ledgerEventId);
  if (!eventId) return null;
  const pointer = await core.readProtocolObject("ledger-event", eventId, null);
  if (!Number.isInteger(Number(pointer?.index))) return null;
  return core.readLedgerLeaf(Number(pointer.index));
}

async function projectLedgerEntry(core, ledgerEntry) {
  const fact = asObject(ledgerEntry?.fact, null);
  if (!fact) return null;
  if (fact.factType === "operation.receipt") {
    const locator = await core.lookupReceipt(fact.receiptId);
    return normalizeReceiptEntry(fact, locatorEnvelope(fact.receiptId, locator));
  }
  if (fact.factType === "operation.intent") {
    const intentLocator = await core.lookupOpenIntent(fact.intentId);
    const entry = normalizeEntry(fact, locatorEnvelope(fact.intentId, intentLocator));
    const outcomeLocator = await core.lookupOutcome(fact.intentId);
    return outcomeLocator.exists && outcomeLocator.outcome
      ? mergeCompletion(
          entry,
          {
            status: outcomeLocator.outcome.status,
            outcomeKind: outcomeLocator.outcome.status
          },
          locatorEnvelope(outcomeLocator.outcome.outcomeId, outcomeLocator),
          outcomeLocator.outcome.status === "failed"
        )
      : entry;
  }
  if (fact.factType === "operation.outcome") {
    const outcomeLocator = await core.lookupOutcome(fact.intentId);
    const at = text(fact.createdAt, nowIso());
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

async function loadProjectedEntry(core, ledgerEventId) {
  return projectLedgerEntry(core, await readLedgerEntryByEventId(core, ledgerEventId));
}

function outcomeStatus({ status = "", failed = false, denied = false } = {}) {
  if (denied) return "denied";
  if (failed) return "failed";
  return text(status, "succeeded");
}

function buildPolicyEvidence(input = {}) {
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

function buildWorkspaceEffectEvidence(input = {}) {
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

function envelopeIdForEntry(entry = {}, kind = "outcome") {
  if (kind === "intent") {
    return text(entry.pactium?.intentEnvelopeId);
  }
  return text(
    entry.pactium?.receiptEnvelopeId ||
    entry.pactium?.outcomeEnvelopeId ||
    entry.pactium?.intentEnvelopeId
  );
}

function receiptResultFor(input = {}, status = "succeeded") {
  return cleanValue({
    outcomeKind: text(input.outcomeKind, status),
    statusCode: Number(input.statusCode || 0),
    auditId: text(input.auditId),
    receiptRefs: asArray(input.receiptRefs).map(String).filter(Boolean).slice(0, 64),
    errorDigest: input.error ? protocolHash("licomesh.operation-error", text(input.error)) : "",
    ...(input.commitment === undefined ? {} : { commitment: cleanValue(input.commitment) })
  });
}

function canExportProofBundle({ actor = null } = {}) {
  if (!actor) return false;
  if (actor.type === "system" || actor.system === true) return true;
  const scopes = new Set(asArray(actor.scopes || actor.user?.scopes).map(String));
  return scopes.has("proof:export") || scopes.has("runtime:admin") || scopes.has("console:admin");
}

function decodeBundleVarint(bytes, offset = 0) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("Bundle varint offset is invalid.");
  }
  while (cursor < bytes.length) {
    const byte = bytes[cursor];
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

function createPortableBundleBlockResolver(bundle, options = {}) {
  if (!bundle?.binaryBase64 || !Array.isArray(bundle?.index)) return null;
  const maxHeaderSize = Number(options.maxHeaderSize || 16 * 1024);
  const maxBlockSize = Number(options.maxBlockSize || 64 * 1024 * 1024);
  const bytes = Buffer.from(String(bundle.binaryBase64), "base64");
  const index = new Map();
  const cache = new Map();
  for (const item of bundle.index) {
    const cid = text(item?.cid);
    if (!cid || index.has(cid)) continue;
    index.set(cid, asObject(item));
  }

  return Object.freeze({
    get(cid) {
      const key = text(cid);
      if (!key || !index.has(key)) return null;
      if (cache.has(key)) return cache.get(key);
      const item = index.get(key);
      let block = null;
      try {
        const offset = Number(item.offset);
        const recordLength = Number(item.recordLength);
        const headerLength = Number(item.headerLength);
        const payloadLength = Number(item.byteLength);
        if (
          !Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(recordLength) || recordLength <= 0 ||
          !Number.isSafeInteger(headerLength) || headerLength < 0 || headerLength > maxHeaderSize ||
          !Number.isSafeInteger(payloadLength) || payloadLength < 0 || payloadLength > maxBlockSize
        ) {
          throw new Error("Bundle index bounds are invalid.");
        }
        const decoded = decodeBundleVarint(bytes, offset);
        if (decoded.value !== recordLength || recordLength !== headerLength + payloadLength) {
          throw new Error("Bundle record length is invalid.");
        }
        const payloadStart = decoded.nextOffset + headerLength;
        const payloadEnd = payloadStart + payloadLength;
        if (payloadEnd > bytes.length) throw new Error("Bundle record exceeds the binary payload.");
        const header = asObject(canonicalDecode(bytes.subarray(decoded.nextOffset, payloadStart)));
        if (
          header.cid !== key ||
          header.payloadHash !== item.payloadHash ||
          Number(header.byteLength) !== payloadLength
        ) {
          throw new Error("Bundle record header does not match its index entry.");
        }
        const payloadBytes = bytes.subarray(payloadStart, payloadEnd);
        const payloadHash = `sha256:${createHash("sha256").update(payloadBytes).digest("hex")}`;
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

function indexExtensionsByName(extensions) {
  const index = new Map();
  for (const extension of asArray(extensions)) {
    const name = text(extension?.name);
    if (!name) continue;
    if (!index.has(name)) index.set(name, []);
    index.get(name).push(extension);
  }
  return index;
}

async function resolveMaterialBlock({ core, cid, bundleResolver }) {
  return bundleResolver?.get(cid) || core.resolveBlock(cid);
}

function materializeLicoMeshEvidenceExtension({ name, evidence, metadata = {} }) {
  const normalizedEvidence = cleanValue(evidence || {});
  return {
    name,
    critical: true,
    value: {
      protocol: LICOMESH_ASPECT_PROTOCOL,
      evidenceType: name,
      evidenceVersion: "v2",
      evidence: normalizedEvidence,
      evidenceHash: protocolHash("licomesh.critical-evidence", normalizedEvidence),
      metadata: cleanValue(asObject(metadata))
    },
    metadata: {
      evidenceHash: protocolHash("licomesh.critical-evidence", normalizedEvidence)
    }
  };
}

function licoMeshEvidenceExtensions({ input = {}, entry = null, phase = "outcome" }) {
  const rawPolicyEvidence = input.policyEvidence ||
    input.policyDecision ||
    (entry?.policyDigest ? { policyDigest: entry.policyDigest } : null) ||
    buildPolicyEvidence({ ...asObject(entry), ...input });
  const policyEvidence = cleanValue({
    evidenceType: "policy-digest",
    operationId: normalizeOperationId(input),
    workspaceId: normalizeWorkspaceId(input),
    decision: text(rawPolicyEvidence?.decision || rawPolicyEvidence?.status),
    reasonCode: text(rawPolicyEvidence?.reasonCode || rawPolicyEvidence?.reason),
    policyDigest: protocolHash("licomesh.policy-evidence", cleanValue(rawPolicyEvidence))
  });
  const rawWorkspaceEffectEvidence = input.workspaceEffectEvidence ||
    input.effectEvidence ||
    input.workspaceEffect ||
    buildWorkspaceEffectEvidence({
      ...asObject(entry),
      ...input,
      status: input.status || entry?.status || ""
    });
  const workspaceEffectEvidence = cleanValue({
    evidenceType: "workspace-effect-digest",
    operationId: normalizeOperationId(input),
    workspaceId: normalizeWorkspaceId(input),
    status: text(input.status || entry?.status),
    receiptRefs: asArray(input.receiptRefs).map(String).filter(Boolean).slice(0, 64),
    effectDigest: protocolHash("licomesh.workspace-effect-evidence", cleanValue(rawWorkspaceEffectEvidence))
  });
  const policyExtension = materializeLicoMeshEvidenceExtension({
      name: LICOMESH_POLICY_EXTENSION,
      evidence: policyEvidence,
      metadata: {
        workspaceId: normalizeWorkspaceId(input)
      }
    });
  if (phase === "intent") return [policyExtension];
  return [
    policyExtension,
    materializeLicoMeshEvidenceExtension({
      name: LICOMESH_WORKSPACE_EFFECT_EXTENSION,
      evidence: workspaceEffectEvidence,
      metadata: {
        workspaceId: normalizeWorkspaceId(input)
      }
    })
  ];
}

function licoMeshEnvelopeSigningHash(envelope) {
  return envelopeSigningHash({
    ...envelope,
    extensions: asArray(envelope?.extensions).filter(
      (extension) => extension?.name !== LICOMESH_SIGNATURE_EXTENSION
    )
  });
}

function finalizeLicoMeshEnvelopeExtensions(signer) {
  if (!signer) return null;
  return async (envelope) => {
    const signedEnvelopeHash = licoMeshEnvelopeSigningHash(envelope);
    const signature = await signer.sign(signedEnvelopeHash);
    return [{
      name: LICOMESH_SIGNATURE_EXTENSION,
      critical: false,
      value: {
        protocol: LICOMESH_ASPECT_PROTOCOL,
        signerId: signer.signerId || "licomesh-signer",
        algorithm: signer.algorithm || "hmac-sha256",
        signedEnvelopeHash,
        signature
      }
    }];
  };
}

function createLicoMeshAspect({
  pactium: core,
  storage,
  evidencePolicy = "production",
  signer = null,
  signerSecret = ""
} = {}) {
  if (!core || !storage) {
    throw new Error("LicoMesh proof aspect requires Pactium core and storage ports.");
  }
  const hasExplicitSignerSecret = text(signerSecret) !== "";
  const resolvedSigner = signer === false
    ? null
    : signer || (hasExplicitSignerSecret || evidencePolicy !== "production"
      ? createLicoMeshSigner({ secret: signerSecret || "licomesh-development-signer" })
      : null);
  const genericRepairPlanner = createRepairPlanner();

  function assertProductionReady() {
    if (evidencePolicy === "production" && !resolvedSigner) {
      throw new Error("LicoMesh production evidence policy requires an explicit signer or signerSecret.");
    }
  }

  async function recordWorkspaceOperation(input = {}) {
    const workspaceId = text(input.workspaceId || input.scope, "default");
    const policyEvidence = input.policyEvidence ?? input.policy;
    const effectEvidence = input.workspaceEffectEvidence ?? input.effectEvidence ?? input.workspaceEffect;
    if (evidencePolicy === "production" && !policyEvidence) {
      throw new Error("LicoMesh production evidence policy requires policy evidence.");
    }
    if (evidencePolicy === "production" && !effectEvidence) {
      throw new Error("LicoMesh production evidence policy requires workspace effect evidence.");
    }
    assertProductionReady();
    const compactInput = {
      ...input,
      workspaceId,
      policyEvidence: policyEvidence || { missing: true, policy: "opportunistic" },
      workspaceEffectEvidence: effectEvidence || { missing: true, policy: "opportunistic" }
    };
    const intentEvidenceExtensions = licoMeshEvidenceExtensions({ input: compactInput, phase: "intent" });
    const outcomeEvidenceExtensions = licoMeshEvidenceExtensions({ input: compactInput, phase: "outcome" });
    const batch = await core.recordOperations([{
      operationId: normalizeOperationId(input),
      workspaceId,
      idempotencyKey: normalizeIdempotencyKey(input),
      outcomeIdempotencyKey: text(input.outcomeIdempotencyKey),
      status: outcomeStatus(input),
      input: {
        inputDigest: protocolHash("licomesh.operation-input", cleanValue(input.input ?? input.payload ?? {}))
      },
      subject: {
        subjectDigest: protocolHash("licomesh.subject", cleanValue(asObject(input.subject)))
      },
      result: {
        resultDigest: protocolHash("licomesh.operation-result", cleanValue(input.result ?? input.output ?? {}))
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
      finalizeEnvelopeExtensions: finalizeLicoMeshEnvelopeExtensions(resolvedSigner),
      stateMutations: input.stateMutations || input.state?.mutations || []
    }]);
    return batch.envelopes[0];
  }

  async function verifyLicoMeshEnvelope(envelope, options = {}) {
    const bundleResolver = createPortableBundleBlockResolver(options.bundle, options);
    const decodedMaterial = new Map();
    async function resolveDecodedMaterial(cid) {
      const key = text(cid);
      if (!key) return { block: null, value: null };
      if (decodedMaterial.has(key)) return decodedMaterial.get(key);
      const block = await resolveMaterialBlock({ core, cid: key, bundleResolver });
      let value = null;
      try {
        value = block
          ? canonicalDecode(block.bytes || Buffer.from(String(block.payloadBase64 || ""), "base64"))
          : null;
      } catch {
        value = null;
      }
      const result = { block, value };
      decodedMaterial.set(key, result);
      return result;
    }

    const effectiveTrustPolicy = evidencePolicy === "production"
      ? PACTIUM_TRUST_POLICIES.trustedManifestRequired
      : options.trustPolicy || PACTIUM_TRUST_POLICIES.selfCarriedManifest;
    const coreResult = options.coreEnvelopeResult || await verifyProofEnvelope(envelope, {
      storage: { getBlock: (cid) => core.resolveBlock(cid) },
      bundle: options.bundle || null,
      supportedCriticalExtensions: LICOMESH_SUPPORTED_CRITICAL_EXTENSIONS,
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
    });
    const failures = [...asArray(coreResult.failures)];
    const extensions = asArray(envelope?.extensions);
    const extensionIndex = indexExtensionsByName(extensions);
    const criticalNames = new Set(asArray(envelope?.criticalExtensions).map(String));

    const requiredCriticalExtensions = envelope?.envelopeKind === "operation-intent"
      ? [LICOMESH_POLICY_EXTENSION]
      : LICOMESH_CRITICAL_EXTENSIONS;
    for (const required of requiredCriticalExtensions) {
      const extension = extensionIndex.get(required)?.[0] || null;
      if (!extension) {
        failures.push(createVerificationFailure({
          layer: "licomesh",
          code: `missing_${required.replace(/\W+/gu, "_")}`,
          message: `LicoMesh Proof Envelope is missing required critical extension ${required}.`,
          evidenceRef: envelope?.envelopeId || "",
          repairable: evidencePolicy !== "production"
        }));
      } else if (extension.critical !== true || !criticalNames.has(required)) {
        failures.push(createVerificationFailure({
          layer: "licomesh",
          code: "noncritical_required_extension",
          message: `LicoMesh required extension ${required} must be critical and listed in criticalExtensions.`,
          evidenceRef: envelope?.envelopeId || "",
          repairable: true
        }));
      }
    }

    for (const name of [LICOMESH_POLICY_EXTENSION, LICOMESH_WORKSPACE_EFFECT_EXTENSION]) {
      for (const extension of asArray(extensionIndex.get(name))) {
        const { value } = await resolveDecodedMaterial(extension.valueRef);
        const evidence = asObject(value?.evidence, null);
        const evidenceHash = text(value?.evidenceHash || extension.metadata?.evidenceHash);
        const expectedEvidenceHash = evidence
          ? protocolHash("licomesh.critical-evidence", cleanValue(evidence))
          : "";
        if (value?.protocol !== LICOMESH_ASPECT_PROTOCOL || value?.evidenceVersion !== "v2" ||
            value?.evidenceType !== name || !evidence || !evidenceHash) {
          failures.push(createVerificationFailure({
            layer: "licomesh.evidence",
            code: "malformed_evidence",
            evidenceRef: extension.valueRef,
            repairable: true
          }));
        } else if (evidenceHash !== expectedEvidenceHash) {
          failures.push(createVerificationFailure({
            layer: "licomesh.evidence",
            code: "bad_evidence_hash",
            evidenceRef: extension.valueRef
          }));
        }
      }
    }

    const signatureExtension = extensionIndex.get(LICOMESH_SIGNATURE_EXTENSION)?.[0] || null;
    if (evidencePolicy === "production" && !resolvedSigner) {
      failures.push(createVerificationFailure({
        layer: "licomesh.signing",
        code: "missing_signature_verifier",
        message: "LicoMesh production verification requires an explicit signer or signerSecret.",
        evidenceRef: envelope?.envelopeId || "",
        repairable: true
      }));
    }
    if (!signatureExtension) {
      failures.push(createVerificationFailure({
        layer: "licomesh.signing",
        code: "missing_signature",
        message: "LicoMesh signing is enabled by default and no signature extension was found.",
        evidenceRef: envelope?.envelopeId || "",
        repairable: evidencePolicy !== "production"
      }));
    } else {
      const { value } = await resolveDecodedMaterial(signatureExtension.valueRef);
      if (!value) {
        failures.push(createVerificationFailure({
          layer: "licomesh.signing",
          code: "missing_signature_material",
          evidenceRef: signatureExtension.valueRef,
          repairable: true
        }));
      } else if (value.signedEnvelopeHash !== licoMeshEnvelopeSigningHash(envelope)) {
        failures.push(createVerificationFailure({
          layer: "licomesh.signing",
          code: "bad_signed_envelope_hash",
          evidenceRef: signatureExtension.valueRef
        }));
      } else if (resolvedSigner && value.signerId !== (resolvedSigner.signerId || "licomesh-signer")) {
        failures.push(createVerificationFailure({
          layer: "licomesh.signing",
          code: "bad_signature_signer",
          evidenceRef: signatureExtension.valueRef
        }));
      } else if (resolvedSigner && value.algorithm !== (resolvedSigner.algorithm || "hmac-sha256")) {
        failures.push(createVerificationFailure({
          layer: "licomesh.signing",
          code: "bad_signature_algorithm",
          evidenceRef: signatureExtension.valueRef
        }));
      } else if (!resolvedSigner) {
        failures.push(createVerificationFailure({
          layer: "licomesh.signing",
          code: "signature_verifier_unconfigured",
          message: "LicoMesh signature material cannot be verified without an explicit signer or signerSecret.",
          evidenceRef: signatureExtension.valueRef,
          repairable: true
        }));
      } else if (!(await resolvedSigner.verify(value.signedEnvelopeHash, value.signature))) {
        failures.push(createVerificationFailure({
          layer: "licomesh.signing",
          code: "bad_signature",
          evidenceRef: signatureExtension.valueRef
        }));
      }
    }

    if (evidencePolicy === "production" && !options.trustedManifest) {
      failures.push(createVerificationFailure({
        layer: "licomesh.trust",
        code: "untrusted_verification",
        message: "LicoMesh production verification requires a caller-supplied trusted manifest.",
        evidenceRef: envelope?.envelopeId || "",
        repairable: true
      }));
    }

    return {
      protocol: PACTIUM_PROTOCOL,
      aspect: LICOMESH_ASPECT_PROTOCOL,
      envelopeId: envelope?.envelopeId || "",
      ok: failures.filter((failure) => failure.severity !== "warning").length === 0,
      proofStructurallyValid: coreResult.proofStructurallyValid,
      ledgerHeadSignatureValid: coreResult.ledgerHeadSignatureValid,
      ledgerHeadTrusted: coreResult.ledgerHeadTrusted,
      trustedSignatureValid: coreResult.trustedSignatureValid,
      trustPolicy: coreResult.trustPolicy,
      failures,
      checked: [
        ...asArray(coreResult.checked),
        "licomesh-critical-policy-extension",
        ...(requiredCriticalExtensions.includes(LICOMESH_WORKSPACE_EFFECT_EXTENSION)
          ? ["licomesh-critical-workspace-effect-extension"]
          : []),
        "licomesh-signature",
        "licomesh-workspace-projection"
      ]
    };
  }

  async function verifyLicoMeshBundle(bundle, options = {}) {
    const supportedCriticalExtensions = [
      ...new Set([
        ...LICOMESH_SUPPORTED_CRITICAL_EXTENSIONS,
        ...asArray(options.supportedCriticalExtensions)
      ])
    ];
    const trustPolicy = evidencePolicy === "production"
      ? PACTIUM_TRUST_POLICIES.trustedManifestRequired
      : options.trustPolicy || PACTIUM_TRUST_POLICIES.selfCarriedManifest;
    const bundleResult = await verifyProofBundle(bundle, {
      ...options,
      trustPolicy,
      supportedCriticalExtensions
    });
    const envelopeResult = await verifyLicoMeshEnvelope(bundle?.envelope || {}, {
      ...options,
      trustPolicy,
      bundle,
      coreEnvelopeResult: bundleResult.envelope
    });
    return {
      protocol: PACTIUM_PROTOCOL,
      aspect: LICOMESH_ASPECT_PROTOCOL,
      ok: bundleResult.ok && envelopeResult.ok,
      failures: [...asArray(bundleResult.failures), ...asArray(envelopeResult.failures)],
      bundle: bundleResult,
      envelope: envelopeResult
    };
  }

  function planRepair(failures = []) {
    const plan = genericRepairPlanner.plan(failures);
    return {
      ...plan,
      tasks: asArray(plan.tasks).map((task, index) => {
        const failure = asArray(failures)[index] || {};
        return String(failure.layer || "").startsWith("licomesh") ||
          String(failure.code || "").startsWith("missing_licomesh_")
          ? { ...task, action: "request-host-evidence" }
          : task;
      })
    };
  }

  return Object.freeze({
    protocol: LICOMESH_ASPECT_PROTOCOL,
    core,
    evidencePolicy,
    workspaceProjectionDefault: true,
    criticalExtensions: LICOMESH_CRITICAL_EXTENSIONS,
    supportedCriticalExtensions: LICOMESH_SUPPORTED_CRITICAL_EXTENSIONS,
    signer: resolvedSigner,
    assertProductionReady,
    recordWorkspaceOperation,
    recordOperation: recordWorkspaceOperation,
    verifyLicoMeshEnvelope,
    verifyEnvelope: verifyLicoMeshEnvelope,
    verifyLicoMeshBundle,
    verifyBundle: verifyLicoMeshBundle,
    planRepair,
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
} = {}) {
  const resolvedDataDir = resolveLicoPactiumDataDir(userDataPath || dataDir);
  const resolvedMode = resolveMode({ mode, runtimeOptions });
  const resolvedEvidencePolicy = resolveEvidencePolicy({ evidencePolicy, runtimeOptions });
  const resolvedSignerSecret = resolveSignerSecret({ signerSecret, runtimeOptions });
  const ownsPactiumRuntime = !pactiumRuntime;
  const runtime = normalizeLicoPactiumRuntime({
    userDataPath: resolvedDataDir,
    dataDir: resolvedDataDir,
    pactiumRuntime
  });
  const core = runtime.core;
  const storage = runtime.storage;
  const aspect = createLicoMeshAspect({
    pactium: core,
    storage,
    evidencePolicy: resolvedEvidencePolicy,
    signer,
    signerSecret: resolvedSignerSecret
  });
  const productionVerifiable = Boolean(resolvedEvidencePolicy === "production" && signerConfigured({
    signer,
    signerSecret: resolvedSignerSecret,
    evidencePolicy: resolvedEvidencePolicy
  }));
  const defaultVerificationTrustPolicy = resolvedEvidencePolicy === "production"
    ? PACTIUM_TRUST_POLICIES.trustedManifestRequired
    : PACTIUM_TRUST_POLICIES.selfCarriedManifest;

  async function beginLifecycle(input = {}) {
    aspect.assertProductionReady();
    const operationId = normalizeOperationId(input);
    const workspaceId = normalizeWorkspaceId(input);
    const idempotencyKey = normalizeIdempotencyKey(input);
    const evidenceExtensions = licoMeshEvidenceExtensions({
      input: {
        ...input,
        operationId,
        workspaceId,
        idempotencyKey
      },
      phase: "intent"
    });
    const envelope = await core.beginOperationIntent({
      operationId,
      workspaceId,
      idempotencyKey,
      input: {
        inputDigest: protocolHash("licomesh.operation-input", cleanValue(input.input ?? input.payload ?? {}))
      },
      subject: {
        subjectDigest: protocolHash("licomesh.subject", cleanValue(asObject(input.subject)))
      },
      causalityRefs: asArray(input.causalityRefs),
      appendCondition: input.appendCondition,
      proofOptions: input.proofOptions,
      extensions: [
        ...evidenceExtensions,
        ...asArray(input.extensions)
      ],
      finalizeEnvelopeExtensions: finalizeLicoMeshEnvelopeExtensions(aspect.signer)
    });
    if (envelope.replayed) {
      const existing = await loadProjectedEntry(core, envelope.factRef?.ledgerEventId);
      if (existing) return { ...existing, replayed: true };
    }
    const entry = normalizeEntry({
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

  async function finishLifecycle(input = {}) {
    aspect.assertProductionReady();
    const ledgerEventId = text(input.ledgerEventId || input.entry?.ledgerEventId);
    const entry = input.entry?.ledgerEventId ? input.entry : await loadProjectedEntry(core, ledgerEventId);
    if (!entry) {
      throw new Error("operation proof entry missing");
    }
    if (!entry.pactium?.intentId) {
      throw new Error("operation proof intent missing");
    }
    const status = outcomeStatus(input);
    const evidenceExtensions = licoMeshEvidenceExtensions({
      input: {
        ...input,
        status
      },
      entry,
      phase: "outcome"
    });
    const envelope = await core.appendOperationOutcome({
      intentId: entry.pactium.intentId,
      status,
      outcomeIdempotencyKey: input.outcomeIdempotencyKey || input.idempotencyKey || `${entry.idempotencyKey}:outcome`,
      result: cleanValue({
        resultDigest: protocolHash("licomesh.operation-result", cleanValue(input.result ?? input.output ?? {})),
        assetRefDigest: protocolHash("licomesh.asset-ref", text(input.assetRef, entry.assetRef || "")),
        receiptSetDigest: protocolHash("licomesh.receipt-set", asArray(input.receiptRefs).map(String)),
        auditDigest: protocolHash("licomesh.audit-ref", text(input.auditId)),
        errorDigest: input.error ? protocolHash("licomesh.operation-error", text(input.error)) : "",
        outcomeKind: text(input.outcomeKind, status)
      }),
      hostEvidenceRefs: asArray(input.receiptRefs),
      causalityRefs: asArray(input.causalityRefs),
      appendCondition: input.appendCondition,
      proofOptions: input.proofOptions,
      stateMutations: asArray(input.stateMutations || input.state?.mutations),
      extensions: [
        ...evidenceExtensions,
        ...asArray(input.extensions)
      ],
      finalizeEnvelopeExtensions: finalizeLicoMeshEnvelopeExtensions(aspect.signer)
    });
    return mergeCompletion(entry, { ...input, status }, envelope, input.failed === true || status === "failed");
  }

  async function recordReceipt(input = {}) {
    aspect.assertProductionReady();
    const operationId = normalizeOperationId(input);
    const workspaceId = normalizeWorkspaceId(input);
    const profile = text(input.profile, "receipt");
    const status = outcomeStatus(input);
    const evidenceExtensions = licoMeshEvidenceExtensions({
      input: { ...input, operationId, workspaceId, status },
      phase: "receipt"
    });
    const receiptResult = receiptResultFor(input, status);
    const envelope = await core.recordOperationReceipt({
      operationId,
      workspaceId,
      profile,
      changeKey: text(input.changeKey || input.changeProjection, operationId),
      changeDigest: text(input.changeDigest),
      idempotencyKey: normalizeIdempotencyKey(input),
      status,
      subject: {
        subjectDigest: protocolHash("licomesh.subject", cleanValue(asObject(input.subject)))
      },
      result: receiptResult,
      extensions: [...evidenceExtensions, ...asArray(input.extensions)],
      finalizeEnvelopeExtensions: finalizeLicoMeshEnvelopeExtensions(aspect.signer)
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
    const entry = normalizeReceiptEntry({
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

  async function exportProofBundleForEntry(input = {}) {
    const actor = input.actor || { type: "system" };
    if (!canExportProofBundle({ actor })) {
      throw new Error("Proof Bundle Export requires proof:export, runtime:admin, console:admin, or system actor.");
    }
    const entry = input.entry || await loadProjectedEntry(core, input.ledgerEventId);
    if (!entry) {
      throw new Error("operation proof entry missing");
    }
    const envelopeId = text(input.envelopeId) || envelopeIdForEntry(entry, input.kind || "outcome");
    if (!envelopeId) {
      throw new Error("operation proof envelope missing");
    }
    return core.exportProofBundle(envelopeId, input.options || {});
  }

  async function verifyReceipt(input = {}) {
    const bundle = input.bundle || await exportProofBundleForEntry({
      ...input,
      actor: input.actor || { type: "system" }
    });
    const result = await aspect.verifyBundle(bundle, {
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
    aspectProtocolVersion: LICOMESH_ASPECT_PROTOCOL,
    dataDir: resolvedDataDir,
    mode: resolvedMode,
    evidencePolicy: resolvedEvidencePolicy,
    productionVerifiable,
    pactiumRuntime: runtime,
    aspect,
    beginLifecycle,
    finishLifecycle,
    recordReceipt,
    denyLifecycle(input = {}) {
      return finishLifecycle({ ...input, status: "denied", denied: true });
    },
    recordWorkspaceOperation(input = {}) {
      return aspect.recordWorkspaceOperation({
        ...input,
        workspaceId: normalizeWorkspaceId(input),
        policyEvidence: input.policyEvidence || buildPolicyEvidence(input),
        workspaceEffectEvidence: input.workspaceEffectEvidence || buildWorkspaceEffectEvidence(input)
      });
    },
    async recordAcceptanceEvidence({ reportDigests = [], evidenceContext = {}, releaseId = "", actor = { type: "system" } } = {}) {
      if (!releaseId) {
        throw new Error("releaseId is required for acceptance evidence anchoring");
      }
      if (!Array.isArray(reportDigests) || reportDigests.length === 0) {
        throw new Error("reportDigests must be a non-empty array");
      }
      const workspaceId = `release:${String(releaseId)}`;
      const operationId = `acceptance.anchor.${String(releaseId)}`;
      const commitment = cleanValue({
        kind: "acceptance-evidence",
        releaseId: String(releaseId),
        reportDigests: reportDigests.map((digest) => ({
          path: String(digest.path || ""),
          schemaVersion: String(digest.schemaVersion || ""),
          contentHash: String(digest.contentHash || "")
        })).sort((left, right) => left.path.localeCompare(right.path)),
        evidenceContext: cleanValue(asObject(evidenceContext))
      });
      const entry = await recordReceipt({
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
    async recordPlanReceiptEvidence({ plan = "", receiptDigest = "", context = {}, actor = { type: "system" } } = {}) {
      const normalizedPlan = text(plan);
      const normalizedDigest = text(receiptDigest);
      if (!normalizedPlan || !/^([a-f0-9]{64})$/u.test(normalizedDigest)) {
        throw new Error("plan and sha256 receiptDigest are required for Plan receipt anchoring");
      }
      const workspaceId = `plan-receipt:${normalizedPlan}`;
      const operationId = `plan.receipt.anchor.${normalizedDigest}`;
      const commitment = cleanValue({
        kind: "plan-final-receipt",
        plan: normalizedPlan,
        receiptDigest: normalizedDigest,
        context: cleanValue(asObject(context))
      });
      const entry = await recordReceipt({
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
    async verifyReceiptCommitment({ ledgerEventId = "", commitment = {} } = {}) {
      const entry = await loadProjectedEntry(core, ledgerEventId);
      if (!entry || !entry.resultDigest) {
        return { ok: false, reason: "receipt-commitment-unavailable" };
      }
      const expectedResultDigest = protocolHash(
        "operation.receipt.result",
        receiptResultFor({ commitment }, "succeeded")
      );
      const ok = entry.resultDigest === expectedResultDigest;
      return {
        ok,
        reason: ok ? "verified-receipt-commitment" : "receipt-commitment-mismatch",
        ledgerEventId: text(entry.ledgerEventId)
      };
    },
    verifyReceipt,
    async verifyEnvelope(envelope, options = {}) {
      return aspect.verifyEnvelope(envelope, {
        trustPolicy: defaultVerificationTrustPolicy,
        ...options
      });
    },
    async verifyBundle(bundle, options = {}) {
      return aspect.verifyBundle(bundle, {
        trustPolicy: defaultVerificationTrustPolicy,
        ...options
      });
    },
    exportProofBundle: exportProofBundleForEntry,
    getWorkspaceProjection(workspaceId = "default") {
      return core.getWorkspaceProjection(workspaceId);
    },
    proveWorkspaceMembership(input = {}) {
      return core.proveWorkspaceMembership(input);
    },
    planRecovery(input = {}) {
      return core.planRecovery(input);
    },
    async doctor() {
      const pactiumDoctor = await core.doctor();
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
    health() {
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
    listCapabilities() {
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
            id: "licomesh-aspect-record",
            kind: "pactium-licomesh-aspect",
            operations: ["recordWorkspaceOperation", "recordAcceptanceEvidence"]
          }
        ]
      };
    },
    getReceipt(ledgerEventId) {
      return loadProjectedEntry(core, ledgerEventId);
    },
    async listReceipts({ limit = 100 } = {}) {
      const normalizedLimit = Math.max(1, Math.min(Number(limit || 100), 10000));
      const head = await core.readLedgerHead();
      const entries = [];
      for (let index = Number(head?.size || 0) - 1; index >= 0 && entries.length < normalizedLimit; index -= 1) {
        const ledgerEntry = await core.readLedgerLeaf(index);
        if (!["operation.outcome", "operation.receipt"].includes(text(ledgerEntry?.fact?.factType))) continue;
        const projected = await projectLedgerEntry(core, ledgerEntry);
        if (projected) entries.push(projected);
      }
      return entries;
    },
    close() {
      return ownsPactiumRuntime
        ? (runtime.close?.() || Promise.resolve())
        : Promise.resolve();
    }
  });
}

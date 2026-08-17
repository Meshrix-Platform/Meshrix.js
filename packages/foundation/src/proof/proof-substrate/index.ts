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
  toCanonicalSafeValue,
  verifyProofBundle,
  verifyProofEnvelope
} from "pactium";
import type {
  PactiumCore,
  PactiumProofBundle,
  PactiumProofEnvelope,
  PactiumProofVerificationOptions,
  PactiumRecord,
  PactiumStoragePort,
  PactiumVerificationFailure,
  PactiumVerificationResult
} from "pactium";
import { serverToken } from "#meshrix/client-strings";
import {
  normalizeMeshrixPactiumRuntime,
  resolveMeshrixPactiumDataDir
} from "../../checkpoint/tree/pactium-runtime.ts";
import type { MeshrixPactiumRuntime } from "../../checkpoint/tree/types.ts";

type ProofField = string | number | boolean | null | ProofField[] | ProofRecord;

interface ProofRecord {
  [key: string]: ProofField | undefined;
  operation?: ProofRecord;
  input?: ProofRecord;
  subject?: ProofRecord;
  risk?: ProofRecord;
  policy?: ProofField;
  policyDecision?: ProofField;
  policyEvidence?: ProofField;
  result?: ProofRecord;
  output?: ProofRecord;
  state?: ProofRecord;
  targetRef?: ProofRecord;
  proof?: ProofRecord;
  pactium?: ProofRecord;
  entry?: ProofRecord;
  user?: ProofRecord;
  metadata?: ProofRecord;
  evidence?: ProofRecord;
  factRef?: ProofRecord;
  fact?: ProofRecord;
  outcome?: ProofRecord;
  extensions?: ProofRecord[];
  criticalExtensions?: string[];
  warnings?: ProofField[];
  receiptRefs?: ProofField[];
  hostEvidenceRefs?: ProofField[];
  causalityRefs?: ProofField[];
  stateMutations?: ProofRecord[];
  mutations?: ProofRecord[];
  scopes?: string[];
  index?: ProofRecord[];
}

interface MeshrixSigner {
  readonly signerId: string;
  readonly algorithm: string;
  sign(message?: string): Promise<string>;
  verify(message?: string, signature?: string): Promise<boolean>;
  verifyFor?(input: { signerId?: string; algorithm?: string; message?: string; signature?: string }): Promise<boolean>;
  close(): void;
}

interface ProofExtension extends ProofRecord {
  name: string;
  critical?: boolean;
  valueRef?: string;
  metadata?: ProofRecord;
}

interface PortableBlock {
  protocol?: ProofField;
  cid: string;
  codec?: ProofField;
  kind?: ProofField;
  refs: ProofField[];
  byteLength: number;
  payloadHash: string;
  bytes: Buffer;
  payloadBase64: string;
}

interface PortableBundleResolver {
  get(cid?: string): PortableBlock | null;
}

interface MaterialBlock {
  bytes?: Uint8Array;
  payloadBase64?: string;
}

interface MeshrixVerificationOptions {
  bundle?: PactiumProofBundle;
  coreEnvelopeResult?: PactiumVerificationResult;
  supportedCriticalExtensions?: string[];
  proofVerifiers?: PactiumRecord;
  requireAllProofs?: boolean;
  verifierManifest?: PactiumRecord;
  trustedManifest?: PactiumRecord;
  ledgerHeadSignatures?: PactiumRecord[];
  trustPolicy?: string;
  requireFullStateMutationProofs?: boolean;
  maxProofLeafEntries?: number;
  maxProofBytes?: number;
  failOnProofSizeWarning?: boolean;
  maxHeaderSize?: number;
  maxBlockSize?: number;
  evidencePolicy?: string;
}

interface MeshrixAspectOptions {
  pactium: PactiumCore;
  storage: PactiumStoragePort;
  evidencePolicy?: string;
  signer?: MeshrixSigner | false | null;
  signerSecret?: string;
}

interface ProofRuntime {
  core: PactiumCore;
  storage: PactiumStoragePort;
  close(): Promise<void>;
}

function requireProofRuntime(value: unknown): ProofRuntime {
  if (!isUnknownRecord(value)) {
    throw new Error("Pactium runtime is unavailable.");
  }
  const core = value.core;
  const storage = value.storage;
  const close = value.close;
  if (
    !isUnknownRecord(core) || typeof core.beginOperationIntent !== "function" ||
    !isUnknownRecord(storage) || typeof storage.close !== "function" ||
    typeof close !== "function"
  ) {
    throw new Error("Pactium runtime does not expose the required proof and storage ports.");
  }
  return value as unknown as ProofRuntime;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface RepairPlanner {
  plan(failures: PactiumVerificationFailure[]): PactiumRecord;
}

function requireRepairPlanner(value: PactiumRecord): RepairPlanner {
  if (typeof value.plan !== "function") {
    throw new Error("Pactium repair planner does not expose plan().");
  }
  return value as PactiumRecord & RepairPlanner;
}

function asProofExtensions(value: unknown): ProofExtension[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ProofExtension =>
    isProofRecord(item) && typeof item.name === "string"
  );
}

interface ProofEnvelopeView {
  factId?: string;
  envelopeId?: string;
  receiptId?: string;
  factRef?: PactiumRecord;
  ledgerHead?: unknown;
  replayed?: boolean;
  disposition?: string;
  envelopeKind?: string;
  extensions?: unknown[];
  criticalExtensions?: string[];
}

interface OperationProofEntry extends ProofRecord {
  ledgerEventId: string;
  operationId: string;
  workspaceId: string;
  status: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  failedAt: string;
  error: string;
  assetRef?: string;
  auditId?: string;
  resultDigest?: string;
  receiptRefs?: ProofField[];
  warnings?: ProofField[];
  proof: ProofRecord;
  pactium: ProofRecord;
}

function isOperationProofEntry(value: unknown): value is OperationProofEntry {
  return isProofRecord(value) &&
    typeof value.ledgerEventId === "string" &&
    typeof value.operationId === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.status === "string" &&
    typeof value.idempotencyKey === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.completedAt === "string" &&
    typeof value.failedAt === "string" &&
    typeof value.error === "string" &&
    isProofRecord(value.proof) && isProofRecord(value.pactium);
}

function requireProofBundle(value: unknown): PactiumProofBundle {
  if (
    !isUnknownRecord(value) || value.bundleType !== "pactium.proof-bundle.indexed" ||
    typeof value.protocol !== "string" || typeof value.schema !== "string" ||
    typeof value.bundleHash !== "string" || !isUnknownRecord(value.envelope)
  ) {
    throw new Error("Pactium Proof Bundle is malformed.");
  }
  return value as unknown as PactiumProofBundle;
}

function isProofRecord(value: unknown): value is ProofRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const OPERATION_PROOF_SUBSTRATE_PROTOCOL_VERSION = "v0.0.1:operation:proof-substrate-2";
export const OPERATION_PROOF_SUBSTRATE_PROTOCOL = PACTIUM_PROTOCOL;
export const OPERATION_PROOF_SUBSTRATE_PROVIDER = "pactium.operation-proof-substrate";
export const OPERATION_PROOF_SIGNER_SECRET_FILE_ENV =
  "MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE";
export const OPERATION_PROOF_SUBSTRATE_MODES = Object.freeze({
  PACTIUM: "pactium"
} as const);

const DEFAULT_EVIDENCE_POLICY = "development";
const SIGNER_SECRET_PATTERN = /^[0-9a-f]{64}$/u;
const MESHRIX_ASPECT_PROTOCOL = "pactium.v0.3.meshrix-aspect";
const MESHRIX_POLICY_EXTENSION = "meshrix.policy";
const MESHRIX_WORKSPACE_EFFECT_EXTENSION = "meshrix.workspaceEffect";
const MESHRIX_SIGNATURE_EXTENSION = "meshrix.signature";
const MESHRIX_CRITICAL_EXTENSIONS: readonly string[] = Object.freeze([
  MESHRIX_POLICY_EXTENSION,
  MESHRIX_WORKSPACE_EFFECT_EXTENSION
]);
const MESHRIX_SUPPORTED_CRITICAL_EXTENSIONS: readonly string[] = Object.freeze([
  ...MESHRIX_CRITICAL_EXTENSIONS,
  MESHRIX_SIGNATURE_EXTENSION
]);

function nowIso(): string {
  return new Date().toISOString();
}

function text(value: unknown, fallback = ""): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function asObject(value: unknown): ProofRecord;
function asObject(value: unknown, fallback: ProofRecord): ProofRecord;
function asObject(value: unknown, fallback: null): ProofRecord | null;
function asObject(value: unknown, fallback: ProofRecord | null = {}): ProofRecord | null {
  return isProofRecord(value) ? value : fallback;
}

function asArray(value: unknown): ProofField[] {
  return Array.isArray(value) ? value.filter(isProofField) : [];
}

function isProofField(value: unknown): value is ProofField {
  return value === null || ["string", "number", "boolean"].includes(typeof value) ||
    (Array.isArray(value) && value.every(isProofField)) ||
    (isProofRecord(value) && Object.values(value).every((item) => item === undefined || isProofField(item)));
}

function hmac(secret: string | Buffer, value: unknown): string {
  return createHmac("sha256", secret)
    .update(String(value || ""))
    .digest("hex");
}

function publicKeyFromPrivateKey(privateKey: string): string | Buffer {
  if (!privateKey) return "";
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" });
}

interface MeshrixSignerOptions {
  signerId?: string;
  secret?: string | Buffer;
  algorithm?: string;
  privateKey?: string;
  publicKey?: string;
}

export function createMeshrixSigner({
  signerId = "meshrix-local",
  secret = "meshrix-development-signer",
  algorithm = "",
  privateKey = "",
  publicKey = ""
}: MeshrixSignerOptions = {}): MeshrixSigner {
  const resolvedAlgorithm = text(algorithm, privateKey || publicKey ? "ed25519" : "hmac-sha256");
  if (resolvedAlgorithm === "ed25519") {
    const verifierPublicKey = publicKey || publicKeyFromPrivateKey(privateKey);
    return Object.freeze({
      protocol: MESHRIX_ASPECT_PROTOCOL,
      signerId,
      algorithm: "ed25519",
      publicKey: verifierPublicKey,
      async sign(message = "") {
        if (!privateKey) {
          throw new Error("Ed25519 Meshrix.js signer requires a privateKey for signing.");
        }
        return `ed25519:${signWithKey(
          null,
          Buffer.from(String(message || "")),
          privateKey
        ).toString("base64")}`;
      },
      async verify(message = "", signature = "") {
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
      close()  {
        // Key ownership remains with the injected asymmetric signer config.
      }
    });
  }
  if (resolvedAlgorithm !== "hmac-sha256") {
    throw new Error(`Unsupported Meshrix.js signer algorithm: ${resolvedAlgorithm}`);
  }
  const retainedSecret = Buffer.isBuffer(secret)
    ? Buffer.from(secret)
    : Buffer.from(String(secret || ""), "utf8");
  let closed = false;
  const assertOpen = ()  => {
    if (closed) throw new Error("Meshrix.js signer is closed.");
  };
  return Object.freeze({
    protocol: MESHRIX_ASPECT_PROTOCOL,
    signerId,
    algorithm: "hmac-sha256",
    async sign(message = "") {
      assertOpen();
      return `hmac-sha256:${hmac(retainedSecret, message)}`;
    },
    async verify(message = "", signature = "") {
      assertOpen();
      const expected = Buffer.from(`hmac-sha256:${hmac(retainedSecret, message)}`);
      const actual = Buffer.from(String(signature || ""));
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
    close()  {
      if (closed) return;
      closed = true;
      retainedSecret.fill(0);
    }
  });
}

interface MeshrixSignerKeyRingOptions {
  active?: MeshrixSigner;
  verification?: MeshrixSigner[];
}

export function createMeshrixSignerKeyRing({
  active,
  verification = []
}: MeshrixSignerKeyRingOptions = {}) {
  if (!active || typeof active.sign !== "function" || typeof active.verify !== "function") {
    throw proofConfigurationError(
      "operation_proof_signer_keyring_active_required",
      "Meshrix.js operation-proof signer key ring requires one active signer."
    );
  }
  const all: MeshrixSigner[] = [active, ...verification];
  const byIdentity = new Map<string, MeshrixSigner>();
  for (const signer of all) {
    const signerId = text(signer?.signerId);
    const algorithm = text(signer?.algorithm);
    const identity = `${signerId}\0${algorithm}`;
    if (
      !signerId ||
      !algorithm ||
      typeof signer?.verify !== "function" ||
      byIdentity.has(identity)
    ) {
      throw proofConfigurationError(
        "operation_proof_signer_keyring_invalid",
        "Meshrix.js operation-proof signer key ring contains an invalid or duplicate verifier."
      );
    }
    byIdentity.set(identity, signer);
  }
  let closed = false;
  const assertOpen = ()  => {
    if (closed) {
      throw proofConfigurationError(
        "operation_proof_signer_keyring_closed",
        "Meshrix.js operation-proof signer key ring is closed."
      );
    }
  };
  return Object.freeze({
    protocol: MESHRIX_ASPECT_PROTOCOL,
    signerId: active.signerId,
    algorithm: active.algorithm,
    verificationKeyCount: byIdentity.size,
    async sign(message = "") {
      assertOpen();
      return active.sign(message);
    },
    async verify(message = "", signature = "") {
      assertOpen();
      return active.verify(message, signature);
    },
    async verifyFor({ signerId = "", algorithm = "", message = "", signature = "" }: {
      signerId?: string; algorithm?: string; message?: string; signature?: string;
    } = {}) {
      assertOpen();
      const signer = byIdentity.get(`${text(signerId)}\0${text(algorithm)}`);
      return signer ? signer.verify(message, signature) : false;
    },
    close()  {
      if (closed) return;
      closed = true;
      for (const signer of new Set(all)) signer.close();
      byIdentity.clear();
    }
  });
}

function cleanValue(value: unknown): ProofField {
  const cleaned = toCanonicalSafeValue(value);
  return isProofField(cleaned) ? cleaned : null;
}

function cleanRecord(value: unknown): ProofRecord {
  return asObject(cleanValue(value));
}

function normalizeMode(value: unknown = ""): string {
  const mode = text(value).toLowerCase();
  if (!mode || mode === OPERATION_PROOF_SUBSTRATE_MODES.PACTIUM) {
    return OPERATION_PROOF_SUBSTRATE_MODES.PACTIUM;
  }
  throw new Error("Operation Proof Substrate only supports Pactium-backed mode.");
}

function env(name: string): string {
  return text(process.env[name]);
}

function proofConfigurationError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function pathIsWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function signerSecretFromExternalFile({ dataDir = "", signerSecretFile = "" }: {
  dataDir?: string; signerSecretFile?: string;
} = {}) {
  const configuredPath = text(signerSecretFile);
  if (!configuredPath || !path.isAbsolute(configuredPath)) {
    throw proofConfigurationError(
      "operation_proof_signer_secret_file_required",
      "Meshrix.js operation-proof signer secret file is not configured.",
    );
  }
  let stat;
  let keyRealPath = "";
  let dataRealPath = path.resolve(dataDir);
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
      "Meshrix.js operation-proof signer secret file is unavailable.",
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
      "Meshrix.js operation-proof signer secret custody is invalid.",
    );
  }
  let bytes;
  try {
    bytes = fs.readFileSync(keyRealPath);
    const encoded = bytes.toString("utf8").trim();
    if (
      !SIGNER_SECRET_PATTERN.test(encoded) ||
      !(
        bytes.length === 64 ||
        (bytes.length === 65 && bytes[64] === 0x0a)
      )
    ) {
      throw proofConfigurationError(
        "operation_proof_signer_secret_invalid",
        "Meshrix.js operation-proof signer secret is invalid.",
      );
    }
    return encoded;
  } catch (error: unknown) {
    if (isErrorWithCode(error) && error.code.startsWith("operation_proof_signer_")) {
      throw error;
    }
    throw proofConfigurationError(
      "operation_proof_signer_secret_file_unavailable",
      "Meshrix.js operation-proof signer secret file is unavailable.",
    );
  } finally {
    bytes?.fill(0);
  }
}

function isErrorWithCode(value: unknown): value is Error & { code: string } {
  return value instanceof Error && "code" in value && typeof value.code === "string";
}

function runtimeOperationProofOptions(runtimeOptions: ProofRecord = {}): ProofRecord {
  return asObject(runtimeOptions.operationProof || runtimeOptions.operationProofSubstrate || runtimeOptions.pactiumProof);
}

function resolveMode({ mode = "", runtimeOptions = {} }: {
  mode?: string; runtimeOptions?: ProofRecord;
} = {}): string {
  const options = runtimeOperationProofOptions(runtimeOptions);
  return normalizeMode(mode || options.mode || env("MESHRIX_OPERATION_PROOF_MODE"));
}

function resolveEvidencePolicy({ evidencePolicy = "", runtimeOptions = {} }: {
  evidencePolicy?: string; runtimeOptions?: ProofRecord;
} = {}): string {
  const options = runtimeOperationProofOptions(runtimeOptions);
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
}: { signerSecret?: string; runtimeOptions?: ProofRecord; dataDir?: string } = {}): string {
  const options = runtimeOperationProofOptions(runtimeOptions);
  const directSecret = text(
    signerSecret ||
    options.signerSecret
  );
  const signerSecretFile = text(
    options.signerSecretFile ||
    env(OPERATION_PROOF_SIGNER_SECRET_FILE_ENV)
  );
  if (directSecret && signerSecretFile) {
    throw proofConfigurationError(
      "operation_proof_signer_custody_ambiguous",
      "Meshrix.js operation-proof signer secret custody is ambiguous.",
    );
  }
  return directSecret || (
    signerSecretFile
      ? signerSecretFromExternalFile({ dataDir, signerSecretFile })
      : ""
  );
}

function signerConfigured({ signer = null, signerSecret = "", evidencePolicy = "" }: {
  signer?: MeshrixSigner | false | null; signerSecret?: string; evidencePolicy?: string;
} = {}): boolean {
  if (evidencePolicy !== "production") return true;
  if (signer === false) return false;
  return Boolean(signer) || text(signerSecret) !== "";
}

function normalizeWorkspaceId(input: ProofRecord = {})  {
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

function normalizeOperationId(input: ProofRecord = {})  {
  return text(input.operationId || input.operation?.id || input.id, "operation.unknown");
}

function normalizeIdempotencyKey(input: ProofRecord = {})  {
  return text(
    input.idempotencyKey ||
    input["idempotency-key"] ||
    input.requestId ||
    input.traceId ||
    randomUUID()
  );
}

function entryIdFromEnvelope(input: ProofRecord = {}, envelope?: ProofEnvelopeView): string {
  return text(envelope?.factRef?.ledgerEventId) || serverToken(
    "operation_proof",
    normalizeWorkspaceId(input),
    normalizeOperationId(input),
    normalizeIdempotencyKey(input),
    nowIso(),
    randomUUID()
  );
}

function normalizeEntry(input: ProofRecord = {}, envelope?: ProofEnvelopeView): OperationProofEntry {
  const at = text(input.createdAt, nowIso());
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
    subjectDigest: text(storedSubject.subjectDigest) || protocolHash("meshrix.subject", cleanValue(storedSubject)),
    riskDigest: text(storedRisk.riskDigest) || protocolHash("meshrix.risk", cleanValue(storedRisk)),
    idempotencyKey: normalizeIdempotencyKey(input),
    inputDigest: text(storedInput.inputDigest) || protocolHash("meshrix.operation-input", cleanValue(storedInput)),
    policyDigest: text(storedPolicy.policyDigest) || protocolHash(
      "meshrix.policy-evidence",
      cleanValue(storedPolicy)
    ),
    warnings: asArray(input.warnings).map((warning?)  => cleanValue(warning)),
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
      ledgerHead: cleanValue(envelope?.ledgerHead)
    }
  };
}

function normalizeReceiptEntry(input: ProofRecord = {}, envelope?: ProofEnvelopeView): OperationProofEntry {
  const at = text(input.createdAt, nowIso());
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
    outcomeKind: text(input.outcomeKind, text(input.status, "succeeded")),
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
      ledgerHead: cleanValue(envelope?.ledgerHead)
    }
  };
}

function mergeCompletion(
  entry: OperationProofEntry,
  patch: ProofRecord = {},
  envelope?: ProofEnvelopeView,
  failed = false
): OperationProofEntry {
  const at = text(
    patch.completedAt || patch.createdAt,
    nowIso()
  );
  const status = text(patch.status, failed ? "failed" : "succeeded");
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
      ...asArray(patch.warnings).map((warning?)  => cleanValue(warning))
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
      ledgerHead: cleanValue(envelope?.ledgerHead || entry.pactium?.ledgerHead)
    }
  };
}

function locatorEnvelope(factId: unknown, locator: ProofRecord = {}): ProofEnvelopeView {
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

function outcomeEvidenceProjection(outcome: ProofRecord = {})  {
  const source = asObject(outcome);
  const hostEvidenceRefs = asArray(source.hostEvidenceRefs)
    .map((value) => text(value))
    .filter(Boolean);
  const auditRef = hostEvidenceRefs.find((value) =>
    value.startsWith("audit:")
  ) || "";
  return {
    auditId: auditRef.slice("audit:".length),
    receiptRefs: hostEvidenceRefs.filter((value) =>
      !value.startsWith("audit:")
    )
  };
}

async function readLedgerEntryByEventId(core: PactiumCore, ledgerEventId: unknown): Promise<PactiumRecord | null> {
  const eventId = text(ledgerEventId);
  if (!eventId) return null;
  const pointer = asObject(await core.readProtocolObject("ledger-event", eventId, null), null);
  if (!pointer || !Number.isInteger(Number(pointer.index))) return null;
  return core.readLedgerLeaf(Number(pointer.index));
}

async function projectLedgerEntry(core: PactiumCore, ledgerEntry: PactiumRecord | null): Promise<OperationProofEntry | null> {
  const fact = asObject(ledgerEntry?.fact, null);
  if (!fact) return null;
  if (fact.factType === "operation.receipt") {
    const locator = await core.lookupReceipt(text(fact.receiptId));
    return normalizeReceiptEntry(fact, locatorEnvelope(fact.receiptId, asObject(locator)));
  }
  if (fact.factType === "operation.intent") {
    const intentLocator = await core.lookupOpenIntent(text(fact.intentId));
    const entry = normalizeEntry(fact, locatorEnvelope(fact.intentId, asObject(intentLocator)));
    const outcomeLocator = await core.lookupOutcome(text(fact.intentId));
    const outcome = asObject(outcomeLocator.outcome, null);
    const evidence = outcomeEvidenceProjection(outcome ?? {});
    return outcomeLocator.exists && outcome
      ? mergeCompletion(
          entry,
          {
            status: outcome.status,
            outcomeKind: outcome.status,
            completedAt: outcome.createdAt,
            auditId: evidence.auditId,
            receiptRefs: evidence.receiptRefs
          },
          locatorEnvelope(outcome.outcomeId, asObject(outcomeLocator)),
          outcome.status === "failed"
        )
      : entry;
  }
  if (fact.factType === "operation.outcome") {
    const intentLocator = await core.lookupOpenIntent(text(fact.intentId));
    const outcomeLocator = await core.lookupOutcome(text(fact.intentId));
    const intentLedgerEntry = await readLedgerEntryByEventId(
      core,
      intentLocator.ledgerEventId
    );
    const intentFact = asObject(intentLedgerEntry?.fact, null);
    if (
      intentFact &&
      intentFact.factType === "operation.intent"
    ) {
      const evidence = outcomeEvidenceProjection(fact);
      return mergeCompletion(
        normalizeEntry(
          intentFact,
          locatorEnvelope(intentFact.intentId, asObject(intentLocator))
        ),
        {
          status: fact.status,
          outcomeKind: fact.status,
          completedAt: fact.createdAt,
          auditId: evidence.auditId,
          receiptRefs: evidence.receiptRefs
        },
        locatorEnvelope(fact.outcomeId, asObject(outcomeLocator)),
        fact.status === "failed"
      );
    }
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
      failedAt: fact.status === "failed" ? at : "",
      error: "",
      idempotencyKey: text(fact.idempotencyKey),
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

async function loadProjectedEntry(core: PactiumCore, ledgerEventId: unknown): Promise<OperationProofEntry | null> {
  return projectLedgerEntry(core, await readLedgerEntryByEventId(core, ledgerEventId));
}

function outcomeStatus({ status = "", failed = false, denied = false }: ProofRecord = {})  {
  if (denied) return "denied";
  if (failed) return "failed";
  return text(status, "succeeded");
}

function buildPolicyEvidence(input: ProofRecord = {}): ProofRecord {
  return cleanRecord({
    operationId: normalizeOperationId(input),
    workspaceId: normalizeWorkspaceId(input),
    subject: asObject(input.subject),
    policyDecision: asObject(input.policyDecision || input.policyEvidence),
    risk: asObject(input.risk),
    traceId: input.traceId || "",
    requestId: input.requestId || ""
  });
}

function buildWorkspaceEffectEvidence(input: ProofRecord = {}): ProofRecord {
  return cleanRecord({
    operationId: normalizeOperationId(input),
    workspaceId: normalizeWorkspaceId(input),
    result: asObject(input.result || input.output),
    assetRef: input.assetRef || "",
    receiptRefs: asArray(input.receiptRefs),
    auditId: input.auditId || "",
    status: input.status || ""
  });
}

function envelopeIdForEntry(entry: ProofRecord = {}, kind = "outcome")  {
  if (kind === "intent") {
    return text(entry.pactium?.intentEnvelopeId);
  }
  return text(
    entry.pactium?.receiptEnvelopeId ||
    entry.pactium?.outcomeEnvelopeId ||
    entry.pactium?.intentEnvelopeId
  );
}

function receiptResultFor(input: ProofRecord = {}, status = "succeeded")  {
  return cleanValue({
    outcomeKind: text(input.outcomeKind, status),
    statusCode: Number(input.statusCode || 0),
    auditId: text(input.auditId),
    receiptRefs: asArray(input.receiptRefs).map(String).filter(Boolean).slice(0, 64),
    errorDigest: input.error ? protocolHash("meshrix.operation-error", text(input.error)) : "",
    ...(input.commitment === undefined ? {} : { commitment: cleanValue(input.commitment) })
  });
}

function canExportProofBundle({ actor = null }: ProofRecord = {})  {
  if (!isProofRecord(actor)) return false;
  if (actor.type === "system" || actor.system === true) return true;
  const scopes = new Set<string>(asArray(actor.scopes || actor.user?.scopes).map(String));
  return scopes.has("proof:export") || scopes.has("runtime:admin") || scopes.has("console:admin");
}

function decodeBundleVarint(bytes: Uint8Array, offset = 0): { value: number; nextOffset: number } {
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

function createPortableBundleBlockResolver(
  bundle?: PactiumProofBundle,
  options: MeshrixVerificationOptions = {}
): PortableBundleResolver | null {
  if (!bundle?.binaryBase64 || !Array.isArray(bundle?.index)) return null;
  const maxHeaderSize = Number(options.maxHeaderSize || 16 * 1024);
  const maxBlockSize = Number(options.maxBlockSize || 64 * 1024 * 1024);
  const bytes = Buffer.from(String(bundle.binaryBase64), "base64");
  const index = new Map<string, ProofRecord>();
  const cache = new Map<string, PortableBlock | null>();
  for (const item of bundle.index) {
    const cid = text(item?.cid);
    if (!cid || index.has(cid)) continue;
    index.set(cid, asObject(item));
  }

  return Object.freeze({
    get(cid = "") {
      const key = text(cid);
      if (!key || !index.has(key)) return null;
      if (cache.has(key)) return cache.get(key) ?? null;
      const item = index.get(key);
      if (!item) return null;
      let block: PortableBlock | null = null;
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

function indexExtensionsByName(extensions: unknown): Map<string, ProofExtension[]> {
  const index = new Map<string, ProofExtension[]>();
  for (const extension of asProofExtensions(extensions)) {
    const name = text(extension.name);
    if (!name) continue;
    const group = index.get(name) ?? [];
    group.push(extension);
    index.set(name, group);
  }
  return index;
}

async function resolveMaterialBlock({ core, cid, bundleResolver }: {
  core: PactiumCore; cid: string; bundleResolver: PortableBundleResolver | null;
}): Promise<MaterialBlock | null> {
  const portable = bundleResolver?.get(cid);
  if (portable) return portable;
  const stored = await core.resolveBlock(cid);
  if (!stored) return null;
  return {
    ...(stored.bytes instanceof Uint8Array ? { bytes: stored.bytes } : {}),
    payloadBase64: text(stored.payloadBase64)
  };
}

function materializeMeshrixEvidenceExtension({ name, evidence, metadata = {} }: {
  name: string; evidence: unknown; metadata?: ProofRecord;
}): ProofExtension {
  const normalizedEvidence = cleanValue(evidence || {});
  return {
    name,
    critical: true,
    value: cleanRecord({
      protocol: MESHRIX_ASPECT_PROTOCOL,
      evidenceType: name,
      evidenceVersion: "v2",
      evidence: normalizedEvidence,
      evidenceHash: protocolHash("meshrix.critical-evidence", normalizedEvidence),
      metadata: cleanRecord(metadata)
    }),
    metadata: {
      evidenceHash: protocolHash("meshrix.critical-evidence", normalizedEvidence)
    }
  };
}

function meshrixMeshEvidenceExtensions({ input = {}, entry = null, phase = "outcome" }: {
  input?: ProofRecord; entry?: OperationProofEntry | null; phase?: string;
}): ProofExtension[] {
  const rawPolicyEvidence = asObject(input.policyEvidence ||
    input.policyDecision ||
    (entry?.policyDigest ? { policyDigest: entry.policyDigest } : null) ||
    buildPolicyEvidence({ ...asObject(entry), ...input }));
  const policyEvidence = cleanValue({
    evidenceType: "policy-digest",
    operationId: normalizeOperationId(input),
    workspaceId: normalizeWorkspaceId(input),
    decision: text(rawPolicyEvidence?.decision || rawPolicyEvidence?.status),
    reasonCode: text(rawPolicyEvidence?.reasonCode || rawPolicyEvidence?.reason),
    policyDigest: protocolHash("meshrix.policy-evidence", cleanValue(rawPolicyEvidence))
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
    effectDigest: protocolHash("meshrix.workspace-effect-evidence", cleanValue(rawWorkspaceEffectEvidence))
  });
  const policyExtension = materializeMeshrixEvidenceExtension({
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

function meshrixMeshEnvelopeSigningHash(envelope?: PactiumProofEnvelope): string {
  return protocolHash("proof.envelope.signing", {
    ...asObject(envelope),
    envelopeId: undefined,
    replayed: false,
    disposition: undefined,
    extensions: asProofExtensions(envelope?.extensions).filter(
      (extension) => extension.name !== MESHRIX_SIGNATURE_EXTENSION
    )
  });
}

function finalizeMeshrixEnvelopeExtensions(signer?: MeshrixSigner | null) {
  if (!signer) return null;
  return async (envelope: PactiumProofEnvelope) => {
    const signedEnvelopeHash = meshrixMeshEnvelopeSigningHash(envelope);
    const signature = await signer.sign(signedEnvelopeHash);
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
  storage: _storage,
  evidencePolicy = "production",
  signer = null,
  signerSecret = ""
}: MeshrixAspectOptions) {
  const hasExplicitSignerSecret = text(signerSecret) !== "";
  const resolvedSigner = signer === false
    ? null
    : signer || (hasExplicitSignerSecret || evidencePolicy !== "production"
      ? createMeshrixSigner({ secret: signerSecret || "meshrix-development-signer" })
      : null);
  const ownsSigner = !signer && Boolean(resolvedSigner);
  const genericRepairPlanner = requireRepairPlanner(createRepairPlanner());

  function assertProductionReady()  {
    if (evidencePolicy === "production" && !resolvedSigner) {
      throw new Error("Meshrix.js production evidence policy requires an explicit signer or signerSecret.");
    }
  }

  async function recordWorkspaceOperation(input: ProofRecord = {})  {
    const workspaceId = text(input.workspaceId || input.scope, "default");
    const policyEvidence = input.policyEvidence ?? input.policy;
    const effectEvidence = input.workspaceEffectEvidence ?? input.effectEvidence ?? input.workspaceEffect;
    if (evidencePolicy === "production" && !policyEvidence) {
      throw new Error("Meshrix.js production evidence policy requires policy evidence.");
    }
    if (evidencePolicy === "production" && !effectEvidence) {
      throw new Error("Meshrix.js production evidence policy requires workspace effect evidence.");
    }
    assertProductionReady();
    const compactInput: ProofRecord = {
      ...input,
      workspaceId,
      policyEvidence: policyEvidence || { missing: true, policy: "opportunistic" },
      workspaceEffectEvidence: effectEvidence || { missing: true, policy: "opportunistic" }
    };
    const intentEvidenceExtensions = meshrixMeshEvidenceExtensions({ input: compactInput, phase: "intent" });
    const outcomeEvidenceExtensions = meshrixMeshEvidenceExtensions({ input: compactInput, phase: "outcome" });
    const batch = await core.recordOperations([{
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

  async function verifyMeshrixEnvelope(
    envelope: PactiumProofEnvelope,
    options: MeshrixVerificationOptions = {}
  ) {
    const bundleResolver = createPortableBundleBlockResolver(options.bundle, options);
    const decodedMaterial = new Map<string, { block: MaterialBlock | null; value: ProofRecord | null }>();
    async function resolveDecodedMaterial(cid: unknown) {
      const key = text(cid);
      if (!key) return { block: null, value: null };
      const cached = decodedMaterial.get(key);
      if (cached) return cached;
      const block = await resolveMaterialBlock({ core, cid: key, bundleResolver });
      let value: ProofRecord | null = null;
      try {
        value = block
          ? asObject(canonicalDecode(
              block.bytes || Buffer.from(String(block.payloadBase64 || ""), "base64")
            ), null)
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
    const coreResult: PactiumVerificationResult = options.coreEnvelopeResult || await verifyProofEnvelope(envelope, ({
      storage: { getBlock: (cid: string) => core.resolveBlock(cid) },
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
    } as PactiumProofVerificationOptions));
    const failures: PactiumVerificationFailure[] = [...coreResult.failures];
    const extensions = asProofExtensions(envelope.extensions);
    const extensionIndex = indexExtensionsByName(extensions);
    const criticalNames = new Set(envelope.criticalExtensions);

    const requiredCriticalExtensions = envelope?.envelopeKind === "operation-intent"
      ? [MESHRIX_POLICY_EXTENSION]
      : MESHRIX_CRITICAL_EXTENSIONS;
    for (const required of requiredCriticalExtensions) {
      const extension = extensionIndex.get(required)?.[0] || null;
      if (!extension) {
        failures.push(createVerificationFailure({
          layer: "meshrix",
          code: `missing_${required.replace(/\W+/gu, "_")}`,
          message: `Meshrix.js Proof Envelope is missing required critical extension ${required}.`,
          evidenceRef: envelope?.envelopeId || "",
          repairable: evidencePolicy !== "production"
        }));
      } else if (extension.critical !== true || !criticalNames.has(required)) {
        failures.push(createVerificationFailure({
          layer: "meshrix",
          code: "noncritical_required_extension",
          message: `Meshrix.js required extension ${required} must be critical and listed in criticalExtensions.`,
          evidenceRef: envelope?.envelopeId || "",
          repairable: true
        }));
      }
    }

    for (const name of [MESHRIX_POLICY_EXTENSION, MESHRIX_WORKSPACE_EFFECT_EXTENSION]) {
      for (const extension of extensionIndex.get(name) ?? []) {
        const { value } = await resolveDecodedMaterial(extension.valueRef);
        const evidence = asObject(value?.evidence, null);
        const evidenceHash = text(value?.evidenceHash || extension.metadata?.evidenceHash);
        const expectedEvidenceHash = evidence
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

    const signatureExtension = extensionIndex.get(MESHRIX_SIGNATURE_EXTENSION)?.[0] || null;
    if (evidencePolicy === "production" && !resolvedSigner) {
      failures.push(createVerificationFailure({
        layer: "meshrix.signing",
        code: "missing_signature_verifier",
        message: "Meshrix.js production verification requires an explicit signer or signerSecret.",
        evidenceRef: envelope?.envelopeId || "",
        repairable: true
      }));
    }
    if (!signatureExtension) {
      failures.push(createVerificationFailure({
        layer: "meshrix.signing",
        code: "missing_signature",
        message: "Meshrix.js signing is enabled by default and no signature extension was found.",
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
          message: "Meshrix.js signature material cannot be verified without an explicit signer or signerSecret.",
          evidenceRef: signatureExtension.valueRef,
          repairable: true
        }));
      } else if (!(await (
        typeof resolvedSigner.verifyFor === "function"
          ? resolvedSigner.verifyFor({
              signerId: text(value.signerId),
              algorithm: text(value.algorithm),
              message: text(value.signedEnvelopeHash),
              signature: text(value.signature)
            })
          : resolvedSigner.verify(text(value.signedEnvelopeHash), text(value.signature))
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
        message: "Meshrix.js production verification requires a caller-supplied trusted manifest.",
        evidenceRef: envelope?.envelopeId || "",
        repairable: true
      }));
    }

    return {
      protocol: PACTIUM_PROTOCOL,
      aspect: MESHRIX_ASPECT_PROTOCOL,
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
        "meshrix-critical-policy-extension",
        ...(requiredCriticalExtensions.includes(MESHRIX_WORKSPACE_EFFECT_EXTENSION)
          ? ["meshrix-critical-workspace-effect-extension"]
          : []),
        "meshrix-signature",
        "meshrix-workspace-projection"
      ]
    };
  }

  async function verifyMeshrixBundle(
    bundle: PactiumProofBundle,
    options: MeshrixVerificationOptions = {}
  ) {
    const supportedCriticalExtensions = [
      ...new Set<string>([
        ...MESHRIX_SUPPORTED_CRITICAL_EXTENSIONS,
        ...(options.supportedCriticalExtensions ?? [])
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
    const envelopeResult = await verifyMeshrixEnvelope(bundle.envelope, {
      ...options,
      trustPolicy,
      bundle,
      coreEnvelopeResult: bundleResult.envelope
    });
    return {
      protocol: PACTIUM_PROTOCOL,
      aspect: MESHRIX_ASPECT_PROTOCOL,
      ok: bundleResult.ok && envelopeResult.ok,
      failures: [...bundleResult.failures, ...envelopeResult.failures],
      bundle: bundleResult,
      envelope: envelopeResult
    };
  }

  function planRepair(failures: PactiumVerificationFailure[] = []) {
    const plan = genericRepairPlanner.plan(failures);
    return {
      ...plan,
      tasks: asArray(plan.tasks).map((task, index) => {
        const failure = failures[index];
        if (!failure) return task;
        return String(failure.layer || "").startsWith("meshrix") ||
          String(failure.code || "").startsWith("missing_meshrix_")
          ? { ...asObject(task), action: "request-host-evidence" }
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
    close()  {
      if (ownsSigner) resolvedSigner?.close?.();
    },
    getWorkspaceProjection: core.getWorkspaceProjection,
    proveWorkspaceMembership: core.proveWorkspaceMembership,
    exportProofBundle: core.exportProofBundle
  });
}

interface OperationProofSubstrateOptions {
  userDataPath?: string;
  dataDir?: string;
  pactiumRuntime?: MeshrixPactiumRuntime | null;
  runtimeOptions?: ProofRecord;
  mode?: string;
  evidencePolicy?: string;
  signer?: MeshrixSigner | false | null;
  signerSecret?: string;
}

interface AcceptanceReportDigest {
  path?: string;
  schemaVersion?: string;
  contentHash?: string;
}

interface AcceptanceEvidenceInput {
  reportDigests?: AcceptanceReportDigest[];
  evidenceContext?: ProofRecord;
  releaseId?: string;
  actor?: ProofRecord;
}

interface PlanReceiptEvidenceInput {
  plan?: string;
  receiptDigest?: string;
  context?: ProofRecord;
  actor?: ProofRecord;
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
}: OperationProofSubstrateOptions = {}) {
  const resolvedDataDir = resolveMeshrixPactiumDataDir(userDataPath || dataDir);
  const resolvedMode = resolveMode({ mode, runtimeOptions });
  const resolvedEvidencePolicy = resolveEvidencePolicy({ evidencePolicy, runtimeOptions });
  const resolvedSignerSecret = resolveSignerSecret({
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
      "Meshrix.js production operation-proof evidence requires a configured signer.",
    );
  }
  const ownsPactiumRuntime = !pactiumRuntime;
  const runtimeCandidate: unknown = normalizeMeshrixPactiumRuntime({
    userDataPath: resolvedDataDir,
    dataDir: resolvedDataDir,
    pactiumRuntime
  });
  const runtime = requireProofRuntime(runtimeCandidate);
  const core = runtime.core;
  const storage = runtime.storage;
  const aspect = createMeshrixAspect({
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

  async function beginLifecycle(input: ProofRecord = {})  {
    aspect.assertProductionReady();
    const operationId = normalizeOperationId(input);
    const workspaceId = normalizeWorkspaceId(input);
    const idempotencyKey = normalizeIdempotencyKey(input);
    const evidenceExtensions = meshrixMeshEvidenceExtensions({
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
      const existing = await loadProjectedEntry(core, envelope.factRef?.ledgerEventId);
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

  async function finishLifecycle(input: ProofRecord = {})  {
    aspect.assertProductionReady();
    const ledgerEventId = text(input.ledgerEventId || input.entry?.ledgerEventId);
    const entry = isOperationProofEntry(input.entry)
      ? input.entry
      : await loadProjectedEntry(core, ledgerEventId);
    if (!entry) {
      throw new Error("operation proof entry missing");
    }
    if (!entry.pactium?.intentId) {
      throw new Error("operation proof intent missing");
    }
    const status = outcomeStatus(input);
    const evidenceExtensions = meshrixMeshEvidenceExtensions({
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
      const existing = await loadProjectedEntry(
        core,
        entry.pactium?.intentLedgerEventId ||
          entry.ledgerEventId
      );
      const durableEntry = existing || entry;
      const canonicalEntry: OperationProofEntry = {
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

  async function recordReceipt(input: ProofRecord = {}): Promise<OperationProofEntry> {
    aspect.assertProductionReady();
    const operationId = normalizeOperationId(input);
    const workspaceId = normalizeWorkspaceId(input);
    const profile = text(input.profile, "receipt") === "on-change" ? "on-change" : "receipt";
    const status = outcomeStatus(input);
    const evidenceExtensions = meshrixMeshEvidenceExtensions({
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
        subjectDigest: protocolHash("meshrix.subject", cleanValue(asObject(input.subject)))
      },
      result: receiptResult,
      extensions: [...evidenceExtensions, ...asArray(input.extensions)],
      finalizeEnvelopeExtensions: finalizeMeshrixEnvelopeExtensions(aspect.signer)
    });
    if (envelope.disposition === "unchanged") {
      const at = nowIso();
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
        idempotencyKey: normalizeIdempotencyKey(input),
        createdAt: at,
        updatedAt: at,
        completedAt: at,
        failedAt: "",
        error: "",
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

  async function exportProofBundleForEntry(input: ProofRecord = {})  {
    const actor = input.actor || { type: "system" };
    if (!canExportProofBundle({ actor })) {
      throw new Error("Proof Bundle Export requires proof:export, runtime:admin, console:admin, or system actor.");
    }
    const entry = isOperationProofEntry(input.entry)
      ? input.entry
      : await loadProjectedEntry(core, input.ledgerEventId);
    if (!entry) {
      throw new Error("operation proof entry missing");
    }
    const envelopeId = text(input.envelopeId) || envelopeIdForEntry(entry, text(input.kind, "outcome"));
    if (!envelopeId) {
      throw new Error("operation proof envelope missing");
    }
    return core.exportProofBundle(envelopeId, asObject(input.options));
  }

  async function verifyReceipt(input: ProofRecord = {})  {
    const bundle = input.bundle
      ? requireProofBundle(input.bundle)
      : await exportProofBundleForEntry({
          ...input,
          actor: input.actor || { type: "system" }
        });
    const result = await aspect.verifyBundle(bundle, {
      requireAllProofs: input.requireAllProofs !== false,
      trustPolicy: defaultVerificationTrustPolicy,
      ...asObject(input.options)
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
    denyLifecycle(input: ProofRecord = {})  {
      return finishLifecycle({ ...input, status: "denied", denied: true });
    },
    recordWorkspaceOperation(input: ProofRecord = {})  {
      return aspect.recordWorkspaceOperation({
        ...input,
        workspaceId: normalizeWorkspaceId(input),
        policyEvidence: input.policyEvidence || buildPolicyEvidence(input),
        workspaceEffectEvidence: input.workspaceEffectEvidence || buildWorkspaceEffectEvidence(input)
      });
    },
    async recordAcceptanceEvidence({
      reportDigests = [], evidenceContext = {}, releaseId = "", actor = { type: "system" }
    }: AcceptanceEvidenceInput = {}) {
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
        subject: cleanRecord(actor),
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
    async recordPlanReceiptEvidence({
      plan = "", receiptDigest = "", context = {}, actor = { type: "system" }
    }: PlanReceiptEvidenceInput = {}) {
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
        subject: cleanRecord(actor),
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
    async verifyReceiptCommitment({ ledgerEventId = "", commitment = {} }: ProofRecord = {})  {
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
    async verifyEnvelope(envelope: PactiumProofEnvelope, options: MeshrixVerificationOptions = {}) {
      return aspect.verifyEnvelope(envelope, {
        trustPolicy: defaultVerificationTrustPolicy,
        ...options
      });
    },
    async verifyBundle(bundle: PactiumProofBundle, options: MeshrixVerificationOptions = {}) {
      return aspect.verifyBundle(bundle, {
        trustPolicy: defaultVerificationTrustPolicy,
        ...options
      });
    },
    exportProofBundle: exportProofBundleForEntry,
    getWorkspaceProjection(workspaceId = "default")  {
      return core.getWorkspaceProjection(workspaceId);
    },
    proveWorkspaceMembership(input: ProofRecord = {})  {
      return core.proveWorkspaceMembership(input);
    },
    planRecovery(input: ProofRecord = {})  {
      return core.planRecovery(input);
    },
    async doctor()  {
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
    health()  {
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
    listCapabilities()  {
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
    getReceipt(ledgerEventId?: string) {
      return loadProjectedEntry(core, ledgerEventId);
    },
    async listReceipts({ limit = 100 }: ProofRecord = {})  {
      const normalizedLimit = Math.max(1, Math.min(Number(limit || 100), 10000));
      const head = await core.readLedgerHead();
      const entries = [];
      for (let index = Number(head?.size || 0) - 1; index >= 0 && entries.length < normalizedLimit; index -= 1) {
        const ledgerEntry = await core.readLedgerLeaf(index);
        const ledgerFact = asObject(ledgerEntry?.fact, null);
        if (!ledgerFact || !["operation.outcome", "operation.receipt"].includes(text(ledgerFact.factType))) continue;
        const projected = await projectLedgerEntry(core, ledgerEntry);
        if (projected) entries.push(projected);
      }
      return entries;
    },
    async close()  {
      let failure = null;
      try {
        aspect.close?.();
      } catch (error) {
        failure = error;
      }
      if (ownsPactiumRuntime) {
        try {
          await (runtime.close?.() || Promise.resolve());
        } catch (error) {
          failure ||= error;
        }
      }
      if (failure) throw failure;
    }
  });
}

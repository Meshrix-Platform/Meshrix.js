import { createHash } from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  consumeGovernedExecutionPermit,
  mintGovernedExecutionPermit
} from "./governed-execution-permit-authority.ts";

type DataRecord = Record<string, unknown>;
type GovernedExecutionPermitConsumptionReceipt = ReturnType<typeof consumeGovernedExecutionPermit>;

export interface FinalProtectedSinkSubject {
  generation: string;
  subjectId: string;
  tenantId: string;
  type: string;
}

export interface FinalProtectedSinkEffect {
  kind: string;
  targetDigest: string;
}

export interface FinalProtectedSinkContext {
  approvalRevision: string;
  grantRevision: string;
  policyRevision: string;
  resourceRevision: string;
  riskRevision: string;
  workloadGeneration: string;
}

export interface FinalProtectedSinkAttemptContext extends Omit<FinalProtectedSinkContext, "resourceRevision"> {}

export interface FinalProtectedSinkBinding {
  audience: string;
  subject: Readonly<FinalProtectedSinkSubject>;
  operationId: string;
  effect: Readonly<FinalProtectedSinkEffect>;
  requestDigest: string;
  context: Readonly<FinalProtectedSinkContext>;
}

export type FinalProtectedSinkAttempt = Readonly<Record<PropertyKey, never>>;

interface CurrentAuthorityResult {
  allowed?: boolean;
  revoked?: boolean;
  subject?: unknown;
  context?: unknown;
  currentBinding?: unknown;
}

interface CurrentResourceResult {
  effect?: unknown;
  resourceRevision?: unknown;
}

interface AttemptRevalidationInput {
  binding: Readonly<FinalProtectedSinkBinding>;
  consumptionReceipt: GovernedExecutionPermitConsumptionReceipt;
  signal: AbortSignal | null;
}

interface ResourceResolutionInput {
  binding: Readonly<FinalProtectedSinkBinding>;
  signal: AbortSignal | null;
}

type AttemptAuthorityRevalidator = (input: Readonly<AttemptRevalidationInput>) => Promise<CurrentAuthorityResult>;
type CurrentResourceResolver = (input: Readonly<ResourceResolutionInput>) => Promise<CurrentResourceResult>;

export interface CreateFinalProtectedSinkAttemptOptions {
  audience?: unknown;
  subject?: unknown;
  operationId?: unknown;
  requestDigest?: unknown;
  context?: unknown;
  targetSelector?: unknown;
  proofRef?: unknown;
  authorization?: DataRecord;
  approval?: DataRecord;
  risk?: DataRecord;
  revalidateCurrentAuthority?: AttemptAuthorityRevalidator;
  signal?: AbortSignal | null;
  now?: () => number;
  ttlMs?: number;
}

export interface ClaimFinalProtectedSinkAttemptOptions {
  attempt?: object;
  targetSelector?: unknown;
  effect?: unknown;
  resourceRevision?: unknown;
  resolveCurrentResource?: CurrentResourceResolver;
}

interface GuardRevalidationInput {
  binding: Readonly<FinalProtectedSinkBinding>;
  consumptionReceipt: GovernedExecutionPermitConsumptionReceipt;
}

type GuardAuthorityRevalidator = (input: Readonly<GuardRevalidationInput>) => Promise<CurrentAuthorityResult>;

export interface CreateFinalProtectedSinkPermitGuardOptions {
  revalidateCurrentAuthority?: GuardAuthorityRevalidator;
  now?: () => number;
}

export interface ConsumeFinalProtectedSinkPermitOptions {
  permit?: unknown;
  binding?: unknown;
}

export interface FinalProtectedSinkPermitGuard {
  consume(options?: ConsumeFinalProtectedSinkPermitOptions): Promise<GovernedExecutionPermitConsumptionReceipt>;
}

interface FinalProtectedSinkAttemptState {
  audience: string;
  subject: Readonly<FinalProtectedSinkSubject>;
  operationId: string;
  requestDigest: string;
  context: Readonly<FinalProtectedSinkAttemptContext>;
  targetSelectorDigest: string;
  proofRef: unknown;
  authorization: Readonly<DataRecord>;
  approval: Readonly<DataRecord>;
  risk: Readonly<DataRecord>;
  revalidateCurrentAuthority: AttemptAuthorityRevalidator;
  signal: AbortSignal | null;
  now: () => number;
  expiresAt: number;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_TEXT_BYTES = 256;
const DEFAULT_ATTEMPT_TTL_MS = 15_000;
const MAX_ATTEMPT_TTL_MS = 60_000;
const FINAL_SINK_INPUT_DIGEST_SCHEMA = "v0.0.1:security:final-protected-sink-input-1";
const BINDING_KEYS = Object.freeze(["audience", "context", "effect", "operationId", "requestDigest", "subject"]);
const SUBJECT_KEYS = Object.freeze(["generation", "subjectId", "tenantId", "type"]);
const EFFECT_KEYS = Object.freeze(["kind", "targetDigest"]);
const CONTEXT_KEYS = Object.freeze(["approvalRevision", "grantRevision", "policyRevision", "resourceRevision", "riskRevision", "workloadGeneration"]);
const ATTEMPT_CONTEXT_KEYS = Object.freeze(CONTEXT_KEYS.filter((key) => key !== "resourceRevision"));
const finalProtectedSinkAttempts = new WeakMap<object, Readonly<FinalProtectedSinkAttemptState>>();

function deny(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, statusCode: 403 });
}

function isPlainObject(value: unknown): value is DataRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, expectedKeys: readonly string[]): value is DataRecord {
  return isPlainObject(value) && Object.keys(value).sort().join("\u0000") === [...expectedKeys].sort().join("\u0000");
}

function boundedText(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  const containsRejectedControl = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!normalized || Buffer.byteLength(normalized, "utf8") > MAX_TEXT_BYTES || containsRejectedControl) return "";
  return normalized;
}

function requiredText(value: unknown): string {
  const normalized = boundedText(value);
  if (!normalized) deny("final_protected_sink_permit_binding_invalid", "Final protected sink permit binding is invalid.");
  return normalized;
}

function requiredDigest(value: unknown): string {
  const normalized = requiredText(value);
  if (!SHA256_PATTERN.test(normalized)) deny("final_protected_sink_permit_binding_invalid", "Final protected sink permit binding is invalid.");
  return normalized;
}

function normalizeSubject(value: unknown): Readonly<FinalProtectedSinkSubject> {
  if (!hasExactKeys(value, SUBJECT_KEYS)) deny("final_protected_sink_permit_binding_invalid", "Final protected sink permit binding is invalid.");
  return Object.freeze({
    generation: requiredText(value.generation),
    subjectId: requiredText(value.subjectId),
    tenantId: requiredText(value.tenantId),
    type: requiredText(value.type)
  });
}

function normalizeEffect(value: unknown): Readonly<FinalProtectedSinkEffect> {
  if (!hasExactKeys(value, EFFECT_KEYS)) deny("final_protected_sink_permit_binding_invalid", "Final protected sink permit binding is invalid.");
  return Object.freeze({ kind: requiredText(value.kind), targetDigest: requiredDigest(value.targetDigest) });
}

function normalizeContext(value: unknown): Readonly<FinalProtectedSinkContext> {
  if (!hasExactKeys(value, CONTEXT_KEYS)) deny("final_protected_sink_permit_binding_invalid", "Final protected sink permit binding is invalid.");
  return Object.freeze({
    approvalRevision: requiredText(value.approvalRevision),
    grantRevision: requiredText(value.grantRevision),
    policyRevision: requiredText(value.policyRevision),
    resourceRevision: requiredText(value.resourceRevision),
    riskRevision: requiredText(value.riskRevision),
    workloadGeneration: requiredText(value.workloadGeneration)
  });
}

function normalizeBinding(value: unknown): Readonly<FinalProtectedSinkBinding> {
  if (!hasExactKeys(value, BINDING_KEYS)) deny("final_protected_sink_permit_binding_invalid", "Final protected sink permit binding is invalid.");
  return Object.freeze({
    audience: requiredText(value.audience),
    subject: normalizeSubject(value.subject),
    operationId: requiredText(value.operationId),
    effect: normalizeEffect(value.effect),
    requestDigest: requiredDigest(value.requestDigest),
    context: normalizeContext(value.context)
  });
}

function authorityBinding(binding: Readonly<FinalProtectedSinkBinding>): DataRecord {
  return {
    audience: binding.audience,
    operationId: binding.operationId,
    principal: binding.subject,
    requestDigest: binding.requestDigest,
    resource: { context: binding.context, effect: binding.effect }
  };
}

function currentBindingMatches(currentBinding: unknown, expectedBinding: Readonly<FinalProtectedSinkBinding>): boolean {
  try {
    return canonicalJson(normalizeBinding(currentBinding)) === canonicalJson(expectedBinding);
  } catch {
    return false;
  }
}

function attemptReplayDenied(): never {
  deny("governed_execution_permit_unknown_or_replayed", "Governed execution permit is unknown or already consumed.");
}

function selectorDigest(value: unknown): string {
  if (!isPlainObject(value)) deny("final_protected_sink_permit_binding_invalid", "Final protected sink permit binding is invalid.");
  return cryptoDigest(canonicalJson(value));
}

function cryptoDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestFinalProtectedSinkInput(input: DataRecord = {}): string {
  const normalizedInput: unknown = JSON.parse(JSON.stringify(input ?? null));
  return cryptoDigest(canonicalJson({ schemaVersion: FINAL_SINK_INPUT_DIGEST_SCHEMA, input: normalizedInput }));
}

function aborted(signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true;
}

function attemptDenied(code = "final_protected_sink_permit_denied"): never {
  deny(code, "Final protected sink authority was denied.");
}

function normalizeAttemptAuthority({ audience, subject, operationId, requestDigest, context }: Pick<CreateFinalProtectedSinkAttemptOptions, "audience" | "subject" | "operationId" | "requestDigest" | "context">): Readonly<Omit<FinalProtectedSinkAttemptState, "targetSelectorDigest" | "proofRef" | "authorization" | "approval" | "risk" | "revalidateCurrentAuthority" | "signal" | "now" | "expiresAt">> {
  if (!hasExactKeys(context, ATTEMPT_CONTEXT_KEYS)) attemptDenied("final_protected_sink_permit_binding_invalid");
  return Object.freeze({
    audience: requiredText(audience),
    subject: normalizeSubject(subject),
    operationId: requiredText(operationId),
    requestDigest: requiredDigest(requestDigest),
    context: Object.freeze({
      approvalRevision: requiredText(context.approvalRevision),
      grantRevision: requiredText(context.grantRevision),
      policyRevision: requiredText(context.policyRevision),
      riskRevision: requiredText(context.riskRevision),
      workloadGeneration: requiredText(context.workloadGeneration)
    })
  });
}

export function createFinalProtectedSinkAttempt({
  audience,
  subject,
  operationId,
  requestDigest,
  context,
  targetSelector,
  proofRef,
  authorization = {},
  approval = {},
  risk = {},
  revalidateCurrentAuthority,
  signal = null,
  now = Date.now,
  ttlMs = DEFAULT_ATTEMPT_TTL_MS
}: CreateFinalProtectedSinkAttemptOptions = {}): FinalProtectedSinkAttempt {
  if (typeof revalidateCurrentAuthority !== "function" || typeof now !== "function") throw new TypeError("Final protected sink attempt dependencies are invalid.");
  const issuedAt = Number(now());
  if (!Number.isFinite(issuedAt)) throw new TypeError("Final protected sink attempt clock is invalid.");
  const lifetime = Math.min(MAX_ATTEMPT_TTL_MS, Math.max(1, Number(ttlMs) || DEFAULT_ATTEMPT_TTL_MS));
  const authority = normalizeAttemptAuthority({ audience, subject, operationId, requestDigest, context });
  const attempt = Object.freeze(Object.create(null)) as FinalProtectedSinkAttempt;
  finalProtectedSinkAttempts.set(attempt, Object.freeze({
    ...authority,
    targetSelectorDigest: selectorDigest(targetSelector),
    proofRef,
    authorization: Object.freeze({ ...authorization }),
    approval: Object.freeze({ ...approval }),
    risk: Object.freeze({ ...risk }),
    revalidateCurrentAuthority,
    signal,
    now,
    expiresAt: issuedAt + lifetime
  }));
  return attempt;
}

export async function claimFinalProtectedSinkAttempt({ attempt, targetSelector, effect, resourceRevision, resolveCurrentResource }: ClaimFinalProtectedSinkAttemptOptions = {}): Promise<GovernedExecutionPermitConsumptionReceipt> {
  if (!attempt) attemptReplayDenied();
  const state = finalProtectedSinkAttempts.get(attempt);
  finalProtectedSinkAttempts.delete(attempt);
  if (!state) attemptReplayDenied();
  const consumedAt = Number(state.now());
  if (!Number.isFinite(consumedAt) || consumedAt >= state.expiresAt) attemptReplayDenied();
  if (aborted(state.signal)) attemptDenied();
  if (selectorDigest(targetSelector) !== state.targetSelectorDigest) attemptDenied("final_protected_sink_permit_binding_invalid");
  if (typeof resolveCurrentResource !== "function") attemptDenied("final_protected_sink_permit_binding_invalid");

  const normalizedBinding = normalizeBinding({
    audience: state.audience,
    subject: state.subject,
    operationId: state.operationId,
    effect,
    requestDigest: state.requestDigest,
    context: { ...state.context, resourceRevision }
  });
  let permit: string;
  try {
    permit = mintGovernedExecutionPermit({
      operationId: normalizedBinding.operationId,
      audience: normalizedBinding.audience,
      principal: normalizedBinding.subject,
      resource: { context: normalizedBinding.context, effect: normalizedBinding.effect },
      requestDigest: normalizedBinding.requestDigest,
      proofRef: state.proofRef,
      authorization: state.authorization,
      approval: state.approval,
      risk: state.risk,
      now: consumedAt,
      ttlMs: Math.max(1, state.expiresAt - consumedAt)
    });
  } catch {
    attemptDenied();
  }

  const guard = createFinalProtectedSinkPermitGuard({
    now: state.now,
    revalidateCurrentAuthority: async ({ consumptionReceipt }) => {
      if (aborted(state.signal)) return Object.freeze({ allowed: false, revoked: false, currentBinding: normalizedBinding });
      const authority = await state.revalidateCurrentAuthority(Object.freeze({ binding: normalizedBinding, consumptionReceipt, signal: state.signal }));
      if (authority.allowed !== true || authority.revoked === true) return Object.freeze({ allowed: false, revoked: authority.revoked === true, currentBinding: normalizedBinding });
      if (aborted(state.signal)) return Object.freeze({ allowed: false, revoked: false, currentBinding: normalizedBinding });
      const currentResource = await resolveCurrentResource(Object.freeze({ binding: normalizedBinding, signal: state.signal }));
      if (aborted(state.signal)) return Object.freeze({ allowed: false, revoked: false, currentBinding: normalizedBinding });
      return Object.freeze({
        allowed: true,
        revoked: false,
        currentBinding: {
          audience: normalizedBinding.audience,
          subject: authority.subject,
          operationId: normalizedBinding.operationId,
          effect: currentResource.effect,
          requestDigest: normalizedBinding.requestDigest,
          context: { ...isPlainObject(authority.context) ? authority.context : {}, resourceRevision: currentResource.resourceRevision }
        }
      });
    }
  });
  return guard.consume({ binding: normalizedBinding, permit });
}

export function createFinalProtectedSinkPermitGuard({ revalidateCurrentAuthority, now = Date.now }: CreateFinalProtectedSinkPermitGuardOptions = {}): FinalProtectedSinkPermitGuard {
  if (typeof revalidateCurrentAuthority !== "function" || typeof now !== "function") throw new TypeError("Final protected sink permit guard dependencies are invalid.");
  const revalidate = revalidateCurrentAuthority;

  async function consume({ permit, binding }: ConsumeFinalProtectedSinkPermitOptions = {}): Promise<GovernedExecutionPermitConsumptionReceipt> {
    if (typeof permit !== "string" || !permit.trim()) deny("final_protected_sink_permit_required", "A final protected sink permit is required.");
    const normalizedBinding = normalizeBinding(binding);
    const consumptionReceipt = consumeGovernedExecutionPermit(permit, authorityBinding(normalizedBinding), Number(now()));
    let current: CurrentAuthorityResult;
    try {
      current = await revalidate(Object.freeze({ binding: normalizedBinding, consumptionReceipt }));
    } catch {
      deny("final_protected_sink_permit_denied", "Final protected sink authority was denied.");
    }
    if (current.revoked === true) deny("final_protected_sink_permit_revoked", "Final protected sink authority was revoked.");
    if (current.allowed !== true) deny("final_protected_sink_permit_denied", "Final protected sink authority was denied.");
    if (!currentBindingMatches(current.currentBinding, normalizedBinding)) deny("final_protected_sink_permit_current_binding_mismatch", "Final protected sink authority is stale.");
    return consumptionReceipt;
  }

  return Object.freeze({ consume });
}

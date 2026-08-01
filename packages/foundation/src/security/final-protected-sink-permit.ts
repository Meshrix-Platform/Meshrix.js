import { createHash } from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  consumeGovernedExecutionPermit,
  mintGovernedExecutionPermit
} from "./governed-execution-permit-authority.ts";

const SHA256_PATTERN: any = /^[a-f0-9]{64}$/u;
const MAX_TEXT_BYTES: any = 256;
const DEFAULT_ATTEMPT_TTL_MS: any = 15_000;
const MAX_ATTEMPT_TTL_MS: any = 60_000;
const FINAL_SINK_INPUT_DIGEST_SCHEMA: any =
  "v0.0.1:security:final-protected-sink-input-1";
const BINDING_KEYS: readonly any[] = Object.freeze([
  "audience",
  "context",
  "effect",
  "operationId",
  "requestDigest",
  "subject"
]);
const SUBJECT_KEYS: readonly any[] = Object.freeze([
  "generation",
  "subjectId",
  "tenantId",
  "type"
]);
const EFFECT_KEYS: readonly any[] = Object.freeze([
  "kind",
  "targetDigest"
]);
const CONTEXT_KEYS: readonly any[] = Object.freeze([
  "approvalRevision",
  "grantRevision",
  "policyRevision",
  "resourceRevision",
  "riskRevision",
  "workloadGeneration"
]);
const ATTEMPT_CONTEXT_KEYS: any = Object.freeze(
  CONTEXT_KEYS.filter((key?: any) : any => key !== "resourceRevision")
);
const finalProtectedSinkAttempts: any = new WeakMap<object, any>();

function deny(code?: any, message?: any) : any {
  throw Object.assign(new Error(message), {
    code,
    statusCode: 403
  });
}

function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value?: any, expectedKeys?: any) : any {
  return isPlainObject(value) &&
    Object.keys(value).sort().join("\u0000") === [...expectedKeys].sort().join("\u0000");
}

function boundedText(value?: any) : any {
  if (typeof value !== "string") return "";
  const normalized: any = value.trim();
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > MAX_TEXT_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return "";
  }
  return normalized;
}

function requiredText(value?: any) : any {
  const normalized: any = boundedText(value);
  if (!normalized) {
    deny(
      "final_protected_sink_permit_binding_invalid",
      "Final protected sink permit binding is invalid."
    );
  }
  return normalized;
}

function requiredDigest(value?: any) : any {
  const normalized: any = requiredText(value);
  if (!SHA256_PATTERN.test(normalized)) {
    deny(
      "final_protected_sink_permit_binding_invalid",
      "Final protected sink permit binding is invalid."
    );
  }
  return normalized;
}

function normalizeBinding(value?: any) : any {
  if (!hasExactKeys(value, BINDING_KEYS) ||
      !hasExactKeys(value.subject, SUBJECT_KEYS) ||
      !hasExactKeys(value.effect, EFFECT_KEYS) ||
      !hasExactKeys(value.context, CONTEXT_KEYS)) {
    deny(
      "final_protected_sink_permit_binding_invalid",
      "Final protected sink permit binding is invalid."
    );
  }
  const subject: Readonly<Record<string, any>> = Object.freeze({
    generation: requiredText(value.subject.generation),
    subjectId: requiredText(value.subject.subjectId),
    tenantId: requiredText(value.subject.tenantId),
    type: requiredText(value.subject.type)
  });
  const effect: Readonly<Record<string, any>> = Object.freeze({
    kind: requiredText(value.effect.kind),
    targetDigest: requiredDigest(value.effect.targetDigest)
  });
  const context: Readonly<Record<string, any>> = Object.freeze({
    approvalRevision: requiredText(value.context.approvalRevision),
    grantRevision: requiredText(value.context.grantRevision),
    policyRevision: requiredText(value.context.policyRevision),
    resourceRevision: requiredText(value.context.resourceRevision),
    riskRevision: requiredText(value.context.riskRevision),
    workloadGeneration: requiredText(value.context.workloadGeneration)
  });
  return Object.freeze({
    audience: requiredText(value.audience),
    subject,
    operationId: requiredText(value.operationId),
    effect,
    requestDigest: requiredDigest(value.requestDigest),
    context
  });
}

function authorityBinding(binding?: any) : any {
  return {
    audience: binding.audience,
    operationId: binding.operationId,
    principal: binding.subject,
    requestDigest: binding.requestDigest,
    resource: {
      context: binding.context,
      effect: binding.effect
    }
  };
}

function currentBindingMatches(currentBinding?: any, expectedBinding?: any) : any {
  try {
    return canonicalJson(normalizeBinding(currentBinding)) === canonicalJson(expectedBinding);
  } catch {
    return false;
  }
}

function attemptReplayDenied() : any {
  deny(
    "governed_execution_permit_unknown_or_replayed",
    "Governed execution permit is unknown or already consumed."
  );
}

function selectorDigest(value?: any) : any {
  if (!isPlainObject(value)) {
    deny(
      "final_protected_sink_permit_binding_invalid",
      "Final protected sink permit binding is invalid."
    );
  }
  return cryptoDigest(canonicalJson(value));
}

function cryptoDigest(value?: any) : any {
  return createHash("sha256").update(value).digest("hex");
}

export function digestFinalProtectedSinkInput(input: Record<string, any> = {}) : any {
  const normalizedInput: any = JSON.parse(JSON.stringify(input ?? null));
  return cryptoDigest(canonicalJson({
    schemaVersion: FINAL_SINK_INPUT_DIGEST_SCHEMA,
    input: normalizedInput
  }));
}

function aborted(signal?: any) : any {
  return signal?.aborted === true;
}

function attemptDenied(code: any = "final_protected_sink_permit_denied") : any {
  deny(code, "Final protected sink authority was denied.");
}

function normalizeAttemptAuthority({
  audience,
  subject,
  operationId,
  requestDigest,
  context
}: Record<string, any> = {}) : any {
  if (
    !hasExactKeys(subject, SUBJECT_KEYS) ||
    !hasExactKeys(context, ATTEMPT_CONTEXT_KEYS)
  ) {
    attemptDenied("final_protected_sink_permit_binding_invalid");
  }
  return Object.freeze({
    audience: requiredText(audience),
    subject: Object.freeze({
      generation: requiredText(subject.generation),
      subjectId: requiredText(subject.subjectId),
      tenantId: requiredText(subject.tenantId),
      type: requiredText(subject.type)
    }),
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
}: Record<string, any> = {}) : any {
  if (
    typeof revalidateCurrentAuthority !== "function" ||
    typeof now !== "function"
  ) {
    throw new TypeError("Final protected sink attempt dependencies are invalid.");
  }
  const issuedAt: any = Number(now());
  if (!Number.isFinite(issuedAt)) {
    throw new TypeError("Final protected sink attempt clock is invalid.");
  }
  const lifetime: any = Math.min(
    MAX_ATTEMPT_TTL_MS,
    Math.max(1, Number(ttlMs) || DEFAULT_ATTEMPT_TTL_MS)
  );
  const authority: any = normalizeAttemptAuthority({
    audience,
    subject,
    operationId,
    requestDigest,
    context
  });
  const attempt: any = Object.freeze(Object.create(null));
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

export async function claimFinalProtectedSinkAttempt({
  attempt,
  targetSelector,
  effect,
  resourceRevision,
  resolveCurrentResource
}: Record<string, any> = {}) : Promise<any> {
  if (
    !attempt ||
    (typeof attempt !== "object" && typeof attempt !== "function")
  ) {
    attemptReplayDenied();
  }
  const state: any = finalProtectedSinkAttempts.get(attempt);
  finalProtectedSinkAttempts.delete(attempt);
  if (!state) {
    attemptReplayDenied();
  }
  const consumedAt: any = Number(state.now());
  if (!Number.isFinite(consumedAt) || consumedAt >= state.expiresAt) {
    attemptReplayDenied();
  }
  if (aborted(state.signal)) {
    attemptDenied();
  }
  if (selectorDigest(targetSelector) !== state.targetSelectorDigest) {
    attemptDenied("final_protected_sink_permit_binding_invalid");
  }
  if (typeof resolveCurrentResource !== "function") {
    attemptDenied("final_protected_sink_permit_binding_invalid");
  }

  const binding: Readonly<Record<string, any>> = Object.freeze({
    audience: state.audience,
    subject: state.subject,
    operationId: state.operationId,
    effect,
    requestDigest: state.requestDigest,
    context: Object.freeze({
      ...state.context,
      resourceRevision
    })
  });
  const normalizedBinding: any = normalizeBinding(binding);
  let permit: any;
  try {
    permit = mintGovernedExecutionPermit({
      operationId: normalizedBinding.operationId,
      audience: normalizedBinding.audience,
      principal: normalizedBinding.subject,
      resource: {
        context: normalizedBinding.context,
        effect: normalizedBinding.effect
      },
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

  const guard: any = createFinalProtectedSinkPermitGuard({
    now: state.now,
    revalidateCurrentAuthority: async ({ consumptionReceipt }: Record<string, any>) : Promise<any> => {
      if (aborted(state.signal)) {
        return Object.freeze({
          allowed: false,
          revoked: false,
          currentBinding: normalizedBinding
        });
      }
      const authority: any = await state.revalidateCurrentAuthority(Object.freeze({
        binding: normalizedBinding,
        consumptionReceipt,
        signal: state.signal
      }));
      if (authority?.allowed !== true || authority?.revoked === true) {
        return Object.freeze({
          allowed: false,
          revoked: authority?.revoked === true,
          currentBinding: normalizedBinding
        });
      }
      if (aborted(state.signal)) {
        return Object.freeze({
          allowed: false,
          revoked: false,
          currentBinding: normalizedBinding
        });
      }
      const currentResource: any = await resolveCurrentResource(Object.freeze({
        binding: normalizedBinding,
        signal: state.signal
      }));
      if (aborted(state.signal)) {
        return Object.freeze({
          allowed: false,
          revoked: false,
          currentBinding: normalizedBinding
        });
      }
      return Object.freeze({
        allowed: true,
        revoked: false,
        currentBinding: Object.freeze({
          audience: normalizedBinding.audience,
          subject: authority.subject,
          operationId: normalizedBinding.operationId,
          effect: currentResource?.effect,
          requestDigest: normalizedBinding.requestDigest,
          context: Object.freeze({
            ...authority.context,
            resourceRevision: currentResource?.resourceRevision
          })
        })
      });
    }
  });
  return guard.consume({
    binding: normalizedBinding,
    permit
  });
}

export function createFinalProtectedSinkPermitGuard({
  revalidateCurrentAuthority,
  now = Date.now
}: Record<string, any> = {}) : any {
  if (typeof revalidateCurrentAuthority !== "function" || typeof now !== "function") {
    throw new TypeError("Final protected sink permit guard dependencies are invalid.");
  }

  async function consume({ permit, binding }: Record<string, any> = {}) : Promise<any> {
    if (typeof permit !== "string" || !permit.trim()) {
      deny(
        "final_protected_sink_permit_required",
        "A final protected sink permit is required."
      );
    }
    const normalizedBinding: any = normalizeBinding(binding);
    const consumptionReceipt: any = consumeGovernedExecutionPermit(
      permit,
      authorityBinding(normalizedBinding),
      Number(now())
    );
    let current: any;
    try {
      current = await revalidateCurrentAuthority(Object.freeze({
        binding: normalizedBinding,
        consumptionReceipt
      }));
    } catch {
      deny(
        "final_protected_sink_permit_denied",
        "Final protected sink authority was denied."
      );
    }
    if (current?.revoked === true) {
      deny(
        "final_protected_sink_permit_revoked",
        "Final protected sink authority was revoked."
      );
    }
    if (current?.allowed !== true) {
      deny(
        "final_protected_sink_permit_denied",
        "Final protected sink authority was denied."
      );
    }
    if (!currentBindingMatches(current.currentBinding, normalizedBinding)) {
      deny(
        "final_protected_sink_permit_current_binding_mismatch",
        "Final protected sink authority is stale."
      );
    }
    return consumptionReceipt;
  }

  return Object.freeze({ consume });
}

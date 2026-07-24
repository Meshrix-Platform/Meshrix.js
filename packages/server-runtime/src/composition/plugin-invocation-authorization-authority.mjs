import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SCHEMA = "meshrix.plugin-invocation-authorization/1";
const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 120_000;
const ALLOWED_AUDIENCES = new Set(["owner-process-identity", "controlled-execution"]);
const MAX_SPENT_NONCES = 16_384;

function text(value, max = 256) {
  const result = String(value || "").trim();
  return result.length <= max ? result : "";
}

function ownerScope(input = {}) {
  const ownerId = text(input.ownerId, 128);
  const ownerGenerationDigest = text(input.ownerGenerationDigest, 64);
  const ownerGeneration = Number(input.ownerGeneration);
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !/^[a-f0-9]{64}$/u.test(ownerGenerationDigest) ||
      !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1 ||
      input.lifecycleStatePort?.id !== "PluginLifecycleStatePort") {
    throw new TypeError("Plugin invocation authorization owner scope is invalid.");
  }
  return Object.freeze({ ownerId, ownerGenerationDigest, ownerGeneration, lifecycleStatePort: input.lifecycleStatePort });
}


function encoded(value) {
  return Buffer.from(canonicalJson(value)).toString("base64url");
}

function controlled(code) {
  return Object.assign(new Error("Plugin invocation authorization was denied."), { code });
}

async function assertActive(scope) {
  const ledger = await scope.lifecycleStatePort.readRecord("ledger");
  if (!ledger || ledger.pluginId !== scope.ownerId || ledger.state !== "active" ||
      ledger.generation !== scope.ownerGeneration) {
    throw controlled("plugin_invocation_owner_retired");
  }
}

export function createPluginInvocationAuthorizationAuthority({
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
  maxSpentNonces = 4096
} = {}) {
  const effectiveTtlMs = Math.min(MAX_TTL_MS, Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS));
  const spentCapacity = Number(maxSpentNonces);
  if (!Number.isSafeInteger(spentCapacity) || spentCapacity < 1 || spentCapacity > MAX_SPENT_NONCES) {
    throw new TypeError("Plugin invocation replay capacity is invalid.");
  }
  const secret = randomBytes(32);
  const owners = new Map();
  const spent = new Map();
  let nextSweepAt = Number.POSITIVE_INFINITY;
  let closed = false;

  const signature = (payload) => createHmac("sha256", secret).update(payload).digest();
  const ownerKey = (scope) => `${scope.ownerId}:${scope.ownerGenerationDigest}:${scope.ownerGeneration}`;

  function registerOwner(input = {}) {
    if (closed) throw controlled("plugin_invocation_authority_closed");
    const scope = ownerScope(input);
    const key = ownerKey(scope);
    const existing = owners.get(scope.ownerId);
    if (existing && ownerKey(existing) === key) return Object.freeze({ id: "PluginInvocationAuthorizationOwnerRegistration", ...existing });
    if (existing && (scope.ownerGeneration < existing.ownerGeneration ||
        (scope.ownerGeneration === existing.ownerGeneration && scope.ownerGenerationDigest !== existing.ownerGenerationDigest))) {
      throw controlled("plugin_invocation_owner_generation_regression");
    }
    owners.set(scope.ownerId, scope);
    return Object.freeze({ id: "PluginInvocationAuthorizationOwnerRegistration", ...scope });
  }

  async function issue(input = {}) {
    if (closed) throw controlled("plugin_invocation_authority_closed");
    const ownerId = text(input.pluginId, 128);
    const scope = owners.get(ownerId);
    if (!scope) throw controlled("plugin_invocation_owner_unregistered");
    await assertActive(scope);
    const operationId = text(input.operationId, 256);
    const targetRef = text(input.targetRef, 256);
    const requestRef = text(input.requestRef, 256);
    const sourceRequestDigest = text(input.sourceRequestDigest, 64);
    const principalInput = input.principal && typeof input.principal === "object" ? input.principal : {};
    const governanceInput = input.governance && typeof input.governance === "object" ? input.governance : {};
    const principal = Object.freeze({
      subjectRef: text(principalInput.subjectRef),
      tenantRef: text(principalInput.tenantRef),
      workspaceRef: text(principalInput.workspaceRef),
      operationRef: operationId
    });
    const issuedAt = Number(now());
    if (!Number.isFinite(issuedAt)) throw controlled("plugin_invocation_clock_invalid");
    const suppliedApprovalExpiresAt = Date.parse(text(governanceInput.approvalExpiresAt, 64));
    const effectiveApprovalExpiresAt = text(governanceInput.approvalRef) && Number.isFinite(suppliedApprovalExpiresAt)
      ? new Date(Math.min(suppliedApprovalExpiresAt, issuedAt + effectiveTtlMs)).toISOString()
      : "";
    const governance = Object.freeze({
      grantRef: text(governanceInput.grantRef),
      approvalRef: text(governanceInput.approvalRef),
      approvalBindingDigest: text(governanceInput.approvalBindingDigest, 64),
      approvalSourceDigest: sourceRequestDigest,
      approvalRequestDigest: "",
      approvalExpiresAt: effectiveApprovalExpiresAt,
      authorizationContextDigest: createHash("sha256").update(canonicalJson({
        ownerId,
        operationId,
        targetRef,
        requestRef,
        sourceRequestDigest,
        principal,
        grantRef: text(governanceInput.grantRef),
        approvalRef: text(governanceInput.approvalRef),
        approvalBindingDigest: text(governanceInput.approvalBindingDigest, 64),
        riskDecisionRef: text(governanceInput.riskDecisionRef),
        policyRevision: text(governanceInput.policyRevision),
        scopes: Array.isArray(governanceInput.scopes) ? governanceInput.scopes : [],
        toolsets: Array.isArray(governanceInput.toolsets) ? governanceInput.toolsets : [],
        toolAllow: Array.isArray(governanceInput.toolAllow) ? governanceInput.toolAllow : [],
        capabilities: Array.isArray(governanceInput.capabilities) ? governanceInput.capabilities : [],
        receiptDigest: text(governanceInput.receiptDigest, 128)
      })).digest("hex"),
      riskDecisionRef: text(governanceInput.riskDecisionRef),
      policyRevision: text(governanceInput.policyRevision),
      authorized: governanceInput.authorized === true,
      current: governanceInput.current === true,
      revoked: governanceInput.revoked === true
    });
    const approvalExpiresAt = Date.parse(governance.approvalExpiresAt);
    const approvalFactsValid = !governance.approvalRef || (
      /^[a-f0-9]{64}$/u.test(governance.approvalBindingDigest) &&
      Number.isFinite(approvalExpiresAt) &&
      approvalExpiresAt > issuedAt
    );
    if (!operationId || !requestRef || !/^[a-f0-9]{64}$/u.test(sourceRequestDigest) || !principal.subjectRef ||
        !principal.tenantRef || !governance.grantRef || !governance.riskDecisionRef || !governance.policyRevision ||
        governance.authorized !== true || governance.current !== true || governance.revoked === true ||
        !approvalFactsValid) {
      throw controlled("plugin_invocation_authorization_facts_invalid");
    }
    const claims = Object.freeze({
      schemaVersion: SCHEMA,
      ownerId: scope.ownerId,
      ownerGenerationDigest: scope.ownerGenerationDigest,
      ownerGeneration: scope.ownerGeneration,
      operationId,
      targetRef,
      requestRef,
      sourceRequestDigest,
      principal,
      governance,
      issuedAt,
      expiresAt: issuedAt + effectiveTtlMs,
      nonce: randomBytes(16).toString("base64url")
    });
    const payload = encoded(claims);
    return `${payload}.${signature(payload).toString("base64url")}`;
  }

  async function verify(token, expected = {}) {
    if (closed) throw controlled("plugin_invocation_authority_closed");
    const serialized = String(token || "");
    if (serialized.length === 0 || serialized.length > 16_384) throw controlled("plugin_invocation_token_invalid");
    const [payload, suppliedSignature, extra] = serialized.split(".");
    if (!payload || !suppliedSignature || extra) throw controlled("plugin_invocation_token_invalid");
    const actual = Buffer.from(suppliedSignature, "base64url");
    const wanted = signature(payload);
    if (actual.toString("base64url") !== suppliedSignature || actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
      throw controlled("plugin_invocation_token_invalid");
    }
    let claims;
    try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw controlled("plugin_invocation_token_invalid"); }
    const scope = owners.get(String(claims.ownerId || ""));
    const issuedAt = Number(claims?.issuedAt);
    const expiresAt = Number(claims?.expiresAt);
    const currentTime = Number(now());
    const audience = text(expected.audience, 64);
    const principal = claims?.principal;
    const governance = claims?.governance;
    if (!ALLOWED_AUDIENCES.has(audience)) throw controlled("plugin_invocation_audience_invalid");
    if (claims.schemaVersion !== SCHEMA || !scope || claims.ownerGenerationDigest !== scope.ownerGenerationDigest ||
        claims.ownerGeneration !== scope.ownerGeneration || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) ||
        expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS || !Number.isFinite(currentTime) || expiresAt <= currentTime ||
        !/^[a-f0-9]{64}$/u.test(String(claims.sourceRequestDigest || "")) || !text(claims.operationId) ||
        !text(claims.requestRef) || !/^[A-Za-z0-9_-]{16,64}$/u.test(String(claims.nonce || "")) ||
        !principal || !text(principal.subjectRef) || !text(principal.tenantRef) || principal.operationRef !== claims.operationId ||
        !governance || !text(governance.grantRef) || !text(governance.riskDecisionRef) || !text(governance.policyRevision) ||
        governance.authorized !== true || governance.current !== true || governance.revoked !== false) {
      throw controlled(Number.isFinite(expiresAt) && Number.isFinite(currentTime) && expiresAt <= currentTime
        ? "plugin_invocation_token_expired" : "plugin_invocation_token_invalid");
    }
    for (const [field, claimField] of [["ownerId", "ownerId"], ["ownerGenerationDigest", "ownerGenerationDigest"],
      ["ownerGeneration", "ownerGeneration"], ["operationId", "operationId"]]) {
      if (expected[field] !== undefined && String(expected[field]) !== String(claims[claimField])) {
        throw controlled(`plugin_invocation_${field.replace(/[A-Z]/g, (entry) => `_${entry.toLowerCase()}`)}_mismatch`);
      }
    }
    if (expected.targetRef !== undefined && claims.targetRef) {
      const wantedTarget = String(expected.targetRef);
      if (claims.targetRef !== wantedTarget) throw controlled("plugin_invocation_target_ref_mismatch");
    }
    if (expected.requestRef !== undefined && String(expected.requestRef) !== String(claims.requestRef)) {
      throw controlled("plugin_invocation_request_ref_mismatch");
    }
    if (expected.sourceRequestDigest !== undefined && String(expected.sourceRequestDigest) !== String(claims.sourceRequestDigest)) {
      throw controlled("plugin_invocation_source_request_digest_mismatch");
    }
    await assertActive(scope);
    if (currentTime >= nextSweepAt) {
      nextSweepAt = Number.POSITIVE_INFINITY;
      for (const [nonce, record] of spent) {
        if (record.expiresAt <= currentTime) spent.delete(nonce);
        else nextSweepAt = Math.min(nextSweepAt, record.expiresAt);
      }
    }
    const spentRecord = spent.get(claims.nonce);
    if (spentRecord?.audiences.has(audience)) throw controlled("plugin_invocation_token_replayed");
    if (!spentRecord && spent.size >= spentCapacity) {
      throw controlled("plugin_invocation_replay_capacity_exhausted");
    }
    const audiences = spentRecord?.audiences || new Set();
    audiences.add(audience);
    spent.set(claims.nonce, { expiresAt, audiences });
    nextSweepAt = Math.min(nextSweepAt, expiresAt);
    return Object.freeze({ ...claims, principal: Object.freeze({ ...claims.principal }), governance: Object.freeze({ ...claims.governance }) });
  }

  return Object.freeze({
    id: "PluginInvocationAuthorizationAuthority",
    registerOwner,
    hasOwner(pluginId) { return owners.has(text(pluginId, 128)); },
    issue,
    verify,
    close() {
      closed = true;
      owners.clear();
      spent.clear();
      nextSweepAt = Number.POSITIVE_INFINITY;
      secret.fill(0);
    }
  });
}

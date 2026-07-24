import crypto from "node:crypto";
import { clientIpFromRequest } from "@meshrix/foundation/security/trusted-client-ip";

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

export function parseJsonObject(value) {
  if (!value) {
    return {};
  }
  if (Buffer.isBuffer(value)) {
    return value.length ? parseJsonObject(value.toString("utf8")) : {};
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return {};
    }
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function trustedApprovedPendingOperation(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return String(value.pendingOperationId || "").trim() ? value : null;
}

export function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function sameStringSet(left = [], right = []) {
  const normalizedLeft = uniqueStrings(left).sort();
  const normalizedRight = uniqueStrings(right).sort();
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function approvalLayers(value = {}) {
  return uniqueStrings(value?.approvalLayers || value?.requiredApproval?.approvalLayers || []);
}

export function approvalAlreadySatisfiesPolicy(policy = {}, approvedPendingOperation = null) {
  const trustedApproval = trustedApprovedPendingOperation(approvedPendingOperation);
  if (!trustedApproval) {
    return false;
  }
  const policyApprovalLayers = approvalLayers(policy.requiredApproval);
  const approvedApprovalLayers = approvalLayers(trustedApproval);
  return policyApprovalLayers.length === 0 || sameStringSet(policyApprovalLayers, approvedApprovalLayers);
}

export function pendingResumeInput(input = {}, operationId = "") {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const output = sanitizePendingResumeValue(source);
  const id = String(operationId || "");
  if ((id.endsWith(".file.move") || id.endsWith(".item.move")) && output.sourcePath && !output.from) {
    output.from = output.sourcePath;
  }
  for (const key of [
    "sourcePath",
    "source-path",
    "localPath",
    "local-path",
    "dirPath",
    "dir-path",
    "content",
    "contentBase64",
    "content-base64",
    "fileContent",
    "rawContent"
  ]) {
    if (Object.hasOwn(output, key)) {
      output[key] = "<redacted>";
    }
  }
  return output;
}

const PENDING_RESUME_SECRET_KEY_PATTERN =
  /token|secret|password|passwd|authorization|cookie|api[-_]?key|client[-_]?secret|csrf|sourceMcpConfig|sourceMcpToken|upstreamToken|delegatedMcpToken|delegatedMcpAccessToken/i;
const PENDING_RESUME_SECRET_VALUE_PATTERN =
  /(Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9._-]+|xox[baprs]-[A-Za-z0-9-]+|(?:(?:api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s"',;]+)/gi;
const PENDING_RESUME_OPAQUE_REFERENCE_LIST_KEYS = new Set(["secretRefs", "secret-refs"]);

function opaqueReferenceList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : "<redacted>";
}

function sanitizePendingResumeValue(value, depth = 0) {
  if (depth > 8) {
    return "<redacted-depth>";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.replace(PENDING_RESUME_SECRET_VALUE_PATTERN, (match) => {
      const prefix = match.match(/^\s*(api[-_]?key|token|secret|password)\s*[:=]/i)?.[0] || "";
      return prefix ? `${prefix}<redacted>` : "<redacted-secret>";
    });
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return {
      redacted: true,
      reason: "buffer",
      byteLength: value.length,
      sha256: crypto.createHash("sha256").update(value).digest("hex")
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePendingResumeValue(item, depth + 1));
  }
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = PENDING_RESUME_OPAQUE_REFERENCE_LIST_KEYS.has(key)
      ? opaqueReferenceList(nested)
      : PENDING_RESUME_SECRET_KEY_PATTERN.test(key)
        ? "<redacted>"
        : sanitizePendingResumeValue(nested, depth + 1);
  }
  return output;
}



export function policyRevisionSummary(policy = {}) {
  const revision = policy.governancePolicyRevision &&
    typeof policy.governancePolicyRevision === "object" &&
    !Array.isArray(policy.governancePolicyRevision)
    ? policy.governancePolicyRevision
    : {};
  return {
    decisionId: policy.decisionId || "",
    effect: policy.effect || "",
    reasonCode: policy.reasonCode || "",
    grantPolicyRevision: Number(policy.grantPolicyRevision || 0),
    grantPolicyState: String(policy.grantPolicyState || ""),
    governancePolicyRevision: {
      protocolVersion: String(revision.protocolVersion || ""),
      revision: Number(revision.revision || 0),
      updatedAt: String(revision.updatedAt || "")
    }
  };
}

export function sourceIpFromRequest(request) {
  return clientIpFromRequest(request);
}

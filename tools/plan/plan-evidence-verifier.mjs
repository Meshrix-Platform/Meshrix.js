import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function isContained(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonical = new Date(timestamp).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z");
}

function assertExactKeys(value, allowed, message) {
  requireCondition(
    Object.keys(value).every((key) => allowed.has(key)),
    message,
  );
}

async function verifyFileEvidence({ repoRoot, realRepoRoot, ref }) {
  const declaredPath = ref.path;
  requireCondition(
    typeof declaredPath === "string" &&
      declaredPath.length > 0 &&
      !path.posix.isAbsolute(declaredPath) &&
      !declaredPath.includes("\\") &&
      !CONTROL_PATTERN.test(declaredPath) &&
      path.posix.normalize(declaredPath) === declaredPath &&
      declaredPath.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Plan file evidence path is invalid",
  );
  requireCondition(SHA256_PATTERN.test(ref.sha256), "Plan file evidence digest is invalid");

  const resolved = path.resolve(repoRoot, ...declaredPath.split("/"));
  requireCondition(isContained(repoRoot, resolved), "Plan file evidence escapes the repository");

  let stat;
  let realEvidencePath;
  let content;
  try {
    stat = await fs.lstat(resolved);
  } catch {
    throw new Error("Plan file evidence is unavailable");
  }
  requireCondition(!stat.isSymbolicLink() && stat.isFile(), "Plan file evidence is not a regular file");
  try {
    realEvidencePath = await fs.realpath(resolved);
  } catch {
    throw new Error("Plan file evidence is unavailable");
  }
  requireCondition(isContained(realRepoRoot, realEvidencePath), "Plan file evidence escapes the repository");
  try {
    content = await fs.readFile(realEvidencePath);
  } catch {
    throw new Error("Plan file evidence is unavailable");
  }
  requireCondition(
    crypto.createHash("sha256").update(content).digest("hex") === ref.sha256,
    "Plan file evidence digest is stale",
  );
}

export async function verifyPlanEvidenceCurrent({ repoRoot, finalNode } = {}) {
  requireCondition(typeof repoRoot === "string" && path.isAbsolute(repoRoot), "Plan evidence repository root is invalid");
  const refs = (finalNode?.acceptance_criteria ?? []).flatMap((criterion) => criterion.evidence_refs ?? []);
  requireCondition(refs.length > 0, "Plan evidence set is empty");

  let realRepoRoot;
  try {
    realRepoRoot = await fs.realpath(repoRoot);
  } catch {
    throw new Error("Plan evidence repository root is unavailable");
  }

  let fileCount = 0;
  let commandCount = 0;
  for (const ref of refs) {
    requireCondition(ref && typeof ref === "object" && !Array.isArray(ref), "Plan evidence reference is invalid");
    requireCondition(isCanonicalTimestamp(ref.recorded_at), "Plan evidence timestamp is invalid");

    if (ref.type === "file") {
      assertExactKeys(
        ref,
        new Set(["type", "path", "sha256", "recorded_at"]),
        "Plan file evidence contains unsupported fields",
      );
      await verifyFileEvidence({ repoRoot, realRepoRoot, ref });
      fileCount += 1;
      continue;
    }
    if (ref.type === "command") {
      assertExactKeys(
        ref,
        new Set(["type", "command_sha256", "exit_code", "recorded_at"]),
        "Plan command evidence contains unsupported fields",
      );
      requireCondition(SHA256_PATTERN.test(ref.command_sha256), "Plan command evidence digest is invalid");
      requireCondition(ref.exit_code === 0, "Plan command evidence did not succeed");
      commandCount += 1;
      continue;
    }
    throw new Error("Plan evidence type is unsupported");
  }

  return Object.freeze({ evidenceCount: refs.length, fileCount, commandCount });
}

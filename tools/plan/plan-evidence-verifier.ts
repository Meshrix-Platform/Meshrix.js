import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hasControlCharacter, isJsonRecord } from "./plan-types.ts";

interface FileEvidenceRef {
  type: "file";
  path: string;
  sha256: string;
  recorded_at: string;
}

interface CommandEvidenceRef {
  type: "command";
  command_sha256: string;
  exit_code: number;
  recorded_at: string;
}
const SHA256_PATTERN  = /^[a-f0-9]{64}$/u;

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isContained(parent: string, candidate: string): boolean {
  const relative  = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const timestamp  = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonical  = new Date(timestamp).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z");
}

function assertExactKeys(value: object, allowed: ReadonlySet<string>, message: string): void {
  requireCondition(
    Object.keys(value).every((key) => allowed.has(key)),
    message,
  );
}

async function verifyFileEvidence({ repoRoot, realRepoRoot, ref }: {
  repoRoot: string;
  realRepoRoot: string;
  ref: FileEvidenceRef;
}): Promise<void> {
  const declaredPath  = ref.path;
  requireCondition(
    typeof declaredPath === "string" &&
      declaredPath.length > 0 &&
      !path.posix.isAbsolute(declaredPath) &&
      !declaredPath.includes("\\") &&
      !hasControlCharacter(declaredPath) &&
      path.posix.normalize(declaredPath) === declaredPath &&
      declaredPath.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Plan file evidence path is invalid",
  );
  requireCondition(SHA256_PATTERN.test(ref.sha256), "Plan file evidence digest is invalid");

  const resolved  = path.resolve(repoRoot, ...declaredPath.split("/"));
  requireCondition(isContained(repoRoot, resolved), "Plan file evidence escapes the repository");

  let stat ;
  let realEvidencePath ;
  let content ;
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

export async function verifyPlanEvidenceCurrent({ repoRoot, finalNode }: {
  repoRoot?: string;
  finalNode?: unknown;
} = {}) {
  requireCondition(typeof repoRoot === "string" && path.isAbsolute(repoRoot), "Plan evidence repository root is invalid");
  requireCondition(isJsonRecord(finalNode), "Plan final node is invalid");
  const criteria = Array.isArray(finalNode.acceptance_criteria) ? finalNode.acceptance_criteria : [];
  const refs = criteria.flatMap((criterion) =>
    isJsonRecord(criterion) && Array.isArray(criterion.evidence_refs)
      ? criterion.evidence_refs
      : []
  );
  requireCondition(refs.length > 0, "Plan evidence set is empty");

  let realRepoRoot ;
  try {
    realRepoRoot = await fs.realpath(repoRoot);
  } catch {
    throw new Error("Plan evidence repository root is unavailable");
  }

  let fileCount  = 0;
  let commandCount  = 0;
  for (const candidate of refs) {
    requireCondition(isJsonRecord(candidate), "Plan evidence reference is invalid");
    requireCondition(isCanonicalTimestamp(candidate.recorded_at), "Plan evidence timestamp is invalid");

    if (candidate.type === "file") {
      requireCondition(typeof candidate.path === "string" && typeof candidate.sha256 === "string", "Plan file evidence reference is invalid");
      const ref: FileEvidenceRef = { type: "file", path: candidate.path, sha256: candidate.sha256, recorded_at: candidate.recorded_at };
      assertExactKeys(
        candidate,
        new Set(["type", "path", "sha256", "recorded_at"]),
        "Plan file evidence contains unsupported fields",
      );
      await verifyFileEvidence({ repoRoot, realRepoRoot, ref });
      fileCount += 1;
      continue;
    }
    if (candidate.type === "command") {
      requireCondition(typeof candidate.command_sha256 === "string" && typeof candidate.exit_code === "number", "Plan command evidence reference is invalid");
      const ref: CommandEvidenceRef = { type: "command", command_sha256: candidate.command_sha256, exit_code: candidate.exit_code, recorded_at: candidate.recorded_at };
      assertExactKeys(
        candidate,
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

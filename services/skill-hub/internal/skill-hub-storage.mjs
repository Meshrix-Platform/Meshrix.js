import path from "node:path";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE
} from "./skill-hub-contracts.mjs";
import { requiredWorkspaceId } from "./operation-helpers.mjs";

export const SKILL_HUB_STORAGE_ROOT_DIR = "SkillHub";
export const SKILL_HUB_SKILL_STORAGE_DIR = path.posix.join(SKILL_HUB_STORAGE_ROOT_DIR, "skills");
export const SKILL_HUB_DIRECTORY_MODE = PRIVATE_DIRECTORY_MODE;
export const SKILL_HUB_FILE_MODE = PRIVATE_FILE_MODE;

export function isSkillHubStorageRelativePath(value = "") {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  return normalized === SKILL_HUB_STORAGE_ROOT_DIR ||
    normalized.startsWith(`${SKILL_HUB_STORAGE_ROOT_DIR}/`);
}

export function skillHubAssetRelativePath({ workspaceId, contributionId, relation = "canonical", safePathSegment } = {}) {
  const skillId = safePathSegment(contributionId || "asset");
  const relationSegment = safePathSegment(relation || "canonical");
  if (relationSegment === "adoption") {
    return path.posix.join(
      SKILL_HUB_SKILL_STORAGE_DIR,
      skillId,
      "adoptions",
      safePathSegment(requiredWorkspaceId(workspaceId, "targetWorkspaceId")),
      "asset.json"
    );
  }
  return path.posix.join(SKILL_HUB_SKILL_STORAGE_DIR, skillId, relationSegment, "asset.json");
}

export function skillHubSandboxPolicy() {
  return {
    storageRoot: SKILL_HUB_STORAGE_ROOT_DIR,
    serverExecution: "blocked",
    uploadTrust: "untrusted",
    directoryMode: "0700",
    fileMode: "0600",
    executableBitsAllowed: false
  };
}

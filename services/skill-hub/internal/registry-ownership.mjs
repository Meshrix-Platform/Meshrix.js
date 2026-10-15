import crypto from "node:crypto";

export function registryResource(workspaceId, tenantRef) {
  const id = crypto.createHash("sha256")
    .update(`skill-hub-registry\0${tenantRef}\0${workspaceId}`).digest("hex");
  return `SkillHub/registries/${id}.json`;
}

export function unownedRegistryResource(workspaceId) {
  return `SkillHub/registries/${crypto.createHash("sha256").update(workspaceId).digest("hex")}.json`;
}

// Historical records contain no tenant authority. Only an operator's explicit
// ownership assignment may relocate them; request identities cannot claim them.
export async function relocateOwnedRegistries(serviceData, assignments) {
  if (!Array.isArray(assignments)) throw new TypeError("Registry ownership assignments must be an array.");
  const workspaces = new Set();
  for (const entry of assignments) {
    if (!entry || Object.keys(entry).some((key) => !["workspaceId", "tenantRef"].includes(key)) ||
        typeof entry.workspaceId !== "string" || !entry.workspaceId || entry.workspaceId.length > 256 ||
        /[\u0000-\u001f\u007f/\\]/u.test(entry.workspaceId) ||
        !/^skill_hub_tenant_[a-f0-9]{64}$/u.test(entry.tenantRef) || workspaces.has(entry.workspaceId)) {
      throw new TypeError("Registry ownership assignment is invalid or ambiguous.");
    }
    workspaces.add(entry.workspaceId);
  }
  const conflicts = new Set();
  for (const { workspaceId, tenantRef } of assignments) {
    const destination = registryResource(workspaceId, tenantRef);
    try {
      await serviceData.relocateFile(unownedRegistryResource(workspaceId), destination);
    } catch (error) {
      if (error?.code !== "skill_hub_registry_ownership_conflict") throw error;
      conflicts.add(destination);
    }
  }
  return conflicts;
}

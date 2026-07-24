export function buildOperationPermissionClientConnectionRows(
  toolSkillManagementProvider,
  { offlineAfterSeconds = 0 } = {}
) {
  if (typeof toolSkillManagementProvider?.listMcpClientConnections !== "function") {
    return [];
  }
  try {
    return toolSkillManagementProvider.listMcpClientConnections({ offlineAfterSeconds });
  } catch {
    return [];
  }
}

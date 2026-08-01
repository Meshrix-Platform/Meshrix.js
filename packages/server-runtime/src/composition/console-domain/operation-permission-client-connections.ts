export function buildOperationPermissionClientConnectionRows(
  toolSkillManagementProvider?: any,
  { offlineAfterSeconds = 0 }: Record<string, any> = {}
) : any {
  if (typeof toolSkillManagementProvider?.listMcpClientConnections !== "function") {
    return [];
  }
  try {
    return toolSkillManagementProvider.listMcpClientConnections({ offlineAfterSeconds });
  } catch {
    return [];
  }
}

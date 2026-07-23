export async function buildRuntimeConsoleSummary({
  moduleManagement = null,
  settings = {},
  features = null,
  listAvailableAnalysisModules = async () => []
}) {
  if (!moduleManagement?.buildRuntimeConsoleSummary) {
    return null;
  }
  return moduleManagement.buildRuntimeConsoleSummary({
    settings,
    features,
    listAvailableAnalysisModules
  });
}

export async function buildRuntimeConsoleSummary({
  moduleManagement = null,
  settings = {},
  features = null,
  listAvailableAnalysisModules = async () : Promise<any> => []
}: Record<string, any>) : Promise<any> {
  if (!moduleManagement?.buildRuntimeConsoleSummary) {
    return null;
  }
  return moduleManagement.buildRuntimeConsoleSummary({
    settings,
    features,
    listAvailableAnalysisModules
  });
}

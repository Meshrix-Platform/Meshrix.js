export function pluginConsoleEntry(workflow = {}, pluginConsoleEntries = []) {
  if (!workflow.pluginId) return null;
  return pluginConsoleEntries.find((entry) => (
    entry.pluginId === workflow.pluginId && workflow.viewKeys.includes(entry.viewKey)
  )) || null;
}

export function routePathFromViewKey(viewKey, pluginConsoleEntries = [], adminRouteRegistry = []) {
  const entry = adminRouteRegistry.find((item) => item.viewKey === viewKey);
  if (entry) return `/admin/${entry.slug}`;
  return pluginConsoleEntries.find((item) => item.viewKey === viewKey)?.routePath || "";
}

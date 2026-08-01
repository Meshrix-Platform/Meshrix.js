export function pluginConsoleEntry(workflow: Record<string, any> = {}, pluginConsoleEntries: any = []) : any {
  if (!workflow.pluginId) return null;
  return pluginConsoleEntries.find((entry?: any) : any => (
    entry.pluginId === workflow.pluginId && workflow.viewKeys.includes(entry.viewKey)
  )) || null;
}

export function routePathFromViewKey(viewKey?: any, pluginConsoleEntries: any = [], adminRouteRegistry: any = []) : any {
  const entry: any = adminRouteRegistry.find((item?: any) : any => item.viewKey === viewKey);
  if (entry) return `/admin/${entry.slug}`;
  return pluginConsoleEntries.find((item?: any) : any => item.viewKey === viewKey)?.routePath || "";
}

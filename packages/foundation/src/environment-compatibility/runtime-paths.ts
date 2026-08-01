import path from "node:path";

function text(value?: any) : any {
  return String(value ?? "").trim();
}

export function safeRuntimeAlias(alias: any = "default") : any {
  return text(alias || "default").replace(/[^a-zA-Z0-9._:-]/g, "_") || "default";
}

export function runtimeStateDir({
  dataDir = "",
  category = "runtime",
  namespace = "state",
  alias = "default"
}: Record<string, any> = {}) : any {
  return path.join(path.resolve(text(dataDir) || "."), safeRuntimeAlias(category), safeRuntimeAlias(namespace), safeRuntimeAlias(alias));
}

export function runtimeStatePath({
  dataDir = "",
  category = "runtime",
  namespace = "state",
  alias = "default",
  fileName = "state.json"
}: Record<string, any> = {}) : any {
  return path.join(runtimeStateDir({ dataDir, category, namespace, alias }), safeRuntimeAlias(fileName));
}

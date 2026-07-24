import path from "node:path";

function text(value) {
  return String(value ?? "").trim();
}

export function safeRuntimeAlias(alias = "default") {
  return text(alias || "default").replace(/[^a-zA-Z0-9._:-]/g, "_") || "default";
}

export function runtimeStateDir({
  dataDir = "",
  category = "runtime",
  namespace = "state",
  alias = "default"
} = {}) {
  return path.join(path.resolve(text(dataDir) || "."), safeRuntimeAlias(category), safeRuntimeAlias(namespace), safeRuntimeAlias(alias));
}

export function runtimeStatePath({
  dataDir = "",
  category = "runtime",
  namespace = "state",
  alias = "default",
  fileName = "state.json"
} = {}) {
  return path.join(runtimeStateDir({ dataDir, category, namespace, alias }), safeRuntimeAlias(fileName));
}

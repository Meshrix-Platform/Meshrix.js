import path from "node:path";

interface RuntimePathOptions {
  dataDir?: string;
  category?: string;
  namespace?: string;
  alias?: string;
  fileName?: string;
}

function text(value?: unknown): string {
  return String(value ?? "").trim();
}

export function safeRuntimeAlias(alias: unknown = "default"): string {
  return text(alias || "default").replace(/[^a-zA-Z0-9._:-]/g, "_") || "default";
}

export function runtimeStateDir({
  dataDir = "",
  category = "runtime",
  namespace = "state",
  alias = "default"
}: RuntimePathOptions = {}): string {
  return path.join(path.resolve(text(dataDir) || "."), safeRuntimeAlias(category), safeRuntimeAlias(namespace), safeRuntimeAlias(alias));
}

export function runtimeStatePath({
  dataDir = "",
  category = "runtime",
  namespace = "state",
  alias = "default",
  fileName = "state.json"
}: RuntimePathOptions = {}): string {
  return path.join(runtimeStateDir({ dataDir, category, namespace, alias }), safeRuntimeAlias(fileName));
}

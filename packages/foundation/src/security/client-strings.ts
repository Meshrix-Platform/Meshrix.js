import { createHash } from "node:crypto";
import path from "node:path";

const TOKEN_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*_[a-f0-9]{32}$/;

function normalizeNamespace(namespace: unknown = "server"): string {
  return String(namespace || "server")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "server";
}

export function hashClientString(value?: unknown, namespace: unknown = "client"): string {
  return createHash("sha256")
    .update(normalizeNamespace(namespace))
    .update("\0")
    .update(String(value ?? ""))
    .digest("hex");
}

export function serverToken(namespace: unknown, ...values: unknown[]): string {
  const normalizedNamespace = normalizeNamespace(namespace);
  const digest = createHash("sha256");
  digest.update(normalizedNamespace);
  for (const value of values) {
    digest.update("\0");
    digest.update(String(value ?? ""));
  }
  return `${normalizedNamespace}_${digest.digest("hex").slice(0, 32)}`;
}

export function isServerToken(value?: unknown, namespace: unknown = ""): boolean {
  const text = String(value || "");
  if (!TOKEN_PATTERN.test(text)) {
    return false;
  }

  const normalizedNamespace = namespace ? `${normalizeNamespace(namespace)}_` : "";
  return normalizedNamespace ? text.startsWith(normalizedNamespace) : true;
}

export function assertServerToken(value?: unknown, namespace: unknown = ""): string {
  const text = String(value || "");
  if (!isServerToken(text, namespace)) {
    throw new Error(`${namespace || "server"} token 格式无效。`);
  }
  return text;
}

export function resolveWithin(rootPath: string, ...parts: unknown[]): string {
  const root = path.resolve(rootPath);
  const target = path.resolve(root, ...parts.map((part) => String(part || "")));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("路径越界，已拒绝。");
  }
  return target;
}

export function rejectClientSuppliedStrings(value: unknown, context: string): void {
  const entries: [string, unknown][] =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value)
      : [];
  const hasString = entries.some(([, item]) => typeof item === "string" && Boolean(item.trim()));
  if (hasString) {
    throw new Error(`${context} 不接受客户端传入的可执行字符串。`);
  }
}

import { createHash } from "node:crypto";
import path from "node:path";

const TOKEN_PATTERN: any = /^[a-z0-9]+(?:_[a-z0-9]+)*_[a-f0-9]{32}$/;

function normalizeNamespace(namespace?: any) : any {
  return String(namespace || "server")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "server";
}

export function hashClientString(value?: any, namespace: any = "client") : any {
  return createHash("sha256")
    .update(normalizeNamespace(namespace))
    .update("\0")
    .update(String(value ?? ""))
    .digest("hex");
}

export function serverToken(namespace: any, ...values: any[]) : any {
  const normalizedNamespace: any = normalizeNamespace(namespace);
  const digest: any = createHash("sha256");
  digest.update(normalizedNamespace);
  for (const value of values) {
    digest.update("\0");
    digest.update(String(value ?? ""));
  }
  return `${normalizedNamespace}_${digest.digest("hex").slice(0, 32)}`;
}

export function isServerToken(value?: any, namespace: any = "") : any {
  const text: any = String(value || "");
  if (!TOKEN_PATTERN.test(text)) {
    return false;
  }

  const normalizedNamespace: any = namespace ? `${normalizeNamespace(namespace)}_` : "";
  return normalizedNamespace ? text.startsWith(normalizedNamespace) : true;
}

export function assertServerToken(value?: any, namespace: any = "") : any {
  const text: any = String(value || "");
  if (!isServerToken(text, namespace)) {
    throw new Error(`${namespace || "server"} token 格式无效。`);
  }
  return text;
}

export function resolveWithin(rootPath: any, ...parts: any[]) : any {
  const root: any = path.resolve(rootPath);
  const target: any = path.resolve(root, ...parts.map((part?: any) : any => String(part || "")));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("路径越界，已拒绝。");
  }
  return target;
}

export function rejectClientSuppliedStrings(value?: any, context?: any) : any {
  const entries: any =
    value && typeof value === "object" && !Array.isArray(value)
      ? (Object.entries(value) as [string, any][])
      : [];
  const hasString: any = entries.some(([, item]: any[]) : any => typeof item === "string" && item.trim());
  if (hasString) {
    throw new Error(`${context} 不接受客户端传入的可执行字符串。`);
  }
}

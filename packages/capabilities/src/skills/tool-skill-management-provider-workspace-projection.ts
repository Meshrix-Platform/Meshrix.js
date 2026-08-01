export function workspaceName(workspace: Record<string, any> = {}) : any {
  return String(workspace.name || workspace.title || workspace.workspaceName || "").trim();
}

export function publicWorkspaceRef(index?: any) : any {
  return `workspace-${index + 1}`;
}

export function workspaceDirectoryFromWorkspaces(workspaces: any = []) : any {
  const entries: any[] = [];
  const byId: any = new Map<any, any>();
  const byRef: any = new Map<any, any>();
  const byName: any = new Map<any, any>();
  workspaces.forEach((workspace?: any, index?: any) : any => {
    const id: any = String(workspace?.workspaceId || "").trim();
    if (!id) {
      return;
    }
    const entry: Record<string, any> = {
      id,
      ref: publicWorkspaceRef(index),
      index: index + 1,
      name: workspaceName(workspace)
    };
    entries.push(entry);
    byId.set(id, entry);
    byRef.set(entry.ref.toLowerCase(), entry);
    byRef.set(String(entry.index), entry);
    if (entry.name) {
      byName.set(entry.name.toLowerCase(), entry);
    }
  });
  return { entries, byId, byRef, byName };
}

export function collectWorkspaces(value?: any, output: any = []) : any {
  if (!value || typeof value !== "object") {
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectWorkspaces(item, output);
    }
    return output;
  }
  if (Array.isArray(value.workspaces)) {
    output.push(...value.workspaces.filter((item?: any) : any => item && typeof item === "object"));
  }
  for (const child of (Object.values(value) as any[])) {
    if (child && typeof child === "object") {
      collectWorkspaces(child, output);
    }
  }
  return output;
}

export function executeToolPayload(result: Record<string, any> = {}) : any {
  return result.payload?.result !== undefined ? result.payload.result : result.payload;
}

export function resolveWorkspaceReference(directory?: any, value?: any) : any {
  const raw: any = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  if (directory.byId.has(raw)) {
    return raw;
  }
  const byRef: any = directory.byRef.get(raw.toLowerCase());
  if (byRef) {
    return byRef.id;
  }
  const byName: any = directory.byName.get(raw.toLowerCase());
  if (byName) {
    return byName.id;
  }
  return "";
}

export function inputMayNeedWorkspaceResolution(value?: any) : any {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(inputMayNeedWorkspaceResolution);
  }
  return (Object.entries(value) as [string, any][]).some(([key, child]: any[]) : any => {
    if (/workspace(Ref|Refs|Index|Name)$/i.test(key) || /^workspace-(ref|refs|index|name)$/i.test(key)) {
      return true;
    }
    if (/workspaceId$/i.test(key) && typeof child === "string" && !String(child).startsWith("workspace_")) {
      return true;
    }
    return inputMayNeedWorkspaceResolution(child);
  });
}

export function resolveWorkspaceReferencesInInput(value?: any, directory?: any) : any {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item?: any) : any => resolveWorkspaceReferencesInInput(item, directory));
  }
  const next: Record<string, any> = {};
  for (const [key, child] of (Object.entries(value) as [string, any][])) {
    if (/workspaceRef$/i.test(key)) {
      const idKey: any = key.replace(/Ref$/i, "Id");
      const resolved: any = resolveWorkspaceReference(directory, child);
      if (resolved) {
        next[idKey] = resolved;
      }
      next[key] = child;
      continue;
    }
    if (/workspaceRefs$/i.test(key) && Array.isArray(child)) {
      const idKey: any = key.replace(/Refs$/i, "Ids");
      const resolved: any = child.map((item?: any) : any => resolveWorkspaceReference(directory, item)).filter(Boolean);
      if (resolved.length) {
        next[idKey] = resolved;
      }
      next[key] = child;
      continue;
    }
    if (/workspaceIndex$/i.test(key) || /workspaceName$/i.test(key)) {
      const resolved: any = resolveWorkspaceReference(directory, child);
      if (resolved && !next.workspaceId) {
        next.workspaceId = resolved;
      }
      next[key] = child;
      continue;
    }
    if (/^workspace-(index|name)$/i.test(key)) {
      const resolved: any = resolveWorkspaceReference(directory, child);
      if (resolved && !next.workspaceId) {
        next.workspaceId = resolved;
      }
      next[key] = child;
      continue;
    }
    if (/workspaceId$/i.test(key) && typeof child === "string") {
      next[key] = resolveWorkspaceReference(directory, child) || child;
      continue;
    }
    next[key] = resolveWorkspaceReferencesInInput(child, directory);
  }
  return next;
}

export function isInternalAbsolutePath(value?: any) : any {
  const text: any = String(value || "");
  return (
    /^\/(?:Users|home|root|private|var|tmp|opt|usr|Volumes)\//.test(text) ||
    /^[A-Za-z]:[\\/]/.test(text)
  );
}

export function publicWorkspaceToken(directory?: any, workspaceId?: any) : any {
  const entry: any = directory.byId.get(String(workspaceId || ""));
  return entry?.ref || "workspace-hidden";
}

export function sanitizeInternalWorkspaceIds(value?: any, directory: any = workspaceDirectoryFromWorkspaces([])) : any {
  return String(value || "").replace(/\bworkspace_[A-Za-z0-9_]+\b/g, (workspaceId?: any) : any =>
    publicWorkspaceToken(directory, workspaceId)
  );
}

export function sanitizeInternalPaths(value?: any) : any {
  return String(value || "")
    .replace(/(^|[\s"'=:(])((?:\/(?:Users|home|root|private|var|tmp|opt|usr|Volumes)\/)[^\s"',)\]}]+)/g, "$1[server-internal-path]")
    .replace(/(^|[\s"'=:(])([A-Za-z]:[\\/][^\s"',)\]}]+)/g, "$1[server-internal-path]");
}

export function sanitizeSensitiveMcpText(value?: any) : any {
  return String(value || "")
    .replace(/\b(Authorization\s*:\s*Bearer\s+)[^\s"',;)\]}]+/gi, "$1<redacted-token>")
    .replace(/\b(X-Meshrix-Api-Key\s*:\s*)[^\s"',;)\]}]+/gi, "$1<redacted-token>")
    .replace(/\b(x-meshrix-tool-token\s*:\s*)[^\s"',;)\]}]+/gi, "$1<redacted-token>")
    .replace(/(^|[\s"'=:(])(--token(?:=|\s+))[^\s"',;)\]}]+/gi, "$1$2<redacted-token>")
    .replace(/\b(token|access_token|refresh_token|api_key|apiKey|secret|password)=([^\s"',;)\]}]+)/gi, "$1=<redacted-secret>");
}

export function sanitizeMcpString(value?: any, directory: any = workspaceDirectoryFromWorkspaces([])) : any {
  const text: any = String(value || "");
  if (isInternalAbsolutePath(text)) {
    return "[server-internal-path]";
  }
  return sanitizeSensitiveMcpText(sanitizeInternalWorkspaceIds(sanitizeInternalPaths(text), directory));
}

export function valueContainsWorkspaceId(value?: any) : any {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(valueContainsWorkspaceId);
  }
  return (Object.entries(value) as [string, any][]).some(([key, child]: any[]) : any =>
    /workspaceId$/i.test(key) || valueContainsWorkspaceId(child)
  );
}

export function sanitizeMcpOutputValue(value?: any, directory: any = workspaceDirectoryFromWorkspaces([])) : any {
  if (Array.isArray(value)) {
    return value.map((item?: any) : any => sanitizeMcpOutputValue(item, directory));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? sanitizeMcpString(value, directory) : value;
  }
  const result: Record<string, any> = {};
  for (const [key, child] of (Object.entries(value) as [string, any][])) {
    const publicKey: any = sanitizeInternalWorkspaceIds(key, directory);
    if (isSensitiveMcpOutputKey(key)) {
      continue;
    }
    if (/^(fsPath|absolutePath|rootPath|databasePath|userDataPath)$/i.test(key)) {
      continue;
    }
    if (/path$/i.test(key) && typeof child === "string" && isInternalAbsolutePath(child)) {
      continue;
    }
    if (/^(ownerUserId|defaultAdminUserId|adminUserIds|userId|userIds)$/i.test(key)) {
      continue;
    }
    if (/workspaceIds$/i.test(key) && Array.isArray(child)) {
      const refKey: any = key.replace(/Ids$/i, "Refs");
      result[refKey] = child.map((item?: any) : any => {
        const entry: any = directory.byId.get(String(item || ""));
        return entry?.ref || "workspace-hidden";
      });
      continue;
    }
    if (/workspaceId$/i.test(key)) {
      const refKey: any = key.replace(/Id$/i, "Ref");
      if (child === null || child === undefined || child === "") {
        result[refKey] = null;
        continue;
      }
      const entry: any = directory.byId.get(String(child || ""));
      // Keep the internal id next to the public ref: workspace:<id>:<path>
      // artifact references require it and the HTTP responses already return it.
      result[publicKey] = child;
      result[refKey] = entry?.ref || "workspace-hidden";
      if (key === "workspaceId" && entry) {
        result.workspaceIndex = entry.index;
        result["workspace-index"] = entry.index;
        result.workspaceName = entry.name;
        result["workspace-name"] = entry.name;
      }
      continue;
    }
    result[publicKey] = sanitizeMcpOutputValue(child, directory);
  }
  if (value.workspaceId && !result.workspaceRef) {
    const entry: any = directory.byId.get(String(value.workspaceId || ""));
    result.workspaceRef = entry?.ref || "workspace-hidden";
    if (entry) {
      result.workspaceIndex = entry.index;
      result.workspaceName = entry.name;
    }
  }
  if (value.title && !result.workspaceName && value.workspaceId) {
    result.workspaceName = String(value.title || "");
    result["workspace-name"] = String(value.title || "");
  }
  return result;
}

export function isSensitiveMcpOutputKey(key: any = "") : any {
  const normalized: any = String(key || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (normalized === "secretref" || normalized === "endpointref") {
    return false;
  }
  if (normalized.endsWith("apikey") || normalized.endsWith("tooltoken")) {
    return true;
  }
  return [
    "authorization",
    "bearertoken",
    "cookie",
    "setcookie",
    "token",
    "tokenprefix",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "secret",
    "clientsecret",
    "password",
    "privatekey",
    "privatekeyjwk"
  ].includes(normalized);
}

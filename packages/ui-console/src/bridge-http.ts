import { triggerBrowserDownload } from "./browser-downloads";
import { parseBrowserRelativeUrl } from "./browser-window";

export type BridgeDownloadOptions = {
  fileName?: string;
  signal?: AbortSignal;
};

export type BridgeDownloadResult = {
  fileName: string;
  contentType: string;
  byteLength: number;
};

type SafetyRequestOptions = {
  safetyConfirm?: boolean;
};

export type BridgeRequestOptions = SafetyRequestOptions & {
  signal?: AbortSignal;
};

let csrfToken: any = "";
let csrfBootstrapPromise: Promise<void> | null = null;

function updateCsrfToken(value: unknown) : any {
  const direct: any = typeof value === "string" ? value : "";
  const fromPayload: any =
    !direct && value && typeof value === "object"
      ? String(
          (value as { csrfToken?: string; session?: { csrfToken?: string } }).csrfToken ||
            (value as { session?: { csrfToken?: string } }).session?.csrfToken ||
            "",
        )
      : "";
  const nextToken: any = direct || fromPayload;
  if (nextToken) {
    csrfToken = nextToken;
  }
}

function requestPath(url: string) : any {
  try {
    return parseBrowserRelativeUrl(url).pathname;
  } catch {
    return String(url || "").split("?")[0] || "";
  }
}

async function ensureCsrfToken(url: string) : Promise<any> {
  if (csrfToken || requestPath(url) === "/api/auth/login") {
    return;
  }
  if (!csrfBootstrapPromise) {
    csrfBootstrapPromise = fetch("/api/auth/session", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    })
      .then(async (response?: any) : Promise<any> => {
        if (!response.ok) {
          return;
        }
        try {
          updateCsrfToken(await response.json());
        } catch {
          // Ignore malformed session bootstrap responses; the caller will fail normally.
        }
      })
      .finally(() : any => {
        csrfBootstrapPromise = null;
      });
  }
  await csrfBootstrapPromise;
}

async function extractErrorMessage(response: Response) : Promise<any> {
  const rawText: any = await response.text();

  try {
    const parsed: any = JSON.parse(rawText);
    return parsed.error || parsed.message || rawText;
  } catch {
    return rawText;
  }
}

async function parseJsonResponse<T>(response: Response, url: string): Promise<T> {
  const rawText: any = await response.text();
  const contentType: any = response.headers.get("content-type") || "";
  const trimmed: any = rawText.trim();

  if (!trimmed) {
    throw new Error(`接口没有返回 JSON：${url}`);
  }

  if (!contentType.includes("application/json") && trimmed.startsWith("<")) {
    throw new Error(
      `接口返回了 HTML 而不是 JSON：${url}。请检查登录状态、接口路径或服务端是否回退到了前端页面。`,
    );
  }

  try {
    return JSON.parse(rawText) as T;
  } catch {
    throw new Error(`接口返回的 JSON 无法解析：${url}。响应片段：${trimmed.slice(0, 160)}`);
  }
}

function trimQuotedHeaderValue(value: string) : any {
  const trimmed: any = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"");
  }
  return trimmed;
}

function sanitizeDownloadFileName(value: string) : any {
  return String(value || "download.bin")
    .replace(/[\\/:*?<>|"\r\n]+/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "download.bin";
}

function decodeContentDispositionValue(value: string) : any {
  const trimmed: any = trimQuotedHeaderValue(value);
  const match: any = /^[^']*'[^']*'(.*)$/i.exec(trimmed);
  const encoded: any = match ? match[1] : trimmed;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function fileNameFromContentDisposition(value: string | null) : any {
  if (!value) return "";
  const parts: any = value.split(";").map((part?: any) : any => part.trim()).filter(Boolean);
  const encoded: any = parts.find((part?: any) : any => /^filename\*/i.test(part));
  if (encoded) {
    const [, ...rest] = encoded.split("=");
    const decoded: any = decodeContentDispositionValue(rest.join("="));
    if (decoded) return sanitizeDownloadFileName(decoded);
  }
  const plain: any = parts.find((part?: any) : any => /^filename=/i.test(part));
  if (plain) {
    const [, ...rest] = plain.split("=");
    const decoded: any = trimQuotedHeaderValue(rest.join("="));
    if (decoded) return sanitizeDownloadFileName(decoded);
  }
  return "";
}

function fileNameFromUrl(url: string) : any {
  try {
    const parsed: any = parseBrowserRelativeUrl(url);
    const segment: any = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return sanitizeDownloadFileName(decodeURIComponent(segment || "download.bin"));
  } catch {
    const [pathPart] = String(url || "").split("?");
    const segment: any = pathPart.split("/").filter(Boolean).pop() || "download.bin";
    return sanitizeDownloadFileName(segment);
  }
}

function safetyHeaders(options: SafetyRequestOptions = {}): Record<string, string> {
  return options.safetyConfirm ? { "x-meshrix-safety-confirm": "true" } : {};
}

export async function downloadFile(
  url: string,
  options: BridgeDownloadOptions = {},
): Promise<BridgeDownloadResult> {
  const response: any = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "*/*",
      ...(csrfToken ? { "x-meshrix-csrf": csrfToken } : {}),
    },
    credentials: "same-origin",
    signal: options.signal,
  });

  if (!response.ok) {
    const message: any = await extractErrorMessage(response);
    throw new Error(message || `下载失败：${response.status}`);
  }

  const contentType: any = response.headers.get("content-type") || "";
  const disposition: any = response.headers.get("content-disposition") || "";
  if (/text\/html/i.test(contentType) && !/filename|attachment/i.test(disposition)) {
    const htmlPreview: any = (await response.text()).trim().slice(0, 160);
    throw new Error(`下载接口返回了 HTML 页面，请检查接口路径或登录状态。响应片段：${htmlPreview}`);
  }

  const blob: any = await response.blob();
  const fileName: any = sanitizeDownloadFileName(
    options.fileName ||
      fileNameFromContentDisposition(disposition) ||
      fileNameFromUrl(url),
  );
  triggerBrowserDownload(blob, fileName);
  return {
    fileName,
    contentType,
    byteLength: blob.size,
  };
}

export async function postJson<T>(
  url: string,
  payload?: unknown,
  options: BridgeRequestOptions = {},
): Promise<T> {
  if (payload) {
    await ensureCsrfToken(url);
  }
  const headers: HeadersInit | undefined = payload
    ? {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(csrfToken ? { "x-meshrix-csrf": csrfToken } : {}),
        ...safetyHeaders(options),
      }
    : { Accept: "application/json" };
  const response: any = await fetch(url, {
    method: payload ? "POST" : "GET",
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
    credentials: "same-origin",
    signal: options.signal,
  });

  if (!response.ok) {
    const message: any = await extractErrorMessage(response);
    throw new Error(message || `Request failed: ${response.status}`);
  }

  const data: any = await parseJsonResponse<T>(response, url);
  updateCsrfToken(data);
  return data;
}

export async function sendJson<T>(
  url: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  payload: unknown,
  options: BridgeRequestOptions = {},
): Promise<T> {
  await ensureCsrfToken(url);
  const response: any = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(csrfToken ? { "x-meshrix-csrf": csrfToken } : {}),
      ...safetyHeaders(options),
    },
    body: JSON.stringify(payload),
    credentials: "same-origin",
    signal: options.signal,
  });
  if (!response.ok) {
    const message: any = await extractErrorMessage(response);
    throw new Error(message || `Request failed: ${response.status}`);
  }
  const data: any = await parseJsonResponse<T>(response, url);
  updateCsrfToken(data);
  return data;
}

export async function deleteJson<T>(
  url: string,
  options: BridgeRequestOptions = {},
): Promise<T> {
  await ensureCsrfToken(url);
  const headers: HeadersInit = {
    Accept: "application/json",
    ...(csrfToken ? { "x-meshrix-csrf": csrfToken } : {}),
    ...safetyHeaders(options),
  };
  const response: any = await fetch(url, {
    method: "DELETE",
    headers,
    credentials: "same-origin",
    signal: options.signal,
  });

  if (!response.ok) {
    const message: any = await extractErrorMessage(response);
    throw new Error(message || `Request failed: ${response.status}`);
  }

  const data: any = await parseJsonResponse<T>(response, url);
  updateCsrfToken(data);
  return data;
}

export async function getJson<T>(
  url: string,
  options: BridgeRequestOptions = {},
): Promise<T> {
  const headers: HeadersInit = {
    Accept: "application/json",
    ...(csrfToken ? { "x-meshrix-csrf": csrfToken } : {}),
  };
  const response: any = await fetch(url, {
    method: "GET",
    headers,
    credentials: "same-origin",
    signal: options.signal,
  });

  if (!response.ok) {
    const message: any = await extractErrorMessage(response);
    throw new Error(message || `Request failed: ${response.status}`);
  }

  const data: any = await parseJsonResponse<T>(response, url);
  updateCsrfToken(data);
  return data;
}

export async function putBinaryJson<T>(
  url: string,
  payload: Blob | ArrayBuffer,
): Promise<T> {
  await ensureCsrfToken(url);
  const response: any = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      ...(csrfToken ? { "x-meshrix-csrf": csrfToken } : {}),
    },
    body: payload,
    credentials: "same-origin",
  });

  if (!response.ok) {
    const message: any = await extractErrorMessage(response);
    throw new Error(message || `Request failed: ${response.status}`);
  }

  const data: any = await parseJsonResponse<T>(response, url);
  updateCsrfToken(data);
  return data;
}

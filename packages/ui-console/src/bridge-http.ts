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

let csrfToken = "";
let csrfBootstrapPromise: Promise<void> | null = null;

function updateCsrfToken(value: unknown) {
  const direct = typeof value === "string" ? value : "";
  const fromPayload =
    !direct && value && typeof value === "object"
      ? String(
          (value as { csrfToken?: string; session?: { csrfToken?: string } }).csrfToken ||
            (value as { session?: { csrfToken?: string } }).session?.csrfToken ||
            "",
        )
      : "";
  const nextToken = direct || fromPayload;
  if (nextToken) {
    csrfToken = nextToken;
  }
}

function requestPath(url: string) {
  try {
    return parseBrowserRelativeUrl(url).pathname;
  } catch {
    return String(url || "").split("?")[0] || "";
  }
}

async function ensureCsrfToken(url: string) {
  if (csrfToken || requestPath(url) === "/api/auth/login") {
    return;
  }
  if (!csrfBootstrapPromise) {
    csrfBootstrapPromise = fetch("/api/auth/session", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!response.ok) {
          return;
        }
        try {
          updateCsrfToken(await response.json());
        } catch {
          // Ignore malformed session bootstrap responses; the caller will fail normally.
        }
      })
      .finally(() => {
        csrfBootstrapPromise = null;
      });
  }
  await csrfBootstrapPromise;
}

async function extractErrorMessage(response: Response) {
  const rawText = await response.text();

  try {
    const parsed = JSON.parse(rawText);
    return parsed.error || parsed.message || rawText;
  } catch {
    return rawText;
  }
}

async function parseJsonResponse<T>(response: Response, url: string): Promise<T> {
  const rawText = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const trimmed = rawText.trim();

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

function trimQuotedHeaderValue(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"");
  }
  return trimmed;
}

function sanitizeDownloadFileName(value: string) {
  return String(value || "download.bin")
    .replace(/[\\/:*?<>|"\r\n]+/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "download.bin";
}

function decodeContentDispositionValue(value: string) {
  const trimmed = trimQuotedHeaderValue(value);
  const match = /^[^']*'[^']*'(.*)$/i.exec(trimmed);
  const encoded = match ? match[1] : trimmed;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function fileNameFromContentDisposition(value: string | null) {
  if (!value) return "";
  const parts = value.split(";").map((part) => part.trim()).filter(Boolean);
  const encoded = parts.find((part) => /^filename\*/i.test(part));
  if (encoded) {
    const [, ...rest] = encoded.split("=");
    const decoded = decodeContentDispositionValue(rest.join("="));
    if (decoded) return sanitizeDownloadFileName(decoded);
  }
  const plain = parts.find((part) => /^filename=/i.test(part));
  if (plain) {
    const [, ...rest] = plain.split("=");
    const decoded = trimQuotedHeaderValue(rest.join("="));
    if (decoded) return sanitizeDownloadFileName(decoded);
  }
  return "";
}

function fileNameFromUrl(url: string) {
  try {
    const parsed = parseBrowserRelativeUrl(url);
    const segment = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return sanitizeDownloadFileName(decodeURIComponent(segment || "download.bin"));
  } catch {
    const [pathPart] = String(url || "").split("?");
    const segment = pathPart.split("/").filter(Boolean).pop() || "download.bin";
    return sanitizeDownloadFileName(segment);
  }
}

function safetyHeaders(options: SafetyRequestOptions = {}): Record<string, string> {
  return options.safetyConfirm ? { "x-lico-safety-confirm": "true" } : {};
}

export async function downloadFile(
  url: string,
  options: BridgeDownloadOptions = {},
): Promise<BridgeDownloadResult> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "*/*",
      ...(csrfToken ? { "x-lico-csrf": csrfToken } : {}),
    },
    credentials: "same-origin",
    signal: options.signal,
  });

  if (!response.ok) {
    const message = await extractErrorMessage(response);
    throw new Error(message || `下载失败：${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const disposition = response.headers.get("content-disposition") || "";
  if (/text\/html/i.test(contentType) && !/filename|attachment/i.test(disposition)) {
    const htmlPreview = (await response.text()).trim().slice(0, 160);
    throw new Error(`下载接口返回了 HTML 页面，请检查接口路径或登录状态。响应片段：${htmlPreview}`);
  }

  const blob = await response.blob();
  const fileName = sanitizeDownloadFileName(
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
        ...(csrfToken ? { "x-lico-csrf": csrfToken } : {}),
        ...safetyHeaders(options),
      }
    : { Accept: "application/json" };
  const response = await fetch(url, {
    method: payload ? "POST" : "GET",
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
    credentials: "same-origin",
    signal: options.signal,
  });

  if (!response.ok) {
    const message = await extractErrorMessage(response);
    throw new Error(message || `Request failed: ${response.status}`);
  }

  const data = await parseJsonResponse<T>(response, url);
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
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(csrfToken ? { "x-lico-csrf": csrfToken } : {}),
      ...safetyHeaders(options),
    },
    body: JSON.stringify(payload),
    credentials: "same-origin",
    signal: options.signal,
  });
  if (!response.ok) {
    const message = await extractErrorMessage(response);
    throw new Error(message || `Request failed: ${response.status}`);
  }
  const data = await parseJsonResponse<T>(response, url);
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
    ...(csrfToken ? { "x-lico-csrf": csrfToken } : {}),
    ...safetyHeaders(options),
  };
  const response = await fetch(url, {
    method: "DELETE",
    headers,
    credentials: "same-origin",
    signal: options.signal,
  });

  if (!response.ok) {
    const message = await extractErrorMessage(response);
    throw new Error(message || `Request failed: ${response.status}`);
  }

  const data = await parseJsonResponse<T>(response, url);
  updateCsrfToken(data);
  return data;
}

export async function getJson<T>(
  url: string,
  options: BridgeRequestOptions = {},
): Promise<T> {
  const headers: HeadersInit = {
    Accept: "application/json",
    ...(csrfToken ? { "x-lico-csrf": csrfToken } : {}),
  };
  const response = await fetch(url, {
    method: "GET",
    headers,
    credentials: "same-origin",
    signal: options.signal,
  });

  if (!response.ok) {
    const message = await extractErrorMessage(response);
    throw new Error(message || `Request failed: ${response.status}`);
  }

  const data = await parseJsonResponse<T>(response, url);
  updateCsrfToken(data);
  return data;
}

export async function putBinaryJson<T>(
  url: string,
  payload: Blob | ArrayBuffer,
): Promise<T> {
  await ensureCsrfToken(url);
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      ...(csrfToken ? { "x-lico-csrf": csrfToken } : {}),
    },
    body: payload,
    credentials: "same-origin",
  });

  if (!response.ok) {
    const message = await extractErrorMessage(response);
    throw new Error(message || `Request failed: ${response.status}`);
  }

  const data = await parseJsonResponse<T>(response, url);
  updateCsrfToken(data);
  return data;
}

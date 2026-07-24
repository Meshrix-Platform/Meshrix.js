import { marked } from "marked";

export function escapeHtmlText(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeLinkHref(value: string) {
  const href = value.trim();
  if (!href) {
    return "";
  }
  if (/^(https?:|mailto:|#|\/(?!\/))/i.test(href)) {
    return href;
  }
  return "";
}

export function safeMediaSrc(value: string) {
  const src = value.trim();
  if (!src) {
    return "";
  }
  if (/^(https?:|\/(?!\/)|data:image\/|blob:)/i.test(src)) {
    return src;
  }
  return "";
}

export function sanitizeHtmlContent(rawHtml: string) {
  const template = document.createElement("template");
  template.innerHTML = rawHtml;
  const blockedTags = new Set([
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "link",
    "meta",
    "form",
    "input",
    "button",
    "svg",
  ]);
  const allowedAttrs = new Set(["href", "src", "alt", "title", "colspan", "rowspan"]);
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    const tag = element.tagName.toLowerCase();
    if (blockedTags.has(tag)) {
      element.remove();
      continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || !allowedAttrs.has(name)) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (name === "href") {
        const href = safeLinkHref(attr.value);
        if (!href) {
          element.removeAttribute(attr.name);
        } else {
          element.setAttribute("href", href);
          element.setAttribute("target", "_blank");
          element.setAttribute("rel", "noreferrer noopener");
        }
      }
      if (name === "src") {
        const src = safeMediaSrc(attr.value);
        if (!src) {
          element.removeAttribute(attr.name);
        } else {
          element.setAttribute("src", src);
          element.setAttribute("loading", "lazy");
        }
      }
    }
  }
  return template.innerHTML;
}

export function markdownToSafeHtml(markdown: string) {
  const rendered = marked.parse(String(markdown || ""), {
    async: false,
    breaks: false,
    gfm: true,
  });
  return sanitizeHtmlContent(String(rendered));
}

export function escapeRegexText(value: string) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function uniqueEvidenceRefs(values: string[]) {
  const seen = new Set<string>();
  return values
    .map((value) => String(value || "").trim())
    .filter((value) => {
      if (!value || seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
}

export function extractEvidenceRefsFromText(value: string) {
  const text = String(value || "");
  return uniqueEvidenceRefs(
    Array.from(text.matchAll(/\b(?:source-evidence::[A-Za-z0-9:_-]+|evidence::[A-Za-z0-9:_-]+|ev_[A-Za-z0-9_-]+)\b/g))
      .map((match) => match[0]),
  );
}

export function evidenceRefHref(evidenceId: string) {
  return `#meshrix-evidence-${encodeURIComponent(evidenceId)}`;
}

export function evidenceIdFromHref(href: string) {
  const prefix = "#meshrix-evidence-";
  if (!String(href || "").startsWith(prefix)) {
    return "";
  }
  try {
    return decodeURIComponent(String(href).slice(prefix.length));
  } catch {
    return String(href).slice(prefix.length);
  }
}

export function linkifyEvidenceRefsInMarkdown(markdown: string, refs: string[]) {
  let next = String(markdown || "");
  for (const refId of [...refs].sort((left, right) => right.length - left.length)) {
    const escaped = escapeRegexText(refId);
    const href = evidenceRefHref(refId);
    next = next.replace(new RegExp(`\\[(${escaped})\\](?!\\()`, "g"), `[${refId}](${href})`);
    next = next.replace(
      new RegExp(`(^|[\\s(（,，;；:：])(${escaped})(?=$|[\\s)）,.，。;；:：])`, "g"),
      (_match, prefix) => `${prefix}[${refId}](${href})`,
    );
  }
  return next;
}

export function plainTextToHtml(text: string) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtmlText(paragraph).replace(/\n/g, "<br />")}</p>`)
    .join("\n");
}

export function normalizeCharset(value: string) {
  const charset = String(value || "utf-8").trim().toLowerCase().replace(/^["']|["']$/g, "");
  if (!charset || charset === "utf8") {
    return "utf-8";
  }
  if (charset === "us-ascii") {
    return "windows-1252";
  }
  return charset;
}

export function decodeBytes(bytes: number[], charset = "utf-8") {
  try {
    return new TextDecoder(normalizeCharset(charset)).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }
}

export function base64ToBytes(value: string) {
  const clean = String(value || "").replace(/\s+/g, "");
  if (!clean) {
    return [];
  }
  try {
    return Array.from(atob(clean), (char) => char.charCodeAt(0));
  } catch {
    return [];
  }
}

export function decodeQuotedPrintableToBytes(value: string, headerMode = false) {
  const text = String(value || "")
    .replace(/=\r?\n/g, "")
    .replace(/\r\n/g, "\n");
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (headerMode && char === "_") {
      bytes.push(0x20);
      continue;
    }
    if (char === "=" && /^[0-9a-f]{2}$/i.test(text.slice(index + 1, index + 3))) {
      bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code <= 0xff) {
      bytes.push(code);
    } else {
      bytes.push(...Array.from(new TextEncoder().encode(char)));
    }
  }
  return bytes;
}

export function decodeMimeWords(value: string) {
  return String(value || "").replace(
    /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (_match, charset, encoding, content) => {
      const bytes =
        String(encoding).toLowerCase() === "b"
          ? base64ToBytes(String(content))
          : decodeQuotedPrintableToBytes(String(content), true);
      return decodeBytes(bytes, String(charset));
    },
  );
}

export function parseHeaderParams(value: string) {
  const parts = String(value || "").split(";").map((part) => part.trim());
  const type = (parts.shift() || "").toLowerCase();
  const params: Record<string, string> = {};
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = part.slice(0, index).trim().toLowerCase();
    const raw = part.slice(index + 1).trim();
    params[key] = raw.replace(/^["']|["']$/g, "");
  }
  return { type, params };
}

export function parseEmailHeaders(rawText: string) {
  const normalized = rawText.replace(/\r\n/g, "\n");
  const match = normalized.match(/^([\s\S]*?)\n\s*\n([\s\S]*)$/);
  if (!match || !/^(from|to|subject|date|cc):/im.test(match[1])) {
    return { headers: [] as Array<[string, string]>, body: rawText };
  }
  const unfolded = match[1].replace(/\n[ \t]+/g, " ");
  const headers = unfolded
    .split("\n")
    .map((line) => {
      const index = line.indexOf(":");
      return index > 0 ? [line.slice(0, index), decodeMimeWords(line.slice(index + 1).trim())] as [string, string] : null;
    })
    .filter(Boolean) as Array<[string, string]>;
  return { headers, body: match[2] };
}

export function emailHeaderValue(headers: Array<[string, string]>, name: string) {
  return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || "";
}

export function decodeMimeBody(body: string, headers: Array<[string, string]>) {
  const transferEncoding = emailHeaderValue(headers, "Content-Transfer-Encoding").toLowerCase();
  const contentType = parseHeaderParams(emailHeaderValue(headers, "Content-Type"));
  const charset = contentType.params.charset || "utf-8";
  if (transferEncoding === "quoted-printable") {
    return decodeBytes(decodeQuotedPrintableToBytes(body), charset);
  }
  if (transferEncoding === "base64") {
    return decodeBytes(base64ToBytes(body), charset);
  }
  return body;
}

export function splitMimeParts(body: string, boundary: string) {
  if (!boundary) {
    return [];
  }
  const normalized = body.replace(/\r\n/g, "\n");
  const marker = `--${boundary}`;
  return normalized
    .split(marker)
    .slice(1)
    .map((part) => part.replace(/^\n/, "").replace(/\n--\s*$/, "").trimEnd())
    .filter((part) => part && part !== "--");
}

export function extractEmailRenderablePart(rawText: string): {
  headers: Array<[string, string]>;
  body: string;
  contentType: string;
} {
  const parsed = parseEmailHeaders(rawText);
  const contentType = parseHeaderParams(emailHeaderValue(parsed.headers, "Content-Type"));
  if (contentType.type.startsWith("multipart/") && contentType.params.boundary) {
    const parts = splitMimeParts(parsed.body, contentType.params.boundary)
      .map((part) => extractEmailRenderablePart(part));
    return (
      parts.find((part) => part.contentType === "text/html") ||
      parts.find((part) => part.contentType === "text/plain") ||
      parts[0] ||
      { headers: parsed.headers, body: "", contentType: "text/plain" }
    );
  }
  return {
    headers: parsed.headers,
    body: decodeMimeBody(parsed.body, parsed.headers),
    contentType: contentType.type || "text/plain",
  };
}

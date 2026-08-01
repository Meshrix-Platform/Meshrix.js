import { marked } from "marked";

export function escapeHtmlText(value: unknown) : any {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeLinkHref(value: string) : any {
  const href: any = value.trim();
  if (!href) {
    return "";
  }
  if (/^(https?:|mailto:|#|\/(?!\/))/i.test(href)) {
    return href;
  }
  return "";
}

export function safeMediaSrc(value: string) : any {
  const src: any = value.trim();
  if (!src) {
    return "";
  }
  if (/^(https?:|\/(?!\/)|data:image\/|blob:)/i.test(src)) {
    return src;
  }
  return "";
}

export function sanitizeHtmlContent(rawHtml: string) : any {
  const template: any = document.createElement("template");
  template.innerHTML = rawHtml;
  const blockedTags: any = new Set<any>([
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
  const allowedAttrs: any = new Set<any>(["href", "src", "alt", "title", "colspan", "rowspan"]);
  for (const element of Array.from(template.content.querySelectorAll("*")) as Element[]) {
    const tag: any = element.tagName.toLowerCase();
    if (blockedTags.has(tag)) {
      element.remove();
      continue;
    }
    for (const attr of Array.from(element.attributes) as Attr[]) {
      const name: any = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || !allowedAttrs.has(name)) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (name === "href") {
        const href: any = safeLinkHref(attr.value);
        if (!href) {
          element.removeAttribute(attr.name);
        } else {
          element.setAttribute("href", href);
          element.setAttribute("target", "_blank");
          element.setAttribute("rel", "noreferrer noopener");
        }
      }
      if (name === "src") {
        const src: any = safeMediaSrc(attr.value);
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

export function markdownToSafeHtml(markdown: string) : any {
  const rendered: any = marked.parse(String(markdown || ""), {
    async: false,
    breaks: false,
    gfm: true,
  });
  return sanitizeHtmlContent(String(rendered));
}

export function escapeRegexText(value: string) : any {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function uniqueEvidenceRefs(values: string[]) : any {
  const seen: any = new Set<string>();
  return values
    .map((value?: any) : any => String(value || "").trim())
    .filter((value?: any) : any => {
      if (!value || seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
}

export function extractEvidenceRefsFromText(value: string) : any {
  const text: any = String(value || "");
  return uniqueEvidenceRefs(
    Array.from(text.matchAll(/\b(?:source-evidence::[A-Za-z0-9:_-]+|evidence::[A-Za-z0-9:_-]+|ev_[A-Za-z0-9_-]+)\b/g))
      .map((match?: any) : any => match[0]),
  );
}

export function evidenceRefHref(evidenceId: string) : any {
  return `#meshrix-evidence-${encodeURIComponent(evidenceId)}`;
}

export function evidenceIdFromHref(href: string) : any {
  const prefix: any = "#meshrix-evidence-";
  if (!String(href || "").startsWith(prefix)) {
    return "";
  }
  try {
    return decodeURIComponent(String(href).slice(prefix.length));
  } catch {
    return String(href).slice(prefix.length);
  }
}

export function linkifyEvidenceRefsInMarkdown(markdown: string, refs: string[]) : any {
  let next: any = String(markdown || "");
  for (const refId of [...refs].sort((left?: any, right?: any) : any => right.length - left.length)) {
    const escaped: any = escapeRegexText(refId);
    const href: any = evidenceRefHref(refId);
    next = next.replace(new RegExp(`\\[(${escaped})\\](?!\\()`, "g"), `[${refId}](${href})`);
    next = next.replace(
      new RegExp(`(^|[\\s(（,，;；:：])(${escaped})(?=$|[\\s)）,.，。;；:：])`, "g"),
      (_match?: any, prefix?: any) : any => `${prefix}[${refId}](${href})`,
    );
  }
  return next;
}

export function plainTextToHtml(text: string) : any {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph?: any) : any => `<p>${escapeHtmlText(paragraph).replace(/\n/g, "<br />")}</p>`)
    .join("\n");
}

export function normalizeCharset(value: string) : any {
  const charset: any = String(value || "utf-8").trim().toLowerCase().replace(/^["']|["']$/g, "");
  if (!charset || charset === "utf8") {
    return "utf-8";
  }
  if (charset === "us-ascii") {
    return "windows-1252";
  }
  return charset;
}

export function decodeBytes(bytes: number[], charset: any = "utf-8") : any {
  try {
    return new TextDecoder(normalizeCharset(charset)).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }
}

export function base64ToBytes(value: string) : any {
  const clean: any = String(value || "").replace(/\s+/g, "");
  if (!clean) {
    return [];
  }
  try {
    return Array.from(atob(clean), (char?: any) : any => char.charCodeAt(0));
  } catch {
    return [];
  }
}

export function decodeQuotedPrintableToBytes(value: string, headerMode: any = false) : any {
  const text: any = String(value || "")
    .replace(/=\r?\n/g, "")
    .replace(/\r\n/g, "\n");
  const bytes: number[] = [];
  for (let index: any = 0; index < text.length; index += 1) {
    const char: any = text[index];
    if (headerMode && char === "_") {
      bytes.push(0x20);
      continue;
    }
    if (char === "=" && /^[0-9a-f]{2}$/i.test(text.slice(index + 1, index + 3))) {
      bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    const code: any = char.charCodeAt(0);
    if (code <= 0xff) {
      bytes.push(code);
    } else {
      bytes.push(...Array.from(new TextEncoder().encode(char)));
    }
  }
  return bytes;
}

export function decodeMimeWords(value: string) : any {
  return String(value || "").replace(
    /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (_match?: any, charset?: any, encoding?: any, content?: any) : any => {
      const bytes: any =
        String(encoding).toLowerCase() === "b"
          ? base64ToBytes(String(content))
          : decodeQuotedPrintableToBytes(String(content), true);
      return decodeBytes(bytes, String(charset));
    },
  );
}

export function parseHeaderParams(value: string) : any {
  const parts: any = String(value || "").split(";").map((part?: any) : any => part.trim());
  const type: any = (parts.shift() || "").toLowerCase();
  const params: Record<string, string> = {};
  for (const part of parts) {
    const index: any = part.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key: any = part.slice(0, index).trim().toLowerCase();
    const raw: any = part.slice(index + 1).trim();
    params[key] = raw.replace(/^["']|["']$/g, "");
  }
  return { type, params };
}

export function parseEmailHeaders(rawText: string) : any {
  const normalized: any = rawText.replace(/\r\n/g, "\n");
  const match: any = normalized.match(/^([\s\S]*?)\n\s*\n([\s\S]*)$/);
  if (!match || !/^(from|to|subject|date|cc):/im.test(match[1])) {
    return { headers: [] as Array<[string, string]>, body: rawText };
  }
  const unfolded: any = match[1].replace(/\n[ \t]+/g, " ");
  const headers: any = unfolded
    .split("\n")
    .map((line?: any) : any => {
      const index: any = line.indexOf(":");
      return index > 0 ? [line.slice(0, index), decodeMimeWords(line.slice(index + 1).trim())] as [string, string] : null;
    })
    .filter(Boolean) as Array<[string, string]>;
  return { headers, body: match[2] };
}

export function emailHeaderValue(headers: Array<[string, string]>, name: string) : any {
  return headers.find(([key]: any[]) : any => key.toLowerCase() === name.toLowerCase())?.[1] || "";
}

export function decodeMimeBody(body: string, headers: Array<[string, string]>) : any {
  const transferEncoding: any = emailHeaderValue(headers, "Content-Transfer-Encoding").toLowerCase();
  const contentType: any = parseHeaderParams(emailHeaderValue(headers, "Content-Type"));
  const charset: any = contentType.params.charset || "utf-8";
  if (transferEncoding === "quoted-printable") {
    return decodeBytes(decodeQuotedPrintableToBytes(body), charset);
  }
  if (transferEncoding === "base64") {
    return decodeBytes(base64ToBytes(body), charset);
  }
  return body;
}

export function splitMimeParts(body: string, boundary: string) : any {
  if (!boundary) {
    return [];
  }
  const normalized: any = body.replace(/\r\n/g, "\n");
  const marker: any = `--${boundary}`;
  return normalized
    .split(marker)
    .slice(1)
    .map((part?: any) : any => part.replace(/^\n/, "").replace(/\n--\s*$/, "").trimEnd())
    .filter((part?: any) : any => part && part !== "--");
}

export function extractEmailRenderablePart(rawText: string): {
  headers: Array<[string, string]>;
  body: string;
  contentType: string;
} {
  const parsed: any = parseEmailHeaders(rawText);
  const contentType: any = parseHeaderParams(emailHeaderValue(parsed.headers, "Content-Type"));
  if (contentType.type.startsWith("multipart/") && contentType.params.boundary) {
    const parts: any = splitMimeParts(parsed.body, contentType.params.boundary)
      .map((part?: any) : any => extractEmailRenderablePart(part));
    return (
      parts.find((part?: any) : any => part.contentType === "text/html") ||
      parts.find((part?: any) : any => part.contentType === "text/plain") ||
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

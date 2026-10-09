/**
 * Minimal HTTP helpers for the relay router and Durable Object endpoints.
 * Responses carry routing metadata only — never payloads or secrets.
 */

export function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function textResponse(body: string, status: number = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Read a bounded JSON body; returns null when the body exceeds the bound.
 * The stream is cancelled as soon as the bound is crossed, so memory and CPU
 * scale with maxBytes rather than with whatever the client actually sent.
 */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(declared) && declared > maxBytes) return null;
  const body = request.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined));
  } catch {
    return null;
  }
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

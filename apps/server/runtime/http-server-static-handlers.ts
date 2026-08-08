import fs from "node:fs/promises";
import path from "node:path";
import { sendJson, serveStaticFile } from "#meshrix/http-utils";

function shouldRenderConsoleIndexFallback(pathname?: any) : any {
  return pathname === "/" || pathname === "/console" || pathname === "/index.html";
}

function injectCspNonceIntoInlineScripts(html?: any, scriptNonce?: any) : any {
  if (!scriptNonce) {
    return String(html || "");
  }
  const safeNonce: any = String(scriptNonce).replace(/["']/g, "");
  return String(html || "").replace(
    /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g,
    (_match?: any, attributes?: any, body?: any) : any => {
      if (/\bnonce\s*=\s*(["']).*?\1/i.test(attributes)) {
        return `<script${attributes}>${body}</script>`;
      }
      const hasAttributes: any = String(attributes || "").trim();
      return `<script${hasAttributes ? `${hasAttributes} ` : " "}nonce="${safeNonce}">${body}</script>`;
    }
  );
}

async function serveConsoleIndexFallback(response?: any, distPath?: any, scriptNonce: any = "") : Promise<any> {
  if (!distPath) {
    return false;
  }
  const fallback: any = await fs.readFile(path.join(distPath, "index.html"));
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(injectCspNonceIntoInlineScripts(fallback, scriptNonce));
  return true;
}

export async function handleStaticFallback({
  url,
  response,
  distPath,
  discoveryState,
  scriptNonce = ""
}: Record<string, any>) : Promise<any> {
  if (url.pathname === "/" && !distPath) {
    sendJson(response, 200, {
      ok: true,
      service: "Meshrix.js Server",
      serverId: discoveryState.serverId,
      activeServiceUrl: discoveryState.activeServiceUrl
    });
    return;
  }

  if (shouldRenderConsoleIndexFallback(url.pathname) && await serveConsoleIndexFallback(response, distPath, scriptNonce)) {
    return;
  }

  const served: any = await serveStaticFile(response, distPath, url.pathname);
  if (served) {
    return;
  }

  if (path.extname(url.pathname)) {
    sendJson(response, 404, {
      error: "资源不存在。"
    });
    return;
  }

  if (!distPath) {
    sendJson(response, 404, {
      error: "接口不存在。"
    });
    return;
  }

  await serveConsoleIndexFallback(response, distPath, scriptNonce);
}

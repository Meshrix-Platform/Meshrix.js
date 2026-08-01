import { sendJson } from "#meshrix/http-utils";

const CONSOLE_ASSET_PREFIX: any = "/api/plugins/v1/console-assets/";
const MAX_CONSOLE_ASSET_BYTES: any = 4 * 1024 * 1024;

function hasRequiredScopes(session?: any, requiredScopes?: any) : any {
  const available: any = new Set<any>(session?.user?.scopes || []);
  return requiredScopes.every((scope?: any) : any => available.has(scope));
}

export async function handlePluginConsoleAssetRequest({
  request,
  response,
  method,
  url,
  consoleAuth,
  pluginContributions
}: Record<string, any> = {}) : Promise<any> {
  if (!url?.pathname?.startsWith(CONSOLE_ASSET_PREFIX)) return false;
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendJson(response, 405, { error: "Method not allowed." });
    return true;
  }
  const entry: any = pluginContributions?.getConsoleAssetEntry?.(url.pathname) || null;
  if (!entry) {
    sendJson(response, 404, { error: "Plugin console asset is unavailable." });
    return true;
  }
  const session: any = consoleAuth?.getSessionFromRequest?.(request) || null;
  if (!session) {
    sendJson(response, 401, { error: "Authentication required." });
    return true;
  }
  if (!hasRequiredScopes(session, entry.requiredScopes)) {
    sendJson(response, 403, { error: "Plugin console asset access denied." });
    return true;
  }
  let asset: any;
  try {
    asset = await pluginContributions.readConsoleAsset(url.pathname);
  } catch {
    asset = null;
  }
  if (!asset || asset.entry.artifactDigest !== entry.artifactDigest ||
      asset.entry.artifactGeneration !== entry.artifactGeneration ||
      asset.entry.pluginId !== entry.pluginId || asset.bytes.length > MAX_CONSOLE_ASSET_BYTES) {
    sendJson(response, 404, { error: "Plugin console asset is unavailable." });
    return true;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/javascript; charset=utf-8");
  response.setHeader("Content-Length", String(asset.bytes.length));
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (method === "HEAD") response.end();
  else response.end(asset.bytes);
  return true;
}

export { CONSOLE_ASSET_PREFIX, MAX_CONSOLE_ASSET_BYTES };
